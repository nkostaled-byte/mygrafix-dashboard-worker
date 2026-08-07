/**
 * Invoice PDF Generation
 * =======================
 * Generates a PDF invoice using pdf-lib.
 * Uses the client's brand color (primary_color from Supabase) for theming.
 */

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import {
  PDF_PAGE_WIDTH,
  PDF_PAGE_HEIGHT,
  PDF_MARGIN,
  PDF_LINE_Y_THRESHOLD,
} from "../config/constants.js";
import { formatMoney } from "./utils.js";

const CHARCOAL = rgb(0.12, 0.16, 0.22);
const MUTED_COLOR = rgb(0.42, 0.45, 0.50);
const LINE_COLOR = rgb(0.90, 0.90, 0.92);
const WHITE = rgb(1, 1, 1);

/**
 * Parse a hex color string (#RRGGBB) into an RGB color. Returns null for invalid input.
 */
function hexToRgb(hex) {
  if (typeof hex !== "string") return null;
  const match = hex.trim().replace(/^#/, "").match(/^([0-9a-fA-F]{6})$/);
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return rgb(((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255);
}

/**
 * Lighten a hex color toward white by `amount` (0-1). Returns an RGB color.
 */
function lightenHex(hex, amount = 0.88) {
  const base = hexToRgb(hex);
  if (!base) return LINE_COLOR;
  const channel = (c) => c + (1 - c) * amount;
  return rgb(channel(base.red), channel(base.green), channel(base.blue));
}

/**
 * Draw a rounded rectangle (fill and/or border).
 */
function drawRoundedRect(page, x, topY, w, h, r, fill, border, borderWidth = 1) {
  const maxR = Math.min(r, w / 2, h / 2);
  const path =
    `M ${maxR} 0 ` +
    `L ${w - maxR} 0 ` +
    `Q ${w} 0 ${w} ${maxR} ` +
    `L ${w} ${h - maxR} ` +
    `Q ${w} ${h} ${w - maxR} ${h} ` +
    `L ${maxR} ${h} ` +
    `Q 0 ${h} 0 ${h - maxR} ` +
    `L 0 ${maxR} ` +
    `Q 0 0 ${maxR} 0 Z`;
  page.drawSvgPath(path, {
    x,
    y: topY,
    color: fill,
    borderColor: border,
    borderWidth: borderWidth,
  });
}

/**
 * Generate an invoice PDF as a Uint8Array.
 * @param {object} client - Client record
 * @param {object} invoice - Invoice record
 * @param {Array} lineItems - Invoice line items
 * @param {object} customer - Customer record
 * @returns {Promise<Uint8Array>} PDF bytes
 */
export async function generateInvoicePdf(client, invoice, lineItems, customer) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // Use client's brand color (primary_color from Supabase), fallback to charcoal
  const brand = hexToRgb(client.primary_color) || CHARCOAL;
  const brandLight = lightenHex(client.primary_color, 0.9);

  const contentLeft = PDF_MARGIN;
  const contentRight = PDF_PAGE_WIDTH - PDF_MARGIN;
  const contentWidth = contentRight - contentLeft;
  const colMid = contentLeft + contentWidth / 2;

  let y = PDF_PAGE_HEIGHT - 40;

  // ---- Header: logo + business name (left) | INVOICE + meta (right) ----
  const logoImage = await tryEmbedLogo(pdfDoc, client.logo_url);
  const logoSize = 40;
  const logoX = contentLeft;
  const logoY = y - logoSize;

  if (logoImage) {
    const logoWidth = Math.min((logoImage.width / logoImage.height) * logoSize, 120);
    page.drawImage(logoImage, {
      x: logoX,
      y: logoY,
      width: logoWidth,
      height: logoSize,
    });
  }

  // Business name next to logo
  const nameX = logoImage ? logoX + 130 : contentLeft;
  page.drawText(client.business_name || "", {
    x: nameX,
    y: y - 10,
    size: 16,
    font: boldFont,
    color: CHARCOAL,
  });

  // Contact lines below business name
  const contactLines = [client.address, client.phone, client.owner_email || client.reply_email].filter(Boolean);
  let cy = y - 24;
  for (const line of contactLines.slice(0, 3)) {
    if (cy < PDF_LINE_Y_THRESHOLD) break;
    page.drawText(line, {
      x: nameX,
      y: cy,
      size: 8.5,
      font,
      color: MUTED_COLOR,
    });
    cy -= 12;
  }

  // "INVOICE" title (right, brand color)
  const titleSize = 32;
  const titleWidth = boldFont.widthOfTextAtSize("INVOICE", titleSize);
  page.drawText("INVOICE", {
    x: contentRight - titleWidth,
    y: y - 10,
    size: titleSize,
    font: boldFont,
    color: brand,
  });

  // Meta row: Invoice No / Issued / Due (labels ABOVE values)
  const metaColW = 90;
  const metaItems = [
    { label: "Invoice No", value: `#${invoice.invoice_number || ""}` },
    { label: "Issued", value: formatDate(invoice.issued_at || invoice.created_at) },
    { label: "Due", value: invoice.due_at ? formatDate(invoice.due_at) : "—" },
  ];
  const metaLabelY = y - 24;
  const metaValueY = y - 38;
  metaItems.forEach((item, i) => {
    const colRight = contentRight - i * metaColW;
    const valW = boldFont.widthOfTextAtSize(item.value, 10);
    const labW = font.widthOfTextAtSize(item.label, 7.5);
    page.drawText(item.label, {
      x: colRight - labW,
      y: metaLabelY,
      size: 7.5,
      font,
      color: MUTED_COLOR,
    });
    page.drawText(item.value, {
      x: colRight - valW,
      y: metaValueY,
      size: 10,
      font: boldFont,
      color: brand,
    });
  });

  y -= 70;

  // ---- BILL TO / FROM cards (bordered boxes) ----
  const cardHeight = 75;
  const cardGap = 20;
  const cardWidth = (contentWidth - cardGap) / 2;

  // BILL TO card
  drawRoundedRect(page, contentLeft, y - cardHeight, cardWidth, cardHeight, 8, WHITE, LINE_COLOR, 1);
  page.drawText("BILL TO", {
    x: contentLeft + 12,
    y: y - 18,
    size: 9,
    font: boldFont,
    color: brand,
  });
  page.drawText(customer.name || "", {
    x: contentLeft + 12,
    y: y - 34,
    size: 12,
    font: boldFont,
    color: CHARCOAL,
  });
  page.drawText(customer.email || "", {
    x: contentLeft + 12,
    y: y - 50,
    size: 9,
    font,
    color: MUTED_COLOR,
  });

  // FROM card
  const fromX = colMid + cardGap / 2;
  drawRoundedRect(page, fromX, y - cardHeight, cardWidth, cardHeight, 8, WHITE, LINE_COLOR, 1);
  page.drawText("FROM", {
    x: fromX + 12,
    y: y - 18,
    size: 9,
    font: boldFont,
    color: brand,
  });
  page.drawText(client.business_name || "", {
    x: fromX + 12,
    y: y - 34,
    size: 12,
    font: boldFont,
    color: CHARCOAL,
  });
  const fromLines = [client.address, client.phone, client.owner_email || client.reply_email].filter(Boolean);
  let fy = y - 50;
  for (const line of fromLines.slice(0, 3)) {
    if (fy < y - cardHeight + 10) break;
    page.drawText(truncateText(font, line, 9, cardWidth - 24), {
      x: fromX + 12,
      y: fy,
      size: 9,
      font,
      color: MUTED_COLOR,
    });
    fy -= 12;
  }

  y -= cardHeight + 30;

  // ---- Item table ----
  const colDesc = contentLeft + 14;
  const colQtyRight = contentRight - 132;
  const colPriceRight = contentRight - 78;
  const colTotalRight = contentRight - 36;
  const headerH = 24;
  const radius = 6;

  // Header row (solid brand color, white text, rounded corners)
  drawRoundedRect(page, contentLeft, y, contentWidth, headerH, radius, brand);
  const headerTextY = y - 9;
  page.drawText("DESCRIPTION", {
    x: colDesc,
    y: headerTextY,
    size: 8.5,
    font: boldFont,
    color: WHITE,
  });
  drawRightInCell(page, boldFont, "QTY", colQtyRight, headerTextY, 8.5, WHITE);
  drawRightInCell(page, boldFont, "UNIT PRICE", colPriceRight, headerTextY, 8.5, WHITE);
  drawRightInCell(page, boldFont, "TOTAL", colTotalRight, headerTextY, 8.5, WHITE);
  y -= headerH + 8;

  // Item rows with subtle dividers
  const rowH = 26;
  for (let i = 0; i < lineItems.length; i++) {
    const item = lineItems[i];
    if (y < PDF_LINE_Y_THRESHOLD) break;
    const rowTop = y;
    page.drawText(truncateText(font, item.description || "", 9, 210), {
      x: colDesc,
      y: y + 8,
      size: 9,
      font,
      color: CHARCOAL,
    });
    drawRightInCell(page, font, String(item.quantity), colQtyRight, y + 8, 9, CHARCOAL);
    drawRightInCell(page, font, formatMoney(item.unit_price), colPriceRight, y + 8, 9, CHARCOAL);
    drawRightInCell(page, boldFont, formatMoney(item.line_total), colTotalRight, y + 8, 9, CHARCOAL);
    y -= rowH;

    if (i < lineItems.length - 1 && y > PDF_LINE_Y_THRESHOLD) {
      page.drawLine({
        start: { x: contentLeft + 14, y: rowTop - rowH },
        end: { x: contentRight - 14, y: rowTop - rowH },
        thickness: 0.5,
        color: LINE_COLOR,
      });
    }
  }

  y -= 14;

  // ---- Totals (bottom-right) ----
  const labelRight = contentRight - 150;
  const valueRight = contentRight;

  const rows = [];
  rows.push({ label: "Subtotal", value: formatMoney(invoice.subtotal) });
  rows.push({ label: "Tax", value: formatMoney(invoice.tax) });
  if (typeof invoice.discount === "number" && invoice.discount > 0) {
    rows.push({ label: "Discount", value: `-${formatMoney(invoice.discount)}` });
  }

  for (const row of rows) {
    y -= 17;
    drawRightInCell(page, font, row.label, labelRight, y, 10, MUTED_COLOR);
    drawRightInCell(page, font, row.value, valueRight, y, 10, CHARCOAL);
  }

  // Grand total box (filled brand color, white text, rounded)
  y -= 26;
  const totalBoxW = 190;
  const totalBoxH = 36;
  const totalText = `Total   ${formatMoney(invoice.total)}`;
  drawRoundedRect(page, contentRight - totalBoxW, y, totalBoxW, totalBoxH, radius, brand);
  const totalTextWidth = boldFont.widthOfTextAtSize(totalText, 12);
  page.drawText(totalText, {
    x: contentRight - totalBoxW + (totalBoxW - totalTextWidth) / 2,
    y: y - totalBoxH + (totalBoxH - 12) / 2 + 3,
    size: 12,
    font: boldFont,
    color: WHITE,
  });

  y -= totalBoxH + 30;

  // ---- Banking details (2-column grid) ----
  const bankLeft = [
    client.bank_account_name ? { label: "Account Name", value: client.bank_account_name } : null,
    client.bank_name ? { label: "Bank Name", value: client.bank_name } : null,
    client.bank_account_number ? { label: "Account Number", value: client.bank_account_number } : null,
  ].filter(Boolean);
  const bankRight = [
    client.bank_branch_code ? { label: "Branch Code", value: client.bank_branch_code } : null,
    client.bank_account_type ? { label: "Account Type", value: client.bank_account_type } : null,
    { label: "Reference", value: client.bank_reference || `Invoice #${invoice.invoice_number || ""}` },
  ].filter(Boolean);

  const hasBanking = bankLeft.length > 0 || bankRight.length > 0;
  if (hasBanking) {
    page.drawText("BANKING DETAILS", {
      x: contentLeft,
      y,
      size: 9,
      font: boldFont,
      color: brand,
    });
    y -= 4;
    page.drawLine({
      start: { x: contentLeft, y },
      end: { x: contentLeft + 180, y },
      thickness: 1.5,
      color: brand,
    });
    y -= 18;

    const rowCount = Math.max(bankLeft.length, bankRight.length);
    const bankRowGap = 30;
    for (let i = 0; i < rowCount; i++) {
      if (y < PDF_LINE_Y_THRESHOLD) break;
      if (bankLeft[i]) {
        page.drawText(bankLeft[i].label, {
          x: contentLeft,
          y,
          size: 8,
          font,
          color: MUTED_COLOR,
        });
        page.drawText(truncateText(font, bankLeft[i].value, 10, contentWidth / 2 - 40), {
          x: contentLeft,
          y: y - 13,
          size: 10,
          font: boldFont,
          color: CHARCOAL,
        });
      }
      if (bankRight[i]) {
        page.drawText(bankRight[i].label, {
          x: colMid,
          y,
          size: 8,
          font,
          color: MUTED_COLOR,
        });
        page.drawText(truncateText(font, bankRight[i].value, 10, contentWidth / 2 - 40), {
          x: colMid,
          y: y - 13,
          size: 10,
          font: boldFont,
          color: CHARCOAL,
        });
      }
      y -= bankRowGap;
    }
    y -= 12;
  }

  // ---- Payment terms card (right side, text INSIDE card) ----
  const termsCardW = 200;
  const termsCardH = 80;
  const termsX = contentRight - termsCardW;
  const termsY = y - termsCardH;

  drawRoundedRect(page, termsX, termsY, termsCardW, termsCardH, 8, brandLight, LINE_COLOR, 1);

  page.drawText("PAYMENT TERMS", {
    x: termsX + 12,
    y: y - 18,
    size: 9,
    font: boldFont,
    color: brand,
  });

  let ty = y - 32;
  if (invoice.due_at) {
    page.drawText(`Payment is due by ${formatDate(invoice.due_at)}.`, {
      x: termsX + 12,
      y: ty,
      size: 9,
      font,
      color: CHARCOAL,
    });
    ty -= 14;
  }
  if (client.payment_instructions) {
    const wrapped = wrapText(font, client.payment_instructions, 8.5, termsCardW - 24);
    for (const line of wrapped.slice(0, 3)) {
      if (ty < termsY + 10) break;
      page.drawText(line, {
        x: termsX + 12,
        y: ty,
        size: 8.5,
        font,
        color: MUTED_COLOR,
      });
      ty -= 12;
    }
  }
  y = termsY - 20;

  // ---- Footer ----
  const footerLineY = 60;
  page.drawLine({
    start: { x: contentLeft, y: footerLineY },
    end: { x: contentRight, y: footerLineY },
    thickness: 0.75,
    color: LINE_COLOR,
  });

  // "Thank you!" left
  page.drawText("Thank you!", {
    x: contentLeft,
    y: footerLineY - 18,
    size: 10,
    font: boldFont,
    color: brand,
  });
  page.drawText("We appreciate your business.", {
    x: contentLeft,
    y: footerLineY - 32,
    size: 9,
    font,
    color: MUTED_COLOR,
  });

  // "Powered by My Grafix Media" right
  const poweredText = "Powered by My Grafix Media";
  const poweredWidth = font.widthOfTextAtSize(poweredText, 9);
  page.drawText(poweredText, {
    x: contentRight - poweredWidth,
    y: footerLineY - 18,
    size: 9,
    font,
    color: MUTED_COLOR,
  });
  const taglineText = "Design. Build. Automate.";
  const taglineWidth = font.widthOfTextAtSize(taglineText, 8.5);
  page.drawText(taglineText, {
    x: contentRight - taglineWidth,
    y: footerLineY - 32,
    size: 8.5,
    font,
    color: MUTED_COLOR,
  });

  return pdfDoc.save();
}

function formatDate(value) {
  try {
    return new Date(value).toLocaleDateString();
  } catch {
    return "";
  }
}

/**
 * Try to fetch and embed a logo image (PNG or JPEG).
 * Never throws — returns null on any failure.
 */
async function tryEmbedLogo(pdfDoc, logoUrl) {
  if (!logoUrl) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(logoUrl, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const contentType = response.headers.get("Content-Type") || "";
    const bytes = new Uint8Array(await response.arrayBuffer());

    if (contentType.includes("png") || logoUrl.toLowerCase().endsWith(".png")) {
      return await pdfDoc.embedPng(bytes);
    }
    if (contentType.includes("jpeg") || contentType.includes("jpg") || /\.jpe?g$/i.test(logoUrl)) {
      return await pdfDoc.embedJpg(bytes);
    }
    return null;
  } catch {
    return null;
  }
}

function truncateText(font, text, size, maxWidth) {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let result = text;
  while (result.length > 1 && font.widthOfTextAtSize(result + "\u2026", size) > maxWidth) {
    result = result.slice(0, -1);
  }
  return result + "\u2026";
}

function drawRightInCell(page, drawFont, text, rightX, y, size, color) {
  const width = drawFont.widthOfTextAtSize(text, size);
  page.drawText(text, {
    x: rightX - width,
    y,
    size,
    font: drawFont,
    color,
  });
}

function wrapText(font, text, size, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Upload a PDF to R2 and return the public URL.
 */
export async function uploadInvoicePdf(env, clientId, invoiceNumber, pdfBytes) {
  const key = `clients/${clientId}/invoices/${invoiceNumber}.pdf`;
  await env.R2_BUCKET.put(key, pdfBytes, {
    httpMetadata: { contentType: "application/pdf" },
  });
  const baseUrl = (env.R2_PUBLIC_URL || "").replace(/\/$/, "");
  return `${baseUrl}/${key}`;
}

/**
 * Convert an ArrayBuffer to a base64 string.
 */
export function arrayBufferToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
