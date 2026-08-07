/**
 * lib/pdf.js — Professional, client-branded Invoice PDF
 * =======================================================
 * Accent color is 100% dynamic: sourced from `client.primary_color` (hex),
 * converted to pdf-lib RGB at render time. NO brand color is hardcoded.
 *
 * Exports:
 *   - generateInvoicePdf(client, invoice, lineItems, customer) → Uint8Array
 *   - uploadInvoicePdf(env, clientId, invoiceNumber, pdfBytes) → string
 *   - arrayBufferToBase64(buffer) → string
 */

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/* ─────────────────────────── Color utilities ─────────────────────────── */

// Neutral slate used ONLY when client.primary_color is missing/invalid.
const NEUTRAL_FALLBACK = rgb(17 / 255, 24 / 255, 39 / 255); // #111827

function hexToRgbColor(hex, fallback) {
  if (!hex || typeof hex !== "string") return fallback;
  let h = hex.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(h)) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return fallback;
  const n = parseInt(h, 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

// Darken overly-light accents so white/colored text stays readable.
function ensureContrast(c) {
  const lum = 0.2126 * c.red + 0.7152 * c.green + 0.0722 * c.blue;
  if (lum > 0.6) {
    const f = 0.55 / lum;
    return rgb(Math.min(1, c.red * f), Math.min(1, c.green * f), Math.min(1, c.blue * f));
  }
  return c;
}

// Blend a color toward white (f = 0..1) to derive light brand tints.
function tint(c, f) {
  return rgb(
    c.red + (1 - c.red) * f,
    c.green + (1 - c.green) * f,
    c.blue + (1 - c.blue) * f
  );
}

/* Static neutrals (non-branded) */
const PAGE_BG     = rgb(0.973, 0.973, 0.965);
const CARD_BG     = rgb(0.965, 0.965, 0.965);
const CARD_BORDER = rgb(0.89, 0.89, 0.89);
const LIGHT_LINE  = rgb(0.90, 0.90, 0.90);
const DARK        = rgb(0.12, 0.12, 0.12);
const GRAY        = rgb(0.33, 0.33, 0.33);
const MID_GRAY    = rgb(0.50, 0.50, 0.50);
const WHITE       = rgb(1, 1, 1);

/* ─────────────────────────── Page geometry (A4) ──────────────────────── */
const W = 595.28;
const H = 841.89;
const MX = 40;
const CW = W - MX * 2;
const RIGHT = W - MX;

const TBL = {
  descX: MX + 14,
  qtyRight: MX + 345,
  unitRight: MX + 445,
  totalRight: RIGHT - 14,
};

/* ─────────────────────────── SVG icons (24×24) ───────────────────────── */
const ICONS = {
  pin: "M12 2 C7.6 2 4.5 5.2 4.5 9.2 C4.5 14.5 12 22 12 22 C12 22 19.5 14.5 19.5 9.2 C19.5 5.2 16.4 2 12 2 Z M12 6.5 C13.4 6.5 14.5 7.6 14.5 9 C14.5 10.4 13.4 11.5 12 11.5 C10.6 11.5 9.5 10.4 9.5 9 C9.5 7.6 10.6 6.5 12 6.5 Z",
  phone: "M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z",
  email: "M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z",
  person: "M12 4 C9.79 4 8 5.79 8 8 C8 10.21 9.79 12 12 12 C14.21 12 16 10.21 16 8 C16 5.79 14.21 4 12 4 Z M12 14 C9.33 14 4 15.34 4 18 L4 20 L20 20 L20 18 C20 15.34 14.67 14 12 14 Z",
  store: "M20 4H4v2h16V4zm1 10v-2l-1-5H4l-1 5v2h1v6h10v-6h4v6h2v-6h1zm-9 4H6v-4h6v4z",
  calendar: "M17 3h-1V1h-2v2H8V1H6v2H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-1zm2 16H5V8h14v11z",
};

/* ─────────────────────────── Text/format helpers ─────────────────────── */

function sanitizeForPdf(str) {
  if (!str) return "";
  return String(str).replace(/[₦₵]/g, "").replace(/[^\x00-\xFF]/g, "");
}

function formatCurrency(amount, currency = "NGN") {
  const num = Number(amount || 0);
  const formatted = num.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const safe = { USD: "$", GBP: "£", EUR: "€", JPY: "¥", ZAR: "R" };
  const symbol = safe[currency] || `${currency} `;
  return `${symbol}${formatted}`;
}

function formatDate(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  if (isNaN(d)) return String(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

function truncate(str, max) {
  str = sanitizeForPdf(str || "");
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

// Rounded-rect SVG path with per-corner radii (origin = top-left, y down).
function rrPath(w, h, rTL, rTR, rBR, rBL) {
  const f = (n) => Number(n).toFixed(2);
  const k = (r) => r * 0.5523;
  return [
    `M ${f(rTL)} 0`,
    `L ${f(w - rTR)} 0`,
    `C ${f(w - rTR + k(rTR))} 0 ${f(w)} ${f(rTR - k(rTR))} ${f(w)} ${f(rTR)}`,
    `L ${f(w)} ${f(h - rBR)}`,
    `C ${f(w)} ${f(h - rBR + k(rBR))} ${f(w - rBR + k(rBR))} ${f(h)} ${f(w - rBR)} ${f(h)}`,
    `L ${f(rBL)} ${f(h)}`,
    `C ${f(rBL - k(rBL))} ${f(h)} 0 ${f(h - rBL + k(rBL))} 0 ${f(h - rBL)}`,
    `L 0 ${f(rTL)}`,
    `C 0 ${f(rTL - k(rTL))} ${f(rTL - k(rTL))} 0 ${f(rTL)} 0`,
    "Z",
  ].join(" ");
}

/* ═══════════════════════════ MAIN GENERATOR ═══════════════════════════ */

export async function generateInvoicePdf(client, invoice, lineItems, customer) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  /* ── DYNAMIC BRAND COLOR — single source of truth: client.primary_color ── */
  const ACCENT           = ensureContrast(hexToRgbColor(client.primary_color, NEUTRAL_FALLBACK));
  const ACCENT_ICON_BG   = tint(ACCENT, 0.88); // icon circles
  const ACCENT_CARD_BG   = tint(ACCENT, 0.93); // payment terms card
  const ACCENT_CARD_BD   = tint(ACCENT, 0.78); // payment terms border
  const STRIPE           = tint(ACCENT, 0.97); // alternating table rows

  const currency = client.currency || "ZAR";
  customer = customer || {};
  lineItems = lineItems || [];

  let page = null;
  let y = 0;

  /* ── drawing primitives ─────────────────────────────────────────────── */

  const text = (str, x, yPos, o = {}) => {
    const { size = 9, f = font, color = DARK, maxWidth, lineHeight } = o;
    const safe = sanitizeForPdf(str);
    const opts = { x, y: yPos, size, font: f, color };
    if (maxWidth) { opts.maxWidth = maxWidth; opts.lineHeight = lineHeight || size * 1.4; }
    try { page.drawText(safe, opts); }
    catch (e) { try { page.drawText(safe.replace(/[^\x00-\x7F]/g, ""), opts); } catch (e2) {} }
  };

  const width = (str, size, f = font) => f.widthOfTextAtSize(sanitizeForPdf(str), size);

  const textRight = (str, xRight, yPos, o = {}) => {
    const size = o.size || 9;
    text(str, xRight - width(str, size, o.f || font), yPos, o);
  };

  const line = (x1, y1, x2, y2, thickness = 0.6, color = LIGHT_LINE, dash) => {
    const o = { start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color };
    if (dash) o.borderDashArray = dash;
    page.drawLine(o);
  };

  const rect = (x, yTop, w, h, color) =>
    page.drawRectangle({ x, y: yTop - h, width: w, height: h, color });

  const roundedRect = (x, yTop, w, h, r, o = {}) => {
    try {
      page.drawSvgPath(rrPath(w, h, r, r, r, r), {
        x, y: yTop, color: o.color, borderColor: o.borderColor, borderWidth: o.borderWidth || 0,
      });
    } catch (e) {
      if (o.color) rect(x, yTop, w, h, o.color);
    }
  };

  // Icon anchored by its CENTER (centerY) so it aligns with text baselines.
  const icon = (name, x, centerY, size, color) => {
    try {
      page.drawSvgPath(ICONS[name], { x, y: centerY + size / 2, scale: size / 24, color });
    } catch (e) {}
  };

  const circle = (cx, cy, r, color) => page.drawCircle({ x: cx, y: cy, size: r, color });

  /* ── page management ────────────────────────────────────────────────── */

  const startPage = (cont = false) => {
    page = pdfDoc.addPage([W, H]);
    rect(0, H, W, 10, ACCENT); // top brand bar
    rect(0, H - 10, W, H - 10, PAGE_BG);
    y = H - 55;
    if (cont) {
      text(client.business_name || client.name || "Invoice", MX, y, { size: 12, f: bold });
      textRight(`Invoice #${invoice.invoice_number || ""}`, RIGHT, y, { size: 10, f: bold, color: ACCENT });
      y -= 30;
    }
  };

  /* ══ PAGE 1 — HEADER ══════════════════════════════════════════════════ */
  startPage();

  let logoW = 0;
  try {
    if (client.logo_url) {
      const res = await fetch(client.logo_url);
      if (res.ok) {
        const buf = await res.arrayBuffer();
        const ctype = (res.headers.get("content-type") || "").toLowerCase();
        const img = ctype.includes("jpeg") || /\.jpe?g(\?|$)/i.test(client.logo_url)
          ? await pdfDoc.embedJpg(buf)
          : await pdfDoc.embedPng(buf);
        if (img) {
          const lh = 64;
          let lw = (img.width / img.height) * lh;
          if (lw > 90) lw = 90;
          page.drawImage(img, { x: MX, y: y - lh, width: lw, height: lh });
          logoW = lw;
        }
      }
    }
  } catch (e) { logoW = 0; }

  if (!logoW) {
    const initials = (client.business_name || client.name || "M G")
      .split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
    roundedRect(MX, y, 56, 56, 8, { color: ACCENT });
    text(initials, MX + 28 - width(initials, 22, bold) / 2, y - 30, { size: 22, f: bold, color: WHITE });
    logoW = 56;
  }

  const textX = MX + logoW + 30;
  line(MX + logoW + 15, y - 62, MX + logoW + 15, y + 2, 0.8, LIGHT_LINE);

  text(client.business_name || client.name || "Your Business", textX, y - 8, { size: 16, f: bold });

  let cy = y - 28;
  const contactLines = [];
  if (client.address) contactLines.push(["pin", client.address]);
  if (client.phone) contactLines.push(["phone", client.phone]);
  if (client.email) contactLines.push(["email", client.email]);
  for (const [ic, val] of contactLines.slice(0, 3)) {
    icon(ic, textX, cy + 3, 11, DARK);
    text(val, textX + 17, cy, { size: 9, color: GRAY });
    cy -= 16;
  }

  textRight("INVOICE", RIGHT, y - 12, { size: 34, f: bold, color: ACCENT });

  /* ── meta row — dividers sit BETWEEN columns (left of next label) ───── */
  const metaY = y - 52;
  const cols = [
    { label: "Invoice No", value: `#${invoice.invoice_number || "—"}`, x: 320 },
    { label: "Issued",     value: formatDate(invoice.created_at),      x: 420 },
    { label: "Due",        value: formatDate(invoice.due_at),          x: 500 },
  ];
  cols.forEach((c, i) => {
    text(c.label, c.x, metaY, { size: 8.5, color: MID_GRAY });
    text(c.value, c.x, metaY - 14, { size: 9.5, f: bold, color: ACCENT });
    if (i < cols.length - 1) {
      const sepX = cols[i + 1].x - 14; // ← divider moved left of the next column
      line(sepX, metaY + 8, sepX, metaY - 20, 0.6, LIGHT_LINE);
    }
  });

  y = metaY - 46;

  /* ══ BILL TO / FROM CARDS ═════════════════════════════════════════════ */
  const cardW = (CW - 20) / 2;
  const cardH = 120;
  const cardTop = y;

  roundedRect(MX, cardTop, cardW, cardH, 8, { color: CARD_BG, borderColor: CARD_BORDER, borderWidth: 0.8 });
  circle(MX + 36, cardTop - 40, 16, ACCENT_ICON_BG);
  icon("person", MX + 27, cardTop - 40, 18, ACCENT);
  text("BILL TO", MX + 64, cardTop - 32, { size: 8.5, f: bold, color: ACCENT });
  text(customer.name || customer.full_name || "Customer", MX + 64, cardTop - 52, { size: 11, f: bold });
  let by = cardTop - 70;
  if (customer.email) { text(customer.email, MX + 64, by, { size: 9, color: GRAY }); by -= 15; }
  if (customer.phone) { text(customer.phone, MX + 64, by, { size: 9, color: GRAY }); }

  const fx = MX + cardW + 20;
  roundedRect(fx, cardTop, cardW, cardH, 8, { color: CARD_BG, borderColor: CARD_BORDER, borderWidth: 0.8 });
  circle(fx + 36, cardTop - 40, 16, ACCENT_ICON_BG);
  icon("store", fx + 27, cardTop - 40, 18, ACCENT);
  text("FROM", fx + 64, cardTop - 32, { size: 8.5, f: bold, color: ACCENT });
  text(client.business_name || client.name || "Your Business", fx + 64, cardTop - 52, { size: 11, f: bold });
  let fy = cardTop - 70;
  if (client.address) { text(client.address, fx + 64, fy, { size: 9, color: GRAY, maxWidth: cardW - 74 }); fy -= 15; }
  if (client.phone) { text(client.phone, fx + 64, fy, { size: 9, color: GRAY }); fy -= 15; }
  if (client.email) { text(client.email, fx + 64, fy, { size: 9, color: GRAY }); }

  y = cardTop - cardH - 28;

  /* ══ LINE ITEMS TABLE — fully rounded ═════════════════════════════════ */
  const headerH = 26;
  const rowH = 32;
  const R = 8;
  let tableSegTop = y;

  const drawTableHeader = () => {
    tableSegTop = y;
    page.drawSvgPath(rrPath(CW, headerH, R, R, 0, 0), { x: MX, y, color: ACCENT });
    const ty = y - 17;
    text("DESCRIPTION", TBL.descX, ty, { size: 8.5, f: bold, color: WHITE });
    textRight("QTY", TBL.qtyRight, ty, { size: 8.5, f: bold, color: WHITE });
    textRight("UNIT PRICE", TBL.unitRight, ty, { size: 8.5, f: bold, color: WHITE });
    textRight("TOTAL", TBL.totalRight, ty, { size: 8.5, f: bold, color: WHITE });
    y -= headerH;
  };

  const closeTableSegment = (roundedBottom) => {
    const h = tableSegTop - y;
    if (h <= 0) return;
    const rB = roundedBottom ? R : 0;
    try {
      page.drawSvgPath(rrPath(CW, h, R, R, rB, rB), {
        x: MX, y: tableSegTop, borderColor: CARD_BORDER, borderWidth: 0.8,
      });
    } catch (e) {
      page.drawRectangle({ x: MX, y: tableSegTop - h, width: CW, height: h, borderColor: CARD_BORDER, borderWidth: 0.8 });
    }
  };

  drawTableHeader();

  if (!lineItems.length) {
    rect(MX + 0.8, y, CW - 1.6, rowH, WHITE);
    text("No items", TBL.descX, y - 20, { size: 9.5, color: MID_GRAY });
    y -= rowH;
  }

  lineItems.forEach((item, idx) => {
    const isLast = idx === lineItems.length - 1;

    if (y - rowH < 70) {           // page break mid-table
      closeTableSegment(false);
      startPage(true);
      drawTableHeader();
    }

    const rowTop = y;
    const stripe = idx % 2 === 1 ? STRIPE : WHITE;
    if (isLast) {
      // rounded bottom corners on the final row fill
      try {
        page.drawSvgPath(rrPath(CW - 1.6, rowH, 0, 0, R - 1, R - 1), { x: MX + 0.8, y: rowTop, color: stripe });
      } catch (e) { rect(MX + 0.8, rowTop, CW - 1.6, rowH, stripe); }
    } else {
      rect(MX + 0.8, rowTop, CW - 1.6, rowH, stripe);
    }

    text(truncate(item.description || "Item", 62), TBL.descX, rowTop - 20, { size: 9.5 });
    textRight(String(item.quantity || 0), TBL.qtyRight, rowTop - 20, { size: 9.5 });
    textRight(formatCurrency(item.unit_price, currency), TBL.unitRight, rowTop - 20, { size: 9.5 });
    const lt = Number(item.line_total ?? (Number(item.quantity || 0) * Number(item.unit_price || 0)));
    textRight(formatCurrency(lt, currency), TBL.totalRight, rowTop - 20, { size: 9.5, f: bold });

    y -= rowH;
    if (!isLast) line(MX + 1, y, RIGHT - 1, y, 0.5, LIGHT_LINE);
  });

  closeTableSegment(true);
  y -= 26;

  /* ══ TOTALS ═══════════════════════════════════════════════════════════ */
  if (y - 160 < 70) startPage(true);

  const totX = MX + 285;
  text("Subtotal", totX, y, { size: 9.5, f: bold });
  textRight(formatCurrency(invoice.subtotal, currency), RIGHT, y, { size: 9.5 });
  y -= 20;
  text("Tax", totX, y, { size: 9.5, f: bold });
  textRight(formatCurrency(invoice.tax, currency), RIGHT, y, { size: 9.5 });
  y -= 14;

  roundedRect(totX - 15, y, RIGHT - totX + 15, 38, 6, { color: ACCENT });
  text("Total", totX, y - 25, { size: 12, f: bold, color: WHITE });
  textRight(formatCurrency(invoice.total, currency), RIGHT - 14, y - 26, { size: 13, f: bold, color: WHITE });

  y -= 66;

  /* ══ BANKING DETAILS + PAYMENT TERMS — top-aligned ════════════════════ */
  if (y - 240 < 70) startPage(true);

  const sectionTop = y; // shared top edge for both blocks

  // Left: banking details
  text("BANKING DETAILS", MX, sectionTop, { size: 9, f: bold, color: ACCENT });
  line(MX, sectionTop - 6, MX + 330, sectionTop - 6, 1, ACCENT);

  // Right: payment terms card — top edge aligned with the heading
  const ptW = 165;
  const ptX = RIGHT - ptW;
  const ptH = 118;
  const ptTop = sectionTop + 7;
  roundedRect(ptX, ptTop, ptW, ptH, 8, { color: ACCENT_CARD_BG, borderColor: ACCENT_CARD_BD, borderWidth: 0.8 });

  const ptTitleY = ptTop - 27;
  icon("calendar", ptX + 14, ptTitleY + 3, 15, ACCENT); // centered on the label
  text("PAYMENT TERMS", ptX + 38, ptTitleY, { size: 8.5, f: bold, color: ACCENT });

  const status = (invoice.status || "").toLowerCase();
  const dueLine = status === "paid"
    ? "This invoice has been paid in full."
    : `Payment is due by ${formatDate(invoice.due_at)}.`;
  text(dueLine, ptX + 14, ptTitleY - 24, { size: 9, color: GRAY, maxWidth: ptW - 28 });
  text("Thank you for your business!", ptX + 14, ptTitleY - 56, { size: 9, color: GRAY, maxWidth: ptW - 28 });

  // Banking rows (kept clear of the card)
  const banking = client.banking || client.banking_details || {};
  const bankRows = [
    ["Account Name", banking.account_name || client.bank_account_name || client.business_name || "", "Branch Code", banking.branch_code || client.bank_branch_code || ""],
    ["Bank Name", banking.bank_name || client.bank_name || "", "Account Type", banking.account_type || client.bank_account_type || ""],
    ["Account Number", banking.account_number || client.bank_account_number || "", "Reference", invoice.invoice_number || ""],
  ].filter((r) => r[1] || r[3]);

  const freeText = !bankRows.length ? (client.payment_instructions || client.bank_details) : null;

  let leftBottom = sectionTop;
  if (bankRows.length) {
    let ry = sectionTop - 28;
    for (const [l1, v1, l2, v2] of bankRows) {
      text(l1, MX, ry, { size: 9, color: GRAY });
      text(v1, MX + 100, ry, { size: 9, f: bold });
      text(l2, MX + 200, ry, { size: 9, color: GRAY });
      text(v2, MX + 278, ry, { size: 9, f: bold });
      ry -= 26;
    }
    leftBottom = ry;
  } else if (freeText) {
    text(freeText, MX, sectionTop - 28, { size: 9, color: GRAY, maxWidth: 330 });
    leftBottom = sectionTop - 88;
  }

  y = Math.min(leftBottom, ptTop - ptH) - 34;

  /* ══ FOOTER ═══════════════════════════════════════════════════════════ */
  line(MX, 120, RIGHT, 120, 0.8, rgb(0.8, 0.8, 0.8), [4, 3]);

  text("Thank you!", MX, 98, { size: 10, f: bold, color: ACCENT });
  text("We appreciate your business.", MX, 82, { size: 9, color: GRAY });

  const brand = "My Grafix Media";
  const poweredPlain = "Powered by ";
  const w1 = width(poweredPlain, 9);
  const w2 = width(brand, 9, bold);
  text(poweredPlain, RIGHT - w1 - w2, 98, { size: 9, color: GRAY });
  text(brand, RIGHT - w2, 98, { size: 9, f: bold, color: ACCENT });
  textRight("Design. Build. Automate.", RIGHT, 82, { size: 9, color: MID_GRAY });

  return await pdfDoc.save();
}

/* ─────────────────────────── Upload (unchanged) ──────────────────────── */

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

export function arrayBufferToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}