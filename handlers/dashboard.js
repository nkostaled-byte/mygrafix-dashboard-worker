/**
 * Dashboard CRUD Handler
 * =======================
 * All /api/dashboard/* endpoints — authenticated CRUD for business resources.
 *
 * Supports: products, customers, bookings, orders, invoices, submissions,
 *           services, staff, team_members
 */

import { jsonResponse } from "../lib/responses.js";
import { parseJsonBody, generateRequestId, generateReference, mapResourceFields } from "../lib/utils.js";
import { verifySupabaseJwt, resolveClientId } from "../lib/auth.js";
import { supabaseFetch } from "../lib/supabase.js";
import { ALLOWED_DASHBOARD_RESOURCES } from "../config/constants.js";
import { findOrCreateCustomer } from "../services/customerService.js";

// ==================================================
// AUTHENTICATION HELPER
// ==================================================

async function authenticateDashboardRequest(request, env) {
  const claims = await verifySupabaseJwt(request, env);
  if (!claims) return { error: jsonResponse({ success: false, error: "Unauthorized." }, 401) };

  const clientId = await resolveClientId(env, claims.sub);
  if (!clientId) return { error: jsonResponse({ success: false, error: "No client account linked to this login." }, 403) };

  return { claims, clientId };
}

// ==================================================
// CRUD HANDLERS
// ==================================================

async function handleDashboardList(request, env, resource) {
  const auth = await authenticateDashboardRequest(request, env);
  if (auth.error) return auth.error;
  const { clientId } = auth;

  const url = new URL(request.url);
  let path = `${resource}?client_id=eq.${encodeURIComponent(clientId)}&select=*`;

  const orderBy = url.searchParams.get("order");
  if (orderBy) {
    path += `&order=${encodeURIComponent(orderBy)}`;
  } else {
    path += `&order=created_at.desc`;
  }

  const limit = url.searchParams.get("limit");
  if (limit) path += `&limit=${encodeURIComponent(limit)}`;

  const rows = await supabaseFetch(env, path);
  const mapped = mapResourceFields(rows || [], resource, "toCamel");

  // Resolve category_id → category name for products
  if (resource === "products" && mapped.length) {
    const categoryIds = mapped.filter(p => p.categoryId).map(p => p.categoryId);
    if (categoryIds.length) {
      const inFilter = categoryIds.map(id => `"${id}"`).join(",");
      const categories = await supabaseFetch(
        env,
        `categories?client_id=eq.${encodeURIComponent(clientId)}&id=in.(${inFilter})&select=id,name`
      );
      const catMap = new Map((categories || []).map(c => [c.id, c.name]));
      for (const product of mapped) {
        product.category = catMap.get(product.categoryId) || "";
      }
    }
  }

  return jsonResponse({ success: true, data: mapped });
}

/**
 * Known database columns per resource (snake_case).
 * Used to sanitize incoming payloads — unsupported fields are safely ignored.
 */
const KNOWN_COLUMNS = {
  products: ["client_id", "name", "sku", "category_id", "price", "cost_price", "stock_qty", "low_stock_warning", "image_url", "barcode", "variants", "is_hidden"],
  services: ["client_id", "name", "category", "duration_minutes", "price", "description", "image_url", "active"],
  customers: ["client_id", "name", "email", "phone", "notes", "tags"],
  bookings: ["client_id", "customer_id", "service_id", "staff_id", "start_time", "end_time", "status"],
  orders: ["client_id", "customer_id", "order_number", "status", "subtotal", "tax", "total", "notes"],
  invoices: ["client_id", "customer_id", "order_id", "invoice_number", "status", "subtotal", "tax", "total", "issued_at", "due_at", "pdf_url"],
  staff: ["client_id", "name", "full_name", "role", "active"],
  submissions: ["submission_id", "client_id", "form_name", "customer_name", "customer_email", "submission_json", "status", "ip_address", "user_agent"],
  gallery: ["client_id", "title", "before_url", "after_url", "barber_name"],
  reviews: ["client_id", "name", "rating", "text", "service", "avatar"],
  team_members: ["client_id", "auth_user_id", "name", "email", "role", "active"],
  clients: ["client_id", "auth_user_id", "business_name", "owner_email", "reply_email", "active", "logo_url", "primary_color", "secondary_color", "hero_title", "hero_subtitle", "phone", "address", "opening_hours", "business_type", "claim_code", "bank_name", "bank_account_name", "bank_account_number", "bank_branch_code", "payment_instructions"],
};

/**
 * Sanitize a payload to only include known database columns for the given resource.
 * Unknown fields are silently dropped.
 */
function sanitizePayload(payload, resource) {
  const allowed = KNOWN_COLUMNS[resource];
  if (!allowed) return payload; // unknown resource, pass through

  const sanitized = {};
  for (const key of Object.keys(payload)) {
    if (allowed.includes(key)) {
      sanitized[key] = payload[key];
    }
  }
  return sanitized;
}

async function handleDashboardCreate(request, env, resource) {
  const auth = await authenticateDashboardRequest(request, env);
  if (auth.error) return auth.error;
  const { clientId } = auth;

  const payload = await parseJsonBody(request);
  if (!payload) return jsonResponse({ success: false, error: "Invalid or missing JSON body." }, 400);

  const mappedPayload = mapResourceFields({ ...payload, clientId }, resource, "toSnake");

  // ── Auto-generate SKU for products if missing ────────────────
  if (resource === "products") {
    if (!mappedPayload.sku || mappedPayload.sku.trim() === "") {
      mappedPayload.sku = generateReference("SKU");
    }
    if (mappedPayload.is_hidden === undefined) {
      mappedPayload.is_hidden = false;
    }
    // Ensure required numeric defaults
    if (mappedPayload.cost_price === undefined) mappedPayload.cost_price = 0;
    if (mappedPayload.low_stock_warning === undefined) mappedPayload.low_stock_warning = 5;

    // Resolve category name → category_id
    // Frontend sends `category` (text), but DB uses `category_id` (FK to categories table)
    const categoryName = mappedPayload.category || payload.category || "";
    delete mappedPayload.category;
    if (categoryName) {
      // Look for existing category by name
      const existing = await supabaseFetch(
        env,
        `categories?client_id=eq.${encodeURIComponent(clientId)}&name=eq.${encodeURIComponent(categoryName)}&select=id`,
        { requestId: generateRequestId() }
      );
      if (existing && existing.length) {
        mappedPayload.category_id = existing[0].id;
      } else {
        // Create new category
        const [newCategory] = await supabaseFetch(env, "categories", {
          method: "POST",
          body: JSON.stringify({
            client_id: clientId,
            name: categoryName,
            sort_order: 0,
          }),
          requestId: generateRequestId(),
        });
        mappedPayload.category_id = newCategory?.id || null;
      }
    }
  }

  // ── Resource-specific preprocessing ──────────────────────────
  if (resource === "orders") {
    const customerName = mappedPayload.customer_name || payload.customerName || "";
    const customerEmail = mappedPayload.customer_email || payload.customerEmail || "";
    const customer = await findOrCreateCustomer(env, clientId, {
      name: customerName,
      email: customerEmail,
    });
    mappedPayload.customer_id = customer.id;
    mappedPayload.order_number = generateReference("ORD");
    mappedPayload.subtotal = mappedPayload.total || 0;
    mappedPayload.tax = 0;
    delete mappedPayload.customer_name;
    delete mappedPayload.customer_email;
    delete mappedPayload.items_count;
    delete mappedPayload.payment_method;
  }

  if (resource === "invoices") {
    const clientName = mappedPayload.client_name || payload.clientName || "";
    const clientEmail = mappedPayload.client_email || payload.clientEmail || "";
    const customer = await findOrCreateCustomer(env, clientId, {
      name: clientName,
      email: clientEmail,
    });
    mappedPayload.customer_id = customer.id;
    mappedPayload.invoice_number = generateReference("INV");
    mappedPayload.total = mappedPayload.total || mappedPayload.amount || 0;
    mappedPayload.subtotal = mappedPayload.total;
    mappedPayload.tax = 0;
    if (mappedPayload.due_date) {
      mappedPayload.due_at = mappedPayload.due_date;
      delete mappedPayload.due_date;
    }
    delete mappedPayload.client_name;
    delete mappedPayload.client_email;
    delete mappedPayload.amount;
  }

  // ── Sanitize: remove any fields not in the known columns ─────
  const sanitized = sanitizePayload(mappedPayload, resource);

  const result = await supabaseFetch(env, resource, {
    method: "POST",
    body: JSON.stringify(sanitized),
  });

  const mapped = mapResourceFields(result || {}, resource, "toCamel");
  return jsonResponse({ success: true, data: mapped });
}

async function handleDashboardUpdate(request, env, resource, id) {
  const auth = await authenticateDashboardRequest(request, env);
  if (auth.error) return auth.error;
  const { clientId } = auth;

  const payload = await parseJsonBody(request);
  if (!payload) return jsonResponse({ success: false, error: "Invalid or missing JSON body." }, 400);

  const mappedPayload = mapResourceFields(payload, resource, "toSnake");

  const existing = await supabaseFetch(
    env,
    `${resource}?id=eq.${encodeURIComponent(id)}&client_id=eq.${encodeURIComponent(clientId)}&select=id`
  );
  if (!existing || !existing.length) {
    return jsonResponse({ success: false, error: "Resource not found." }, 404);
  }

  // ── Sanitize: remove any fields not in the known columns ─────
  const sanitized = sanitizePayload(mappedPayload, resource);

  await supabaseFetch(env, `${resource}?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify(sanitized),
  });

  return jsonResponse({ success: true });
}

async function handleDashboardDelete(request, env, resource, id) {
  const auth = await authenticateDashboardRequest(request, env);
  if (auth.error) return auth.error;
  const { clientId } = auth;

  const existing = await supabaseFetch(
    env,
    `${resource}?id=eq.${encodeURIComponent(id)}&client_id=eq.${encodeURIComponent(clientId)}&select=id`
  );
  if (!existing || !existing.length) {
    return jsonResponse({ success: false, error: "Resource not found." }, 404);
  }

  await supabaseFetch(env, `${resource}?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE",
    prefer: "return=minimal",
  });

  return jsonResponse({ success: true });
}

// ==================================================
// METRICS
// ==================================================

async function handleDashboardMetrics(request, env) {
  const auth = await authenticateDashboardRequest(request, env);
  if (auth.error) return auth.error;
  const { clientId } = auth;

  const [products, customers, bookings, orders, invoices, submissions] = await Promise.all([
    supabaseFetch(env, `products?client_id=eq.${encodeURIComponent(clientId)}&select=id`),
    supabaseFetch(env, `customers?client_id=eq.${encodeURIComponent(clientId)}&select=id`),
    supabaseFetch(env, `bookings?client_id=eq.${encodeURIComponent(clientId)}&select=id,status`),
    supabaseFetch(env, `orders?client_id=eq.${encodeURIComponent(clientId)}&select=id,total,created_at`),
    supabaseFetch(env, `invoices?client_id=eq.${encodeURIComponent(clientId)}&select=id,total,status`),
    supabaseFetch(env, `submissions?client_id=eq.${encodeURIComponent(clientId)}&select=submission_id,status`),
  ]);

  const totalRevenue = (orders || []).reduce((sum, o) => sum + Number(o.total || 0), 0);
  const pendingInvoices = (invoices || []).filter(i => i.status === "pending" || i.status === "sent" || i.status === "overdue");
  const activeBookings = (bookings || []).filter(b => b.status === "confirmed" || b.status === "upcoming");
  const unreadSubmissions = (submissions || []).filter(s => s.status === "received" || s.status === "new");

  const today = new Date().toISOString().split("T")[0];
  const todayBookings = await supabaseFetch(
    env,
    `bookings?client_id=eq.${encodeURIComponent(clientId)}&start_time=gte.${encodeURIComponent(today + "T00:00:00")}&start_time=lte.${encodeURIComponent(today + "T23:59:59")}&select=*&order=start_time.asc`
  );

  const metrics = {
    totalProducts: (products || []).length,
    totalCustomers: (customers || []).length,
    totalBookings: (bookings || []).length,
    activeBookings: activeBookings.length,
    totalOrders: (orders || []).length,
    totalRevenue,
    pendingInvoices: pendingInvoices.length,
    unreadSubmissions: unreadSubmissions.length,
    todayBookings: todayBookings || [],
    dailySales: buildDailySales(orders || []),
    monthlyRevenue: buildMonthlyRevenue(orders || []),
  };

  return jsonResponse({ success: true, data: metrics });
}

function formatDateYmd(date) {
  return date.toISOString().split("T")[0];
}

function buildDailySales(orders) {
  const buckets = new Map();
  const today = new Date();

  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const key = formatDateYmd(d);
    buckets.set(key, { date: key, revenue: 0, orders: 0 });
  }

  for (const order of orders) {
    if (!order.created_at) continue;
    const key = formatDateYmd(new Date(order.created_at));
    if (buckets.has(key)) {
      const bucket = buckets.get(key);
      bucket.revenue += Number(order.total || 0);
      bucket.orders += 1;
    }
  }

  return Array.from(buckets.values());
}

function buildMonthlyRevenue(orders) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const buckets = new Map();
  const today = new Date();

  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    buckets.set(key, { month: months[d.getUTCMonth()], revenue: 0, yearMonth: key });
  }

  for (const order of orders) {
    if (!order.created_at) continue;
    const d = new Date(order.created_at);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    if (buckets.has(key)) {
      buckets.get(key).revenue += Number(order.total || 0);
    }
  }

  return Array.from(buckets.values());
}

// ==================================================
// MAIN ROUTER
// ==================================================

/**
 * Main entry point for all /api/dashboard/* requests.
 * Delegates to the appropriate handler based on URL pattern and HTTP method.
 */
export async function handleDashboardRoute(request, env, url) {
  // /api/dashboard/metrics
  if (url.pathname === "/api/dashboard/metrics") {
    return await handleDashboardMetrics(request, env);
  }

  // /api/dashboard/:resource/:id/status
  const statusMatch = url.pathname.match(/^\/api\/dashboard\/([a-z_-]+)\/([0-9a-fA-F-]+)\/status$/);
  if (statusMatch && request.method === "PUT") {
    const [, resource, id] = statusMatch;
    return await handleDashboardUpdate(request, env, resource, id);
  }

  // /api/dashboard/:resource/:id
  const idMatch = url.pathname.match(/^\/api\/dashboard\/([a-z_-]+)\/([0-9a-fA-F-]+)$/);
  if (idMatch) {
    const [, resource, id] = idMatch;
    if (request.method === "PUT") return await handleDashboardUpdate(request, env, resource, id);
    if (request.method === "DELETE") return await handleDashboardDelete(request, env, resource, id);
    return jsonResponse({ success: false, error: "Method not allowed." }, 405);
  }

  // /api/dashboard/:resource
  const listMatch = url.pathname.match(/^\/api\/dashboard\/([a-z_-]+)$/);
  if (listMatch) {
    const [, resource] = listMatch;
    if (!ALLOWED_DASHBOARD_RESOURCES.includes(resource)) {
      return jsonResponse({ success: false, error: `Unknown resource: ${resource}` }, 400);
    }

    if (request.method === "GET") return await handleDashboardList(request, env, resource);
    if (request.method === "POST") return await handleDashboardCreate(request, env, resource);
    return jsonResponse({ success: false, error: "Method not allowed." }, 405);
  }

  return jsonResponse({ success: false, error: "Not found." }, 404);
}

