/**
 * Invoice PDF Generation — Fresh Design
 * ======================================
 * Premium minimal layout with consistent spacing and alignment.
 * Uses client's brand color from Supabase (primary_color).
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
const GRAY_900 = rgb(0.11, 0.11, 0.12);
const GRAY_600 = rgb(0.4, 0.4, 0.42);
const GRAY_400 = rgb(0.63, 0.63, 0.65);
const GRAY_200 = rgb(0.9, 0.9, 0.91);
const WHITE = rgb(1, 1, 1);

// ─── Spacing System (8px grid) ─────────────────────────────────────────────
const SP = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

// ─── Typography ─────────────────────────────────────────────────────────────
const FS = {
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
 * Lighten color toward white
 */
function lightenHex(hex, amount = 0.9) {
  const base = hexToRgb(hex);
  if (!base) return GRAY_200;
  const channel = (c) => c + (1 - c) * amount;
  return rgb(channel(base.red), channel(base.green), channel(base.blue));
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
 * Draw right-aligned text
 */
function drawRight(page, text, x, y, size, font, color) {
  const width = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: x - width, y, size, font, color });
}

/**
 * Truncate with ellipsis
 */
function truncate(font, text, size, max) {
  if (font.widthOfTextAtSize(text, size) <= max) return text;
  let r = text;
  while (r.length > 1 && font.widthOfTextAtSize(r + "…", size) > max) r = r.slice(0, -1);
  return r + "…";
}

/**
 * Wrap text
 */
function wrap(font, text, size, max) {
  const words = text.split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const c = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(c, size) > max && cur) {
      lines.push(cur);
      cur = w;
    } else cur = c;
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Draw a dashed horizontal line
 */
function drawDashedLine(page, x1, x2, y, color, dash = 4, gap = 3, thickness = 1) {
  let x = x1;
  while (x < x2) {
    const segEnd = Math.min(x + dash, x2);
    page.drawLine({ start: { x, y }, end: { x: segEnd, y }, thickness, color });
    x += dash + gap;
  }
}

/**
 * Draw a small circular avatar with a simple glyph inside, used for
 * the Bill To / From cards.
 */
function drawAvatarCircle(page, cx, cy, r, bgColor, glyphColor, kind) {
  page.drawCircle({ x: cx, y: cy, size: r, color: bgColor });

  if (kind === "person") {
    // head
    page.drawCircle({ x: cx, y: cy + r * 0.28, size: r * 0.32, color: glyphColor });
    // shoulders (half ellipse via arc-ish path)
    const w = r * 0.85;
    const h = r * 0.6;
    const path = `M ${-w} 0 Q ${-w} ${h} 0 ${h} Q ${w} ${h} ${w} 0 Z`;
    page.drawSvgPath(path, { x: cx, y: cy - r * 0.32, color: glyphColor });
  } else if (kind === "shop") {
    const w = r * 0.9;
    const h = r * 0.55;
    // storefront base
    page.drawRectangle({ x: cx - w / 2, y: cy - r * 0.45, width: w, height: h, color: glyphColor });
    // awning scallops (simple triangle roof)
    const roofPath = `M ${-w / 2 - 2} 0 L 0 ${r * 0.4} L ${w / 2 + 2} 0 Z`;
    page.drawSvgPath(roofPath, { x: cx, y: cy - r * 0.45, color: glyphColor });
  } else if (kind === "calendar") {
    const w = r * 1.1;
    const h = r * 1.0;
    // calendar body outline
    page.drawRectangle({
      x: cx - w / 2,
      y: cy - h / 2,
      width: w,
      height: h,
      borderColor: glyphColor,
      borderWidth: 1.2,
    });
    // header bar
    page.drawRectangle({ x: cx - w / 2, y: cy + h / 2 - h * 0.28, width: w, height: h * 0.28, color: glyphColor });
  }
}

/**
 * Format date
 */
function fmtDate(v) {
  try {
    return new Date(v).toLocaleDateString("en-ZA", { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

/**
 * Embed logo
 */
async function embedLogo(doc, url) {
  if (!url) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const ct = res.headers.get("Content-Type") || "";
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (ct.includes("png") || url.toLowerCase().endsWith(".png")) return await doc.embedPng(bytes);
    if (ct.includes("jpeg") || ct.includes("jpg") || /\.jpe?g$/i.test(url)) return await doc.embedJpg(bytes);
    return null;
  } catch {
    return null;
  }
}

/**
 * Generate invoice PDF
 */
export async function generateInvoicePdf(client, invoice, lineItems, customer) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const brand = hexToRgb(client.primary_color) || GRAY_900;
  const brandLight = lightenHex(client.primary_color, 0.92);

  const L = PDF_MARGIN;
  const R = PDF_PAGE_WIDTH - PDF_MARGIN;
  const W = R - L;
  const M = L + W / 2;

  // Top brand accent bar (full-bleed strip across the very top of the page)
  const topBarH = 10;
  page.drawRectangle({
    x: 0,
    y: PDF_PAGE_HEIGHT - topBarH,
    width: PDF_PAGE_WIDTH,
    height: topBarH,
    color: brand,
  });

  let y = PDF_PAGE_HEIGHT - topBarH - SP.xxl;

  // ═══════════════════════════════════════════════════════════════════════
  // HEADER
  // ══════════════════════════════════════════════════════════════════════

  // Logo
  const logo = await embedLogo(doc, client.logo_url);
  if (logo) {
    const h = 40;
    const w = Math.min((logo.width / logo.height) * h, 120);
    page.drawImage(logo, { x: L, y: y - h, width: w, height: h });
    // thin divider between the logo block and the business info block
    page.drawLine({
      start: { x: L + w + SP.md, y: y + 4 },
      end: { x: L + w + SP.md, y: y - h - 4 },
      thickness: 1,
      color: GRAY_200,
    });
  }

  // Business info
  const infoX = logo ? L + 140 : L;
  page.drawText(client.business_name || "", {
    x: infoX,
    y: y - 8,
    size: FS.xl,
    font: bold,
    color: GRAY_900,
  });

  const contacts = [client.address, client.phone, client.owner_email || client.reply_email].filter(Boolean);
  let cy = y - 22;
  for (const line of contacts.slice(0, 3)) {
    if (cy < PDF_LINE_Y_THRESHOLD) break;
    page.drawText(line, { x: infoX, y: cy, size: FS.sm, font, color: GRAY_600 });
    cy -= 13;
  }

  // INVOICE title
  const tSize = FS.xxxl;
  const tW = bold.widthOfTextAtSize("INVOICE", tSize);
  page.drawText("INVOICE", { x: R - tW, y: y - 8, size: tSize, font: bold, color: brand });

  y -= 72;

  // Meta columns (Invoice No | Issued | Due), left to right, each value in brand color
  const metaW = 110;
  const metaItems = [
    { label: "Invoice No", value: invoice.invoice_number ? `#${invoice.invoice_number}` : "" },
    { label: "Issued", value: fmtDate(invoice.issued_at || invoice.created_at) },
    { label: "Due", value: invoice.due_at ? fmtDate(invoice.due_at) : "—" },
  ];
  const metaStartX = R - metaItems.length * metaW;

  metaItems.forEach((item, i) => {
    const colX = metaStartX + i * metaW;
    if (i > 0) {
      page.drawLine({ start: { x: colX - SP.md, y: y + 4 }, end: { x: colX - SP.md, y: y - 16 }, thickness: 1, color: GRAY_200 });
    }
    page.drawText(item.label, { x: colX, y: y, size: FS.xs, font, color: GRAY_400 });
    page.drawText(item.value, { x: colX, y: y - 16, size: FS.sm, font: bold, color: brand });
  });

  y -= 48;

  // Divider
  page.drawLine({ start: { x: L, y }, end: { x: R, y }, thickness: 1, color: GRAY_200 });
  y -= SP.xl;

  // ═══════════════════════════════════════════════════════════════════════
  // BILL TO / FROM CARDS
  // ═══════════════════════════════════════════════════════════════════════

  const cardH = 90;
  const gap = SP.md;
  const cardW = (W - gap) / 2;
  const avatarR = 18;
  const avatarPadTop = 26;
  const textX = L + SP.md + avatarR * 2 + SP.md;

  // BILL TO
  drawRoundedRect(page, L, y - cardH, cardW, cardH, 8, rgb(0.98, 0.98, 0.98), GRAY_200, 1);
  drawAvatarCircle(page, L + SP.md + avatarR, y - avatarPadTop, avatarR, brandLight, brand, "person");
  page.drawText("BILL TO", { x: textX, y: y - 20, size: FS.xs, font: bold, color: brand });
  page.drawText(customer.name || "", { x: textX, y: y - 36, size: FS.lg, font: bold, color: GRAY_900 });
  page.drawText(customer.email || "", { x: textX, y: y - 52, size: FS.sm, font, color: GRAY_600 });

  // FROM
  const fromX = M + gap / 2;
  const fromTextX = fromX + SP.md + avatarR * 2 + SP.md;
  drawRoundedRect(page, fromX, y - cardH, cardW, cardH, 8, rgb(0.98, 0.98, 0.98), GRAY_200, 1);
  drawAvatarCircle(page, fromX + SP.md + avatarR, y - avatarPadTop, avatarR, brandLight, brand, "shop");
  page.drawText("FROM", { x: fromTextX, y: y - 20, size: FS.xs, font: bold, color: brand });
  page.drawText(client.business_name || "", { x: fromTextX, y: y - 36, size: FS.lg, font: bold, color: GRAY_900 });

  const fromLines = [client.address, client.phone, client.owner_email || client.reply_email].filter(Boolean);
  let fy = y - 52;
  for (const line of fromLines.slice(0, 3)) {
    if (fy < y - cardH + 12) break;
    page.drawText(truncate(font, line, FS.sm, cardW - (fromTextX - fromX) - 16), { x: fromTextX, y: fy, size: FS.sm, font, color: GRAY_600 });
    fy -= 13;
  }

  y -= cardH + SP.xxl;

  // ═══════════════════════════════════════════════════════════════════════
  // ITEM TABLE
  // ═══════════════════════════════════════════════════════════════════════

  const colDesc = L + SP.md;
  const colQty = R - 140;
  const colPrice = R - 90;
  const colTotal = R - SP.md;
  const headerH = 32;
  const radius = 6;

  // Header
  drawRoundedRect(page, L, y, W, headerH, radius, brand);
  const hY = y - 22;
  page.drawText("Description", { x: colDesc, y: hY, size: FS.sm, font: bold, color: WHITE });
  drawRight(page, "Qty", colQty + 20, hY, FS.sm, bold, WHITE);
  drawRight(page, "Unit Price", colPrice + 20, hY, FS.sm, bold, WHITE);
  drawRight(page, "Total", colTotal, hY, FS.sm, bold, WHITE);

  y -= headerH + SP.sm;

  // Rows — thin divider line beneath each row, no alternating fill
  const rowH = 36;
  for (let i = 0; i < lineItems.length; i++) {
    const item = lineItems[i];
    if (y < PDF_LINE_Y_THRESHOLD) break;

    const rY = y - 26;
    page.drawText(truncate(font, item.description || "", FS.base, 280), { x: colDesc, y: rY, size: FS.base, font, color: GRAY_900 });
    drawRight(page, String(item.quantity), colQty + 20, rY, FS.base, font, GRAY_600);
    drawRight(page, formatMoney(item.unit_price), colPrice + 20, rY, FS.base, font, GRAY_600);
    drawRight(page, formatMoney(item.line_total), colTotal, rY, FS.base, bold, GRAY_900);

    page.drawLine({ start: { x: L, y: y - rowH }, end: { x: R, y: y - rowH }, thickness: 1, color: GRAY_200 });

    y -= rowH;
  }

  y -= SP.xl;

  // ══════════════════════════════════════════════════════════════════════
  // TOTALS
  // ═══════════════════════════════════════════════════════════════════════

  const totW = 220;
  const totX = R - totW;
  const totGap = 12;

  page.drawText("Subtotal", { x: totX, y: y, size: FS.sm, font, color: GRAY_600 });
  drawRight(page, formatMoney(invoice.subtotal), R, y, FS.sm, font, GRAY_900);
  y -= totGap + 8;

  page.drawText("Tax", { x: totX, y: y, size: FS.sm, font, color: GRAY_600 });
  drawRight(page, formatMoney(invoice.tax), R, y, FS.sm, font, GRAY_900);
  y -= totGap + 8;

  if (typeof invoice.discount === "number" && invoice.discount > 0) {
    page.drawText("Discount", { x: totX, y: y, size: FS.sm, font, color: GRAY_600 });
    drawRight(page, `-${formatMoney(invoice.discount)}`, R, y, FS.sm, font, GRAY_900);
    y -= totGap + 8;
  }

  // Divider
  page.drawLine({ start: { x: totX, y: y + 4 }, end: { x: R, y: y + 4 }, thickness: 1, color: GRAY_200 });
  y -= 20;

  // Grand total box
  const boxH = 48;
  drawRoundedRect(page, totX, y - boxH, totW, boxH, 8, brand);
  page.drawText("Total", { x: totX + SP.md, y: y - 30, size: FS.lg, font: bold, color: WHITE });
  drawRight(page, formatMoney(invoice.total), R - SP.md, y - 30, FS.xl, bold, WHITE);

  y -= boxH + SP.xxl;

  // ═══════════════════════════════════════════════════════════════════════
  // BANKING DETAILS
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

  const hasBank = bankLeft.length > 0 || bankRight.length > 0;
  if (hasBank) {
    const bankH = 110;

    page.drawText("BANKING DETAILS", { x: L, y: y - 8, size: FS.xs, font: bold, color: brand });
    page.drawLine({ start: { x: L, y: y - 16 }, end: { x: L + 260, y: y - 16 }, thickness: 1.5, color: brand });

    const col1 = L;
    const col3 = L + W * 0.32;
    const labelY = y - 40;
    const rowGap = 26;

    bankLeft.forEach((item, i) => {
      const rY = labelY - i * rowGap;
      page.drawText(item.label, { x: col1, y: rY, size: FS.xs, font, color: GRAY_400 });
      page.drawText(truncate(font, item.value, FS.base, 180), { x: col3, y: rY, size: FS.base, font: bold, color: GRAY_900 });
    });

    const col2 = L + W * 0.55;
    const col4 = L + W * 0.85;
    bankRight.forEach((item, i) => {
      const rY = labelY - i * rowGap;
      page.drawText(item.label, { x: col2, y: rY, size: FS.xs, font, color: GRAY_400 });
      page.drawText(truncate(font, item.value, FS.base, 140), { x: col4, y: rY, size: FS.base, font: bold, color: GRAY_900 });
    });

    y -= bankH + SP.xl;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PAYMENT TERMS
  // ═══════════════════════════════════════════════════════════════════════

  if (client.payment_instructions || invoice.due_at) {
    const termsW = 280;
    const termsH = 80;
    const termsX = R - termsW;
    const termsY = y - termsH;

    drawRoundedRect(page, termsX, termsY, termsW, termsH, 8, brandLight, GRAY_200, 1);

    drawAvatarCircle(page, termsX + SP.md + 8, y - 18, 8, brandLight, brand, "calendar");
    page.drawText("PAYMENT TERMS", { x: termsX + SP.md + 22, y: y - 21, size: FS.xs, font: bold, color: brand });

    let ty = y - 36;
    if (invoice.due_at) {
      page.drawText(`Payment is due by ${fmtDate(invoice.due_at)}.`, { x: termsX + SP.md, y: ty, size: FS.sm, font, color: GRAY_900 });
      ty -= 16;
    }
    if (client.payment_instructions) {
      const wrapped = wrap(font, client.payment_instructions, FS.sm, termsW - 32);
      for (const line of wrapped.slice(0, 3)) {
        if (ty < termsY + 12) break;
        page.drawText(line, { x: termsX + SP.md, y: ty, size: FS.sm, font, color: GRAY_600 });
        ty -= 14;
      }
    }

    y = termsY - SP.xxl;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FOOTER
  // ══════════════════════════════════════════════════════════════════════

  const footerY = 90;
  drawDashedLine(page, L, R, footerY, GRAY_200);

  // Left: thank-you note
  page.drawText("Thank you!", { x: L, y: footerY - 24, size: FS.lg, font: bold, color: brand });
  page.drawText("We appreciate your business.", { x: L, y: footerY - 40, size: FS.sm, font, color: GRAY_600 });

  // Right: "Powered by <brand name>" with the brand name colored, then tagline
  const preText = "Powered by ";
  const brandNameText = "My Grafix Media";
  const preW = font.widthOfTextAtSize(preText, FS.xs);
  const brandW = bold.widthOfTextAtSize(brandNameText, FS.xs);
  const powRowY = footerY - 24;
  page.drawText(preText, { x: R - preW - brandW, y: powRowY, size: FS.xs, font, color: GRAY_400 });
  page.drawText(brandNameText, { x: R - brandW, y: powRowY, size: FS.xs, font: bold, color: brand });

  const tagText = "Design. Build. Automate.";
  const tagW = font.widthOfTextAtSize(tagText, FS.xs);
  page.drawText(tagText, { x: R - tagW, y: powRowY - 14, size: FS.xs, font, color: GRAY_400 });

  return doc.save();
}

/**
 * Upload PDF to R2
 */
export async function uploadInvoicePdf(env, clientId, invoiceNumber, pdfBytes) {
  const key = `clients/${clientId}/invoices/${invoiceNumber}.pdf`;
  await env.R2_BUCKET.put(key, pdfBytes, { httpMetadata: { contentType: "application/pdf" } });
  const baseUrl = (env.R2_PUBLIC_URL || "").replace(/\/$/, "");
  return `${baseUrl}/${key}`;
}

/**
 * ArrayBuffer to base64
 */
export function arrayBufferToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
