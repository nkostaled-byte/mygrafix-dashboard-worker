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

const TEXT_COLOR = rgb(0.13, 0.13, 0.13);
const MUTED_COLOR = rgb(0.45, 0.45, 0.45);
const LINE_COLOR = rgb(0.82, 0.82, 0.82);

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

  let y = PDF_PAGE_HEIGHT - PDF_MARGIN;

  // ---- Header: logo + business name ----
  const logoImage = await tryEmbedLogo(pdfDoc, client.logo_url);
  if (logoImage) {
    const logoHeight = 44;
    const logoWidth = (logoImage.width / logoImage.height) * logoHeight;
    page.drawImage(logoImage, {
      x: PDF_MARGIN,
      y: y - logoHeight,
      width: logoWidth,
      height: logoHeight,
    });
  }

  page.drawText(client.business_name || "", {
    x: PDF_MARGIN,
    y: y - 60,
    size: 12,
    font: boldFont,
    color: TEXT_COLOR,
  });

  // "INVOICE" title, right-aligned
  const invoiceTitle = "INVOICE";
  const titleWidth = boldFont.widthOfTextAtSize(invoiceTitle, 22);
  page.drawText(invoiceTitle, {
    x: PDF_PAGE_WIDTH - PDF_MARGIN - titleWidth,
    y: y - 10,
    size: 22,
    font: boldFont,
    color: TEXT_COLOR,
  });

  const invoiceNumberText = `#${invoice.invoice_number}`;
  const invoiceNumberWidth = font.widthOfTextAtSize(invoiceNumberText, 11);
  page.drawText(invoiceNumberText, {
    x: PDF_PAGE_WIDTH - PDF_MARGIN - invoiceNumberWidth,
    y: y - 28,
    size: 11,
    font,
    color: MUTED_COLOR,
  });

  y -= 90;

  // ---- Dates + Bill To ----
  const issuedDate = new Date(
    invoice.issued_at || invoice.created_at || Date.now()
  ).toLocaleDateString();
  page.drawText(`Issued: ${issuedDate}`, {
    x: PDF_MARGIN,
    y,
    size: 10,
    font,
    color: MUTED_COLOR,
  });
  if (invoice.due_at) {
    page.drawText(`Due: ${new Date(invoice.due_at).toLocaleDateString()}`, {
      x: PDF_MARGIN,
      y: y - 14,
      size: 10,
      font,
      color: MUTED_COLOR,
    });
  }

  const billToX = 320;
  page.drawText("Bill To", {
    x: billToX,
    y,
    size: 10,
    font: boldFont,
    color: TEXT_COLOR,
  });
  page.drawText(customer.name || "", {
    x: billToX,
    y: y - 14,
    size: 10,
    font,
    color: TEXT_COLOR,
  });
  let billToY = y - 28;
  if (customer.email) {
    page.drawText(customer.email, {
      x: billToX,
      y: billToY,
      size: 10,
      font,
      color: MUTED_COLOR,
    });
    billToY -= 14;
  }
  if (customer.phone) {
    page.drawText(customer.phone, {
      x: billToX,
      y: billToY,
      size: 10,
      font,
      color: MUTED_COLOR,
    });
  }

  y -= 60;

  // ---- Itemized table ----
  const col = {
    desc: PDF_MARGIN,
    qty: 340,
    price: 400,
    total: 480,
  };
  page.drawText("Description", {
    x: col.desc,
    y,
    size: 9,
    font: boldFont,
    color: MUTED_COLOR,
  });
  page.drawText("Qty", { x: col.qty, y, size: 9, font: boldFont, color: MUTED_COLOR });
  page.drawText("Price", {
    x: col.price,
    y,
    size: 9,
    font: boldFont,
    color: MUTED_COLOR,
  });
  page.drawText("Total", {
    x: col.total,
    y,
    size: 9,
    font: boldFont,
    color: MUTED_COLOR,
  });
  y -= 6;
  page.drawLine({
    start: { x: PDF_MARGIN, y },
    end: { x: PDF_PAGE_WIDTH - PDF_MARGIN, y },
    thickness: 0.75,
    color: LINE_COLOR,
  });
  y -= 18;

  for (const item of lineItems) {
    if (y < PDF_LINE_Y_THRESHOLD) break;
    page.drawText(truncateText(font, item.description || "", 9, 260), {
      x: col.desc,
      y,
      size: 9,
      font,
      color: TEXT_COLOR,
    });
    page.drawText(String(item.quantity), {
      x: col.qty,
      y,
      size: 9,
      font,
      color: TEXT_COLOR,
    });
    page.drawText(formatMoney(item.unit_price), {
      x: col.price,
      y,
      size: 9,
      font,
      color: TEXT_COLOR,
    });
    page.drawText(formatMoney(item.line_total), {
      x: col.total,
      y,
      size: 9,
      font,
      color: TEXT_COLOR,
    });
    y -= 18;
  }

  y -= 8;
  page.drawLine({
    start: { x: PDF_MARGIN, y },
    end: { x: PDF_PAGE_WIDTH - PDF_MARGIN, y },
    thickness: 0.75,
    color: LINE_COLOR,
  });
  y -= 22;

  // ---- Totals ----
  drawRightAligned(page, font, `Subtotal   ${formatMoney(invoice.subtotal)}`, y, 10, MUTED_COLOR);
  y -= 16;
  drawRightAligned(page, font, `Tax   ${formatMoney(invoice.tax)}`, y, 10, MUTED_COLOR);
  y -= 20;
  drawRightAligned(page, boldFont, `Total   ${formatMoney(invoice.total)}`, y, 13, TEXT_COLOR);

  y -= 50;

  // ---- Banking details ----
  if (client.bank_name || client.bank_account_number) {
    page.drawText("Banking Details", {
      x: PDF_MARGIN,
      y,
      size: 10,
      font: boldFont,
      color: TEXT_COLOR,
    });
    y -= 16;
    const bankLines = [
      client.bank_name ? `Bank: ${client.bank_name}` : null,
      client.bank_account_name ? `Account Name: ${client.bank_account_name}` : null,
      client.bank_account_number ? `Account Number: ${client.bank_account_number}` : null,
      client.bank_branch_code ? `Branch Code: ${client.bank_branch_code}` : null,
    ].filter(Boolean);

    for (const line of bankLines) {
      page.drawText(line, {
        x: PDF_MARGIN,
        y,
        size: 9,
        font,
        color: MUTED_COLOR,
      });
      y -= 13;
    }
    y -= 10;
  }

  // ---- Payment instructions ----
  if (client.payment_instructions) {
    page.drawText("Payment Instructions", {
      x: PDF_MARGIN,
      y,
      size: 10,
      font: boldFont,
      color: TEXT_COLOR,
    });
    y -= 16;
    const wrapped = wrapText(font, client.payment_instructions, 9, PDF_PAGE_WIDTH - PDF_MARGIN * 2);
    for (const line of wrapped) {
      page.drawText(line, {
        x: PDF_MARGIN,
        y,
        size: 9,
        font,
        color: MUTED_COLOR,
      });
      y -= 13;
    }
  }

  return pdfDoc.save();
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

function drawRightAligned(page, font, text, y, size, color) {
  const width = font.widthOfTextAtSize(text, size);
  page.drawText(text, {
    x: PDF_PAGE_WIDTH - PDF_MARGIN - width,
    y,
    size,
    font,
    color,
  });
}

function truncateText(font, text, size, maxWidth) {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let result = text;
  while (result.length > 1 && font.widthOfTextAtSize(result + "\u2026", size) > maxWidth) {
    result = result.slice(0, -1);
  }
  return result + "\u2026";
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

