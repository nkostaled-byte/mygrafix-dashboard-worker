/**
 * Dashboard CRUD Handler
 * =======================
 * All /api/dashboard/* endpoints — authenticated CRUD for business resources.
 *
 * Supports: products, customers, bookings, orders, invoices, submissions,
 *           services, staff, team_members
 */

import { jsonResponse } from "../lib/responses.js";
import { parseJsonBody, generateRequestId } from "../lib/utils.js";
import { verifySupabaseJwt, resolveClientId } from "../lib/auth.js";
import { supabaseFetch } from "../lib/supabase.js";
import { ALLOWED_DASHBOARD_RESOURCES } from "../config/constants.js";

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
  if (orderBy) path += `&order=${encodeURIComponent(orderBy)}`;

  const limit = url.searchParams.get("limit");
  if (limit) path += `&limit=${encodeURIComponent(limit)}`;

  const rows = await supabaseFetch(env, path);
  return jsonResponse({ success: true, data: rows || [] });
}

async function handleDashboardCreate(request, env, resource) {
  const auth = await authenticateDashboardRequest(request, env);
  if (auth.error) return auth.error;
  const { clientId } = auth;

  const payload = await parseJsonBody(request);
  if (!payload) return jsonResponse({ success: false, error: "Invalid or missing JSON body." }, 400);

  const row = { ...payload, client_id: clientId };
  if (resource === "products" && row.is_hidden === undefined) {
    row.is_hidden = false;
  }

  const result = await supabaseFetch(env, resource, {
    method: "POST",
    body: JSON.stringify(row),
  });

  return jsonResponse({ success: true, data: result });
}

async function handleDashboardUpdate(request, env, resource, id) {
  const auth = await authenticateDashboardRequest(request, env);
  if (auth.error) return auth.error;
  const { clientId } = auth;

  const payload = await parseJsonBody(request);
  if (!payload) return jsonResponse({ success: false, error: "Invalid or missing JSON body." }, 400);

  const existing = await supabaseFetch(
    env,
    `${resource}?id=eq.${encodeURIComponent(id)}&client_id=eq.${encodeURIComponent(clientId)}&select=id`
  );
  if (!existing || !existing.length) {
    return jsonResponse({ success: false, error: "Resource not found." }, 404);
  }

  await supabaseFetch(env, `${resource}?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify(payload),
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
    supabaseFetch(env, `submissions?client_id=eq.${encodeURIComponent(clientId)}&select=id,status`),
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
    daily_sales: buildDailySales(orders || []),
    monthly_revenue: buildMonthlyRevenue(orders || []),
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

