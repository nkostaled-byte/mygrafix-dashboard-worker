/**
 * Invoice PDF Generation
 * =======================
 * Generates a PDF invoice using pdf-lib.
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
 * Used for the "light brand tint" table header.
 */
function lightenHex(hex, amount = 0.88) {
  const base = hexToRgb(hex);
  if (!base) return LINE_COLOR;
  const channel = (c) => c + (1 - c) * amount;
  return rgb(channel(base.red), channel(base.green), channel(base.blue));
}

/**
 * Draw a rounded rectangle (fill and/or border).
 * Coordinates are in pdf-lib space (origin bottom-left, y up).
 * @param {object} page - pdf-lib page
 * @param {number} x - left
 * @param {number} topY - top edge (page y from bottom)
 * @param {number} w - width
 * @param {number} h - height
 * @param {number} r - corner radius
 * @param {object} [fill] - RGB fill color
 * @param {object} [border] - RGB border color
 * @param {number} [borderWidth] - border thickness
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
 * Premium A4 layout using the client's brand colour + logo.
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

  const brand = hexToRgb(client.primary_color) || CHARCOAL;
  const brandTint = lightenHex(client.primary_color, 0.9);

  const contentLeft = PDF_MARGIN;
  const contentRight = PDF_PAGE_WIDTH - PDF_MARGIN;
  const contentWidth = contentRight - contentLeft;
  const colMid = contentLeft + contentWidth / 2;
  const white = rgb(1, 1, 1);

  // ---- Top accent bar (brand colour) ----
  page.drawRectangle({
    x: 0,
    y: PDF_PAGE_HEIGHT - 7,
    width: PDF_PAGE_WIDTH,
    height: 7,
    color: brand,
  });

  let y = PDF_PAGE_HEIGHT - 38;

  // ---- Header: logo (left) + business name + contact ----
  const logoImage = await tryEmbedLogo(pdfDoc, client.logo_url);
  let nameY = y;
  if (logoImage) {
    const logoHeight = 40;
    const logoWidth = Math.min((logoImage.width / logoImage.height) * logoHeight, 150);
    page.drawImage(logoImage, {
      x: contentLeft,
      y: y - logoHeight,
      width: logoWidth,
      height: logoHeight,
    });
    nameY = y - logoHeight - 14;
  }

  page.drawText(client.business_name || "", {
    x: contentLeft,
    y: nameY,
    size: 16,
    font: boldFont,
    color: CHARCOAL,
  });

  const contactLines = [client.address, client.phone, client.owner_email || client.reply_email].filter(Boolean);
  if (contactLines.length) {
    const wrapped = wrapText(font, contactLines.join("  ·  "), 8.5, contentWidth * 0.55);
    let cy = nameY - 16;
    for (const line of wrapped.slice(0, 2)) {
      page.drawText(line, {
        x: contentLeft,
        y: cy,
        size: 8.5,
        font,
        color: MUTED_COLOR,
      });
      cy -= 12;
    }
  }

  // ---- "INVOICE" title (right, brand colour) ----
  const titleSize = 30;
  const titleWidth = boldFont.widthOfTextAtSize("INVOICE", titleSize);
  page.drawText("INVOICE", {
    x: contentRight - titleWidth,
    y: y - 6,
    size: titleSize,
    font: boldFont,
    color: brand,
  });

  // ---- Meta row (Invoice No / Issued / Due) — fixed columns, right aligned ----
  const metaColW = 92;
  const metaItems = [
    { label: "Invoice No", value: `#${invoice.invoice_number || ""}` },
    { label: "Issued", value: formatDate(invoice.issued_at || invoice.created_at) },
    { label: "Due", value: invoice.due_at ? formatDate(invoice.due_at) : "—" },
  ];
  const metaValueY = y - 34;
  const metaLabelY = y - 46;
  metaItems.forEach((item, i) => {
    const colRight = contentRight - i * metaColW;
    const valW = boldFont.widthOfTextAtSize(item.value, 10);
    const labW = font.widthOfTextAtSize(item.label, 7.5);
    page.drawText(item.value, {
      x: colRight - valW,
      y: metaValueY,
      size: 10,
      font: boldFont,
      color: CHARCOAL,
    });
    page.drawText(item.label, {
      x: colRight - labW,
      y: metaLabelY,
      size: 7.5,
      font,
      color: MUTED_COLOR,
    });
  });

  y -= 78;

  // ---- Soft grey divider ----
  page.drawLine({
    start: { x: contentLeft, y },
    end: { x: contentRight, y },
    thickness: 0.75,
    color: LINE_COLOR,
  });
  y -= 32;

  // ---- Bill To (left) / From (right) — aligned two-column ----
  const headingSize = 9;
  page.drawText("BILL TO", {
    x: contentLeft,
    y,
    size: headingSize,
    font: boldFont,
    color: brand,
  });
  page.drawText("FROM", {
    x: colMid,
    y,
    size: headingSize,
    font: boldFont,
    color: brand,
  });
  y -= 18;

  page.drawText(customer.name || "", {
    x: contentLeft,
    y,
    size: 11,
    font: boldFont,
    color: CHARCOAL,
  });
  page.drawText(client.business_name || "", {
    x: colMid,
    y,
    size: 11,
    font: boldFont,
    color: CHARCOAL,
  });
  y -= 16;

  const billToLines = [customer.email, customer.phone].filter(Boolean);
  const fromLines = [client.address, client.phone, client.owner_email || client.reply_email].filter(Boolean);
  let by = y;
  for (const line of billToLines.slice(0, 3)) {
    if (by < PDF_LINE_Y_THRESHOLD) break;
    page.drawText(line, {
      x: contentLeft,
      y: by,
      size: 9,
      font,
      color: MUTED_COLOR,
    });
    by -= 13;
  }
  let fy = y;
  for (const line of fromLines.slice(0, 3)) {
    if (fy < PDF_LINE_Y_THRESHOLD) break;
    page.drawText(truncateText(font, line, 9, contentWidth / 2 - 24), {
      x: colMid,
      y: fy,
      size: 9,
      font,
      color: MUTED_COLOR,
    });
    fy -= 13;
  }

  const bottom = Math.min(by, fy);
  y = bottom - 34;

  // ---- Item table ----
  const colDesc = contentLeft + 14;
  const colQtyRight = contentRight - 132;
  const colPriceRight = contentRight - 78;
  const colTotalRight = contentRight - 36;
  const headerH = 30;
  const radius = 10;

  // Header row (light brand tint, rounded corners, NO border)
  drawRoundedRect(page, contentLeft, y, contentWidth, headerH, radius, brandTint);
  const headerTextY = y - 11;
  page.drawText("DESCRIPTION", {
    x: colDesc,
    y: headerTextY,
    size: 8.5,
    font: boldFont,
    color: brand,
  });
  drawRightInCell(page, boldFont, "QTY", colQtyRight, headerTextY, 8.5, brand);
  drawRightInCell(page, boldFont, "UNIT PRICE", colPriceRight, headerTextY, 8.5, brand);
  drawRightInCell(page, boldFont, "TOTAL", colTotalRight, headerTextY, 8.5, brand);
  y -= headerH;

  // Item rows with subtle dividers between rows
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

    // Subtle border under each row except the last
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

  // Grand total box (filled brand colour, white text, rounded)
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
    color: white,
  });

  y -= totalBoxH + 30;

  // ---- Banking details (two-column) ----
  const bankLeft = [
    client.bank_name ? { label: "Bank", value: client.bank_name } : null,
    client.bank_account_name ? { label: "Account Name", value: client.bank_account_name } : null,
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

  // ---- Payment terms ----
  if (client.payment_instructions) {
    page.drawText("PAYMENT TERMS", {
      x: contentLeft,
      y,
      size: 9,
      font: boldFont,
      color: brand,
    });
    y -= 15;
    const wrapped = wrapText(font, client.payment_instructions, 9, contentWidth);
    for (const line of wrapped.slice(0, 4)) {
      if (y < PDF_LINE_Y_THRESHOLD) break;
      page.drawText(line, {
        x: contentLeft,
        y,
        size: 9,
        font,
        color: MUTED_COLOR,
      });
      y -= 13;
    }
  }

  // ---- Footer ----
  const footerLineY = 60;
  page.drawLine({
    start: { x: contentLeft, y: footerLineY },
    end: { x: contentRight, y: footerLineY },
    thickness: 0.75,
    color: LINE_COLOR,
  });

  const footerParts = [
    client.business_name,
    client.phone,
    client.owner_email || client.reply_email,
    buildWebsite(client),
  ].filter(Boolean);
  if (footerParts.length) {
    const footerText = footerParts.join("  ·  ");
    const footerWidth = font.widthOfTextAtSize(footerText, 8.5);
    if (footerWidth > contentWidth) {
      const chunks = wrapText(font, footerText, 8.5, contentWidth);
      let fy = footerLineY - 18;
      for (const chunk of chunks.slice(0, 2)) {
        const w = font.widthOfTextAtSize(chunk, 8.5);
        page.drawText(chunk, {
          x: (PDF_PAGE_WIDTH - w) / 2,
          y: fy,
          size: 8.5,
          font,
          color: MUTED_COLOR,
        });
        fy -= 11;
      }
    } else {
      page.drawText(footerText, {
        x: (PDF_PAGE_WIDTH - footerWidth) / 2,
        y: footerLineY - 18,
        size: 8.5,
        font,
        color: MUTED_COLOR,
      });
    }
  }

  return pdfDoc.save();
}

function buildWebsite(client) {
  if (!client.business_name) return "";
  const slug = client.business_name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return slug ? `https://${slug}.co.za` : "";
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

