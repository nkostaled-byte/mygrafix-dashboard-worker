/**
 * Order Handler
 * ==============
 * POST /api/orders — Public ecommerce checkout
 *
 * Creates an order with server-side product validation, stock management,
 * and email notifications.
 */

import { jsonResponse, rateLimitResponse } from "../lib/responses.js";
import { parseJsonBody, generateReference, generateRequestId } from "../lib/utils.js";
import { validateOrderPayload } from "../lib/validation.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { IP_RATE_LIMIT, CLIENT_RATE_LIMIT } from "../config/constants.js";
import { supabaseFetch } from "../lib/supabase.js";
import { loadClient } from "../services/clientService.js";
import { findOrCreateCustomer } from "../services/customerService.js";
import { logEmail } from "../services/submissionService.js";
import { sendEmail, buildOrderCustomerEmail, buildOrderOwnerEmail } from "../lib/email.js";
import { buildFromAddress } from "../lib/email.js";

/**
 * POST /api/orders
 */
export async function handleCreateOrder(request, env) {
  const requestId = generateRequestId();
  const ipAddress = request.headers.get("CF-Connecting-IP") || "";

  // Rate limit by IP
  const ipLimit = await checkRateLimit(env, `order:ip:${ipAddress}`, IP_RATE_LIMIT);
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit.retryAfter);

  // Parse body
  const payload = await parseJsonBody(request);
  if (!payload) {
    return jsonResponse({ success: false, error: "Invalid or missing JSON body." }, 400);
  }

  // Validate
  const orderError = validateOrderPayload(payload);
  if (orderError) {
    return jsonResponse({ success: false, error: orderError }, 400);
  }

  const { clientId, customer, items, notes } = payload;

  // Rate limit by client
  const clientLimit = await checkRateLimit(env, `order:client:${clientId}`, CLIENT_RATE_LIMIT);
  if (!clientLimit.allowed) return rateLimitResponse(clientLimit.retryAfter);

  // Load client
  const client = await loadClient(env, clientId, { requestId });
  if (!client) return jsonResponse({ success: false, error: "Unknown client." }, 404);
  if (!client.active) return jsonResponse({ success: false, error: "Client account is inactive." }, 403);

  // Look up products server-side
  const productIds = items.map((i) => i.productId);
  const inFilter = productIds.map((id) => `"${id}"`).join(",");
  const products = await supabaseFetch(
    env,
    `products?client_id=eq.${encodeURIComponent(clientId)}&id=in.(${inFilter})&select=*`,
    { requestId }
  );

  const productById = new Map((products || []).map((p) => [p.id, p]));
  const lineItems = [];
  let subtotal = 0;

  for (const item of items) {
    const product = productById.get(item.productId);
    if (!product || product.is_hidden) {
      return jsonResponse({ success: false, error: `Product ${item.productId} is not available.` }, 400);
    }
    if (product.stock_qty < item.qty) {
      return jsonResponse(
        { success: false, error: `Insufficient stock for "${product.name}" (${product.stock_qty} left).` },
        409
      );
    }
    const lineTotal = Number(product.price) * item.qty;
    subtotal += lineTotal;
    lineItems.push({
      product,
      qty: item.qty,
      unitPrice: Number(product.price),
      lineTotal,
    });
  }

  const total = subtotal;
  const orderNumber = generateReference("ORD");
  const dbCustomer = await findOrCreateCustomer(env, clientId, customer, { requestId });

  // Create order
  const [order] = await supabaseFetch(env, "orders", {
    method: "POST",
    body: JSON.stringify({
      order_number: orderNumber,
      client_id: clientId,
      customer_id: dbCustomer.id,
      status: "pending",
      subtotal,
      tax: 0,
      total,
      notes: notes || null,
    }),
    requestId,
  });

  // Create order items
  await supabaseFetch(env, "order_items", {
    method: "POST",
    prefer: "return=minimal",
    body: JSON.stringify(
      lineItems.map((li) => ({
        order_id: order.id,
        product_id: li.product.id,
        name_snapshot: li.product.name,
        unit_price: li.unitPrice,
        qty: li.qty,
        line_total: li.lineTotal,
      }))
    ),
    requestId,
  });

  // Decrement stock + log movement
  for (const li of lineItems) {
    await supabaseFetch(
      env,
      `products?id=eq.${encodeURIComponent(li.product.id)}`,
      {
        method: "PATCH",
        prefer: "return=minimal",
        body: JSON.stringify({ stock_qty: li.product.stock_qty - li.qty }),
        requestId,
      }
    );
    await supabaseFetch(env, "inventory_movements", {
      method: "POST",
      prefer: "return=minimal",
      body: JSON.stringify({
        client_id: clientId,
        product_id: li.product.id,
        change_qty: -li.qty,
        reason: "sale",
        note: `Order ${orderNumber}`,
      }),
      requestId,
    });
  }

  // Send emails
  const customerEmailResult = await sendEmail(env, {
    to: customer.email,
    from: buildFromAddress(client),
    replyTo: client.reply_email || undefined,
    subject: "Order Confirmed",
    html: buildOrderCustomerEmail(client, order, lineItems, customer),
  }).catch((err) => {
    console.error(`[${requestId}] Failed to send order customer email:`, err.message);
    return { id: null };
  });

  const ownerEmailResult = await sendEmail(env, {
    to: client.owner_email,
    from: buildFromAddress(client),
    replyTo: client.reply_email || undefined,
    subject: `New order ${orderNumber}`,
    html: buildOrderOwnerEmail(client, order, lineItems, customer),
  }).catch((err) => {
    console.error(`[${requestId}] Failed to send order owner email:`, err.message);
    return { id: null };
  });

  // Log emails
  await Promise.all([
    logEmail(env, {
      clientId,
      relatedType: "order",
      relatedId: order.id,
      recipient: customer.email,
      subject: "Order Confirmed",
      resendId: customerEmailResult?.id || null,
    }, { requestId }),
    logEmail(env, {
      clientId,
      relatedType: "order",
      relatedId: order.id,
      recipient: client.owner_email,
      subject: `New order ${orderNumber}`,
      resendId: ownerEmailResult?.id || null,
    }, { requestId }),
  ]);

  return jsonResponse({ success: true, orderId: order.id, orderNumber, total });
}

