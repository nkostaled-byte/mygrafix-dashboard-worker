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
import { verifySupabaseJwt, resolveUserRole } from "../lib/auth.js";
import { supabaseFetch, supabaseAdminCreateUser } from "../lib/supabase.js";
import { ALLOWED_DASHBOARD_RESOURCES, RESOURCE_MIN_PLAN, FEATURE_MIN_PLAN } from "../config/constants.js";
import { findOrCreateCustomer } from "../services/customerService.js";
import { loadClient } from "../services/clientService.js";
import { getEffectivePlan, getPlanTier, planAccessDenied } from "../lib/planAccess.js";

// ==================================================
// AUTHENTICATION HELPER
// ==================================================

async function authenticateDashboardRequest(request, env) {
  const claims = await verifySupabaseJwt(request, env);
  if (!claims) return { error: jsonResponse({ success: false, error: "Unauthorized." }, 401) };

  const resolved = await resolveUserRole(env, claims.sub);
  if (!resolved) return { error: jsonResponse({ success: false, error: "No client account linked to this login." }, 403) };

  const client = await loadClient(env, resolved.clientId);
  const plan = getEffectivePlan(client);
  return { claims, clientId: resolved.clientId, role: resolved.role, client, plan, planTier: getPlanTier(plan) };
}

/**
 * Plan-gating guard. Returns a 403 jsonResponse if `auth.plan` does not meet
 * `minPlan`, otherwise returns null (allowed).
 */
function assertPlan(auth, minPlan) {
  return auth.planTier >= getPlanTier(minPlan) ? null : planAccessDenied(minPlan);
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

  // Invoices: also pull the linked customer for display (client name/email)
  if (resource === "invoices") {
    path = `${resource}?client_id=eq.${encodeURIComponent(clientId)}&select=*,customer:customers(id,name,email)`;
  }

// Bookings: pull linked customer/service/staff names for display
  if (resource === "bookings") {
    path = `${resource}?client_id=eq.${encodeURIComponent(clientId)}&select=*,customer:customers(id,name,phone),service:services(id,name,price),staff:staff(id,name)`;
  }

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

  // Expose the linked customer as clientName / clientEmail for the frontend
  if (resource === "invoices" && mapped.length) {
    for (const invoice of mapped) {
      const customer = invoice.customer || null;
      invoice.clientName = customer?.name || invoice.clientName || "";
      invoice.clientEmail = customer?.email || invoice.clientEmail || "";
      delete invoice.customer;
    }
  }

  // Bookings: expose linked customer/service/staff names for the frontend
  if (resource === "bookings" && mapped.length) {
    for (const booking of mapped) {
      const customer = booking.customer || null;
      const service = booking.service || null;
      const staff = booking.staff || null;
      booking.clientName = customer?.name || booking.clientName || "";
      booking.clientPhone = customer?.phone || booking.clientPhone || "";
      booking.serviceName = service?.name || booking.serviceName || "";
      booking.staffName = staff?.name || booking.staffName || "";
      // Fall back to the linked service price when no amount was stored.
      if (!booking.amount && service?.price != null) {
        booking.amount = Number(service.price);
      }
      // Derive the display date/time from start_time (the DB only stores start_time/end_time)
      if (booking.startTime && (!booking.date || !booking.time)) {
        const dt = new Date(booking.startTime);
        if (!isNaN(dt.getTime())) {
          if (!booking.date) {
            const y = dt.getFullYear();
            const m = String(dt.getMonth() + 1).padStart(2, "0");
            const d = String(dt.getDate()).padStart(2, "0");
            booking.date = `${y}-${m}-${d}`;
          }
          if (!booking.time) {
            booking.time = `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
          }
        }
      }
      delete booking.customer;
      delete booking.service;
      delete booking.staff;
    }
  }

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
  bookings: ["client_id", "customer_id", "service_id", "staff_id", "start_time", "end_time", "status", "notes", "amount"],
  orders: ["client_id", "customer_id", "customer_name", "order_number", "status", "subtotal", "tax", "total", "notes", "is_pos", "payment_method", "items", "items_count"],
  invoices: ["client_id", "customer_id", "order_id", "invoice_number", "status", "subtotal", "tax", "total", "issued_at", "due_at", "pdf_url"],
  staff: ["client_id", "name", "role", "email", "phone", "specialties", "photo_url", "active"],
  submissions: ["submission_id", "client_id", "form_name", "customer_name", "customer_email", "submission_json", "status", "ip_address", "user_agent"],
  gallery: ["client_id", "title", "before_url", "after_url", "barber_name"],
  reviews: ["client_id", "name", "rating", "text", "service", "avatar"],
  team_members: ["client_id", "auth_user_id", "name", "email", "role", "active"],
  clients: ["client_id", "auth_user_id", "business_name", "owner_email", "reply_email", "active", "logo_url", "primary_color", "secondary_color", "hero_title", "hero_subtitle", "phone", "address", "opening_hours", "business_type", "claim_code", "bank_name", "bank_account_name", "bank_account_number", "bank_branch_code", "payment_instructions"],
};

/**
 * Role-based access control.
 * `staff` team members can use operational resources (POS, inventory, orders,
 * customers, services, bookings, gallery, reviews, forms) but NOT admin areas
 * (invoices/billing, team management, client settings, clients).
 */
const STAFF_ALLOWED_RESOURCES = new Set([
  "products", "orders", "customers", "services", "bookings",
  "staff", "gallery", "reviews", "submissions",
]);

function isAdmin(role) {
  return role === "owner" || role === "admin";
}

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
        // Create new category (no sort_order column in categories table)
        const [newCategory] = await supabaseFetch(env, "categories", {
          method: "POST",
          body: JSON.stringify({
            client_id: clientId,
            name: categoryName,
          }),
          requestId: generateRequestId(),
        });
        mappedPayload.category_id = newCategory?.id || null;
      }
    }
  }

  // ── Resource-specific preprocessing ──────────────────────────
  if (resource === "staff") {
    if (mappedPayload.active === undefined) mappedPayload.active = true;
    if (mappedPayload.role === undefined) mappedPayload.role = "Team Member";
  }

  if (resource === "orders") {
    const customerName = mappedPayload.customer_name || payload.customerName || "";
    const customerEmail = mappedPayload.customer_email || payload.customerEmail || "";
    const customer = await findOrCreateCustomer(env, clientId, {
      name: customerName,
      email: customerEmail,
    });
    mappedPayload.customer_id = customer.id;
    // Keep a frontend-supplied receipt number (e.g. "#POS-1234"), otherwise generate one
    if (!mappedPayload.order_number) {
      mappedPayload.order_number = generateReference("ORD");
    }
    mappedPayload.subtotal = mappedPayload.total || 0;
    mappedPayload.tax = 0;
    delete mappedPayload.customer_email;
    if (mappedPayload.is_pos === undefined) mappedPayload.is_pos = false;
    if (mappedPayload.items_count === undefined) {
      mappedPayload.items_count = Array.isArray(mappedPayload.items) ? mappedPayload.items.length : 0;
    }
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

  if (resource === "bookings") {
    const clientName = payload.clientName || payload.customerName || "";
    const clientPhone = payload.clientPhone || "";
    const serviceId = mappedPayload.service_id || payload.serviceId || "";
    const staffId = mappedPayload.staff_id || payload.staffId || null;
    const status = mappedPayload.status || "upcoming";

    // Resolve (or create) the customer so we can store a customer_id FK
    const customer = await findOrCreateCustomer(env, clientId, {
      name: clientName,
      phone: clientPhone || undefined,
      email: payload.clientEmail || "",
    });

    // Compute start_time/end_time — prefer explicit ISO, else derive from date+time
    let startTime = mappedPayload.start_time || payload.startTime || "";
    if (!startTime && payload.date && payload.time) {
      startTime = new Date(`${payload.date}T${payload.time}:00`).toISOString();
    }
    let durationMinutes = parseInt(payload.durationMinutes, 10) || 30;
    if (mappedPayload.service_id) {
      const svc = await supabaseFetch(
        env,
        `services?client_id=eq.${encodeURIComponent(clientId)}&id=eq.${encodeURIComponent(mappedPayload.service_id)}&select=duration_minutes`,
        { requestId: generateRequestId() }
      );
      if (svc && svc[0] && svc[0].duration_minutes) {
        durationMinutes = svc[0].duration_minutes;
      }
    }
    const start = new Date(startTime);
    const endTime = mappedPayload.end_time || new Date(start.getTime() + durationMinutes * 60000).toISOString();

    mappedPayload.customer_id = customer.id;
    mappedPayload.service_id = mappedPayload.service_id || null;
    mappedPayload.staff_id = staffId || null;
    mappedPayload.start_time = start.toISOString();
    mappedPayload.end_time = endTime;
    mappedPayload.status = status;
    mappedPayload.notes = payload.notes || null;
    mappedPayload.amount = Number(payload.amount ?? mappedPayload.amount ?? 0);
  }

  // ── Sanitize: remove any fields not in the known columns ─────
  const sanitized = sanitizePayload(mappedPayload, resource);

  const result = await supabaseFetch(env, resource, {
    method: "POST",
    body: JSON.stringify(sanitized),
  });

  // Supabase POST with return=representation returns [record] — extract single object
  const record = Array.isArray(result) ? result[0] : result;
  const mapped = mapResourceFields(record || {}, resource, "toCamel");
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

  // For products, fetch image_url so we can clean up R2
  const selectFields = resource === "products" ? "id,image_url" : "id";
  const existing = await supabaseFetch(
    env,
    `${resource}?id=eq.${encodeURIComponent(id)}&client_id=eq.${encodeURIComponent(clientId)}&select=${selectFields}`
  );
  if (!existing || !existing.length) {
    return jsonResponse({ success: false, error: "Resource not found." }, 404);
  }

  await supabaseFetch(env, `${resource}?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE",
    prefer: "return=minimal",
  });

  // Clean up associated R2 image for products
  if (resource === "products" && existing[0].image_url && env.R2_PUBLIC_URL) {
    const baseUrl = env.R2_PUBLIC_URL.replace(/\/$/, "");
    if (existing[0].image_url.startsWith(baseUrl)) {
      const key = existing[0].image_url.slice(baseUrl.length + 1);
      await env.R2_BUCKET.delete(key).catch(() => {});
    }
  }

  return jsonResponse({ success: true });
}

// ==================================================
// METRICS
// ==================================================

async function handleDashboardMetrics(request, env) {
  const auth = await authenticateDashboardRequest(request, env);
  if (auth.error) return auth.error;
  const planBlocked = assertPlan(auth, FEATURE_MIN_PLAN.metrics);
  if (planBlocked) return planBlocked;
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
// TEAM MEMBER INVITES
// ==================================================

function generateTempPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let secret = "";
  for (const byte of bytes) secret += alphabet[byte % alphabet.length];
  return `MGOS-${secret}`;
}

/**
 * POST /api/dashboard/team_members/invite
 * Owner/admin only. Creates a Supabase Auth account (confirmed email, temp
 * password) and links it to a team_members row for the current client.
 */
async function handleTeamInvite(request, env) {
  const auth = await authenticateDashboardRequest(request, env);
  if (auth.error) return auth.error;
  const { clientId, role } = auth;

  if (!isAdmin(role)) {
    return jsonResponse({ success: false, error: "Only the business owner or an admin can invite team members." }, 403);
  }

  const planBlocked = assertPlan(auth, FEATURE_MIN_PLAN.team_invite);
  if (planBlocked) return planBlocked;

  const payload = await parseJsonBody(request);
  if (!payload) return jsonResponse({ success: false, error: "Invalid or missing JSON body." }, 400);

  const email = String(payload.email || "").trim().toLowerCase();
  const name = String(payload.name || "").trim();
  const memberRole = String(payload.role || "staff").trim();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse({ success: false, error: "A valid email address is required." }, 400);
  }
  if (!name) {
    return jsonResponse({ success: false, error: "A name is required." }, 400);
  }
  if (!["admin", "staff"].includes(memberRole)) {
    return jsonResponse({ success: false, error: "Role must be 'admin' or 'staff'." }, 400);
  }

  // Create (or fetch) the Supabase Auth user
  const tempPassword = generateTempPassword();
  let userId;
  try {
    const { user } = await supabaseAdminCreateUser(env, { email, password: tempPassword, fullName: name });
    userId = user.id;
  } catch (err) {
    return jsonResponse({ success: false, error: err.message || "Failed to create account." }, 400);
  }

  // Check they aren't already a team member of this client
  const existing = await supabaseFetch(
    env,
    `team_members?client_id=eq.${encodeURIComponent(clientId)}&auth_user_id=eq.${encodeURIComponent(userId)}&select=id`
  );
  if (existing && existing.length) {
    return jsonResponse({ success: false, error: "This person is already a member of your team." }, 409);
  }

  const [member] = await supabaseFetch(env, "team_members", {
    method: "POST",
    body: JSON.stringify({
      client_id: clientId,
      auth_user_id: userId,
      name,
      email,
      role: memberRole,
      active: true,
    }),
    requestId: generateRequestId(),
  });

  if (!member) {
    return jsonResponse({ success: false, error: "Could not save the team member." }, 400);
  }

  const mapped = mapResourceFields(member, "team_members", "toCamel");
  return jsonResponse({
    success: true,
    data: { member: mapped, tempPassword },
  });
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

  // /api/dashboard/team_members/invite
  if (request.method === "POST" && url.pathname === "/api/dashboard/team_members/invite") {
    return await handleTeamInvite(request, env);
  }

  // /api/dashboard/:resource/:id/status
  const statusMatch = url.pathname.match(/^\/api\/dashboard\/([a-z_-]+)\/([0-9a-fA-F-]+)\/status$/);
  if (statusMatch && request.method === "PUT") {
    const [, resource, id] = statusMatch;
    const auth = await authenticateDashboardRequest(request, env);
    if (auth.error) return auth.error;
    if (auth.role === "staff" && !STAFF_ALLOWED_RESOURCES.has(resource)) {
      return jsonResponse({ success: false, error: "Insufficient permissions." }, 403);
    }
    const planBlocked = assertPlan(auth, RESOURCE_MIN_PLAN[resource] || "starter");
    if (planBlocked) return planBlocked;
    return await handleDashboardUpdate(request, env, resource, id);
  }

  // /api/dashboard/:resource/:id
  const idMatch = url.pathname.match(/^\/api\/dashboard\/([a-z_-]+)\/([0-9a-fA-F-]+)$/);
  if (idMatch) {
    const [, resource, id] = idMatch;
    const auth = await authenticateDashboardRequest(request, env);
    if (auth.error) return auth.error;
    if (auth.role === "staff" && !STAFF_ALLOWED_RESOURCES.has(resource)) {
      return jsonResponse({ success: false, error: "Insufficient permissions." }, 403);
    }
    const planBlocked = assertPlan(auth, RESOURCE_MIN_PLAN[resource] || "starter");
    if (planBlocked) return planBlocked;
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

    const auth = await authenticateDashboardRequest(request, env);
    if (auth.error) return auth.error;
    if (auth.role === "staff" && !STAFF_ALLOWED_RESOURCES.has(resource)) {
      return jsonResponse({ success: false, error: "Insufficient permissions." }, 403);
    }
    const planBlocked = assertPlan(auth, RESOURCE_MIN_PLAN[resource] || "starter");
    if (planBlocked) return planBlocked;

    if (request.method === "GET") return await handleDashboardList(request, env, resource);
    if (request.method === "POST") return await handleDashboardCreate(request, env, resource);
    return jsonResponse({ success: false, error: "Method not allowed." }, 405);
  }

  return jsonResponse({ success: false, error: "Not found." }, 404);
}

