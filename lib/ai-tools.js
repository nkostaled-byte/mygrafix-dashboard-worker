/**
 * AI Tool Registry — Read-Only Business Data Tools
 * =================================================
 *
 * Each tool maps an AI function call to an existing Worker data-fetching path.
 * Tools are READ-ONLY — no create/update/delete operations.
 *
 * Every tool receives the server-resolved clientId (never from the AI model).
 * Data is fetched via supabaseFetch using the same patterns as dashboard.js.
 */

import { supabaseFetch } from "./supabase.js";
import { mapResourceFields } from "./utils.js";
import { loadClient } from "../services/clientService.js";

/**
 * Tool definitions sent to OpenRouter as function calling schemas.
 * These describe what the AI model can do — the actual execution is in executeTool().
 */
export const AI_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_business_info",
      description: "Get the current business profile information including name, contact details, address, and settings.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_bookings",
      description: "Get bookings for the business. Optionally filter by status (upcoming, confirmed, completed, cancelled, in-progress) or date range.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description: "Filter by booking status: upcoming, confirmed, completed, cancelled, in-progress",
            enum: ["upcoming", "confirmed", "completed", "cancelled", "in-progress"],
          },
          limit: {
            type: "number",
            description: "Maximum number of bookings to return (default 20)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_customers",
      description: "Get the customer list with names, emails, phones, tiers, and spending totals.",
      parameters: {
        type: "object",
        properties: {
          search: {
            type: "string",
            description: "Search customers by name or email",
          },
          limit: {
            type: "number",
            description: "Maximum number of customers to return (default 20)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_products",
      description: "Get the product catalog with names, SKUs, prices, stock levels, and categories.",
      parameters: {
        type: "object",
        properties: {
          search: {
            type: "string",
            description: "Search products by name or SKU",
          },
          low_stock: {
            type: "boolean",
            description: "If true, only return products with low or zero stock",
          },
          limit: {
            type: "number",
            description: "Maximum number of products to return (default 20)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_services",
      description: "Get the list of services offered, including names, categories, durations, and prices.",
      parameters: {
        type: "object",
        properties: {
          search: {
            type: "string",
            description: "Search services by name or category",
          },
          active_only: {
            type: "boolean",
            description: "If true, only return active services",
          },
          limit: {
            type: "number",
            description: "Maximum number of services to return (default 20)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_orders",
      description: "Get orders with customer names, amounts, statuses, and payment methods.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description: "Filter by order status: pending, processing, completed, cancelled, refunded",
            enum: ["pending", "processing", "completed", "cancelled", "refunded"],
          },
          limit: {
            type: "number",
            description: "Maximum number of orders to return (default 20)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_invoices",
      description: "Get invoices with client names, amounts, statuses, and due dates.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description: "Filter by invoice status: draft, sent, paid, overdue, cancelled",
            enum: ["draft", "sent", "paid", "overdue", "cancelled"],
          },
          limit: {
            type: "number",
            description: "Maximum number of invoices to return (default 20)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_metrics",
      description: "Get business metrics including total revenue, order counts, booking counts, daily sales, and business health scores.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
];

/**
 * Execute a tool call from the AI model.
 * All tools are READ-ONLY and use the server-resolved clientId.
 *
 * @param {string} toolName - The function name from the AI model
 * @param {object} args - Arguments from the AI model
 * @param {object} env - Worker env bindings
 * @param {string} clientId - Server-resolved client ID (NEVER from AI)
 * @returns {Promise<object>} Tool result
 */
export async function executeTool(toolName, args, env, clientId) {
  switch (toolName) {
    case "get_business_info":
      return await getBusinessInfo(env, clientId);

    case "get_bookings":
      return await getBookings(env, clientId, args);

    case "get_customers":
      return await getCustomers(env, clientId, args);

    case "get_products":
      return await getProducts(env, clientId, args);

    case "get_services":
      return await getServices(env, clientId, args);

    case "get_orders":
      return await getOrders(env, clientId, args);

    case "get_invoices":
      return await getInvoices(env, clientId, args);

    case "get_metrics":
      return await getMetrics(env, clientId);

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ─── Tool Implementations ──────────────────────────────────────────

async function getBusinessInfo(env, clientId) {
  const rows = await supabaseFetch(
    env,
    `clients?client_id=eq.${encodeURIComponent(clientId)}&select=*`
  );
  const client = rows && rows[0];
  if (!client) return { error: "Business not found." };

  return {
    businessName: client.business_name || "",
    phone: client.phone || "",
    address: client.address || "",
    openingHours: client.opening_hours || "",
    ownerEmail: client.owner_email || "",
    websiteUrl: client.website_url || "",
    businessType: client.business_type || "",
  };
}

async function getBookings(env, clientId, args = {}) {
  let path = `bookings?client_id=eq.${encodeURIComponent(clientId)}&select=*&order=start_time.desc`;

  if (args.status) {
    path += `&status=eq.${encodeURIComponent(args.status)}`;
  }

  const limit = Math.min(args.limit || 20, 50);
  path += `&limit=${limit}`;

  const rows = await supabaseFetch(env, path);
  const mapped = mapResourceFields(rows || [], "bookings", "toCamel");

  // Add derived date/time from start_time like dashboard.js does
  for (const booking of mapped) {
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
  }

  return { bookings: mapped, count: mapped.length };
}

async function getCustomers(env, clientId, args = {}) {
  let path = `customers?client_id=eq.${encodeURIComponent(clientId)}&select=*&order=created_at.desc`;

  if (args.search) {
    path += `&or=(name.ilike.%25${encodeURIComponent(args.search)}%25,email.ilike.%25${encodeURIComponent(args.search)}%25)`;
  }

  const limit = Math.min(args.limit || 20, 50);
  path += `&limit=${limit}`;

  const rows = await supabaseFetch(env, path);
  const mapped = mapResourceFields(rows || [], "customers", "toCamel");

  return { customers: mapped, count: mapped.length };
}

async function getProducts(env, clientId, args = {}) {
  let path = `products?client_id=eq.${encodeURIComponent(clientId)}&select=*&order=created_at.desc`;

  if (args.search) {
    path += `&or=(name.ilike.%25${encodeURIComponent(args.search)}%25,sku.ilike.%25${encodeURIComponent(args.search)}%25)`;
  }

  if (args.low_stock) {
    path += `&stock_qty=lte.10`;
  }

  const limit = Math.min(args.limit || 20, 50);
  path += `&limit=${limit}`;

  const rows = await supabaseFetch(env, path);
  const mapped = mapResourceFields(rows || [], "products", "toCamel");

  return { products: mapped, count: mapped.length };
}

async function getServices(env, clientId, args = {}) {
  let path = `services?client_id=eq.${encodeURIComponent(clientId)}&select=*&order=created_at.desc`;

  if (args.search) {
    path += `&or=(name.ilike.%25${encodeURIComponent(args.search)}%25,category.ilike.%25${encodeURIComponent(args.search)}%25)`;
  }

  if (args.active_only) {
    path += `&active=eq.true`;
  }

  const limit = Math.min(args.limit || 20, 50);
  path += `&limit=${limit}`;

  const rows = await supabaseFetch(env, path);
  const mapped = mapResourceFields(rows || [], "services", "toCamel");

  return { services: mapped, count: mapped.length };
}

async function getOrders(env, clientId, args = {}) {
  let path = `orders?client_id=eq.${encodeURIComponent(clientId)}&select=*&order=created_at.desc`;

  if (args.status) {
    path += `&status=eq.${encodeURIComponent(args.status)}`;
  }

  const limit = Math.min(args.limit || 20, 50);
  path += `&limit=${limit}`;

  const rows = await supabaseFetch(env, path);
  const mapped = mapResourceFields(rows || [], "orders", "toCamel");

  return { orders: mapped, count: mapped.length };
}

async function getInvoices(env, clientId, args = {}) {
  let path = `invoices?client_id=eq.${encodeURIComponent(clientId)}&select=*&order=created_at.desc`;

  if (args.status) {
    path += `&status=eq.${encodeURIComponent(args.status)}`;
  }

  const limit = Math.min(args.limit || 20, 50);
  path += `&limit=${limit}`;

  const rows = await supabaseFetch(env, path);
  const mapped = mapResourceFields(rows || [], "invoices", "toCamel");

  return { invoices: mapped, count: mapped.length };
}

async function getMetrics(env, clientId) {
  const [products, customers, bookings, orders, invoices, submissions, reviews, clientData] = await Promise.all([
    supabaseFetch(env, `products?client_id=eq.${encodeURIComponent(clientId)}&select=id`),
    supabaseFetch(env, `customers?client_id=eq.${encodeURIComponent(clientId)}&select=id`),
    supabaseFetch(env, `bookings?client_id=eq.${encodeURIComponent(clientId)}&select=id,status`),
    supabaseFetch(env, `orders?client_id=eq.${encodeURIComponent(clientId)}&select=id,total,created_at`),
    supabaseFetch(env, `invoices?client_id=eq.${encodeURIComponent(clientId)}&select=id,total,status`),
    supabaseFetch(env, `submissions?client_id=eq.${encodeURIComponent(clientId)}&select=submission_id,status`),
    supabaseFetch(env, `reviews?client_id=eq.${encodeURIComponent(clientId)}&select=id,rating`),
    supabaseFetch(env, `clients?client_id=eq.${encodeURIComponent(clientId)}&select=business_name`),
  ]);

  const totalRevenue = (orders || []).reduce((sum, o) => sum + Number(o.total || 0), 0);
  const pendingInvoices = (invoices || []).filter(i => i.status === "pending" || i.status === "sent" || i.status === "overdue");
  const activeBookings = (bookings || []).filter(b => b.status === "confirmed" || b.status === "upcoming");

  return {
    totalProducts: (products || []).length,
    totalCustomers: (customers || []).length,
    totalBookings: (bookings || []).length,
    activeBookings: activeBookings.length,
    totalOrders: (orders || []).length,
    totalRevenue,
    pendingInvoices: pendingInvoices.length,
    businessName: (clientData && clientData[0] && clientData[0].business_name) || "",
  };
}
