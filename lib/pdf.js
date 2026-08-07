/**
 * Invoice PDF Generator
 * Clean, professional layout with proper spacing
 */

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import {
  PDF_PAGE_WIDTH,
  PDF_PAGE_HEIGHT,
  PDF_MARGIN,
} from "../config/constants.js";
import { formatMoney } from "./utils.js";

const BLACK = rgb(0, 0, 0);
const DARK_GRAY = rgb(0.2, 0.2, 0.2);
const MED_GRAY = rgb(0.5, 0.5, 0.5);
const LIGHT_GRAY = rgb(0.85, 0.85, 0.85);
const WHITE = rgb(1, 1, 1);

function hexToRgb(hex) {
  if (!hex || typeof hex !== "string") return null;
  const m = hex.trim().replace(/^#/, "").match(/^([0-9a-fA-F]{6})$/);
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return rgb(((v >> 16) & 0xff) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255);
}

function lighten(hex, amt = 0.85) {
  const base = hexToRgb(hex);
  if (!base) return LIGHT_GRAY;
  const c = (x) => x + (1 - x) * amt;
  return rgb(c(base.red), c(base.green), c(base.blue));
}

function drawRect(page, x, y, w, h, r, fill, border) {
  const mr = Math.min(r, w / 2, h / 2);
  const p = `M ${mr} 0 L ${w - mr} 0 Q ${w} 0 ${w} ${mr} L ${w} ${h - mr} Q ${w} ${h} ${w - mr} ${h} L ${mr} ${h} Q 0 ${h} 0 ${h - mr} L 0 ${mr} Q 0 0 ${mr} 0 Z`;
  page.drawSvgPath(p, { x, y, color: fill, borderColor: border, borderWidth: 1 });
}

function drawRight(page, text, x, y, size, font, color) {
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: x - w, y, size, font, color });
}

function truncate(font, text, size, max) {
  if (font.widthOfTextAtSize(text, size) <= max) return text;
  let r = text;
  while (r.length > 1 && font.widthOfTextAtSize(r + "…", size) > max) r = r.slice(0, -1);
  return r + "…";
}

function fmtDate(v) {
  try {
    return new Date(v).toLocaleDateString("en-ZA", { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

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

export async function generateInvoicePdf(client, invoice, lineItems, customer) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const brand = hexToRgb(client.primary_color) || rgb(0.42, 0.56, 0.14);
  const brandLight = lighten(client.primary_color, 0.92);

  const L = PDF_MARGIN;
  const R = PDF_PAGE_WIDTH - PDF_MARGIN;
  const W = R - L;
  const M = L + W / 2;

  const FOOTER_HEIGHT = 90;
  const CONTENT_BOTTOM = FOOTER_HEIGHT + 10;

  let y = PDF_PAGE_HEIGHT - 60;

  // ─── HEADER ────────────────────────────────────────────────────────────
  const logo = await embedLogo(doc, client.logo_url);
  if (logo) {
    const h = 45;
    const w = Math.min((logo.width / logo.height) * h, 130);
    page.drawImage(logo, { x: L, y: y - h, width: w, height: h });
  }

  const infoX = logo ? L + 150 : L;
  page.drawText(client.business_name || "", {
    x: infoX,
    y: y - 10,
    size: 18,
    font: bold,
    color: BLACK,
  });

  const contacts = [client.address, client.phone, client.owner_email || client.reply_email].filter(Boolean);
  let cy = y - 26;
  for (const line of contacts.slice(0, 3)) {
    page.drawText(line, { x: infoX, y: cy, size: 10, font, color: MED_GRAY });
    cy -= 14;
  }

  const tSize = 36;
  const tW = bold.widthOfTextAtSize("INVOICE", tSize);
  page.drawText("INVOICE", { x: R - tW, y: y - 10, size: tSize, font: bold, color: brand });

  y -= 90;

  // Meta columns (right-aligned)
  const metaW = 110;
  const metaItems = [
    { label: "Invoice Number", value: invoice.invoice_number || "" },
    { label: "Issue Date", value: fmtDate(invoice.issued_at || invoice.created_at) },
    { label: "Due Date", value: invoice.due_at ? fmtDate(invoice.due_at) : "—" },
  ];

  metaItems.forEach((item, i) => {
    const colX = R - (i + 1) * metaW;
    page.drawText(item.label, { x: colX, y: y, size: 9, font, color: MED_GRAY });
    page.drawText(item.value, { x: colX, y: y - 16, size: 11, font: bold, color: DARK_GRAY });
  });

  y -= 60;

  // Divider
  page.drawLine({ start: { x: L, y }, end: { x: R, y }, thickness: 1, color: LIGHT_GRAY });
  y -= 40;

  // ─── BILL TO / FROM CARDS ─────────────────────────────────────────────
  const cardH = 90;
  const gap = 20;
  const cardW = (W - gap) / 2;

  // BILL TO card
  const billToCardY = y - cardH;
  drawRect(page, L, billToCardY, cardW, cardH, 8, WHITE, LIGHT_GRAY);
  page.drawText("Bill To", { x: L + 16, y: billToCardY + cardH - 20, size: 10, font: bold, color: brand });
  page.drawText(customer.name || "", { x: L + 16, y: billToCardY + cardH - 38, size: 14, font: bold, color: BLACK });
  page.drawText(customer.email || "", { x: L + 16, y: billToCardY + cardH - 56, size: 10, font, color: MED_GRAY });

  // FROM card
  const fromX = M + gap / 2;
  const fromCardY = y - cardH;
  drawRect(page, fromX, fromCardY, cardW, cardH, 8, WHITE, LIGHT_GRAY);
  page.drawText("From", { x: fromX + 16, y: fromCardY + cardH - 20, size: 10, font: bold, color: brand });
  page.drawText(client.business_name || "", { x: fromX + 16, y: fromCardY + cardH - 38, size: 14, font: bold, color: BLACK });

  const fromLines = [client.address, client.phone, client.owner_email || client.reply_email].filter(Boolean);
  let fy = fromCardY + cardH - 56;
  for (const line of fromLines.slice(0, 3)) {
    page.drawText(truncate(font, line, 10, cardW - 32), { x: fromX + 16, y: fy, size: 10, font, color: MED_GRAY });
    fy -= 14;
  }

  y -= cardH + 30;

  // ─── ITEM TABLE ───────────────────────────────────────────────────────
  const colDesc = L + 16;
  const colQty = R - 150;
  const colPrice = R - 100;
  const colTotal = R - 16;
  const headerH = 36;

  // Header
  const tableHeaderY = y - headerH;
  drawRect(page, L, tableHeaderY, W, headerH, 8, brand);
  const hY = tableHeaderY + 12;
  page.drawText("Description", { x: colDesc, y: hY, size: 11, font: bold, color: WHITE });
  drawRight(page, "Qty", colQty + 20, hY, 11, bold, WHITE);
  drawRight(page, "Unit Price", colPrice + 20, hY, 11, bold, WHITE);
  drawRight(page, "Total", colTotal, hY, 11, bold, WHITE);

  y -= headerH + 10;

  // Rows
  const rowH = 40;
  for (let i = 0; i < lineItems.length; i++) {
    const item = lineItems[i];
    if (y - rowH < CONTENT_BOTTOM) break;

    if (i % 2 === 0) {
      drawRect(page, L, y - rowH, W, rowH, 0, rgb(0.96, 0.96, 0.96));
    }

    const rY = y - 28;
    page.drawText(truncate(font, item.description || "", 11, 300), { x: colDesc, y: rY, size: 11, font, color: BLACK });
    drawRight(page, String(item.quantity), colQty + 20, rY, 11, font, DARK_GRAY);
    drawRight(page, formatMoney(item.unit_price), colPrice + 20, rY, 11, font, DARK_GRAY);
    drawRight(page, formatMoney(item.line_total), colTotal, rY, 11, bold, BLACK);

    y -= rowH;
  }

  y -= 30;

  // ─── TOTALS ────────────────────────────────────────────────────────────
  const totW = 240;
  const totX = R - totW;
  const totGap = 14;

  page.drawText("Subtotal", { x: totX, y: y, size: 11, font, color: MED_GRAY });
  drawRight(page, formatMoney(invoice.subtotal), R, y, 11, font, DARK_GRAY);
  y -= totGap + 10;

  page.drawText("Tax", { x: totX, y: y, size: 11, font, color: MED_GRAY });
  drawRight(page, formatMoney(invoice.tax), R, y, 11, font, DARK_GRAY);
  y -= totGap + 10;

  if (typeof invoice.discount === "number" && invoice.discount > 0) {
    page.drawText("Discount", { x: totX, y: y, size: 11, font, color: MED_GRAY });
    drawRight(page, `-${formatMoney(invoice.discount)}`, R, y, 11, font, DARK_GRAY);
    y -= totGap + 10;
  }

  // Divider
  page.drawLine({ start: { x: totX, y: y + 6 }, end: { x: R, y: y + 6 }, thickness: 1, color: LIGHT_GRAY });
  y -= 24;

  // Grand total box
  const boxH = 52;
  const totalBoxY = y - boxH;
  drawRect(page, totX, totalBoxY, totW, boxH, 8, brand);
  page.drawText("Total", { x: totX + 16, y: totalBoxY + 18, size: 14, font: bold, color: WHITE });
  drawRight(page, formatMoney(invoice.total), R - 16, totalBoxY + 18, 16, bold, WHITE);

  y -= boxH + 30;

  // ─── BANKING DETAILS ───────────────────────────────────────────────────
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
    const maxRows = Math.max(bankLeft.length, bankRight.length);
    const bankH = 40 + maxRows * 28;
    const bankCardY = y - bankH;
    drawRect(page, L, bankCardY, W, bankH, 8, WHITE, LIGHT_GRAY);

    page.drawText("Banking Details", { x: L + 16, y: bankCardY + bankH - 22, size: 10, font: bold, color: brand });

    const col1 = L + 16;
    const col2 = M + 10;
    const labelStartY = bankCardY + bankH - 44;
    const rowGap = 28;

    bankLeft.forEach((item, i) => {
      const rY = labelStartY - i * rowGap;
      page.drawText(item.label, { x: col1, y: rY, size: 9, font, color: MED_GRAY });
      page.drawText(truncate(font, item.value, 11, 200), { x: col1, y: rY - 16, size: 11, font: bold, color: BLACK });
    });

    bankRight.forEach((item, i) => {
      const rY = labelStartY - i * rowGap;
      page.drawText(item.label, { x: col2, y: rY, size: 9, font, color: MED_GRAY });
      page.drawText(truncate(font, item.value, 11, 200), { x: col2, y: rY - 16, size: 11, font: bold, color: BLACK });
    });

    y -= bankH + 30;
  }

  // ── PAYMENT TERMS ─────────────────────────────────────────────────────
  if (client.payment_instructions || invoice.due_at) {
    const termsW = 300;
    const termsH = 90;
    const termsX = R - termsW;
    const termsY = y - termsH;

    if (termsY > CONTENT_BOTTOM) {
      drawRect(page, termsX, termsY, termsW, termsH, 8, brandLight, LIGHT_GRAY);

      page.drawText("Payment Terms", { x: termsX + 16, y: termsY + termsH - 22, size: 10, font: bold, color: brand });

      let ty = termsY + termsH - 40;
      if (invoice.due_at) {
        page.drawText(`Payment is due by ${fmtDate(invoice.due_at)}.`, { x: termsX + 16, y: ty, size: 10, font, color: DARK_GRAY });
        ty -= 18;
      }
      if (client.payment_instructions) {
        const words = client.payment_instructions.split(/\s+/);
        let line = "";
        const lines = [];
        for (const w of words) {
          const c = line ? `${line} ${w}` : w;
          if (font.widthOfTextAtSize(c, 10) > termsW - 32 && line) {
            lines.push(line);
            line = w;
          } else line = c;
        }
        if (line) lines.push(line);
        for (const l of lines.slice(0, 3)) {
          if (ty < termsY + 14) break;
          page.drawText(l, { x: termsX + 16, y: ty, size: 10, font, color: MED_GRAY });
          ty -= 16;
        }
      }

      y = termsY - 30;
    }
  }

  // ── FOOTER ────────────────────────────────────────────────────────────
  const footerY = Math.max(CONTENT_BOTTOM, y - 20);
  page.drawLine({ start: { x: L, y: footerY }, end: { x: R, y: footerY }, thickness: 1, color: LIGHT_GRAY });

  const thankText = "Thank you!";
  const thankW = bold.widthOfTextAtSize(thankText, 14);
  page.drawText(thankText, { x: (PDF_PAGE_WIDTH - thankW) / 2, y: footerY - 26, size: 14, font: bold, color: brand });

  const appText = "We appreciate your business.";
  const appW = font.widthOfTextAtSize(appText, 10);
  page.drawText(appText, { x: (PDF_PAGE_WIDTH - appW) / 2, y: footerY - 44, size: 10, font, color: MED_GRAY });

  const powText = "Powered by My Grafix Media";
  const powW = font.widthOfTextAtSize(powText, 9);
  page.drawText(powText, { x: R - powW, y: footerY - 64, size: 9, font, color: MED_GRAY });

  const tagText = "Design. Build. Automate.";
  const tagW = font.widthOfTextAtSize(tagText, 9);
  page.drawText(tagText, { x: R - tagW, y: footerY - 78, size: 9, font, color: MED_GRAY });

  return doc.save();
}

export async function uploadInvoicePdf(env, clientId, invoiceNumber, pdfBytes) {
  const key = `clients/${clientId}/invoices/${invoiceNumber}.pdf`;
  await env.R2_BUCKET.put(key, pdfBytes, { httpMetadata: { contentType: "application/pdf" } });
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
