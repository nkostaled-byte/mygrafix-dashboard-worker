/**
 * lib/pdf.js — Professional Invoice PDF Generator (Bulletproof Edition)
 * ======================================================================
 * Generates professional invoice PDFs using pdf-lib.
 * Includes safety guards to prevent 500 errors from unsupported characters 
 * (emojis, Naira/Cedi symbols, non-Latin text) which crash standard PDF fonts.
 */

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

// ─── Color Palette ───────────────────────────────────────────────────────────
const COLORS = {
  primary:      rgb(0.13, 0.15, 0.19),   // #212529 — near-black
  secondary:    rgb(0.42, 0.45, 0.50),   // #6B7280 — slate
  accent:       rgb(0.20, 0.44, 0.85),   // #3370D9 — professional blue
  accentLight:  rgb(0.92, 0.95, 1.00),   // #EBF2FF — light blue tint
  success:      rgb(0.13, 0.65, 0.37),   // #22A65E
  warning:      rgb(0.85, 0.55, 0.05),   // #D98C0D
  danger:       rgb(0.80, 0.20, 0.20),   // #CC3333
  border:       rgb(0.88, 0.89, 0.91),   // #E2E4E8
  white:        rgb(1, 1, 1),
  tableHeader:  rgb(0.96, 0.97, 0.98),   // #F5F7FA
  tableAlt:     rgb(0.98, 0.98, 0.99),
};

// ─── Page Layout Constants ───────────────────────────────────────────────────
const PAGE = {
  width: 595.28,   // A4
  height: 841.89,
  marginX: 50,
  marginTop: 50,
  marginBottom: 60,
};

const CONTENT_WIDTH = PAGE.width - PAGE.marginX * 2;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Sanitizes text to prevent pdf-lib from crashing on unsupported characters.
 * Standard PDF fonts (Helvetica) only support WinAnsi (basic Latin + symbols).
 * This strips emojis, Naira/Cedi symbols, and non-Latin characters.
 */
function sanitizeForPdf(str) {
  if (!str) return "";
  return String(str)
    .replace(/[₦₵]/g, "") // Explicitly remove known problematic currency symbols
    .replace(/[^\x00-\xFF]/g, ""); // Remove all non-WinAnsi characters (emojis, Chinese, Arabic, etc.)
}

function formatCurrency(amount, currency = "NGN") {
  const num = Number(amount || 0);
  const formatted = num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  
  // Use ISO codes for currencies not in the standard WinAnsi character set
  // to prevent pdf-lib font encoding crashes.
  const safeSymbols = { USD: "$", GBP: "£", EUR: "€", JPY: "¥" };
  const symbol = safeSymbols[currency] || `${currency} `;
  
  return `${symbol}${formatted}`;
}

function formatDate(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function statusColor(status) {
  const s = (status || "draft").toLowerCase();
  if (["paid", "settled"].includes(s)) return COLORS.success;
  if (["sent", "pending"].includes(s)) return COLORS.warning;
  if (["overdue", "void", "cancelled"].includes(s)) return COLORS.danger;
  return COLORS.secondary;
}

function statusBgColor(status) {
  const s = (status || "draft").toLowerCase();
  if (["paid", "settled"].includes(s)) return rgb(0.88, 0.97, 0.91);
  if (["sent", "pending"].includes(s)) return rgb(1.0, 0.96, 0.87);
  if (["overdue", "void", "cancelled"].includes(s)) return rgb(0.98, 0.89, 0.89);
  return rgb(0.93, 0.94, 0.96);
}

function truncate(text, maxLen) {
  if (!text) return "";
  text = sanitizeForPdf(text);
  return text.length > maxLen ? text.slice(0, maxLen - 1) + "…" : text;
}

// ─── Main PDF Generator ──────────────────────────────────────────────────────

export async function generateInvoicePdf(client, invoice, lineItems, customer) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([PAGE.width, PAGE.height]);

  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontLight = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  const currency = client.currency || "NGN";
  let y = PAGE.height - PAGE.marginTop;

  // ─── Helper: draw text (with safety guards) ─────────────────────────────────
  const text = (str, x, yPos, opts = {}) => {
    const { size = 10, font = fontRegular, color = COLORS.primary, maxWidth } = opts;
    let safeStr = sanitizeForPdf(str);

    const drawOpts = { x, y: yPos, size, font, color };
    if (maxWidth !== undefined) drawOpts.maxWidth = maxWidth;

    try {
      page.drawText(safeStr, drawOpts);
    } catch (err) {
      // Extreme fallback: pure ASCII only if WinAnsi still complains
      const asciiStr = safeStr.replace(/[^\x00-\x7F]/g, "");
      page.drawText(asciiStr, drawOpts);
    }
    return yPos;
  };

  // ─── Helper: draw line ──────────────────────────────────────────────────────
  const line = (x1, y1, x2, y2, thickness = 0.5, color = COLORS.border) => {
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color });
  };

  // ─── Helper: draw rect ──────────────────────────────────────────────────────
  const drawRect = (x, yPos, w, h, opts = {}) => {
    const { color = COLORS.accentLight, borderColor = undefined, borderWidth = 0 } = opts;
    page.drawRectangle({ x, y: yPos, width: w, height: h, color, borderColor, borderWidth });
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // HEADER
  // ═══════════════════════════════════════════════════════════════════════════

  // Top accent bar
  page.drawRectangle({ x: 0, y: PAGE.height - 8, width: PAGE.width, height: 8, color: COLORS.accent });
  y -= 10;

  const bizName = client.business_name || client.name || "Your Business";
  text(bizName, PAGE.marginX, y, { size: 22, font: fontBold, color: COLORS.primary });
  y -= 28;

  if (client.tagline) {
    text(client.tagline, PAGE.marginX, y, { size: 9, font: fontLight, color: COLORS.secondary });
    y -= 16;
  }

  // Business contact details
  const bizDetails = [client.email, client.phone, client.website, client.address].filter(Boolean);
  let bizDetailY = PAGE.height - PAGE.marginTop - 10;
  for (const detail of bizDetails) {
    const dw = fontRegular.widthOfTextAtSize(sanitizeForPdf(detail), 8.5);
    text(detail, PAGE.width - PAGE.marginX - dw, bizDetailY, { size: 8.5, color: COLORS.secondary });
    bizDetailY -= 14;
  }

  y -= 20;

  // ═══════════════════════════════════════════════════════════════════════════
  // INVOICE TITLE + META
  // ═══════════════════════════════════════════════════════════════════════════

  text("INVOICE", PAGE.marginX, y, { size: 28, font: fontBold, color: COLORS.accent });

  // Status badge
  const statusText = (invoice.status || "draft").toUpperCase();
  const statusW = fontBold.widthOfTextAtSize(statusText, 9) + 20;
  const statusX = PAGE.width - PAGE.marginX - statusW;
  drawRect(statusX, y - 4, statusW, 22, { color: statusBgColor(invoice.status) });
  text(statusText, statusX + 10, y + 2, { size: 9, font: fontBold, color: statusColor(invoice.status) });

  y -= 40;

  // Invoice meta row
  const metaItems = [
    { label: "Invoice #", value: invoice.invoice_number || "—" },
    { label: "Issue Date", value: formatDate(invoice.created_at) },
    { label: "Due Date", value: formatDate(invoice.due_at) },
  ];

  const metaColWidth = CONTENT_WIDTH / metaItems.length;
  metaItems.forEach((item, i) => {
    const mx = PAGE.marginX + i * metaColWidth;
    text(item.label, mx, y, { size: 8, font: fontBold, color: COLORS.secondary });
    text(item.value, mx, y - 14, { size: 11, font: fontBold, color: COLORS.primary });
  });

  y -= 50;
  line(PAGE.marginX, y, PAGE.width - PAGE.marginX, y, 1, COLORS.accent);
  y -= 30;

  // ═══════════════════════════════════════════════════════════════════════════
  // BILL TO
  // ═══════════════════════════════════════════════════════════════════════════

  text("BILL TO", PAGE.marginX, y, { size: 8, font: fontBold, color: COLORS.secondary });
  y -= 18;

  const custName = customer.name || customer.full_name || "Customer";
  text(custName, PAGE.marginX, y, { size: 12, font: fontBold });
  y -= 16;

  if (customer.email) { text(customer.email, PAGE.marginX, y, { size: 9, color: COLORS.secondary }); y -= 14; }
  if (customer.phone) { text(customer.phone, PAGE.marginX, y, { size: 9, color: COLORS.secondary }); y -= 14; }
  if (customer.address) { text(customer.address, PAGE.marginX, y, { size: 9, color: COLORS.secondary, maxWidth: 250 }); y -= 14; }

  y -= 20;

  // ═══════════════════════════════════════════════════════════════════════════
  // LINE ITEMS TABLE
  // ═══════════════════════════════════════════════════════════════════════════

  const colDesc = PAGE.marginX;
  const colQty = PAGE.marginX + 270;
  const colUnit = PAGE.marginX + 330;
  const colTotal = PAGE.width - PAGE.marginX;

  const rowHeight = 30;
  const headerHeight = 26;

  // Table header
  page.drawRectangle({ x: PAGE.marginX, y: y - headerHeight + 8, width: CONTENT_WIDTH, height: headerHeight, color: COLORS.accent });

  const headerY = y - 8;
  text("DESCRIPTION", colDesc + 10, headerY, { size: 8, font: fontBold, color: COLORS.white });
  text("QTY", colQty, headerY, { size: 8, font: fontBold, color: COLORS.white });
  text("UNIT PRICE", colUnit, headerY, { size: 8, font: fontBold, color: COLORS.white });
  const amtLabel = "AMOUNT";
  const amtW = fontBold.widthOfTextAtSize(amtLabel, 8);
  text(amtLabel, colTotal - amtW - 10, headerY, { size: 8, font: fontBold, color: COLORS.white });

  y -= headerHeight + 8;

  lineItems.forEach((item, idx) => {
    const rowY = y - 8;
    const isAlt = idx % 2 === 1;

    if (isAlt) {
      page.drawRectangle({ x: PAGE.marginX, y: y - rowHeight + 8, width: CONTENT_WIDTH, height: rowHeight, color: COLORS.tableAlt });
    }

    const desc = truncate(item.description || "Item", 55);
    text(desc, colDesc + 10, rowY, { size: 9.5 });

    const qtyStr = String(item.quantity || 0);
    const qtyW = fontRegular.widthOfTextAtSize(qtyStr, 9.5);
    text(qtyStr, colQty + 30 - qtyW, rowY, { size: 9.5 });

    const unitStr = formatCurrency(item.unit_price, currency);
    const unitW = fontRegular.widthOfTextAtSize(sanitizeForPdf(unitStr), 9.5);
    text(unitStr, colUnit + 60 - unitW, rowY, { size: 9.5 });

    const lineTotal = Number(item.quantity || 0) * Number(item.unit_price || 0);
    const totalStr = formatCurrency(lineTotal, currency);
    const totalW = fontRegular.widthOfTextAtSize(sanitizeForPdf(totalStr), 9.5);
    text(totalStr, colTotal - totalW - 10, rowY, { size: 9.5, font: fontBold });

    y -= rowHeight;
    line(PAGE.marginX, y + 8, PAGE.width - PAGE.marginX, y + 8, 0.3, COLORS.border);
  });

  y -= 20;

  // ═══════════════════════════════════════════════════════════════════════════
  // TOTALS SECTION
  // ═══════════════════════════════════════════════════════════════════════════

  const totalsX = PAGE.marginX + 280;
  const totalsRight = PAGE.width - PAGE.marginX;

  text("Subtotal", totalsX, y, { size: 9.5, color: COLORS.secondary });
  const subStr = formatCurrency(invoice.subtotal, currency);
  const subW = fontRegular.widthOfTextAtSize(sanitizeForPdf(subStr), 9.5);
  text(subStr, totalsRight - subW - 10, y, { size: 9.5 });
  y -= 20;

  if (invoice.tax && Number(invoice.tax) !== 0) {
    text("Tax", totalsX, y, { size: 9.5, color: COLORS.secondary });
    const taxStr = formatCurrency(invoice.tax, currency);
    const taxW = fontRegular.widthOfTextAtSize(sanitizeForPdf(taxStr), 9.5);
    text(taxStr, totalsRight - taxW - 10, y, { size: 9.5 });
    y -= 20;
  }

  if (invoice.discount && Number(invoice.discount) !== 0) {
    text("Discount", totalsX, y, { size: 9.5, color: COLORS.secondary });
    const discStr = "-" + formatCurrency(invoice.discount, currency);
    const discW = fontRegular.widthOfTextAtSize(sanitizeForPdf(discStr), 9.5);
    text(discStr, totalsRight - discW - 10, y, { size: 9.5, color: COLORS.danger });
    y -= 20;
  }

  line(totalsX, y + 6, totalsRight, y + 6, 1, COLORS.primary);
  y -= 8;

  text("TOTAL DUE", totalsX, y, { size: 11, font: fontBold });
  const grandStr = formatCurrency(invoice.total, currency);
  const grandW = fontBold.widthOfTextAtSize(sanitizeForPdf(grandStr), 13);
  text(grandStr, totalsRight - grandW - 10, y - 1, { size: 13, font: fontBold, color: COLORS.accent });

  y -= 40;

  // ═══════════════════════════════════════════════════════════════════════════
  // NOTES / PAYMENT INFO
  // ═══════════════════════════════════════════════════════════════════════════

  if (invoice.notes || client.payment_instructions || client.bank_details) {
    line(PAGE.marginX, y, PAGE.width - PAGE.marginX, y, 0.5, COLORS.border);
    y -= 24;

    if (invoice.notes) {
      text("NOTES", PAGE.marginX, y, { size: 8, font: fontBold, color: COLORS.secondary });
      y -= 14;
      text(invoice.notes, PAGE.marginX, y, { size: 8.5, color: COLORS.secondary, maxWidth: CONTENT_WIDTH });
      y -= 30;
    }

    const payInfo = client.payment_instructions || client.bank_details;
    if (payInfo) {
      text("PAYMENT INFORMATION", PAGE.marginX, y, { size: 8, font: fontBold, color: COLORS.secondary });
      y -= 14;
      text(payInfo, PAGE.marginX, y, { size: 8.5, color: COLORS.secondary, maxWidth: CONTENT_WIDTH });
      y -= 30;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FOOTER
  // ═══════════════════════════════════════════════════════════════════════════

  const footerY = PAGE.marginBottom - 10;
  line(PAGE.marginX, footerY + 20, PAGE.width - PAGE.marginX, footerY + 20, 0.5, COLORS.border);

  const footerText = client.footer_text || `Thank you for your business! — ${sanitizeForPdf(bizName)}`;
  const footerW = fontLight.widthOfTextAtSize(sanitizeForPdf(footerText), 8);
  text(footerText, (PAGE.width - footerW) / 2, footerY, { size: 8, font: fontLight, color: COLORS.secondary });

  const pageLabel = "Page 1 of 1";
  const pageW = fontRegular.widthOfTextAtSize(pageLabel, 7);
  text(pageLabel, PAGE.width - PAGE.marginX - pageW, footerY - 14, { size: 7, color: COLORS.border });

  return await pdfDoc.save();
}

// ─── Upload to Supabase Storage ──────────────────────────────────────────────
export async function uploadInvoicePdf(env, clientId, invoiceNumber, pdfBytes) {
  const bucket = env.INVOICE_BUCKET || "invoices";
  const path = `${clientId}/${invoiceNumber}.pdf`;
  const url = `${env.SUPABASE_URL}/storage/v1/object/${bucket}/${path}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/pdf",
      "x-upsert": "true",
    },
    body: pdfBytes,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "Unknown error");
    console.error(`[uploadInvoicePdf] Upload failed (${res.status}):`, errText);
    throw new Error(`PDF upload failed: ${res.status}`);
  }

  return `${env.SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`;
}

// ─── Utility: ArrayBuffer → Base64 ───────────────────────────────────────────
export function arrayBufferToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}