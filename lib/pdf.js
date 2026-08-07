/**
 * Invoice PDF Generation — Premium Minimal Design
 * =================================================
 * Completely rebuilt layout with 8px spacing system, grid alignment,
 * and premium typography. Inspired by Stripe/Apple/Linear/Notion.
 */

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import {
  PDF_PAGE_WIDTH,
  PDF_PAGE_HEIGHT,
  PDF_MARGIN,
  PDF_LINE_Y_THRESHOLD,
} from "../config/constants.js";
import { formatMoney } from "./utils.js";

// ─── Color System ───────────────────────────────────────────────────────────
const BLACK = rgb(0, 0, 0);
const GRAY_900 = rgb(0.11, 0.11, 0.12);
const GRAY_600 = rgb(0.4, 0.4, 0.42);
const GRAY_400 = rgb(0.63, 0.63, 0.65);
const GRAY_200 = rgb(0.9, 0.9, 0.91);
const WHITE = rgb(1, 1, 1);

// ─── Spacing System (8px grid) ─────────────────────────────────────────────
const SPACING = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
  xxxl: 64,
};

// ── Typography ─────────────────────────────────────────────────────────────
const FONT_SIZE = {
  xs: 8,
  sm: 10,
  base: 11,
  lg: 13,
  xl: 16,
  xxl: 20,
  xxxl: 28,
};

/**
 * Parse hex color to RGB
 */
function hexToRgb(hex) {
  if (typeof hex !== "string") return null;
  const match = hex.trim().replace(/^#/, "").match(/^([0-9a-fA-F]{6})$/);
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return rgb(((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255);
}

/**
 * Draw rounded rectangle
 */
function drawRoundedRect(page, x, y, w, h, r, fill, border, borderWidth = 1) {
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
  page.drawSvgPath(path, { x, y, color: fill, borderColor: border, borderWidth });
}

/**
 * Draw text with right alignment
 */
function drawRightAligned(page, text, x, y, size, font, color) {
  const width = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: x - width, y, size, font, color });
}

/**
 * Truncate text with ellipsis
 */
function truncateText(font, text, size, maxWidth) {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let result = text;
  while (result.length > 1 && font.widthOfTextAtSize(result + "…", size) > maxWidth) {
    result = result.slice(0, -1);
  }
  return result + "…";
}

/**
 * Wrap text to fit width
 */
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
 * Format date
 */
function formatDate(value) {
  try {
    return new Date(value).toLocaleDateString("en-ZA", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

/**
 * Try to embed logo
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

/**
 * Generate premium invoice PDF
 */
export async function generateInvoicePdf(client, invoice, lineItems, customer) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // Brand color (fallback to black)
  const brand = hexToRgb(client.primary_color) || BLACK;

  // ─── Layout Constants ───────────────────────────────────────────────────
  const left = PDF_MARGIN;
  const right = PDF_PAGE_WIDTH - PDF_MARGIN;
  const width = right - left;
  const mid = left + width / 2;

  let y = PDF_PAGE_HEIGHT - SPACING.xxl;

  // ═══════════════════════════════════════════════════════════════════════
  // HEADER
  // ══════════════════════════════════════════════════════════════════════

  // Logo (left)
  const logoImage = await tryEmbedLogo(pdfDoc, client.logo_url);
  const logoSize = 48;
  if (logoImage) {
    const logoWidth = Math.min((logoImage.width / logoImage.height) * logoSize, 140);
    page.drawImage(logoImage, {
      x: left,
      y: y - logoSize,
      width: logoWidth,
      height: logoSize,
    });
  }

  // Business info (next to logo)
  const infoX = logoImage ? left + 160 : left;
  page.drawText(client.business_name || "", {
    x: infoX,
    y: y - 8,
    size: FONT_SIZE.xl,
    font: boldFont,
    color: GRAY_900,
  });

  const contactLines = [client.address, client.phone, client.owner_email || client.reply_email].filter(Boolean);
  let cy = y - 24;
  for (const line of contactLines.slice(0, 3)) {
    if (cy < PDF_LINE_Y_THRESHOLD) break;
    page.drawText(line, {
      x: infoX,
      y: cy,
      size: FONT_SIZE.sm,
      font,
      color: GRAY_600,
    });
    cy -= 14;
  }

  // INVOICE title (right)
  const titleSize = FONT_SIZE.xxxl;
  const titleWidth = boldFont.widthOfTextAtSize("INVOICE", titleSize);
  page.drawText("INVOICE", {
    x: right - titleWidth,
    y: y - 8,
    size: titleSize,
    font: boldFont,
    color: brand,
  });

  y -= 80;

  // Meta info (right-aligned, 3 columns)
  const metaColWidth = 100;
  const metaItems = [
    { label: "Invoice Number", value: invoice.invoice_number || "" },
    { label: "Issue Date", value: formatDate(invoice.issued_at || invoice.created_at) },
    { label: "Due Date", value: invoice.due_at ? formatDate(invoice.due_at) : "—" },
  ];

  metaItems.forEach((item, i) => {
    const colX = right - (i + 1) * metaColWidth;
    page.drawText(item.label, {
      x: colX,
      y: y,
      size: FONT_SIZE.xs,
      font,
      color: GRAY_400,
    });
    page.drawText(item.value, {
      x: colX,
      y: y - 14,
      size: FONT_SIZE.sm,
      font: boldFont,
      color: GRAY_900,
    });
  });

  y -= 56;

  // Divider
  page.drawLine({
    start: { x: left, y },
    end: { x: right, y },
    thickness: 1,
    color: GRAY_200,
  });

  y -= SPACING.xl;

  // ═══════════════════════════════════════════════════════════════════════
  // CUSTOMER SECTION (Bill To / From cards)
  // ═══════════════════════════════════════════════════════════════════════

  const cardHeight = 88;
  const cardGap = SPACING.md;
  const cardWidth = (width - cardGap) / 2;

  // Bill To card
  drawRoundedRect(page, left, y - cardHeight, cardWidth, cardHeight, 8, WHITE, GRAY_200, 1);
  page.drawText("Bill To", {
    x: left + SPACING.md,
    y: y - 20,
    size: FONT_SIZE.xs,
    font: boldFont,
    color: GRAY_400,
  });
  page.drawText(customer.name || "", {
    x: left + SPACING.md,
    y: y - 38,
    size: FONT_SIZE.lg,
    font: boldFont,
    color: GRAY_900,
  });
  page.drawText(customer.email || "", {
    x: left + SPACING.md,
    y: y - 54,
    size: FONT_SIZE.sm,
    font,
    color: GRAY_600,
  });

  // From card
  const fromX = mid + cardGap / 2;
  drawRoundedRect(page, fromX, y - cardHeight, cardWidth, cardHeight, 8, WHITE, GRAY_200, 1);
  page.drawText("From", {
    x: fromX + SPACING.md,
    y: y - 20,
    size: FONT_SIZE.xs,
    font: boldFont,
    color: GRAY_400,
  });
  page.drawText(client.business_name || "", {
    x: fromX + SPACING.md,
    y: y - 38,
    size: FONT_SIZE.lg,
    font: boldFont,
    color: GRAY_900,
  });
  const fromLines = [client.address, client.phone, client.owner_email || client.reply_email].filter(Boolean);
  let fy = y - 54;
  for (const line of fromLines.slice(0, 3)) {
    if (fy < y - cardHeight + 12) break;
    page.drawText(truncateText(font, line, FONT_SIZE.sm, cardWidth - 32), {
      x: fromX + SPACING.md,
      y: fy,
      size: FONT_SIZE.sm,
      font,
      color: GRAY_600,
    });
    fy -= 14;
  }

  y -= cardHeight + SPACING.xxl;

  // ═══════════════════════════════════════════════════════════════════════
  // ITEM TABLE
  // ═══════════════════════════════════════════════════════════════════════

  const tableLeft = left;
  const tableRight = right;
  const tableWidth = tableRight - tableLeft;

  // Column positions
  const colDescX = tableLeft + SPACING.md;
  const colQtyX = tableRight - 140;
  const colPriceX = tableRight - 90;
  const colTotalX = tableRight - SPACING.md;

  // Header
  const headerHeight = 32;
  drawRoundedRect(page, tableLeft, y - headerHeight, tableWidth, headerHeight, 6, GRAY_900);
  const headerY = y - 22;
  page.drawText("Description", {
    x: colDescX,
    y: headerY,
    size: FONT_SIZE.sm,
    font: boldFont,
    color: WHITE,
  });
  drawRightAligned(page, "Qty", colQtyX + 20, headerY, FONT_SIZE.sm, boldFont, WHITE);
  drawRightAligned(page, "Unit Price", colPriceX + 20, headerY, FONT_SIZE.sm, boldFont, WHITE);
  drawRightAligned(page, "Total", colTotalX, headerY, FONT_SIZE.sm, boldFont, WHITE);

  y -= headerHeight + SPACING.sm;

  // Rows
  const rowHeight = 40;
  for (let i = 0; i < lineItems.length; i++) {
    const item = lineItems[i];
    if (y < PDF_LINE_Y_THRESHOLD) break;

    // Alternating background
    if (i % 2 === 0) {
      drawRoundedRect(page, tableLeft, y - rowHeight, tableWidth, rowHeight, 0, GRAY_200);
    }

    const rowY = y - 28;
    page.drawText(truncateText(font, item.description || "", FONT_SIZE.base, 280), {
      x: colDescX,
      y: rowY,
      size: FONT_SIZE.base,
      font,
      color: GRAY_900,
    });
    drawRightAligned(page, String(item.quantity), colQtyX + 20, rowY, FONT_SIZE.base, font, GRAY_600);
    drawRightAligned(page, formatMoney(item.unit_price), colPriceX + 20, rowY, FONT_SIZE.base, font, GRAY_600);
    drawRightAligned(page, formatMoney(item.line_total), colTotalX, rowY, FONT_SIZE.base, boldFont, GRAY_900);

    y -= rowHeight;
  }

  y -= SPACING.xl;

  // ═══════════════════════════════════════════════════════════════════════
  // TOTALS (right-aligned summary)
  // ═══════════════════════════════════════════════════════════════════════

  const totalsWidth = 220;
  const totalsX = right - totalsWidth;
  const totalsGap = 12;

  // Subtotal
  page.drawText("Subtotal", {
    x: totalsX,
    y: y,
    size: FONT_SIZE.sm,
    font,
    color: GRAY_600,
  });
  drawRightAligned(page, formatMoney(invoice.subtotal), right, y, FONT_SIZE.sm, font, GRAY_900);
  y -= totalsGap + 8;

  // Tax
  page.drawText("Tax", {
    x: totalsX,
    y: y,
    size: FONT_SIZE.sm,
    font,
    color: GRAY_600,
  });
  drawRightAligned(page, formatMoney(invoice.tax), right, y, FONT_SIZE.sm, font, GRAY_900);
  y -= totalsGap + 8;

  // Discount (if any)
  if (typeof invoice.discount === "number" && invoice.discount > 0) {
    page.drawText("Discount", {
      x: totalsX,
      y: y,
      size: FONT_SIZE.sm,
      font,
      color: GRAY_600,
    });
    drawRightAligned(page, `-${formatMoney(invoice.discount)}`, right, y, FONT_SIZE.sm, font, GRAY_900);
    y -= totalsGap + 8;
  }

  // Divider
  page.drawLine({
    start: { x: totalsX, y: y + 4 },
    end: { x: right, y: y + 4 },
    thickness: 1,
    color: GRAY_200,
  });

  y -= 20;

  // Grand Total (dominant)
  const totalBoxHeight = 48;
  drawRoundedRect(page, totalsX, y - totalBoxHeight, totalsWidth, totalBoxHeight, 8, brand);
  page.drawText("Total", {
    x: totalsX + SPACING.md,
    y: y - 30,
    size: FONT_SIZE.lg,
    font: boldFont,
    color: WHITE,
  });
  drawRightAligned(page, formatMoney(invoice.total), right - SPACING.md, y - 30, FONT_SIZE.xl, boldFont, WHITE);

  y -= totalBoxHeight + SPACING.xxl;

  // ═══════════════════════════════════════════════════════════════════════
  // BANKING DETAILS (two-column card)
  // ═══════════════════════════════════════════════════════════════════════

  const bankLeft = [
    client.bank_account_name ? { label: "Account Name", value: client.bank_account_name } : null,
    client.bank_name ? { label: "Bank", value: client.bank_name } : null,
    client.bank_account_number ? { label: "Account Number", value: client.bank_account_number } : null,
  ].filter(Boolean);

  const bankRight = [
    client.bank_branch_code ? { label: "Branch Code", value: client.bank_branch_code } : null,
    client.bank_account_type ? { label: "Account Type", value: client.bank_account_type } : null,
    { label: "Reference", value: client.bank_reference || `Invoice #${invoice.invoice_number || ""}` },
  ].filter(Boolean);

  const hasBanking = bankLeft.length > 0 || bankRight.length > 0;
  if (hasBanking) {
    const bankCardHeight = 120;
    drawRoundedRect(page, left, y - bankCardHeight, width, bankCardHeight, 8, WHITE, GRAY_200, 1);

    // Section title
    page.drawText("Banking Details", {
      x: left + SPACING.md,
      y: y - 20,
      size: FONT_SIZE.xs,
      font: boldFont,
      color: GRAY_400,
    });

    const col1X = left + SPACING.md;
    const col2X = mid + SPACING.sm;
    const labelY = y - 40;
    const valueY = y - 56;
    const rowGap = 24;

    // Left column
    bankLeft.forEach((item, i) => {
      const rowY = labelY - i * rowGap;
      page.drawText(item.label, {
        x: col1X,
        y: rowY,
        size: FONT_SIZE.xs,
        font,
        color: GRAY_400,
      });
      page.drawText(truncateText(font, item.value, FONT_SIZE.base, 180), {
        x: col1X,
        y: rowY - 14,
        size: FONT_SIZE.base,
        font: boldFont,
        color: GRAY_900,
      });
    });

    // Right column
    bankRight.forEach((item, i) => {
      const rowY = labelY - i * rowGap;
      page.drawText(item.label, {
        x: col2X,
        y: rowY,
        size: FONT_SIZE.xs,
        font,
        color: GRAY_400,
      });
      page.drawText(truncateText(font, item.value, FONT_SIZE.base, 180), {
        x: col2X,
        y: rowY - 14,
        size: FONT_SIZE.base,
        font: boldFont,
        color: GRAY_900,
      });
    });

    y -= bankCardHeight + SPACING.xl;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PAYMENT TERMS (info box)
  // ═══════════════════════════════════════════════════════════════════════

  if (client.payment_instructions || invoice.due_at) {
    const termsWidth = 280;
    const termsHeight = 80;
    const termsX = right - termsWidth;
    const termsY = y - termsHeight;

    drawRoundedRect(page, termsX, termsY, termsWidth, termsHeight, 8, GRAY_200);

    page.drawText("Payment Terms", {
      x: termsX + SPACING.md,
      y: y - 20,
      size: FONT_SIZE.xs,
      font: boldFont,
      color: GRAY_600,
    });

    let ty = y - 36;
    if (invoice.due_at) {
      page.drawText(`Payment is due by ${formatDate(invoice.due_at)}.`, {
        x: termsX + SPACING.md,
        y: ty,
        size: FONT_SIZE.sm,
        font,
        color: GRAY_900,
      });
      ty -= 16;
    }
    if (client.payment_instructions) {
      const wrapped = wrapText(font, client.payment_instructions, FONT_SIZE.sm, termsWidth - 32);
      for (const line of wrapped.slice(0, 3)) {
        if (ty < termsY + 12) break;
        page.drawText(line, {
          x: termsX + SPACING.md,
          y: ty,
          size: FONT_SIZE.sm,
          font,
          color: GRAY_600,
        });
        ty -= 14;
      }
    }

    y = termsY - SPACING.xxl;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FOOTER
  // ═══════════════════════════════════════════════════════════════════════

  const footerY = 80;
  page.drawLine({
    start: { x: left, y: footerY },
    end: { x: right, y: footerY },
    thickness: 1,
    color: GRAY_200,
  });

  // Centered thank you
  const thankYouText = "Thank you!";
  const thankYouWidth = boldFont.widthOfTextAtSize(thankYouText, FONT_SIZE.lg);
  page.drawText(thankYouText, {
    x: (PDF_PAGE_WIDTH - thankYouWidth) / 2,
    y: footerY - 24,
    size: FONT_SIZE.lg,
    font: boldFont,
    color: brand,
  });

  const appreciateText = "We appreciate your business.";
  const appreciateWidth = font.widthOfTextAtSize(appreciateText, FONT_SIZE.sm);
  page.drawText(appreciateText, {
    x: (PDF_PAGE_WIDTH - appreciateWidth) / 2,
    y: footerY - 40,
    size: FONT_SIZE.sm,
    font,
    color: GRAY_600,
  });

  // Powered by (bottom right)
  const poweredText = "Powered by My Grafix Media";
  const poweredWidth = font.widthOfTextAtSize(poweredText, FONT_SIZE.xs);
  page.drawText(poweredText, {
    x: right - poweredWidth,
    y: footerY - 60,
    size: FONT_SIZE.xs,
    font,
    color: GRAY_400,
  });

  const taglineText = "Design. Build. Automate.";
  const taglineWidth = font.widthOfTextAtSize(taglineText, FONT_SIZE.xs);
  page.drawText(taglineText, {
    x: right - taglineWidth,
    y: footerY - 74,
    size: FONT_SIZE.xs,
    font,
    color: GRAY_400,
  });

  return pdfDoc.save();
}

/**
 * Upload PDF to R2
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
 * Convert ArrayBuffer to base64
 */
export function arrayBufferToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
