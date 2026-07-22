/**
 * Email Content Builders + Resend Integration
 * ============================================
 * All email-related functionality: content generation and sending via Resend.
 */

import { FORM_COPY, DEFAULT_FORM_COPY } from "../config/constants.js";
import { escapeHtml, formatMoney } from "./utils.js";

// ==================================================
// EMAIL CONTENT BUILDERS
// ==================================================

export function getFormCopy(formName) {
  const key = String(formName || "").toLowerCase().trim();
  return FORM_COPY[key] || DEFAULT_FORM_COPY;
}

export function buildFromAddress(client) {
  const name = escapeHtml(client.business_name || "My Grafix Media");
  return `${name} <hello@mygrafixmedia.online>`;
}

function buildFieldsHtml(fields) {
  if (!fields || Object.keys(fields).length === 0) {
    return "";
  }

  const rows = Object.entries(fields)
    .map(
      ([key, value]) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600;color:#333;">${escapeHtml(key)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#555;">${escapeHtml(formatFieldValue(value))}</td>
        </tr>`
    )
    .join("");

  return `
    <table style="width:100%;border-collapse:collapse;margin-top:16px;">
      ${rows}
    </table>`;
}

function formatFieldValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function buildEmailShell(client, bodyHtml) {
  const businessName = escapeHtml(client.business_name || "");
  const primaryColor = escapeHtml(client.primary_color || "#111111");
  const secondaryColor = escapeHtml(client.secondary_color || "#f5f5f5");
  const logoUrl = client.logo_url ? escapeHtml(client.logo_url) : "";

  return `
  <div style="font-family:Arial, Helvetica, sans-serif;max-width:600px;margin:0 auto;background:${secondaryColor};padding:24px;">
    <div style="background:#ffffff;border-radius:8px;overflow:hidden;">
      <div style="background:${primaryColor};padding:20px;text-align:center;">
        ${logoUrl ? `<img src="${logoUrl}" alt="${businessName}" style="max-height:48px;margin-bottom:8px;">` : ""}
        <h1 style="color:#ffffff;font-size:20px;margin:0;">${businessName}</h1>
      </div>
      <div style="padding:24px;">
        ${bodyHtml}
      </div>
      <div style="padding:16px 24px;text-align:center;color:#999;font-size:11px;line-height:1.6;">
        Powered by My Grafix Forms<br>
        Secure Forms Platform &mdash; Built by My Grafix Media
      </div>
    </div>
  </div>`;
}

export function buildCustomerEmail(client, formName, customer, fields, context) {
  const copy = getFormCopy(formName);

  const body = `
    <h2 style="margin-top:0;">${escapeHtml(copy.heading)}</h2>
    <p>Hi ${escapeHtml(customer.name)}, ${escapeHtml(copy.intro)}</p>
    ${buildFieldsHtml(fields)}
    <p style="margin-top:24px;color:#888;font-size:12px;">Reference: ${escapeHtml(context.submissionId)}</p>
  `;

  return buildEmailShell(client, body);
}

export function buildOwnerEmail(client, formName, customer, fields, context) {
  const metaFields = {
    "Submission ID": context.submissionId,
    "Submission Time": context.receivedAt,
    "Client ID": context.clientId,
    "Form Name": formName,
    ...(context.website ? { Website: context.website } : {}),
    "IP Address": context.ipAddress,
    Browser: context.userAgent,
  };

  const body = `
    <h2 style="margin-top:0;">New ${escapeHtml(formName)} submission</h2>
    <p><strong>Name:</strong> ${escapeHtml(customer.name)}</p>
    <p><strong>Email:</strong> ${escapeHtml(customer.email)}</p>
    ${buildFieldsHtml(fields)}
    <h3 style="margin-top:24px;">Submission Details</h3>
    ${buildFieldsHtml(metaFields)}
  `;

  return buildEmailShell(client, body);
}

function buildLineItemsHtml(lineItems) {
  const rows = lineItems
    .map(
      (li) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#333;">${escapeHtml(li.product.name)} &times; ${li.qty}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#555;text-align:right;">${formatMoney(li.lineTotal)}</td>
        </tr>`
    )
    .join("");

  return `<table style="width:100%;border-collapse:collapse;margin-top:16px;">${rows}</table>`;
}

export function buildOrderCustomerEmail(client, order, lineItems, customer) {
  const body = `
    <h2 style="margin-top:0;">Order Confirmed</h2>
    <p>Hi ${escapeHtml(customer.name)}, thanks for your order! Here's a summary:</p>
    ${buildLineItemsHtml(lineItems)}
    <p style="margin-top:16px;font-weight:600;">Total: ${formatMoney(order.total)}</p>
    <p style="margin-top:24px;color:#888;font-size:12px;">Order reference: ${escapeHtml(order.order_number)}</p>
  `;
  return buildEmailShell(client, body);
}

export function buildOrderOwnerEmail(client, order, lineItems, customer) {
  const body = `
    <h2 style="margin-top:0;">New order ${escapeHtml(order.order_number)}</h2>
    <p><strong>Customer:</strong> ${escapeHtml(customer.name)} (${escapeHtml(customer.email)})</p>
    ${buildLineItemsHtml(lineItems)}
    <p style="margin-top:16px;font-weight:600;">Total: ${formatMoney(order.total)}</p>
  `;
  return buildEmailShell(client, body);
}

export function buildBookingCustomerEmail(client, booking, service, customer) {
  const body = `
    <h2 style="margin-top:0;">Booking Confirmed</h2>
    <p>Hi ${escapeHtml(customer.name)}, your booking is confirmed:</p>
    <p><strong>Service:</strong> ${escapeHtml(service.name)}</p>
    <p><strong>Time:</strong> ${escapeHtml(new Date(booking.start_time).toLocaleString())}</p>
  `;
  return buildEmailShell(client, body);
}

export function buildBookingOwnerEmail(client, booking, service, customer) {
  const body = `
    <h2 style="margin-top:0;">New booking: ${escapeHtml(service.name)}</h2>
    <p><strong>Customer:</strong> ${escapeHtml(customer.name)} (${escapeHtml(customer.email)})</p>
    <p><strong>Time:</strong> ${escapeHtml(new Date(booking.start_time).toLocaleString())}</p>
  `;
  return buildEmailShell(client, body);
}

export function buildInvoiceEmail(client, invoice) {
  const body = `
    <h2 style="margin-top:0;">Invoice ${escapeHtml(invoice.invoice_number)}</h2>
    <p>Hi ${escapeHtml(invoice.customer.name)}, please find your invoice attached as a PDF.</p>
    <p><strong>Amount due:</strong> ${formatMoney(invoice.total)}</p>
    ${invoice.due_at ? `<p><strong>Due date:</strong> ${escapeHtml(new Date(invoice.due_at).toLocaleDateString())}</p>` : ""}
    ${invoice.pdf_url ? `<p style="margin-top:16px;"><a href="${escapeHtml(invoice.pdf_url)}" style="color:#111;">View / download invoice</a></p>` : ""}
  `;
  return buildEmailShell(client, body);
}

// ==================================================
// RESEND EMAIL SENDER
// ==================================================

/**
 * Send an email via Resend API.
 * @param {object} env
 * @param {{ to: string, from: string, replyTo?: string, subject: string, html: string, attachments?: Array }} params
 * @returns {Promise<object>} Resend API response
 */
export async function sendEmail(env, { to, from, replyTo, subject, html, attachments }) {
  const body = {
    from,
    to,
    subject,
    html,
  };

  if (replyTo) {
    body.reply_to = replyTo;
  }

  if (attachments && attachments.length) {
    body.attachments = attachments;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Resend API error (${response.status}) sending to ${to}: ${errorText}`);
  }

  return response.json();
}

