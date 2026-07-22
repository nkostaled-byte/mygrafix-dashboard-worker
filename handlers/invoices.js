/**
 * Invoice Handlers
 * =================
 * POST /api/invoices — Create a new invoice with PDF generation
 * POST /api/invoices/:id/send — Send an invoice via email with PDF attachment
 */

import { jsonResponse } from "../lib/responses.js";
import { parseJsonBody, generateReference, generateRequestId } from "../lib/utils.js";
import { validateInvoicePayload } from "../lib/validation.js";
import { verifySupabaseJwt, resolveClientId } from "../lib/auth.js";
import { supabaseFetch } from "../lib/supabase.js";
import { loadClient } from "../services/clientService.js";
import { findOrCreateCustomer } from "../services/customerService.js";
import { logEmail } from "../services/submissionService.js";
import {
  sendEmail,
  buildInvoiceEmail,
  buildFromAddress,
} from "../lib/email.js";
import { generateInvoicePdf, uploadInvoicePdf, arrayBufferToBase64 } from "../lib/pdf.js";

/**
 * POST /api/invoices
 * Creates an invoice with line items and generates a PDF.
 */
export async function handleCreateInvoice(request, env) {
  const requestId = generateRequestId();

  // Authenticate
  const claims = await verifySupabaseJwt(request, env);
  if (!claims) return jsonResponse({ success: false, error: "Unauthorized." }, 401);

  const clientId = await resolveClientId(env, claims.sub);
  if (!clientId) {
    return jsonResponse({ success: false, error: "No client account linked to this login." }, 403);
  }

  // Parse body
  const payload = await parseJsonBody(request);
  if (!payload) return jsonResponse({ success: false, error: "Invalid or missing JSON body." }, 400);

  // Validate
  const invoiceError = validateInvoicePayload(payload);
  if (invoiceError) return jsonResponse({ success: false, error: invoiceError }, 400);

  // Load client
  const client = await loadClient(env, clientId, { requestId });
  if (!client) return jsonResponse({ success: false, error: "Client not found." }, 404);

  // Resolve customer
  let customer;
  if (payload.customer.id) {
    const rows = await supabaseFetch(
      env,
      `customers?id=eq.${encodeURIComponent(payload.customer.id)}&client_id=eq.${encodeURIComponent(clientId)}&select=*`,
      { requestId }
    );
    if (!rows || !rows.length) return jsonResponse({ success: false, error: "Customer not found." }, 404);
    customer = rows[0];
  } else {
    customer = await findOrCreateCustomer(env, clientId, payload.customer, { requestId });
  }

  // Build line items
  const lineItems = payload.items.map((item) => ({
    product_id: item.productId || null,
    description: item.description || "Item",
    quantity: item.quantity,
    unit_price: item.price,
    line_total: Number((item.quantity * item.price).toFixed(2)),
  }));

  const subtotal = Number(lineItems.reduce((sum, li) => sum + li.line_total, 0).toFixed(2));
  const tax = typeof payload.tax === "number" ? payload.tax : 0;
  const total = Number((subtotal + tax).toFixed(2));
  const invoiceNumber = generateReference("INV");

  // Create invoice record
  const [invoice] = await supabaseFetch(env, "invoices", {
    method: "POST",
    body: JSON.stringify({
      invoice_number: invoiceNumber,
      client_id: clientId,
      customer_id: customer.id,
      order_id: payload.orderId || null,
      status: "draft",
      subtotal,
      tax,
      total,
      due_at: payload.dueDate || null,
    }),
    requestId,
  });

  // Create invoice items
  await supabaseFetch(env, "invoice_items", {
    method: "POST",
    prefer: "return=minimal",
    body: JSON.stringify(lineItems.map((li) => ({ ...li, invoice_id: invoice.id }))),
    requestId,
  });

  // Generate PDF
  const pdfBytes = await generateInvoicePdf(client, invoice, lineItems, customer);
  const pdfUrl = await uploadInvoicePdf(env, clientId, invoiceNumber, pdfBytes);

  // Store PDF URL
  await supabaseFetch(
    env,
    `invoices?id=eq.${encodeURIComponent(invoice.id)}`,
    {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify({ pdf_url: pdfUrl }),
      requestId,
    }
  );

  return jsonResponse({
    success: true,
    invoiceId: invoice.id,
    invoiceNumber,
    total,
    pdfUrl,
  });
}

/**
 * POST /api/invoices/:id/send
 * Sends an invoice email with PDF attachment.
 */
export async function handleSendInvoice(request, env, invoiceId) {
  const requestId = generateRequestId();

  // Authenticate
  const claims = await verifySupabaseJwt(request, env);
  if (!claims) return jsonResponse({ success: false, error: "Unauthorized." }, 401);

  const clientId = await resolveClientId(env, claims.sub);
  if (!clientId) {
    return jsonResponse({ success: false, error: "No client account linked to this login." }, 403);
  }

  // Load invoice with customer and items
  const invoices = await supabaseFetch(
    env,
    `invoices?id=eq.${encodeURIComponent(invoiceId)}&client_id=eq.${encodeURIComponent(clientId)}&select=*,customer:customers(*),invoice_items(*)`,
    { requestId }
  );
  const invoice = invoices && invoices[0];
  if (!invoice) return jsonResponse({ success: false, error: "Invoice not found." }, 404);
  if (!invoice.customer || !invoice.customer.email) {
    return jsonResponse({ success: false, error: "Invoice has no customer email on file." }, 400);
  }

  // Load client
  const client = await loadClient(env, clientId, { requestId });

  // Generate fresh PDF
  const pdfBytes = await generateInvoicePdf(
    client,
    invoice,
    invoice.invoice_items,
    invoice.customer
  );
  const pdfUrl = await uploadInvoicePdf(
    env,
    clientId,
    invoice.invoice_number,
    pdfBytes
  );
  const pdfBase64 = arrayBufferToBase64(pdfBytes);

  // Send email
  const emailResult = await sendEmail(env, {
    to: invoice.customer.email,
    from: buildFromAddress(client),
    replyTo: client.reply_email || undefined,
    subject: `Invoice ${invoice.invoice_number}`,
    html: buildInvoiceEmail(client, { ...invoice, pdf_url: pdfUrl }),
    attachments: [{ filename: `${invoice.invoice_number}.pdf`, content: pdfBase64 }],
  }).catch((err) => {
    console.error(`[${requestId}] Failed to send invoice email:`, err.message);
    return { id: null };
  });

  // Update invoice status
  await supabaseFetch(
    env,
    `invoices?id=eq.${encodeURIComponent(invoiceId)}`,
    {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify({ status: "sent", pdf_url: pdfUrl }),
      requestId,
    }
  );

  // Log email
  await logEmail(env, {
    clientId,
    relatedType: "invoice",
    relatedId: invoice.id,
    recipient: invoice.customer.email,
    subject: `Invoice ${invoice.invoice_number}`,
    resendId: emailResult?.id || null,
  }, { requestId });

  return jsonResponse({ success: true, invoiceId: invoice.id, status: "sent" });
}

