/**
 * Invoice PDF Generator
 *
 * A4, data-driven invoice template for the Cloudflare Worker.
 * Layout is cursor-based: every section consumes the space it actually uses.
 * The public exports are intentionally kept compatible with handlers/invoices.js.
 */

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import {
  PDF_PAGE_WIDTH,
  PDF_PAGE_HEIGHT,
  PDF_MARGIN,
} from "../config/constants.js";
import { formatMoney } from "./utils.js";

const PAGE_W = PDF_PAGE_WIDTH;
const PAGE_H = PDF_PAGE_HEIGHT;
const ML = PDF_MARGIN;
const MR = PAGE_W - PDF_MARGIN;
const CW = MR - ML;

const TOP_MARGIN = 42;
const BOTTOM_MARGIN = 42;
const FOOTER_H = 58;
const SECTION_GAP = 22;

const BLACK = rgb(0.08, 0.08, 0.09);
const TEXT = rgb(0.18, 0.18, 0.19);
const MUTED = rgb(0.47, 0.47, 0.49);
const BORDER = rgb(0.86, 0.86, 0.87);
const SOFT = rgb(0.97, 0.97, 0.97);
const WHITE = rgb(1, 1, 1);

function hexToRgb(hex) {
  if (!hex || typeof hex !== "string") return null;
  const value = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(value)) return null;
  const n = parseInt(value, 16);
  return rgb(
    ((n >> 16) & 255) / 255,
    ((n >> 8) & 255) / 255,
    (n & 255) / 255,
  );
}

function lighten(hex, amount = 0.92) {
  const base = hexToRgb(hex);
  if (!base) return rgb(0.97, 0.98, 0.94);
  const mix = (v) => v + (1 - v) * amount;
  return rgb(mix(base.red), mix(base.green), mix(base.blue));
}

function safe(value) {
  return value === null || value === undefined ? "" : String(value);
}

function drawRounded(page, x, y, width, height, radius, options = {}) {
  const r = Math.min(radius, width / 2, height / 2);
  const path = [
    `M ${r} 0`,
    `L ${width - r} 0`,
    `Q ${width} 0 ${width} ${r}`,
    `L ${width} ${height - r}`,
    `Q ${width} ${height} ${width - r} ${height}`,
    `L ${r} ${height}`,
    `Q 0 ${height} 0 ${height - r}`,
    `L 0 ${r}`,
    `Q 0 0 ${r} 0`,
    `Z`,
  ].join(" ");

  page.drawSvgPath(path, {
    x,
    y,
    color: options.color,
    borderColor: options.borderColor,
    borderWidth: options.borderWidth ?? 0,
    opacity: options.opacity,
  });
}

function drawRight(page, text, rightX, y, size, font, color) {
  const value = safe(text);
  page.drawText(value, {
    x: rightX - font.widthOfTextAtSize(value, size),
    y,
    size,
    font,
    color,
  });
}

function drawCenter(page, text, centerX, y, size, font, color) {
  const value = safe(text);
  page.drawText(value, {
    x: centerX - font.widthOfTextAtSize(value, size) / 2,
    y,
    size,
    font,
    color,
  });
}

function truncate(font, text, size, maxWidth) {
  const value = safe(text);
  if (font.widthOfTextAtSize(value, size) <= maxWidth) return value;
  let out = value;
  while (out.length > 1 && font.widthOfTextAtSize(`${out}…`, size) > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

function wrapText(font, text, size, maxWidth) {
  const value = safe(text).trim();
  if (!value) return [""];

  const words = value.split(/\s+/);
  const lines = [];
  let line = "";

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
      continue;
    }

    if (line) lines.push(line);

    if (font.widthOfTextAtSize(word, size) <= maxWidth) {
      line = word;
    } else {
      let chunk = "";
      for (const char of word) {
        const next = chunk + char;
        if (font.widthOfTextAtSize(next, size) <= maxWidth) {
          chunk = next;
        } else {
          if (chunk) lines.push(chunk);
          chunk = char;
        }
      }
      line = chunk;
    }
  }

  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function fmtDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return safe(value);
  return date.toLocaleDateString("en-ZA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Africa/Johannesburg",
  });
}

function normalizeItems(lineItems = []) {
  return lineItems.map((item) => {
    const quantity = Number(item.quantity || 0);
    const unitPrice = Number(item.unit_price ?? item.price ?? 0);
    const lineTotal = Number(
      item.line_total ?? item.lineTotal ?? quantity * unitPrice,
    );
    return {
      description: safe(item.description || "Item"),
      quantity,
      unitPrice,
      lineTotal,
    };
  });
}

async function embedLogo(doc, url) {
  if (!url) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") || "";
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (contentType.includes("png") || /\.png(?:\?|$)/i.test(url)) {
      return await doc.embedPng(bytes);
    }
    if (
      contentType.includes("jpeg") ||
      contentType.includes("jpg") ||
      /\.jpe?g(?:\?|$)/i.test(url)
    ) {
      return await doc.embedJpg(bytes);
    }
  } catch {
    // Logo failure must never prevent invoice generation.
  }
  return null;
}

function createPage(doc) {
  return doc.addPage([PAGE_W, PAGE_H]);
}

function startY() {
  return PAGE_H - TOP_MARGIN;
}

function availableContentHeight(cursorY) {
  return cursorY - BOTTOM_MARGIN - FOOTER_H;
}

function needsPage(cursorY, requiredHeight) {
  return cursorY - requiredHeight < BOTTOM_MARGIN + FOOTER_H;
}

function drawHeader(page, fonts, brand, client, invoice, logo, cursorY) {
  const { font, bold } = fonts;
  const y = cursorY;
  const logoSize = 58;
  const logoW = logo
    ? Math.min(logoSize * (logo.width / Math.max(logo.height, 1)), 78)
    : 0;
  const infoX = logo ? ML + logoW + 16 : ML;
  const rightStart = ML + CW * 0.58;

  if (logo) {
    page.drawImage(logo, {
      x: ML,
      y: y - logoSize,
      width: logoW,
      height: logoSize,
    });
  }

  page.drawText(safe(client.business_name), {
    x: infoX,
    y: y - 12,
    size: 18,
    font: bold,
    color: BLACK,
  });

  const contacts = [client.address, client.phone, client.owner_email || client.reply_email]
    .filter(Boolean)
    .slice(0, 3);
  let contactY = y - 31;
  for (const contact of contacts) {
    page.drawText(truncate(font, contact, 9.5, rightStart - infoX - 14), {
      x: infoX,
      y: contactY,
      size: 9.5,
      font,
      color: TEXT,
    });
    contactY -= 15;
  }

  const title = "INVOICE";
  const titleSize = 35;
  drawRight(page, title, MR, y - 8, titleSize, bold, brand);

  const metaTop = y - 55;
  const metaX = rightStart;
  const metaW = MR - rightStart;
  const colW = metaW / 3;
  const meta = [
    ["Invoice No", `#${safe(invoice.invoice_number)}`],
    ["Issued", fmtDate(invoice.issued_at || invoice.created_at)],
    ["Due", fmtDate(invoice.due_at)],
  ];

  meta.forEach(([label, value], index) => {
    const x = metaX + index * colW;
    page.drawText(label, { x, y: metaTop, size: 8.5, font, color: MUTED });
    page.drawText(truncate(bold, value, 10, colW - 8), {
      x,
      y: metaTop - 15,
      size: 10,
      font: bold,
      color: brand,
    });
  });

  page.drawLine({
    start: { x: ML, y: y - 92 },
    end: { x: MR, y: y - 92 },
    thickness: 0.8,
    color: BORDER,
  });

  return y - 112;
}

function calculatePartyCardHeight(font, bold, client, customer, cardW) {
  const innerW = cardW - 74;
  const customerLines = wrapText(font, customer?.email || "", 9.5, innerW).length;
  const fromLines = [client.address, client.phone, client.owner_email || client.reply_email]
    .filter(Boolean)
    .flatMap((v) => wrapText(font, v, 9.5, innerW)).length;
  const fromHeight = 20 + 22 + Math.max(1, fromLines) * 15 + 16;
  const billHeight = 20 + 22 + Math.max(1, customerLines) * 15 + 16;
  return Math.max(100, fromHeight, billHeight);
}

function drawPartyCard(page, fonts, brand, x, y, width, height, title, name, lines, iconType) {
  const { font, bold } = fonts;
  drawRounded(page, x, y - height, width, height, 9, {
    color: WHITE,
    borderColor: BORDER,
    borderWidth: 1,
  });

  const iconSize = 38;
  const iconX = x + 16;
  const iconY = y - 16 - iconSize;
  const iconBg = lighten(
    `#${Math.round(brand.red * 255).toString(16).padStart(2, "0")}${Math.round(brand.green * 255).toString(16).padStart(2, "0")}${Math.round(brand.blue * 255).toString(16).padStart(2, "0")}`,
    0.86,
  );
  drawRounded(page, iconX, iconY, iconSize, iconSize, 19, { color: iconBg });

  // Simple vector glyphs keep the PDF independent of external icon fonts.
  const cx = iconX + iconSize / 2;
  const cy = iconY + iconSize / 2;
  if (iconType === "person") {
    page.drawCircle({ x: cx, y: cy + 6, size: 5, borderColor: brand, borderWidth: 2 });
    page.drawLine({ start: { x: cx - 9, y: cy - 9 }, end: { x: cx - 9, y: cy - 3 }, thickness: 2, color: brand });
    page.drawLine({ start: { x: cx + 9, y: cy - 9 }, end: { x: cx + 9, y: cy - 3 }, thickness: 2, color: brand });
    page.drawLine({ start: { x: cx - 9, y: cy - 3 }, end: { x: cx + 9, y: cy - 3 }, thickness: 2, color: brand });
  } else {
    page.drawRectangle({ x: cx - 10, y: cy - 5, width: 20, height: 13, borderColor: brand, borderWidth: 1.5 });
    page.drawLine({ start: { x: cx - 12, y: cy + 8 }, end: { x: cx + 12, y: cy + 8 }, thickness: 2, color: brand });
    page.drawLine({ start: { x: cx - 7, y: cy - 8 }, end: { x: cx - 7, y: cy - 13 }, thickness: 1.5, color: brand });
    page.drawLine({ start: { x: cx + 7, y: cy - 8 }, end: { x: cx + 7, y: cy - 13 }, thickness: 1.5, color: brand });
  }

  const tx = iconX + iconSize + 16;
  const top = y - 22;
  page.drawText(title, { x: tx, y: top, size: 9.5, font: bold, color: brand });
  page.drawText(truncate(bold, name, 13.5, width - (tx - x) - 16), {
    x: tx,
    y: top - 22,
    size: 13.5,
    font: bold,
    color: BLACK,
  });

  let lineY = top - 43;
  for (const rawLine of lines.filter(Boolean)) {
    const wrapped = wrapText(font, rawLine, 9.5, width - (tx - x) - 16);
    for (const line of wrapped) {
      page.drawText(line, { x: tx, y: lineY, size: 9.5, font, color: TEXT });
      lineY -= 14;
    }
  }
}

function drawBillToFrom(page, fonts, brand, client, customer, cursorY) {
  const gap = 18;
  const cardW = (CW - gap) / 2;
  const cardH = calculatePartyCardHeight(fonts.font, fonts.bold, client, customer, cardW);

  drawPartyCard(
    page,
    fonts,
    brand,
    ML,
    cursorY,
    cardW,
    cardH,
    "BILL TO",
    customer?.name || "",
    [customer?.email],
    "person",
  );

  drawPartyCard(
    page,
    fonts,
    brand,
    ML + cardW + gap,
    cursorY,
    cardW,
    cardH,
    "FROM",
    client.business_name || "",
    [client.address, client.phone, client.owner_email || client.reply_email],
    "business",
  );

  return cursorY - cardH - SECTION_GAP;
}

function columnGeometry() {
  const widths = {
    description: CW * 0.54,
    quantity: CW * 0.10,
    unitPrice: CW * 0.18,
    total: CW * 0.18,
  };
  return {
    descriptionX: ML,
    quantityX: ML + widths.description,
    unitPriceX: ML + widths.description + widths.quantity,
    totalX: ML + widths.description + widths.quantity + widths.unitPrice,
    widths,
  };
}

function drawTableHeader(page, fonts, brand, cursorY) {
  const { bold } = fonts;
  const h = 34;
  const y = cursorY - h;
  drawRounded(page, ML, y, CW, h, 8, { color: brand });

  const { descriptionX, quantityX, unitPriceX, totalX, widths } = columnGeometry();
  const textY = y + 11;

  page.drawText("DESCRIPTION", { x: descriptionX + 12, y: textY, size: 9.5, font: bold, color: WHITE });
  drawCenter(page, "QTY", quantityX + widths.quantity / 2, textY, 9.5, bold, WHITE);
  drawCenter(page, "UNIT PRICE", unitPriceX + widths.unitPrice / 2, textY, 9.5, bold, WHITE);
  drawRight(page, "TOTAL", totalX + widths.total - 12, textY, 9.5, bold, WHITE);

  return { nextY: y, height: h };
}

function itemRowHeight(font, item, descriptionWidth) {
  const lines = wrapText(font, item.description, 10.5, descriptionWidth - 24);
  return Math.max(38, 18 + lines.length * 13);
}

function drawItemRow(page, fonts, item, index, cursorY, rowH) {
  const { font, bold } = fonts;
  const rowY = cursorY - rowH;
  const { descriptionX, quantityX, unitPriceX, totalX, widths } = columnGeometry();

  if (index % 2 === 1) {
    page.drawRectangle({ x: ML, y: rowY, width: CW, height: rowH, color: SOFT });
  }

  const lines = wrapText(font, item.description, 10.5, widths.description - 24);
  const textBlockH = lines.length * 13;
  let textY = rowY + (rowH + textBlockH) / 2 - 9;

  for (const line of lines) {
    page.drawText(line, { x: descriptionX + 12, y: textY, size: 10.5, font, color: TEXT });
    textY -= 13;
  }

  const baseline = rowY + rowH / 2 - 4;
  drawCenter(page, String(item.quantity), quantityX + widths.quantity / 2, baseline, 10.5, font, TEXT);
  drawRight(page, formatMoney(item.unitPrice), unitPriceX + widths.unitPrice - 12, baseline, 10.5, font, TEXT);
  drawRight(page, formatMoney(item.lineTotal), totalX + widths.total - 12, baseline, 10.5, bold, BLACK);

  page.drawLine({
    start: { x: ML, y: rowY },
    end: { x: MR, y: rowY },
    thickness: 0.45,
    color: BORDER,
  });

  return rowY;
}

function drawTableHeaderAndRows(page, fonts, brand, items, cursorY, pageState) {
  let y = cursorY;
  let startIndex = pageState.startIndex;
  let index = startIndex;

  while (index < items.length) {
    const header = drawTableHeader(page, fonts, brand, y);
    y = header.nextY;

    let rowsDrawn = 0;
    while (index < items.length) {
      const rowH = itemRowHeight(fonts.font, items[index], columnGeometry().widths.description);
      const minBottom = BOTTOM_MARGIN + FOOTER_H;
      if (y - rowH < minBottom) break;
      y = drawItemRow(page, fonts, items[index], index, y, rowH);
      index += 1;
      rowsDrawn += 1;
    }

    if (rowsDrawn === 0) {
      // One oversized row: draw it on the current page rather than looping forever.
      const rowH = Math.max(52, Math.min(150, itemRowHeight(fonts.font, items[index], columnGeometry().widths.description)));
      y = drawItemRow(page, fonts, items[index], index, y, rowH);
      index += 1;
    }

    if (index < items.length) {
      // Continuation page. The next page repeats the table header.
      return { nextPage: true, nextIndex: index, cursorY: y };
    }
  }

  return { nextPage: false, nextIndex: index, cursorY: y - 1 };
}

function drawTotals(page, fonts, brand, invoice, cursorY) {
  const { font, bold } = fonts;
  const width = 255;
  const x = MR - width;
  let y = cursorY - 12;

  page.drawText("Subtotal", { x, y, size: 10.5, font: bold, color: TEXT });
  drawRight(page, formatMoney(invoice.subtotal), MR, y, 10.5, font, TEXT);
  y -= 22;

  page.drawText("Tax", { x, y, size: 10.5, font: bold, color: TEXT });
  drawRight(page, formatMoney(invoice.tax), MR, y, 10.5, font, TEXT);
  y -= 27;

  const boxH = 50;
  const boxY = y - boxH;
  drawRounded(page, x, boxY, width, boxH, 9, { color: brand });
  page.drawText("Total", { x: x + 16, y: boxY + 17, size: 16, font: bold, color: WHITE });
  drawRight(page, formatMoney(invoice.total), MR - 16, boxY + 15, 17, bold, WHITE);

  return boxY - SECTION_GAP;
}

function bankingRows(client, invoice) {
  return [
    ["Account Name", client.bank_account_name],
    ["Bank Name", client.bank_name],
    ["Account Number", client.bank_account_number],
    ["Branch Code", client.bank_branch_code],
    ["Account Type", client.bank_account_type],
    ["Reference", client.bank_reference || (invoice.invoice_number ? `#${invoice.invoice_number}` : "")],
  ].filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== "");
}

function drawBankingAndPayment(page, fonts, brand, brandLight, client, invoice, cursorY) {
  const { font, bold } = fonts;
  const gap = 22;
  const paymentW = 185;
  const bankingW = CW - paymentW - gap;
  const rows = bankingRows(client, invoice);
  const rowH = 29;
  const headingH = 32;
  const sectionH = headingH + Math.max(3, Math.ceil(rows.length / 2)) * rowH + 10;
  const cardH = Math.max(112, sectionH);
  const top = cursorY;

  page.drawText("BANKING DETAILS", { x: ML, y: top - 10, size: 10.5, font: bold, color: brand });
  page.drawLine({ start: { x: ML, y: top - 20 }, end: { x: ML + bankingW, y: top - 20 }, thickness: 1.1, color: brand });

  const left = rows.filter((_, i) => i % 2 === 0);
  const right = rows.filter((_, i) => i % 2 === 1);
  const leftLabelX = ML;
  const leftValueX = ML + 92;
  const rightLabelX = ML + bankingW * 0.52;
  const rightValueX = ML + bankingW * 0.72;

  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const rowY = top - 48 - i * rowH;
    const leftRow = left[i];
    const rightRow = right[i];

    if (leftRow) {
      page.drawText(truncate(font, leftRow[0], 8.5, 84), { x: leftLabelX, y: rowY, size: 8.5, font, color: MUTED });
      page.drawText(truncate(bold, leftRow[1], 9.5, rightLabelX - leftValueX - 8), { x: leftValueX, y: rowY, size: 9.5, font: bold, color: BLACK });
    }
    if (rightRow) {
      page.drawText(truncate(font, rightRow[0], 8.5, rightValueX - rightLabelX - 8), { x: rightLabelX, y: rowY, size: 8.5, font, color: MUTED });
      page.drawText(truncate(bold, rightRow[1], 9.5, ML + bankingW - rightValueX), { x: rightValueX, y: rowY, size: 9.5, font: bold, color: BLACK });
    }
  }

  const paymentX = ML + bankingW + gap;
  const paymentY = top - cardH;
  drawRounded(page, paymentX, paymentY, paymentW, cardH, 9, {
    color: brandLight,
    borderColor: BORDER,
    borderWidth: 1,
  });

  page.drawText("PAYMENT TERMS", { x: paymentX + 16, y: top - 22, size: 9.5, font: bold, color: brand });
  let py = top - 46;
  const due = invoice.due_at ? fmtDate(invoice.due_at) : "—";
  page.drawText("Payment is due by", { x: paymentX + 16, y: py, size: 9.5, font, color: TEXT });
  py -= 15;
  page.drawText(`${due}.`, { x: paymentX + 16, y: py, size: 9.5, font, color: TEXT });
  py -= 25;

  const instructions = client.payment_instructions || "Thank you for your business!";
  const instructionLines = wrapText(font, instructions, 9.5, paymentW - 32);
  for (const line of instructionLines.slice(0, 5)) {
    page.drawText(line, { x: paymentX + 16, y: py, size: 9.5, font, color: MUTED });
    py -= 14;
  }

  return top - cardH - SECTION_GAP;
}

function drawFooter(page, fonts, brand, cursorY) {
  const { font, bold } = fonts;
  const lineY = Math.max(BOTTOM_MARGIN + 34, cursorY);
  page.drawLine({ start: { x: ML, y: lineY }, end: { x: MR, y: lineY }, thickness: 0.7, color: BORDER });

  const textY = lineY - 23;
  page.drawText("Thank you!", { x: ML, y: textY, size: 11, font: bold, color: brand });
  page.drawText("We appreciate your business.", { x: ML, y: textY - 16, size: 9.5, font, color: MUTED });

  const brandText = "My Grafix Media";
  const prefix = "Powered by ";
  const brandW = bold.widthOfTextAtSize(brandText, 9.5);
  const prefixW = font.widthOfTextAtSize(prefix, 9.5);
  page.drawText(prefix, { x: MR - prefixW - brandW, y: textY, size: 9.5, font, color: MUTED });
  page.drawText(brandText, { x: MR - brandW, y: textY, size: 9.5, font: bold, color: brand });
  drawRight(page, "Design. Build. Automate.", MR, textY - 16, 9.5, font, MUTED);
}

function drawTableContinuationLabel(page, fonts, brand, cursorY) {
  const { font } = fonts;
  page.drawText("Invoice — continued", { x: ML, y: cursorY, size: 8.5, font, color: MUTED });
  return cursorY - 14;
}

export async function generateInvoicePdf(client, invoice, lineItems, customer) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fonts = { font, bold };

  const brand = hexToRgb(client.primary_color) || rgb(0.45, 0.68, 0.16);
  const brandLight = lighten(client.primary_color);
  const items = normalizeItems(lineItems);
  const logo = await embedLogo(doc, client.logo_url);

  let page = createPage(doc);
  let cursorY = startY();

  cursorY = drawHeader(page, fonts, brand, client, invoice, logo, cursorY);
  cursorY -= SECTION_GAP;

  const partyHeight = calculatePartyCardHeight(font, bold, client, customer, (CW - 18) / 2);
  if (needsPage(cursorY, partyHeight + 70)) {
    page = createPage(doc);
    cursorY = startY();
  }
  cursorY = drawBillToFrom(page, fonts, brand, client, customer, cursorY);

  // At least one table header is always drawn. Empty invoices get a single placeholder row.
  const tableItems = items.length ? items : [{ description: "No items", quantity: 0, unitPrice: 0, lineTotal: 0 }];
  let index = 0;

  while (index < tableItems.length) {
    if (needsPage(cursorY, 90)) {
      page = createPage(doc);
      cursorY = startY();
      cursorY = drawTableContinuationLabel(page, fonts, brand, cursorY);
    }

    const result = drawTableHeaderAndRows(page, fonts, brand, tableItems, cursorY, { startIndex: index });
    cursorY = result.cursorY;
    index = result.nextIndex;

    if (result.nextPage) {
      page = createPage(doc);
      cursorY = startY();
      continue;
    }
  }

  // Final-page-only sections.
  const totalsRequired = 115;
  if (needsPage(cursorY, totalsRequired)) {
    page = createPage(doc);
    cursorY = startY();
  }
  cursorY = drawTotals(page, fonts, brand, invoice, cursorY);

  const rows = bankingRows(client, invoice);
  const bankingRequired = 32 + Math.max(3, Math.ceil(rows.length / 2)) * 29 + 25;
  if (needsPage(cursorY, bankingRequired + 15)) {
    page = createPage(doc);
    cursorY = startY();
  }
  cursorY = drawBankingAndPayment(page, fonts, brand, brandLight, client, invoice, cursorY);

  if (cursorY < BOTTOM_MARGIN + 34) {
    page = createPage(doc);
    cursorY = startY();
  }
  drawFooter(page, fonts, brand, cursorY);

  return doc.save();
}

export async function uploadInvoicePdf(env, clientId, invoiceNumber, pdfBytes) {
  const key = `clients/${clientId}/invoices/${invoiceNumber}.pdf`;
  await env.R2_BUCKET.put(key, pdfBytes, {
    httpMetadata: { contentType: "application/pdf" },
  });
  const baseUrl = (env.R2_PUBLIC_URL || "").replace(/\/$/, "");
  return `${baseUrl}/${key}`;
}

export function arrayBufferToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
