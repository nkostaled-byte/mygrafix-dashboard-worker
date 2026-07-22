/**
 * My Grafix Forms + Uploads Engine
 * A single, multi-tenant Cloudflare Worker that:
 *  - accepts form submissions (contact/quote/booking/reservation) for
 *    unlimited clients and writes them to Supabase
 *  - accepts authenticated file uploads (logos, profile pics, product
 *    images) from logged-in client dashboards, storing bytes in R2 and
 *    metadata references in Supabase
 *  - creates invoices, generates a PDF with pdf-lib, and emails it
 *
 * Requires:
 *   - KV binding RATE_LIMIT_KV (optional, degrades gracefully if absent)
 *   - R2 bucket binding R2_BUCKET
 *   - Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET,
 *     RESEND_API_KEY, R2_PUBLIC_URL
 *   - npm dependency: pdf-lib (add to package.json, wrangler bundles it)
 *
 * The service role key bypasses Supabase RLS entirely — this Worker is a
 * trusted backend. Never expose SUPABASE_SERVICE_ROLE_KEY to any frontend.
 */

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

// ==================================================
// CONSTANTS
// ==================================================

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const VALID_STATUSES = ["received", "pending", "confirmed", "cancelled", "completed"];

// Rate limit tuning
const IP_RATE_LIMIT = { max: 20, windowSeconds: 60 };
const CLIENT_RATE_LIMIT = { max: 60, windowSeconds: 60 };

// Per-form copy for customer confirmation emails. Falls back to a generic
// message for any formName not listed here, so new form types never need
// a code change.
const FORM_COPY = {
  booking: {
    subject: "Booking Confirmed",
    heading: "Booking Confirmed",
    intro: "Your booking has been confirmed. Here's a summary:",
  },
  contact: {
    subject: "We've received your enquiry",
    heading: "Thanks for reaching out",
    intro: "We've received your enquiry. Here's a summary:",
  },
  quote: {
    subject: "Your quotation request has been received",
    heading: "Quote Request Received",
    intro: "Your quotation request has been received. Here's a summary:",
  },
  reservation: {
    subject: "Your reservation request has been received",
    heading: "Reservation Received",
    intro: "Your reservation request has been received. Here's a summary:",
  },
};

const DEFAULT_FORM_COPY = {
  subject: "Your submission has been received",
  heading: "Submission Received",
  intro: "We've received your submission. Here's a summary:",
};

// Uploads
const ALLOWED_UPLOAD_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const EXTENSION_BY_TYPE = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_UPLOAD_FOLDERS = ["logos", "profile", "products"];

// CSV export — whitelist of tables the dashboard can export, and which
// column each one is date-filtered/sorted by.
const EXPORTABLE_TABLES = {
  customers: { filename: "customers", dateColumn: "created_at" },
  submissions: { filename: "submissions", dateColumn: "created_at" },
  orders: { filename: "orders", dateColumn: "created_at" },
  products: { filename: "products", dateColumn: "created_at" },
  bookings: { filename: "bookings", dateColumn: "start_time" },
  invoices: { filename: "invoices", dateColumn: "issued_at" },
};

// ==================================================
// ENTRY POINT
// ==================================================

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return handleOptions();
    }

    const url = new URL(request.url);

    try {
      const exportMatch = url.pathname.match(/^\/api\/export\/([a-z_]+)$/);
      if (request.method === "GET" && exportMatch) {
        return await handleExport(request, env, exportMatch[1]);
      }

      if (request.method === "POST" && url.pathname === "/api/claim-account") {
        return await handleClaimAccount(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/claim-account/relink") {
        return await handleRelinkAccount(request, env);
      }

      if (request.method === "GET" && url.pathname === "/api/search") {
        return await handleSearch(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/upload") {
        return await handleUpload(request, env, url);
      }

      if (request.method === "POST" && url.pathname === "/api/orders") {
        return await handleCreateOrder(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/bookings") {
        return await handleCreateBooking(request, env);
      }

      const sendInvoiceMatch = url.pathname.match(/^\/api\/invoices\/([0-9a-fA-F-]+)\/send$/);
      if (request.method === "POST" && sendInvoiceMatch) {
        return await handleSendInvoice(request, env, sendInvoiceMatch[1]);
      }

      if (request.method === "POST" && url.pathname === "/api/invoices") {
        return await handleCreateInvoice(request, env);
      }

      if (request.method === "POST") {
        return await handleSubmission(request, env);
      }

      return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
    } catch (err) {
      console.error("Unhandled error:", err);
      return jsonResponse(
        {
          success: false,
          error: err instanceof Error ? err.message : "Unknown error",
        },
        500
      );
    }
  },
};

// ==================================================
// CORE WORKFLOW — form submissions
// ==================================================

async function handleSubmission(request, env) {
  const ipAddress = request.headers.get("CF-Connecting-IP") || "";
  const userAgent = request.headers.get("User-Agent") || "";

  // 1. Rate limit by IP before doing any work
  const ipLimit = await checkRateLimit(env, `ip:${ipAddress}`, IP_RATE_LIMIT);
  if (!ipLimit.allowed) {
    return rateLimitResponse(ipLimit.retryAfter);
  }

  // 2. Parse JSON safely
  const payload = await parseJsonBody(request);
  if (!payload) {
    return jsonResponse({ success: false, error: "Invalid or missing JSON body." }, 400);
  }

  // 3. Validate payload shape
  const validationError = validatePayload(payload);
  if (validationError) {
    return jsonResponse({ success: false, error: validationError }, 400);
  }

  const { clientId, formName, customer, fields, website } = payload;
  const status = VALID_STATUSES.includes(payload.status) ? payload.status : "received";

  // 4. Rate limit by client
  const clientLimit = await checkRateLimit(env, `client:${clientId}`, CLIENT_RATE_LIMIT);
  if (!clientLimit.allowed) {
    return rateLimitResponse(clientLimit.retryAfter);
  }

  // 5. Load client dynamically from Supabase
  const client = await loadClient(env, clientId);

  if (!client) {
    return jsonResponse({ success: false, error: "Unknown client." }, 404);
  }

  if (!client.active) {
    return jsonResponse({ success: false, error: "Client account is inactive." }, 403);
  }

  // 6. Generate a unique submission reference + timestamp
  const submissionId = generateSubmissionId();
  const receivedAt = new Date().toISOString();

  const context = {
    submissionId,
    clientId,
    formName,
    website: website || "",
    ipAddress,
    userAgent,
    receivedAt,
  };

  // 7. Persist submission (email IDs filled in after send)
  await saveSubmission(env, {
    submissionId,
    clientId,
    formName,
    customerName: customer.name,
    customerEmail: customer.email,
    fields,
    status,
    ipAddress,
    userAgent,
  });

  // 8. Send customer confirmation email
  const customerEmailResult = await sendEmail(env, {
    to: customer.email,
    from: buildFromAddress(client),
    replyTo: client.reply_email || undefined,
    subject: getFormCopy(formName).subject,
    html: buildCustomerEmail(client, formName, customer, fields, context),
  });

  // 9. Send owner notification email
  const ownerEmailResult = await sendEmail(env, {
    to: client.owner_email,
    from: buildFromAddress(client),
    replyTo: client.reply_email || undefined,
    subject: `New ${formName} submission`,
    html: buildOwnerEmail(client, formName, customer, fields, context),
  });

  // 10. Store the Resend email IDs against the submission for auditability
  await saveEmailIds(env, submissionId, {
    customerEmailId: customerEmailResult?.id || null,
    ownerEmailId: ownerEmailResult?.id || null,
  });

  // 11. Log both sends to email_log for a client-visible audit trail
  await Promise.all([
    logEmail(env, {
      clientId,
      relatedType: "submission",
      relatedId: null,
      recipient: customer.email,
      subject: getFormCopy(formName).subject,
      resendId: customerEmailResult?.id || null,
    }),
    logEmail(env, {
      clientId,
      relatedType: "submission",
      relatedId: null,
      recipient: client.owner_email,
      subject: `New ${formName} submission`,
      resendId: ownerEmailResult?.id || null,
    }),
  ]);

  return jsonResponse({
    success: true,
    submissionId,
    receivedAt,
  });
}

// ==================================================
// UPLOADS — authenticated logo/profile/product image uploads
// ==================================================

async function handleUpload(request, env, url) {
  const claims = await verifySupabaseJwt(request, env);
  if (!claims) {
    return jsonResponse({ success: false, error: "Unauthorized." }, 401);
  }

  const clientId = await resolveClientId(env, claims.sub);
  if (!clientId) {
    return jsonResponse({ success: false, error: "No client account linked to this login." }, 403);
  }

  const folderParam = (url.searchParams.get("folder") || "misc").toLowerCase();
  const folder = ALLOWED_UPLOAD_FOLDERS.includes(folderParam) ? folderParam : "misc";

  const contentType = request.headers.get("Content-Type") || "";
  if (!ALLOWED_UPLOAD_TYPES.includes(contentType)) {
    return jsonResponse(
      { success: false, error: `Unsupported file type: ${contentType || "unknown"}` },
      400
    );
  }

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) {
    return jsonResponse({ success: false, error: "Empty file." }, 400);
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return jsonResponse({ success: false, error: "File too large (max 5MB)." }, 400);
  }

  const extension = EXTENSION_BY_TYPE[contentType];
  const key = `clients/${clientId}/${folder}/${crypto.randomUUID()}.${extension}`;

  await env.R2_BUCKET.put(key, bytes, {
    httpMetadata: { contentType },
  });

  const publicUrl = `${env.R2_PUBLIC_URL.replace(/\/$/, "")}/${key}`;

  return jsonResponse({ success: true, url: publicUrl, key, folder });
}

// ==================================================
// AUTH — Supabase JWT verification
// ==================================================

/**
 * Verifies a Supabase-issued JWT (HS256, shared secret) sent as
 * "Authorization: Bearer <token>". Returns the decoded payload
 * (includes `sub` = auth user id) if valid, or null otherwise.
 *
 * NOTE: this assumes your Supabase project still uses the legacy
 * shared JWT secret (Settings > API > JWT Secret). If the project has
 * been switched to the newer asymmetric signing keys (ES256/RS256),
 * this needs to fetch and verify against Supabase's JWKS instead —
 * let me know if that's the case and I'll swap this out.
 */
async function verifySupabaseJwt(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(env.SUPABASE_JWT_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const signature = base64UrlToArrayBuffer(signatureB64);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      encoder.encode(`${headerB64}.${payloadB64}`)
    );

    if (!valid) return null;

    const payload = JSON.parse(atob(base64UrlToStdB64(payloadB64)));

    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    if (!payload.sub) return null;

    return payload;
  } catch {
    return null;
  }
}

function base64UrlToStdB64(b64url) {
  const std = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (std.length % 4)) % 4;
  return std + "=".repeat(padLength);
}

function base64UrlToArrayBuffer(b64url) {
  const raw = atob(base64UrlToStdB64(b64url));
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}

/**
 * Resolves a Supabase auth user id to the client_id they belong to —
 * either as the client owner or as an active team member.
 */
async function resolveClientId(env, authUserId) {
  const ownerRows = await supabaseFetch(
    env,
    `clients?auth_user_id=eq.${encodeURIComponent(authUserId)}&select=client_id`
  );
  if (ownerRows.length) return ownerRows[0].client_id;

  const teamRows = await supabaseFetch(
    env,
    `team_members?auth_user_id=eq.${encodeURIComponent(authUserId)}&active=eq.true&select=client_id`
  );
  if (teamRows.length) return teamRows[0].client_id;

  return null;
}

// ==================================================
// REQUEST HELPERS
// ==================================================

function handleOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return Response.json(body, { status, headers: { ...CORS_HEADERS, ...extraHeaders } });
}

function rateLimitResponse(retryAfter) {
  return jsonResponse(
    { success: false, error: "Too many requests. Please try again shortly." },
    429,
    { "Retry-After": String(retryAfter) }
  );
}

async function parseJsonBody(request) {
  try {
    const data = await request.json();
    if (!data || typeof data !== "object") return null;
    return data;
  } catch {
    return null;
  }
}

// ==================================================
// VALIDATION
// ==================================================

function validatePayload(payload) {
  if (!payload.clientId || typeof payload.clientId !== "string") {
    return "Missing or invalid 'clientId'.";
  }

  if (!payload.formName || typeof payload.formName !== "string") {
    return "Missing or invalid 'formName'.";
  }

  if (!payload.customer || typeof payload.customer !== "object") {
    return "Missing or invalid 'customer' object.";
  }

  if (!payload.customer.name || typeof payload.customer.name !== "string") {
    return "Missing or invalid 'customer.name'.";
  }

  if (!payload.customer.email || typeof payload.customer.email !== "string") {
    return "Missing or invalid 'customer.email'.";
  }

  if (!EMAIL_REGEX.test(payload.customer.email.trim())) {
    return "Invalid 'customer.email' format.";
  }

  if (
    payload.fields !== undefined &&
    (typeof payload.fields !== "object" || payload.fields === null || Array.isArray(payload.fields))
  ) {
    return "'fields' must be an object of key/value pairs.";
  }

  if (payload.status !== undefined && !VALID_STATUSES.includes(payload.status)) {
    return `'status' must be one of: ${VALID_STATUSES.join(", ")}.`;
  }

  if (payload.website !== undefined && typeof payload.website !== "string") {
    return "'website' must be a string.";
  }

  return null;
}

// ==================================================
// SUBMISSION ID
// ==================================================

function generateReference(prefix) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);

  let suffix = "";
  for (const byte of bytes) {
    suffix += alphabet[byte % alphabet.length];
  }

  return `${prefix}-${suffix}`;
}

function generateSubmissionId() {
  return generateReference("SUB");
}

// ==================================================
// SUPABASE (replaces the old D1 DATABASE section)
// ==================================================

/**
 * Thin wrapper around Supabase's PostgREST API, authenticated with the
 * service role key (bypasses RLS — this Worker is a trusted backend).
 */
async function supabaseFetch(env, path, options = {}) {
  const url = `${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${path}`;

  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: options.prefer || "return=representation",
      ...(options.headers || {}),
    },
    body: options.body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Supabase error (${response.status}) on ${path}: ${errorText}`);
  }

  if (response.status === 204) return null;

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function loadClient(env, clientId) {
  const rows = await supabaseFetch(
    env,
    `clients?client_id=eq.${encodeURIComponent(clientId)}&select=*`
  );
  return (rows && rows[0]) || null;
}

async function saveSubmission(env, {
  submissionId,
  clientId,
  formName,
  customerName,
  customerEmail,
  fields,
  status,
  ipAddress,
  userAgent,
}) {
  await supabaseFetch(env, "submissions", {
    method: "POST",
    prefer: "return=minimal",
    body: JSON.stringify({
      submission_id: submissionId,
      client_id: clientId,
      form_name: formName,
      customer_name: customerName,
      customer_email: customerEmail,
      submission_json: fields || {},
      status,
      ip_address: ipAddress,
      user_agent: userAgent,
    }),
  });
}

async function saveEmailIds(env, submissionId, { customerEmailId, ownerEmailId }) {
  await supabaseFetch(env, `submissions?submission_id=eq.${encodeURIComponent(submissionId)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify({
      customer_email_id: customerEmailId,
      owner_email_id: ownerEmailId,
    }),
  });
}

async function logEmail(env, { clientId, relatedType, relatedId, recipient, subject, resendId }) {
  await supabaseFetch(env, "email_log", {
    method: "POST",
    prefer: "return=minimal",
    body: JSON.stringify({
      client_id: clientId,
      related_type: relatedType,
      related_id: relatedId,
      recipient,
      subject,
      resend_id: resendId,
    }),
  });
}

// ==================================================
// CUSTOMERS (shared helper — used by orders + bookings)
// ==================================================

async function findOrCreateCustomer(env, clientId, { name, email, phone }) {
  if (email) {
    const existing = await supabaseFetch(
      env,
      `customers?client_id=eq.${encodeURIComponent(clientId)}&email=eq.${encodeURIComponent(email)}&select=*`
    );
    if (existing && existing.length) return existing[0];
  }

  const created = await supabaseFetch(env, "customers", {
    method: "POST",
    body: JSON.stringify({
      client_id: clientId,
      name,
      email: email || null,
      phone: phone || null,
    }),
  });

  return created[0];
}

// ==================================================
// ORDERS (ecommerce checkout — public, customer-facing)
// ==================================================

async function handleCreateOrder(request, env) {
  const ipAddress = request.headers.get("CF-Connecting-IP") || "";

  const ipLimit = await checkRateLimit(env, `order:ip:${ipAddress}`, IP_RATE_LIMIT);
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit.retryAfter);

  const payload = await parseJsonBody(request);
  if (!payload) {
    return jsonResponse({ success: false, error: "Invalid or missing JSON body." }, 400);
  }

  const orderError = validateOrderPayload(payload);
  if (orderError) {
    return jsonResponse({ success: false, error: orderError }, 400);
  }

  const { clientId, customer, items, notes } = payload;

  const clientLimit = await checkRateLimit(env, `order:client:${clientId}`, CLIENT_RATE_LIMIT);
  if (!clientLimit.allowed) return rateLimitResponse(clientLimit.retryAfter);

  const client = await loadClient(env, clientId);
  if (!client) return jsonResponse({ success: false, error: "Unknown client." }, 404);
  if (!client.active) return jsonResponse({ success: false, error: "Client account is inactive." }, 403);

  // Look up products server-side — never trust client-submitted prices.
  const productIds = items.map((i) => i.productId);
  const inFilter = productIds.map((id) => `"${id}"`).join(",");
  const products = await supabaseFetch(
    env,
    `products?client_id=eq.${encodeURIComponent(clientId)}&id=in.(${inFilter})&select=*`
  );

  const productById = new Map(products.map((p) => [p.id, p]));
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

  const total = subtotal; // tax handling can be added per-client later
  const orderNumber = generateReference("ORD");
  const dbCustomer = await findOrCreateCustomer(env, clientId, customer);

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
  });

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
  });

  // Decrement stock + log the movement per item.
  for (const li of lineItems) {
    await supabaseFetch(
      env,
      `products?id=eq.${encodeURIComponent(li.product.id)}`,
      {
        method: "PATCH",
        prefer: "return=minimal",
        body: JSON.stringify({ stock_qty: li.product.stock_qty - li.qty }),
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
    });
  }

  const customerEmailResult = await sendEmail(env, {
    to: customer.email,
    from: buildFromAddress(client),
    replyTo: client.reply_email || undefined,
    subject: "Order Confirmed",
    html: buildOrderCustomerEmail(client, order, lineItems, customer),
  });

  const ownerEmailResult = await sendEmail(env, {
    to: client.owner_email,
    from: buildFromAddress(client),
    replyTo: client.reply_email || undefined,
    subject: `New order ${orderNumber}`,
    html: buildOrderOwnerEmail(client, order, lineItems, customer),
  });

  await Promise.all([
    logEmail(env, {
      clientId,
      relatedType: "order",
      relatedId: order.id,
      recipient: customer.email,
      subject: "Order Confirmed",
      resendId: customerEmailResult?.id || null,
    }),
    logEmail(env, {
      clientId,
      relatedType: "order",
      relatedId: order.id,
      recipient: client.owner_email,
      subject: `New order ${orderNumber}`,
      resendId: ownerEmailResult?.id || null,
    }),
  ]);

  return jsonResponse({ success: true, orderId: order.id, orderNumber, total });
}

function validateOrderPayload(payload) {
  if (!payload.clientId || typeof payload.clientId !== "string") return "Missing or invalid 'clientId'.";
  if (!payload.customer || typeof payload.customer !== "object") return "Missing or invalid 'customer' object.";
  if (!payload.customer.name || typeof payload.customer.name !== "string") return "Missing or invalid 'customer.name'.";
  if (!payload.customer.email || !EMAIL_REGEX.test(String(payload.customer.email).trim())) {
    return "Missing or invalid 'customer.email'.";
  }
  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    return "'items' must be a non-empty array.";
  }
  for (const item of payload.items) {
    if (!item.productId || typeof item.productId !== "string") return "Each item needs a valid 'productId'.";
    if (!Number.isInteger(item.qty) || item.qty <= 0) return "Each item needs a positive integer 'qty'.";
  }
  return null;
}

// ==================================================
// BOOKINGS (appointment scheduling — public, customer-facing)
// ==================================================

async function handleCreateBooking(request, env) {
  const ipAddress = request.headers.get("CF-Connecting-IP") || "";

  const ipLimit = await checkRateLimit(env, `booking:ip:${ipAddress}`, IP_RATE_LIMIT);
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit.retryAfter);

  const payload = await parseJsonBody(request);
  if (!payload) {
    return jsonResponse({ success: false, error: "Invalid or missing JSON body." }, 400);
  }

  const bookingError = validateBookingPayload(payload);
  if (bookingError) {
    return jsonResponse({ success: false, error: bookingError }, 400);
  }

  const { clientId, customer, serviceId, staffId, startTime } = payload;

  const clientLimit = await checkRateLimit(env, `booking:client:${clientId}`, CLIENT_RATE_LIMIT);
  if (!clientLimit.allowed) return rateLimitResponse(clientLimit.retryAfter);

  const client = await loadClient(env, clientId);
  if (!client) return jsonResponse({ success: false, error: "Unknown client." }, 404);
  if (!client.active) return jsonResponse({ success: false, error: "Client account is inactive." }, 403);

  const services = await supabaseFetch(
    env,
    `services?client_id=eq.${encodeURIComponent(clientId)}&id=eq.${encodeURIComponent(serviceId)}&select=*`
  );
  const service = services[0];
  if (!service || !service.active) {
    return jsonResponse({ success: false, error: "Service not found or unavailable." }, 400);
  }

  if (staffId) {
    const staffRows = await supabaseFetch(
      env,
      `staff?client_id=eq.${encodeURIComponent(clientId)}&id=eq.${encodeURIComponent(staffId)}&select=id`
    );
    if (!staffRows.length) {
      return jsonResponse({ success: false, error: "Staff member not found." }, 400);
    }
  }

  const start = new Date(startTime);
  const end = new Date(start.getTime() + service.duration_minutes * 60000);

  const dbCustomer = await findOrCreateCustomer(env, clientId, customer);

  const [booking] = await supabaseFetch(env, "bookings", {
    method: "POST",
    body: JSON.stringify({
      client_id: clientId,
      customer_id: dbCustomer.id,
      service_id: serviceId,
      staff_id: staffId || null,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      status: "confirmed",
    }),
  });

  const customerEmailResult = await sendEmail(env, {
    to: customer.email,
    from: buildFromAddress(client),
    replyTo: client.reply_email || undefined,
    subject: "Booking Confirmed",
    html: buildBookingCustomerEmail(client, booking, service, customer),
  });

  const ownerEmailResult = await sendEmail(env, {
    to: client.owner_email,
    from: buildFromAddress(client),
    replyTo: client.reply_email || undefined,
    subject: `New booking: ${service.name}`,
    html: buildBookingOwnerEmail(client, booking, service, customer),
  });

  await Promise.all([
    logEmail(env, {
      clientId,
      relatedType: "booking",
      relatedId: booking.id,
      recipient: customer.email,
      subject: "Booking Confirmed",
      resendId: customerEmailResult?.id || null,
    }),
    logEmail(env, {
      clientId,
      relatedType: "booking",
      relatedId: booking.id,
      recipient: client.owner_email,
      subject: `New booking: ${service.name}`,
      resendId: ownerEmailResult?.id || null,
    }),
  ]);

  return jsonResponse({
    success: true,
    bookingId: booking.id,
    startTime: booking.start_time,
    endTime: booking.end_time,
  });
}

function validateBookingPayload(payload) {
  if (!payload.clientId || typeof payload.clientId !== "string") return "Missing or invalid 'clientId'.";
  if (!payload.customer || typeof payload.customer !== "object") return "Missing or invalid 'customer' object.";
  if (!payload.customer.name || typeof payload.customer.name !== "string") return "Missing or invalid 'customer.name'.";
  if (!payload.customer.email || !EMAIL_REGEX.test(String(payload.customer.email).trim())) {
    return "Missing or invalid 'customer.email'.";
  }
  if (!payload.serviceId || typeof payload.serviceId !== "string") return "Missing or invalid 'serviceId'.";
  if (!payload.startTime || isNaN(Date.parse(payload.startTime))) return "Missing or invalid 'startTime'.";
  return null;
}

// ==================================================
// INVOICES (staff-triggered — authenticated)
// ==================================================

async function handleCreateInvoice(request, env) {
  const claims = await verifySupabaseJwt(request, env);
  if (!claims) return jsonResponse({ success: false, error: "Unauthorized." }, 401);

  const clientId = await resolveClientId(env, claims.sub);
  if (!clientId) {
    return jsonResponse({ success: false, error: "No client account linked to this login." }, 403);
  }

  const payload = await parseJsonBody(request);
  if (!payload) return jsonResponse({ success: false, error: "Invalid or missing JSON body." }, 400);

  const invoiceError = validateInvoicePayload(payload);
  if (invoiceError) return jsonResponse({ success: false, error: invoiceError }, 400);

  const client = await loadClient(env, clientId);
  if (!client) return jsonResponse({ success: false, error: "Client not found." }, 404);

  // Resolve the customer — either an existing one by id, or find/create by email.
  let customer;
  if (payload.customer.id) {
    const rows = await supabaseFetch(
      env,
      `customers?id=eq.${encodeURIComponent(payload.customer.id)}&client_id=eq.${encodeURIComponent(clientId)}&select=*`
    );
    if (!rows.length) return jsonResponse({ success: false, error: "Customer not found." }, 404);
    customer = rows[0];
  } else {
    customer = await findOrCreateCustomer(env, clientId, payload.customer);
  }

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
  });

  await supabaseFetch(env, "invoice_items", {
    method: "POST",
    prefer: "return=minimal",
    body: JSON.stringify(lineItems.map((li) => ({ ...li, invoice_id: invoice.id }))),
  });

  // Generate the PDF now so it's ready the moment someone hits "send".
  const pdfBytes = await generateInvoicePdf(client, invoice, lineItems, customer);
  const pdfUrl = await uploadInvoicePdf(env, clientId, invoiceNumber, pdfBytes);

  await supabaseFetch(env, `invoices?id=eq.${encodeURIComponent(invoice.id)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify({ pdf_url: pdfUrl }),
  });

  return jsonResponse({
    success: true,
    invoiceId: invoice.id,
    invoiceNumber,
    total,
    pdfUrl,
  });
}

function validateInvoicePayload(payload) {
  if (!payload.customer || typeof payload.customer !== "object") return "Missing or invalid 'customer' object.";
  if (!payload.customer.id && !payload.customer.name) return "'customer' needs either an 'id' or a 'name'.";
  if (!Array.isArray(payload.items) || payload.items.length === 0) return "'items' must be a non-empty array.";
  for (const item of payload.items) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) return "Each item needs a positive integer 'quantity'.";
    if (typeof item.price !== "number" || item.price < 0) return "Each item needs a numeric 'price'.";
  }
  return null;
}

async function handleSendInvoice(request, env, invoiceId) {
  const claims = await verifySupabaseJwt(request, env);
  if (!claims) return jsonResponse({ success: false, error: "Unauthorized." }, 401);

  const clientId = await resolveClientId(env, claims.sub);
  if (!clientId) {
    return jsonResponse({ success: false, error: "No client account linked to this login." }, 403);
  }

  const invoices = await supabaseFetch(
    env,
    `invoices?id=eq.${encodeURIComponent(invoiceId)}&client_id=eq.${encodeURIComponent(clientId)}&select=*,customer:customers(*),invoice_items(*)`
  );
  const invoice = invoices[0];
  if (!invoice) return jsonResponse({ success: false, error: "Invoice not found." }, 404);
  if (!invoice.customer || !invoice.customer.email) {
    return jsonResponse({ success: false, error: "Invoice has no customer email on file." }, 400);
  }

  const client = await loadClient(env, clientId);

  // Regenerate fresh at send time — guarantees the attached PDF always
  // reflects the current invoice_items/status, even if items changed
  // since creation.
  const pdfBytes = await generateInvoicePdf(client, invoice, invoice.invoice_items, invoice.customer);
  const pdfUrl = await uploadInvoicePdf(env, clientId, invoice.invoice_number, pdfBytes);
  const pdfBase64 = arrayBufferToBase64(pdfBytes);

  const emailResult = await sendEmail(env, {
    to: invoice.customer.email,
    from: buildFromAddress(client),
    replyTo: client.reply_email || undefined,
    subject: `Invoice ${invoice.invoice_number}`,
    html: buildInvoiceEmail(client, { ...invoice, pdf_url: pdfUrl }),
    attachments: [{ filename: `${invoice.invoice_number}.pdf`, content: pdfBase64 }],
  });

  await supabaseFetch(env, `invoices?id=eq.${encodeURIComponent(invoiceId)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify({ status: "sent", pdf_url: pdfUrl }),
  });

  await logEmail(env, {
    clientId,
    relatedType: "invoice",
    relatedId: invoice.id,
    recipient: invoice.customer.email,
    subject: `Invoice ${invoice.invoice_number}`,
    resendId: emailResult?.id || null,
  });

  return jsonResponse({ success: true, invoiceId: invoice.id, status: "sent" });
}

// ==================================================
// INVOICE PDF GENERATION (pdf-lib)
// ==================================================

const PAGE_WIDTH = 595; // A4 in points
const PAGE_HEIGHT = 842;
const MARGIN = 50;
const TEXT_COLOR = rgb(0.13, 0.13, 0.13);
const MUTED_COLOR = rgb(0.45, 0.45, 0.45);
const LINE_COLOR = rgb(0.82, 0.82, 0.82);

async function generateInvoicePdf(client, invoice, lineItems, customer) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let y = PAGE_HEIGHT - MARGIN;

  // ---- Header: logo (if any) + business name ----
  const logoImage = await tryEmbedLogo(pdfDoc, client.logo_url);
  if (logoImage) {
    const logoHeight = 44;
    const logoWidth = (logoImage.width / logoImage.height) * logoHeight;
    page.drawImage(logoImage, { x: MARGIN, y: y - logoHeight, width: logoWidth, height: logoHeight });
  }

  page.drawText(client.business_name || "", {
    x: MARGIN,
    y: y - 60,
    size: 12,
    font: boldFont,
    color: TEXT_COLOR,
  });

  // "INVOICE" + number, right-aligned
  const invoiceTitle = "INVOICE";
  const titleWidth = boldFont.widthOfTextAtSize(invoiceTitle, 22);
  page.drawText(invoiceTitle, {
    x: PAGE_WIDTH - MARGIN - titleWidth,
    y: y - 10,
    size: 22,
    font: boldFont,
    color: TEXT_COLOR,
  });

  const invoiceNumberText = `#${invoice.invoice_number}`;
  const invoiceNumberWidth = font.widthOfTextAtSize(invoiceNumberText, 11);
  page.drawText(invoiceNumberText, {
    x: PAGE_WIDTH - MARGIN - invoiceNumberWidth,
    y: y - 28,
    size: 11,
    font,
    color: MUTED_COLOR,
  });

  y -= 90;

  // ---- Dates + Bill To, side by side ----
  const issuedDate = new Date(invoice.issued_at || invoice.created_at || Date.now()).toLocaleDateString();
  page.drawText(`Issued: ${issuedDate}`, { x: MARGIN, y, size: 10, font, color: MUTED_COLOR });
  if (invoice.due_at) {
    page.drawText(`Due: ${new Date(invoice.due_at).toLocaleDateString()}`, {
      x: MARGIN,
      y: y - 14,
      size: 10,
      font,
      color: MUTED_COLOR,
    });
  }

  const billToX = 320;
  page.drawText("Bill To", { x: billToX, y, size: 10, font: boldFont, color: TEXT_COLOR });
  page.drawText(customer.name || "", { x: billToX, y: y - 14, size: 10, font, color: TEXT_COLOR });
  let billToY = y - 28;
  if (customer.email) {
    page.drawText(customer.email, { x: billToX, y: billToY, size: 10, font, color: MUTED_COLOR });
    billToY -= 14;
  }
  if (customer.phone) {
    page.drawText(customer.phone, { x: billToX, y: billToY, size: 10, font, color: MUTED_COLOR });
  }

  y -= 60;

  // ---- Itemized table ----
  const col = { desc: MARGIN, qty: 340, price: 400, total: 480 };
  page.drawText("Description", { x: col.desc, y, size: 9, font: boldFont, color: MUTED_COLOR });
  page.drawText("Qty", { x: col.qty, y, size: 9, font: boldFont, color: MUTED_COLOR });
  page.drawText("Price", { x: col.price, y, size: 9, font: boldFont, color: MUTED_COLOR });
  page.drawText("Total", { x: col.total, y, size: 9, font: boldFont, color: MUTED_COLOR });
  y -= 6;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 0.75, color: LINE_COLOR });
  y -= 18;

  for (const item of lineItems) {
    if (y < 140) break; // simple guard — long invoices need real pagination, flagged below
    page.drawText(truncateText(font, item.description || "", 9, 260), {
      x: col.desc,
      y,
      size: 9,
      font,
      color: TEXT_COLOR,
    });
    page.drawText(String(item.quantity), { x: col.qty, y, size: 9, font, color: TEXT_COLOR });
    page.drawText(formatMoney(item.unit_price), { x: col.price, y, size: 9, font, color: TEXT_COLOR });
    page.drawText(formatMoney(item.line_total), { x: col.total, y, size: 9, font, color: TEXT_COLOR });
    y -= 18;
  }

  y -= 8;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 0.75, color: LINE_COLOR });
  y -= 22;

  // ---- Totals, right-aligned ----
  drawRightAligned(page, font, `Subtotal   ${formatMoney(invoice.subtotal)}`, y, 10, MUTED_COLOR);
  y -= 16;
  drawRightAligned(page, font, `Tax   ${formatMoney(invoice.tax)}`, y, 10, MUTED_COLOR);
  y -= 20;
  drawRightAligned(page, boldFont, `Total   ${formatMoney(invoice.total)}`, y, 13, TEXT_COLOR);

  y -= 50;

  // ---- Banking details ----
  if (client.bank_name || client.bank_account_number) {
    page.drawText("Banking Details", { x: MARGIN, y, size: 10, font: boldFont, color: TEXT_COLOR });
    y -= 16;
    const bankLines = [
      client.bank_name ? `Bank: ${client.bank_name}` : null,
      client.bank_account_name ? `Account Name: ${client.bank_account_name}` : null,
      client.bank_account_number ? `Account Number: ${client.bank_account_number}` : null,
      client.bank_branch_code ? `Branch Code: ${client.bank_branch_code}` : null,
    ].filter(Boolean);

    for (const line of bankLines) {
      page.drawText(line, { x: MARGIN, y, size: 9, font, color: MUTED_COLOR });
      y -= 13;
    }
    y -= 10;
  }

  // ---- Payment instructions ----
  if (client.payment_instructions) {
    page.drawText("Payment Instructions", { x: MARGIN, y, size: 10, font: boldFont, color: TEXT_COLOR });
    y -= 16;
    const wrapped = wrapText(font, client.payment_instructions, 9, PAGE_WIDTH - MARGIN * 2);
    for (const line of wrapped) {
      page.drawText(line, { x: MARGIN, y, size: 9, font, color: MUTED_COLOR });
      y -= 13;
    }
  }

  return pdfDoc.save();
}

/**
 * Fetches and embeds a client's logo from its URL (R2 or otherwise).
 * Supports PNG/JPEG. Returns null (never throws) if it's missing,
 * unreachable, or an unsupported format — a PDF without a logo is far
 * better than a failed invoice send.
 */
async function tryEmbedLogo(pdfDoc, logoUrl) {
  if (!logoUrl) return null;
  try {
    const response = await fetch(logoUrl);
    if (!response.ok) return null;
    const contentType = response.headers.get("Content-Type") || "";
    const bytes = new Uint8Array(await response.arrayBuffer());

    if (contentType.includes("png") || logoUrl.toLowerCase().endsWith(".png")) {
      return await pdfDoc.embedPng(bytes);
    }
    if (contentType.includes("jpeg") || contentType.includes("jpg") || /\.jpe?g$/i.test(logoUrl)) {
      return await pdfDoc.embedJpg(bytes);
    }
    return null; // webp/gif logos aren't supported by pdf-lib's embedder
  } catch {
    return null;
  }
}

function drawRightAligned(page, font, text, y, size, color) {
  const width = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: PAGE_WIDTH - MARGIN - width, y, size, font, color });
}

function truncateText(font, text, size, maxWidth) {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let result = text;
  while (result.length > 1 && font.widthOfTextAtSize(result + "…", size) > maxWidth) {
    result = result.slice(0, -1);
  }
  return result + "…";
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

async function uploadInvoicePdf(env, clientId, invoiceNumber, pdfBytes) {
  const key = `clients/${clientId}/invoices/${invoiceNumber}.pdf`;
  await env.R2_BUCKET.put(key, pdfBytes, { httpMetadata: { contentType: "application/pdf" } });
  return `${env.R2_PUBLIC_URL.replace(/\/$/, "")}/${key}`;
}

function arrayBufferToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ==================================================
// ACCOUNT CLAIMING (called once, right after signup)
// ==================================================

/**
 * Called immediately after a user completes Supabase Auth signup.
 * Three possible outcomes:
 *  1. Already linked (re-called on a later login by mistake) — no-op.
 *  2. A `clients` row already exists for this email (created when the
 *     agency built their site) but has no auth_user_id yet — link it.
 *  3. No matching row at all — this is a brand new self-service
 *     signup with no pre-existing website — create a fresh client.
 */
async function handleClaimAccount(request, env) {
  const claims = await verifySupabaseJwt(request, env);
  if (!claims) return jsonResponse({ success: false, error: "Unauthorized." }, 401);
  if (!claims.email) return jsonResponse({ success: false, error: "Token has no email claim." }, 400);

  const authUserId = claims.sub;
  const email = claims.email.toLowerCase();

  // 1. Already linked?
  const alreadyLinked = await supabaseFetch(
    env,
    `clients?auth_user_id=eq.${encodeURIComponent(authUserId)}&select=client_id,business_name`
  );
  if (alreadyLinked.length) {
    return jsonResponse({ success: true, status: "already_linked", client: alreadyLinked[0] });
  }

  // 2. Pre-existing client row waiting to be claimed (case-insensitive
  // email match, not yet linked to any login)?
  const unclaimed = await supabaseFetch(
    env,
    `clients?owner_email=ilike.${encodeURIComponent(email)}&auth_user_id=is.null&select=client_id,business_name`
  );
  if (unclaimed.length) {
    const client = unclaimed[0];
    await supabaseFetch(env, `clients?client_id=eq.${encodeURIComponent(client.client_id)}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify({ auth_user_id: authUserId }),
    });
    return jsonResponse({ success: true, status: "linked", client });
  }

  // 3. No existing record — brand new self-service business.
  const payload = await parseJsonBody(request);
  const businessName = payload?.businessName || "My Business";
  const clientId = generateReference("CLI").toLowerCase();

  const [created] = await supabaseFetch(env, "clients", {
    method: "POST",
    body: JSON.stringify({
      client_id: clientId,
      auth_user_id: authUserId,
      business_name: businessName,
      owner_email: email,
      active: true,
    }),
  });

  return jsonResponse({ success: true, status: "created", client: created });
}

// ==================================================
// MANUAL RELINK (fallback — claim code, e.g. Google email mismatch)
// ==================================================

/**
 * Lets a logged-in user manually link their account to a pre-existing
 * business using a claim code the agency gave them, in cases where
 * automatic email matching failed (e.g. they used Google Sign-In with a
 * different email than the one on file).
 *
 * Safety: if this user's login already auto-created an empty placeholder
 * client (the "created" branch of /api/claim-account), that placeholder
 * gets deactivated ONLY if it's genuinely empty — no products, orders,
 * bookings, invoices, or submissions. If it already has real data, this
 * refuses and asks for manual support instead of silently discarding it.
 */
async function handleRelinkAccount(request, env) {
  const claims = await verifySupabaseJwt(request, env);
  if (!claims) return jsonResponse({ success: false, error: "Unauthorized." }, 401);

  const payload = await parseJsonBody(request);
  const claimCode = (payload?.claimCode || "").trim().toUpperCase();
  if (!claimCode) {
    return jsonResponse({ success: false, error: "Missing 'claimCode'." }, 400);
  }

  const authUserId = claims.sub;

  const targets = await supabaseFetch(
    env,
    `clients?claim_code=eq.${encodeURIComponent(claimCode)}&select=*`
  );
  const target = targets[0];
  if (!target) {
    return jsonResponse({ success: false, error: "Invalid claim code." }, 404);
  }

  if (target.auth_user_id === authUserId) {
    return jsonResponse({ success: true, status: "already_linked", client: target });
  }

  if (target.auth_user_id) {
    return jsonResponse(
      { success: false, error: "This business is already linked to another account. Contact support." },
      409
    );
  }

  // Does this user currently own a different (likely placeholder) client?
  const existingOwned = await supabaseFetch(
    env,
    `clients?auth_user_id=eq.${encodeURIComponent(authUserId)}&select=client_id`
  );

  if (existingOwned.length && existingOwned[0].client_id !== target.client_id) {
    const placeholderId = existingOwned[0].client_id;
    const isEmpty = await clientHasNoData(env, placeholderId);

    if (!isEmpty) {
      return jsonResponse(
        {
          success: false,
          error:
            "Your account already has data under a different business record. This needs a manual merge — contact support rather than continuing here.",
        },
        409
      );
    }

    // Safe to release the empty placeholder.
    await supabaseFetch(env, `clients?client_id=eq.${encodeURIComponent(placeholderId)}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify({ auth_user_id: null, active: false }),
    });
  }

  await supabaseFetch(env, `clients?client_id=eq.${encodeURIComponent(target.client_id)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify({ auth_user_id: authUserId }),
  });

  return jsonResponse({ success: true, status: "linked", client: { ...target, auth_user_id: authUserId } });
}

async function clientHasNoData(env, clientId) {
  const tables = ["products", "orders", "bookings", "invoices", "submissions"];
  for (const table of tables) {
    const rows = await supabaseFetch(
      env,
      `${table}?client_id=eq.${encodeURIComponent(clientId)}&select=id&limit=1`
    );
    if (rows.length) return false;
  }
  return true;
}

// ==================================================
// GLOBAL SEARCH (authenticated — dashboard-triggered)
// ==================================================

async function handleSearch(request, env) {
  const claims = await verifySupabaseJwt(request, env);
  if (!claims) return jsonResponse({ success: false, error: "Unauthorized." }, 401);

  const clientId = await resolveClientId(env, claims.sub);
  if (!clientId) {
    return jsonResponse({ success: false, error: "No client account linked to this login." }, 403);
  }

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();

  if (q.length < 2) {
    return jsonResponse({ success: false, error: "Search query must be at least 2 characters." }, 400);
  }

  const results = await supabaseFetch(env, "rpc/search_all", {
    method: "POST",
    prefer: "return=representation",
    body: JSON.stringify({ p_client_id: clientId, q }),
  });

  return jsonResponse({ success: true, query: q, results });
}

// ==================================================
// CSV EXPORT (authenticated — dashboard-triggered)
// ==================================================

async function handleExport(request, env, table) {
  const claims = await verifySupabaseJwt(request, env);
  if (!claims) return jsonResponse({ success: false, error: "Unauthorized." }, 401);

  const clientId = await resolveClientId(env, claims.sub);
  if (!clientId) {
    return jsonResponse({ success: false, error: "No client account linked to this login." }, 403);
  }

  const config = EXPORTABLE_TABLES[table];
  if (!config) {
    return jsonResponse(
      { success: false, error: `Unknown export table. Choose one of: ${Object.keys(EXPORTABLE_TABLES).join(", ")}` },
      400
    );
  }

  const url = new URL(request.url);
  const dateFrom = url.searchParams.get("from"); // e.g. 2026-01-01
  const dateTo = url.searchParams.get("to");

  let path = `${table}?client_id=eq.${encodeURIComponent(clientId)}&select=*`;
  if (dateFrom) path += `&${config.dateColumn}=gte.${encodeURIComponent(dateFrom)}`;
  if (dateTo) path += `&${config.dateColumn}=lte.${encodeURIComponent(dateTo)}`;
  path += `&order=${config.dateColumn}.desc`;

  const rows = await supabaseFetch(env, path);
  const csv = rowsToCsv(rows || []);
  const filename = `${config.filename}-${new Date().toISOString().slice(0, 10)}.csv`;

  return new Response(csv, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

function rowsToCsv(rows) {
  if (!rows.length) return "";

  // Union of keys across all rows, in case some rows have nulls/missing
  // fields — keeps the header consistent even with sparse data.
  const columns = Array.from(
    rows.reduce((set, row) => {
      Object.keys(row).forEach((key) => set.add(key));
      return set;
    }, new Set())
  );

  const header = columns.map(csvEscape).join(",");
  const lines = rows.map((row) =>
    columns.map((col) => csvEscape(formatCsvValue(row[col]))).join(",")
  );

  return [header, ...lines].join("\r\n");
}

function formatCsvValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function csvEscape(value) {
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// ==================================================
// RATE LIMITING
// ==================================================

/**
 * Simple fixed-window rate limiter backed by Workers KV.
 * Degrades gracefully (allows the request) if RATE_LIMIT_KV isn't bound,
 * so the worker never hard-fails due to missing config.
 */
async function checkRateLimit(env, key, { max, windowSeconds }) {
  if (!env.RATE_LIMIT_KV) {
    return { allowed: true, retryAfter: 0 };
  }

  const now = Date.now();
  const raw = await env.RATE_LIMIT_KV.get(key);
  let record = raw ? JSON.parse(raw) : null;

  if (!record || now > record.resetAt) {
    record = { count: 0, resetAt: now + windowSeconds * 1000 };
  }

  record.count += 1;

  const secondsUntilReset = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
  // Cloudflare KV requires expirationTtl >= 60, even if the rate-limit
  // window itself is shorter — this is a storage constraint, unrelated
  // to how long the limit should actually apply for.
  const kvTtl = Math.max(60, secondsUntilReset);
  await env.RATE_LIMIT_KV.put(key, JSON.stringify(record), { expirationTtl: kvTtl });

  if (record.count > max) {
    return { allowed: false, retryAfter: secondsUntilReset };
  }

  return { allowed: true, retryAfter: 0 };
}

// ==================================================
// EMAIL CONTENT BUILDERS
// ==================================================

function getFormCopy(formName) {
  const key = String(formName || "").toLowerCase().trim();
  return FORM_COPY[key] || DEFAULT_FORM_COPY;
}

function buildFromAddress(client) {
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

function buildCustomerEmail(client, formName, customer, fields, context) {
  const copy = getFormCopy(formName);

  const body = `
    <h2 style="margin-top:0;">${escapeHtml(copy.heading)}</h2>
    <p>Hi ${escapeHtml(customer.name)}, ${escapeHtml(copy.intro)}</p>
    ${buildFieldsHtml(fields)}
    <p style="margin-top:24px;color:#888;font-size:12px;">Reference: ${escapeHtml(context.submissionId)}</p>
  `;

  return buildEmailShell(client, body);
}

function buildOwnerEmail(client, formName, customer, fields, context) {
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

function formatMoney(value) {
  return `$${Number(value).toFixed(2)}`;
}

function buildOrderCustomerEmail(client, order, lineItems, customer) {
  const body = `
    <h2 style="margin-top:0;">Order Confirmed</h2>
    <p>Hi ${escapeHtml(customer.name)}, thanks for your order! Here's a summary:</p>
    ${buildLineItemsHtml(lineItems)}
    <p style="margin-top:16px;font-weight:600;">Total: ${formatMoney(order.total)}</p>
    <p style="margin-top:24px;color:#888;font-size:12px;">Order reference: ${escapeHtml(order.order_number)}</p>
  `;
  return buildEmailShell(client, body);
}

function buildOrderOwnerEmail(client, order, lineItems, customer) {
  const body = `
    <h2 style="margin-top:0;">New order ${escapeHtml(order.order_number)}</h2>
    <p><strong>Customer:</strong> ${escapeHtml(customer.name)} (${escapeHtml(customer.email)})</p>
    ${buildLineItemsHtml(lineItems)}
    <p style="margin-top:16px;font-weight:600;">Total: ${formatMoney(order.total)}</p>
  `;
  return buildEmailShell(client, body);
}

function buildBookingCustomerEmail(client, booking, service, customer) {
  const body = `
    <h2 style="margin-top:0;">Booking Confirmed</h2>
    <p>Hi ${escapeHtml(customer.name)}, your booking is confirmed:</p>
    <p><strong>Service:</strong> ${escapeHtml(service.name)}</p>
    <p><strong>Time:</strong> ${escapeHtml(new Date(booking.start_time).toLocaleString())}</p>
  `;
  return buildEmailShell(client, body);
}

function buildBookingOwnerEmail(client, booking, service, customer) {
  const body = `
    <h2 style="margin-top:0;">New booking: ${escapeHtml(service.name)}</h2>
    <p><strong>Customer:</strong> ${escapeHtml(customer.name)} (${escapeHtml(customer.email)})</p>
    <p><strong>Time:</strong> ${escapeHtml(new Date(booking.start_time).toLocaleString())}</p>
  `;
  return buildEmailShell(client, body);
}

function buildInvoiceEmail(client, invoice) {
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
// SECURITY HELPERS
// ==================================================

function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ==================================================
// RESEND
// ==================================================

async function sendEmail(env, { to, from, replyTo, subject, html, attachments }) {
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
    body.attachments = attachments; // [{ filename, content: base64 }]
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