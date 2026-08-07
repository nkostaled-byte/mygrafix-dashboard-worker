/**
 * Invoice PDF Generator
 *
 * A4 invoice template built around one coordinate convention:
 * every section receives its TOP Y coordinate and returns its BOTTOM Y.
 * This prevents the overlap/alignment problems caused by mixing top/bottom
 * coordinate assumptions in pdf-lib.
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
const LEFT = PDF_MARGIN;
const RIGHT = PAGE_W - PDF_MARGIN;
const CONTENT_W = RIGHT - LEFT;

const COLORS = {
  black: rgb(0.08, 0.09, 0.11),
  text: rgb(0.16, 0.17, 0.19),
  muted: rgb(0.42, 0.43, 0.45),
  light: rgb(0.84, 0.85, 0.86),
  lighter: rgb(0.95, 0.95, 0.96),
  white: rgb(1, 1, 1),
};

const S = {
  pageTop: 40,
  pageBottom: 38,
  section: 18,
  xs: 5,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
};

const F = {
  xs: 8,
  sm: 9,
  body: 10,
  bodyLg: 11,
  heading: 14,
  title: 36,
};

function hexToRgb(hex) {
  if (!hex || typeof hex !== "string") return null;
  const match = hex.trim().replace(/^#/, "").match(/^([0-9a-fA-F]{6})$/);
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return rgb(
    ((value >> 16) & 0xff) / 255,
    ((value >> 8) & 0xff) / 255,
    (value & 0xff) / 255
  );
}

function lighten(hex, amount = 0.92) {
  const base = hexToRgb(hex);
  if (!base) return COLORS.lighter;
  const mix = (channel) => channel + (1 - channel) * amount;
  return rgb(mix(base.red), mix(base.green), mix(base.blue));
}

function drawRoundedRect(page, x, y, width, height, radius, fill, border = null, borderWidth = 1) {
  const r = Math.min(radius, width / 2, height / 2);
  const path =
    `M ${r} 0 ` +
    `L ${width - r} 0 ` +
    `Q ${width} 0 ${width} ${r} ` +
    `L ${width} ${height - r} ` +
    `Q ${width} ${height} ${width - r} ${height} ` +
    `L ${r} ${height} ` +
    `Q 0 ${height} 0 ${height - r} ` +
    `L 0 ${r} ` +
    `Q 0 0 ${r} 0 Z`;

  const options = { x, y, color: fill };
  if (border) {
    options.borderColor = border;
    options.borderWidth = borderWidth;
  }
  page.drawSvgPath(path, options);
}

function drawRight(page, text, rightX, baselineY, size, font, color) {
  const value = String(text ?? "");
  const width = font.widthOfTextAtSize(value, size);
  page.drawText(value, { x: rightX - width, y: baselineY, size, font, color });
}

function truncate(font, value, size, maxWidth) {
  const text = String(value ?? "");
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let result = text;
  while (result.length > 1 && font.widthOfTextAtSize(`${result}…`, size) > maxWidth) {
    result = result.slice(0, -1);
  }
  return `${result}…`;
}

function wrapText(font, value, size, maxWidth) {
  const text = String(value ?? "").trim();
  if (!text) return [];

  const words = text.split(/\s+/);
  const lines = [];
  let line = "";

  for (const word of words) {
    // Handle a single word wider than the column.
    if (font.widthOfTextAtSize(word, size) > maxWidth) {
      if (line) {
        lines.push(line);
        line = "";
      }
      let chunk = "";
      for (const char of word) {
        const candidate = chunk + char;
        if (font.widthOfTextAtSize(candidate, size) > maxWidth && chunk) {
          lines.push(chunk);
          chunk = char;
        } else {
          chunk = candidate;
        }
      }
      if (chunk) line = chunk;
      continue;
    }

    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }

  if (line) lines.push(line);
  return lines;
}

function fmtDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-ZA", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
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

    const contentType = response.headers.get("Content-Type") || "";
    const bytes = new Uint8Array(await response.arrayBuffer());

    if (contentType.includes("png") || /\.png$/i.test(url)) {
      return await doc.embedPng(bytes);
    }
    if (contentType.includes("jpeg") || contentType.includes("jpg") || /\.jpe?g$/i.test(url)) {
      return await doc.embedJpg(bytes);
    }
  } catch {
    // A missing logo must never prevent invoice generation.
  }
  return null;
}

function drawWrapped(page, lines, x, firstBaselineY, size, lineHeight, font, color) {
  lines.forEach((line, index) => {
    page.drawText(line, {
      x,
      y: firstBaselineY - index * lineHeight,
      size,
      font,
      color,
    });
  });
}

function drawHeader(page, font, bold, brand, logo, client, invoice, topY) {
  const logoBoxW = 74;
  const logoBoxH = 58;
  const leftInfoX = LEFT + logoBoxW + 16;
  const rightAreaX = LEFT + CONTENT_W * 0.62;
  const titleY = topY - 2;

  if (logo) {
    const ratio = logo.width / Math.max(logo.height, 1);
    const height = Math.min(logoBoxH, 58);
    const width = Math.min(ratio * height, logoBoxW);
    page.drawImage(logo, {
      x: LEFT + (logoBoxW - width) / 2,
      y: topY - height,
      width,
      height,
    });
  }

  page.drawLine({
    start: { x: LEFT + logoBoxW + 7, y: topY - 2 },
    end: { x: LEFT + logoBoxW + 7, y: topY - 60 },
    thickness: 0.8,
    color: COLORS.light,
  });

  page.drawText(client.business_name || "", {
    x: leftInfoX,
    y: topY - 12,
    size: 18,
    font: bold,
    color: COLORS.black,
  });

  const contacts = [client.address, client.phone, client.owner_email || client.reply_email]
    .filter(Boolean)
    .slice(0, 3);

  let contactY = topY - 31;
  for (const line of contacts) {
    const lines = wrapText(font, line, F.body, rightAreaX - leftInfoX - 8).slice(0, 2);
    drawWrapped(page, lines, leftInfoX, contactY, F.body, 12, font, COLORS.text);
    contactY -= Math.max(12, lines.length * 12);
  }

  const title = "INVOICE";
  const titleWidth = bold.widthOfTextAtSize(title, F.title);
  page.drawText(title, {
    x: RIGHT - titleWidth,
    y: titleY - F.title,
    size: F.title,
    font: bold,
    color: brand,
  });

  const metaTop = topY - 62;
  const metaStart = rightAreaX;
  const metaWidth = RIGHT - metaStart;
  const colWidth = metaWidth / 3;
  const meta = [
    ["Invoice No", `#${invoice.invoice_number || ""}`],
    ["Issued", fmtDate(invoice.issued_at || invoice.created_at)],
    ["Due", fmtDate(invoice.due_at)],
  ];

  meta.forEach(([label, value], index) => {
    const x = metaStart + index * colWidth;
    if (index > 0) {
      page.drawLine({
        start: { x: x - 8, y: metaTop + 3 },
        end: { x: x - 8, y: metaTop - 28 },
        thickness: 0.6,
        color: COLORS.light,
      });
    }
    page.drawText(label, {
      x,
      y: metaTop,
      size: F.sm,
      font,
      color: COLORS.muted,
    });
    page.drawText(truncate(bold, value, F.body, colWidth - 8), {
      x,
      y: metaTop - 16,
      size: F.body,
      font: bold,
      color: brand,
    });
  });

  const bottomY = topY - 90;
  page.drawLine({
    start: { x: LEFT, y: bottomY },
    end: { x: RIGHT, y: bottomY },
    thickness: 0.8,
    color: COLORS.light,
  });

  return bottomY;
}

function drawPartyCards(page, font, bold, brand, client, customer, topY) {
  const gap = 18;
  const cardW = (CONTENT_W - gap) / 2;
  const cardH = 104;
  const bottomY = topY - cardH;

  const cards = [
    {
      x: LEFT,
      label: "BILL TO",
      name: customer?.name || "",
      lines: [customer?.email].filter(Boolean),
    },
    {
      x: LEFT + cardW + gap,
      label: "FROM",
      name: client.business_name || "",
      lines: [client.address, client.phone, client.owner_email || client.reply_email].filter(Boolean),
    },
  ];

  for (const card of cards) {
    drawRoundedRect(page, card.x, bottomY, cardW, cardH, 9, COLORS.white, COLORS.light, 1);

    const x = card.x + 16;
    const contentTop = topY - 17;
    page.drawText(card.label, {
      x,
      y: contentTop,
      size: F.body,
      font: bold,
      color: brand,
    });

    page.drawText(truncate(bold, card.name, F.heading, cardW - 32), {
      x,
      y: contentTop - 23,
      size: F.heading,
      font: bold,
      color: COLORS.black,
    });

    let lineY = contentTop - 42;
    for (const value of card.lines) {
      const lines = wrapText(font, value, F.body, cardW - 32).slice(0, 2);
      drawWrapped(page, lines, x, lineY, F.body, 12, font, COLORS.muted);
      lineY -= Math.max(12, lines.length * 12);
    }
  }

  return bottomY;
}

function tableColumns() {
  const descW = CONTENT_W * 0.50;
  const qtyW = CONTENT_W * 0.11;
  const priceW = CONTENT_W * 0.19;
  const totalW = CONTENT_W - descW - qtyW - priceW;

  const descX = LEFT + 14;
  const qtyX = descX + descW;
  const priceX = qtyX + qtyW;
  const totalX = priceX + priceW;

  return { descW, qtyW, priceW, totalW, descX, qtyX, priceX, totalX };
}

function itemRowHeight(font, item, columns) {
  const lines = wrapText(font, item.description || "", F.bodyLg, columns.descW - 28);
  return Math.max(38, 18 + Math.max(1, lines.length) * 14);
}

function drawTableHeader(page, bold, brand, topY) {
  const height = 34;
  const bottomY = topY - height;
  drawRoundedRect(page, LEFT, bottomY, CONTENT_W, height, 8, brand);

  const c = tableColumns();
  const baseline = bottomY + 11;

  page.drawText("DESCRIPTION", {
    x: c.descX,
    y: baseline,
    size: F.body,
    font: bold,
    color: COLORS.white,
  });
  page.drawText("QTY", {
    x: c.qtyX + 8,
    y: baseline,
    size: F.body,
    font: bold,
    color: COLORS.white,
  });
  page.drawText("UNIT PRICE", {
    x: c.priceX + 7,
    y: baseline,
    size: F.body,
    font: bold,
    color: COLORS.white,
  });
  drawRight(page, "TOTAL", RIGHT - 12, baseline, F.body, bold, COLORS.white);

  return bottomY;
}

function drawTableRow(page, font, bold, item, index, topY) {
  const c = tableColumns();
  const height = itemRowHeight(font, item, c);
  const bottomY = topY - height;

  if (index % 2 === 1) {
    page.drawRectangle({
      x: LEFT,
      y: bottomY,
      width: CONTENT_W,
      height,
      color: COLORS.lighter,
    });
  }

  const lines = wrapText(font, item.description || "", F.bodyLg, c.descW - 28);
  const firstBaseline = topY - 14;

  drawWrapped(page, lines, c.descX, firstBaseline, F.bodyLg, 14, font, COLORS.text);
  page.drawText(String(item.quantity ?? ""), {
    x: c.qtyX + 8,
    y: firstBaseline,
    size: F.bodyLg,
    font,
    color: COLORS.text,
  });
  page.drawText(formatMoney(item.unit_price), {
    x: c.priceX + 7,
    y: firstBaseline,
    size: F.bodyLg,
    font,
    color: COLORS.text,
  });
  drawRight(page, formatMoney(item.line_total), RIGHT - 12, firstBaseline, F.bodyLg, bold, COLORS.black);

  page.drawLine({
    start: { x: LEFT, y: bottomY },
    end: { x: RIGHT, y: bottomY },
    thickness: 0.6,
    color: COLORS.light,
  });

  return bottomY;
}

function drawTotals(page, font, bold, brand, invoice, topY) {
  const width = 245;
  const x = RIGHT - width;
  let y = topY;

  page.drawText("Subtotal", { x, y, size: F.bodyLg, font, color: COLORS.text });
  drawRight(page, formatMoney(invoice.subtotal), RIGHT, y, F.bodyLg, font, COLORS.text);
  y -= 20;

  page.drawText("Tax", { x, y, size: F.bodyLg, font, color: COLORS.text });
  drawRight(page, formatMoney(invoice.tax), RIGHT, y, F.bodyLg, font, COLORS.text);
  y -= 18;

  page.drawLine({
    start: { x, y: y + 4 },
    end: { x: RIGHT, y: y + 4 },
    thickness: 0.8,
    color: COLORS.light,
  });
  y -= 12;

  const boxH = 50;
  const boxBottom = y - boxH;
  drawRoundedRect(page, x, boxBottom, width, boxH, 9, brand);
  page.drawText("Total", {
    x: x + 16,
    y: boxBottom + 17,
    size: 16,
    font: bold,
    color: COLORS.white,
  });
  drawRight(page, formatMoney(invoice.total), RIGHT - 16, boxBottom + 15, 17, bold, COLORS.white);

  return boxBottom;
}

function bankEntries(client, invoice) {
  return [
    [
      client.bank_account_name ? { label: "Account Name", value: client.bank_account_name } : null,
      client.bank_name ? { label: "Bank Name", value: client.bank_name } : null,
      client.bank_account_number ? { label: "Account Number", value: client.bank_account_number } : null,
    ].filter(Boolean),
    [
      client.bank_branch_code ? { label: "Branch Code", value: client.bank_branch_code } : null,
      client.bank_account_type ? { label: "Account Type", value: client.bank_account_type } : null,
      { label: "Reference", value: client.bank_reference || `#${invoice.invoice_number || ""}` },
    ].filter(Boolean),
  ];
}

function drawBankingAndTerms(page, font, bold, brand, brandLight, client, invoice, topY) {
  const gap = 22;
  const termsW = Math.min(190, CONTENT_W * 0.32);
  const bankW = CONTENT_W - termsW - gap;
  const termsX = RIGHT - termsW;
  const bankX = LEFT;

  const [bankLeft, bankRight] = bankEntries(client, invoice);
  const maxRows = Math.max(bankLeft.length, bankRight.length, 1);
  const rowHeight = 27;
  const bankTitleH = 28;
  const bankH = bankTitleH + maxRows * rowHeight + 8;

  const paymentLines = [];
  if (invoice.due_at) paymentLines.push(`Payment is due by ${fmtDate(invoice.due_at)}.`);
  if (client.payment_instructions) {
    paymentLines.push(...wrapText(font, client.payment_instructions, F.body, termsW - 28));
  }
  if (!paymentLines.length) paymentLines.push("Thank you for your business!");

  const termsH = Math.max(104, 36 + paymentLines.length * 14 + 22);
  const sectionH = Math.max(bankH, termsH);
  const sectionBottom = topY - sectionH;

  // Banking details title and rule.
  page.drawText("BANKING DETAILS", {
    x: bankX,
    y: topY - 10,
    size: F.body,
    font: bold,
    color: brand,
  });
  page.drawLine({
    start: { x: bankX, y: topY - 22 },
    end: { x: bankX + bankW, y: topY - 22 },
    thickness: 1.1,
    color: brand,
  });

  const leftLabelX = bankX;
  const leftValueX = bankX + bankW * 0.28;
  const rightLabelX = bankX + bankW * 0.62;
  const rightValueX = bankX + bankW * 0.82;
  const rowTop = topY - 43;

  for (let i = 0; i < maxRows; i++) {
    const y = rowTop - i * rowHeight;
    const left = bankLeft[i];
    const right = bankRight[i];

    if (left) {
      page.drawText(left.label, { x: leftLabelX, y, size: F.sm, font, color: COLORS.muted });
      page.drawText(truncate(bold, left.value, F.bodyLg, bankW * 0.31), {
        x: leftValueX,
        y,
        size: F.bodyLg,
        font: bold,
        color: COLORS.black,
      });
    }

    if (right) {
      page.drawText(right.label, { x: rightLabelX, y, size: F.sm, font, color: COLORS.muted });
      page.drawText(truncate(bold, right.value, F.bodyLg, bankW * 0.18), {
        x: rightValueX,
        y,
        size: F.bodyLg,
        font: bold,
        color: COLORS.black,
      });
    }
  }

  // Payment terms card is aligned to the SAME top edge as banking details.
  drawRoundedRect(page, termsX, topY - termsH, termsW, termsH, 10, brandLight, COLORS.light, 1);
  const px = termsX + 14;
  page.drawText("PAYMENT TERMS", {
    x: px,
    y: topY - 20,
    size: F.body,
    font: bold,
    color: brand,
  });

  let py = topY - 40;
  for (const line of paymentLines.slice(0, 6)) {
    page.drawText(truncate(font, line, F.body, termsW - 28), {
      x: px,
      y: py,
      size: F.body,
      font,
      color: COLORS.text,
    });
    py -= 14;
  }

  return sectionBottom;
}

function drawFooter(page, font, bold, brand, topY) {
  const dividerY = topY - 4;
  page.drawLine({
    start: { x: LEFT, y: dividerY },
    end: { x: RIGHT, y: dividerY },
    thickness: 0.8,
    color: COLORS.light,
  });

  const baseline = dividerY - 23;
  page.drawText("Thank you!", {
    x: LEFT,
    y: baseline,
    size: 12,
    font: bold,
    color: brand,
  });
  page.drawText("We appreciate your business.", {
    x: LEFT,
    y: baseline - 17,
    size: F.body,
    font,
    color: COLORS.muted,
  });

  const tag = "Design. Build. Automate.";
  const powered = "Powered by ";
  const company = "My Grafix Media";
  const tagW = font.widthOfTextAtSize(tag, F.body);
  const companyW = bold.widthOfTextAtSize(company, F.body);
  const poweredW = font.widthOfTextAtSize(powered, F.body);
  const rightX = RIGHT;

  page.drawText(powered, {
    x: rightX - companyW - poweredW,
    y: baseline,
    size: F.body,
    font,
    color: COLORS.muted,
  });
  page.drawText(company, {
    x: rightX - companyW,
    y: baseline,
    size: F.body,
    font: bold,
    color: brand,
  });
  page.drawText(tag, {
    x: rightX - tagW,
    y: baseline - 17,
    size: F.body,
    font,
    color: COLORS.muted,
  });
}

export async function generateInvoicePdf(client, invoice, lineItems, customer) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const brand = hexToRgb(client.primary_color) || rgb(0.42, 0.56, 0.14);
  const brandLight = lighten(client.primary_color, 0.92);
  const logo = await embedLogo(doc, client.logo_url);

  const items = Array.isArray(lineItems) ? lineItems : [];
  let page = doc.addPage([PAGE_W, PAGE_H]);
  let cursorY = PAGE_H - S.pageTop;

  // Header is intentionally only drawn once. Continuation pages get a compact
  // table header instead of repeating the full invoice header.
  cursorY = drawHeader(page, font, bold, brand, logo, client, invoice, cursorY);
  cursorY -= S.section;

  cursorY = drawPartyCards(page, font, bold, brand, client, customer || {}, cursorY);
  cursorY -= S.section;

  // Table header + rows. The table is the only section allowed to span pages.
  cursorY = drawTableHeader(page, bold, brand, cursorY);
  cursorY -= 2; // 2px gap after header

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const rowH = itemRowHeight(font, item, tableColumns());

    // Leave enough room for at least one row. If there isn't, start a new page
    // and repeat only the table header.
    if (cursorY - rowH < S.pageBottom + 18) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      cursorY = PAGE_H - S.pageTop;
      cursorY = drawTableHeader(page, bold, brand, cursorY);
    }

    cursorY = drawTableRow(page, font, bold, item, i, cursorY);
  }

  cursorY -= S.section;

  // Keep totals together. If the current page is too full, move totals to a
  // clean page rather than allowing them to collide with the table/footer.
  const totalsHeight = 20 + 20 + 18 + 12 + 50;
  if (cursorY - totalsHeight < S.pageBottom + 20) {
    page = doc.addPage([PAGE_W, PAGE_H]);
    cursorY = PAGE_H - S.pageTop;
  }
  cursorY = drawTotals(page, font, bold, brand, invoice, cursorY);
  cursorY -= S.section + 4;

  // Banking + payment terms stay on the same top edge and are treated as one
  // section so neither can push the other out of alignment.
  const bottomSectionEstimate = 125;
  const footerEstimate = 52;
  if (cursorY - bottomSectionEstimate - footerEstimate < S.pageBottom) {
    page = doc.addPage([PAGE_W, PAGE_H]);
    cursorY = PAGE_H - S.pageTop;
  }

  cursorY = drawBankingAndTerms(page, font, bold, brand, brandLight, client, invoice, cursorY);
  cursorY -= S.section;

  // Footer follows the bottom of the real content. If the content happened to
  // consume too much space, move it to a fresh page instead of overlapping.
  if (cursorY - 52 < S.pageBottom) {
    page = doc.addPage([PAGE_W, PAGE_H]);
    cursorY = PAGE_H - S.pageTop;
  }
  drawFooter(page, font, bold, brand, cursorY);

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
