/**
 * AI Tool Registry — Read-Only + Write Business Data Tools
 * ==========================================================
 *
 * READ-ONLY tools execute immediately and return data.
 * WRITE tools create a pending action that requires user confirmation
 * before execution via the /api/ai/confirm endpoint.
 *
 * Every tool receives the server-resolved clientId (never from the AI model).
 * Data is fetched via supabaseFetch using the same patterns as dashboard.js.
 */

import { supabaseFetch } from "./supabase.js";
import { mapResourceFields, generateReference } from "./utils.js";
import { loadClient } from "../services/clientService.js";

// ─── Pending Actions Store (Cloudflare KV, persistent across instances) ────────

const ACTION_TTL_MS = 5 * 60 * 1000; // 5 minutes
const ACTION_KV_PREFIX = "ai_action:";

function generateActionId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return "act-" + Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ─── Write Tool Names ──────────────────────────────────────────────

export const WRITE_TOOL_NAMES = new Set([
  "create_booking",
  "create_customer",
  "create_product",
  "create_service",
  "create_invoice",
  "update_booking_status",
  "update_order_status",
  "cancel_booking",
  "mark_invoice_paid",
]);

export function isWriteTool(toolName) {
  return WRITE_TOOL_NAMES.has(toolName);
}

// ─── Tool Definitions ──────────────────────────────────────────────
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
  // ─── WRITE TOOLS (require user confirmation before execution) ───
  {
    type: "function",
    function: {
      name: "create_booking",
      description: "Create a new booking/appointment. Requires customer name, service name, date, and time. The user must confirm before the booking is created.",
      parameters: {
        type: "object",
        properties: {
          customerName: {
            type: "string",
            description: "Full name of the customer",
          },
          serviceName: {
            type: "string",
            description: "Name of the service to book",
          },
          date: {
            type: "string",
            description: "Booking date in YYYY-MM-DD format",
          },
          time: {
            type: "string",
            description: "Booking time in HH:MM format (24-hour)",
          },
          staffName: {
            type: "string",
            description: "Name of the staff member (optional)",
          },
          amount: {
            type: "number",
            description: "Booking amount in cents (optional, defaults to service price)",
          },
          notes: {
            type: "string",
            description: "Additional notes for the booking (optional)",
          },
        },
        required: ["customerName", "serviceName", "date", "time"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_customer",
      description: "Create a new customer record. Requires customer name. The user must confirm before the customer is created.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Full name of the customer",
          },
          email: {
            type: "string",
            description: "Email address (optional)",
          },
          phone: {
            type: "string",
            description: "Phone number (optional)",
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_product",
      description: "Create a new product in the catalog. Requires product name and price. The user must confirm before the product is created.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Product name",
          },
          price: {
            type: "number",
            description: "Product price in cents",
          },
          sku: {
            type: "string",
            description: "SKU code (optional, auto-generated if not provided)",
          },
          category: {
            type: "string",
            description: "Product category (optional)",
          },
          stock: {
            type: "number",
            description: "Initial stock quantity (optional, defaults to 0)",
          },
        },
        required: ["name", "price"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_service",
      description: "Create a new service offering. Requires service name, price, and duration. The user must confirm before the service is created.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Service name",
          },
          price: {
            type: "number",
            description: "Service price in cents",
          },
          durationMinutes: {
            type: "number",
            description: "Service duration in minutes",
          },
          category: {
            type: "string",
            description: "Service category (optional)",
          },
        },
        required: ["name", "price", "durationMinutes"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_invoice",
      description: "Create a new invoice. Requires client name and amount. The user must confirm before the invoice is created.",
      parameters: {
        type: "object",
        properties: {
          clientName: {
            type: "string",
            description: "Client/customer name",
          },
          clientEmail: {
            type: "string",
            description: "Client email address (optional)",
          },
          amount: {
            type: "number",
            description: "Invoice total amount in cents",
          },
          dueDate: {
            type: "string",
            description: "Due date in YYYY-MM-DD format (optional)",
          },
        },
        required: ["clientName", "amount"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_booking_status",
      description: "Update the status of an existing booking. Requires the booking ID and new status. The user must confirm before the status is changed.",
      parameters: {
        type: "object",
        properties: {
          bookingId: {
            type: "string",
            description: "The ID of the booking to update",
          },
          status: {
            type: "string",
            description: "New booking status",
            enum: ["upcoming", "confirmed", "completed", "cancelled", "in-progress"],
          },
        },
        required: ["bookingId", "status"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_order_status",
      description: "Update the status of an existing order. Requires the order ID and new status. The user must confirm before the status is changed.",
      parameters: {
        type: "object",
        properties: {
          orderId: {
            type: "string",
            description: "The ID of the order to update",
          },
          status: {
            type: "string",
            description: "New order status",
            enum: ["pending", "processing", "completed", "cancelled", "refunded"],
          },
        },
        required: ["orderId", "status"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_booking",
      description: "Cancel an existing booking. This is a destructive action that cannot be automatically undone. Requires the booking ID. The user must explicitly confirm the cancellation.",
      parameters: {
        type: "object",
        properties: {
          bookingId: {
            type: "string",
            description: "The ID of the booking to cancel",
          },
        },
        required: ["bookingId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mark_invoice_paid",
      description: "Mark an invoice as paid. Requires the invoice ID. The user must confirm before the invoice status is changed.",
      parameters: {
        type: "object",
        properties: {
          invoiceId: {
            type: "string",
            description: "The ID of the invoice to mark as paid",
          },
        },
        required: ["invoiceId"],
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
  // Write tools create a pending action instead of executing directly
  if (isWriteTool(toolName)) {
    const action = await createPendingAction(toolName, args, clientId, env);
    if (!action) {
      return { error: `Failed to create pending action for ${toolName}.` };
    }
    if (action.error) {
      return action; // Return validation error
    }
    return {
      status: "pending_confirmation",
      action_id: action.id,
      action_type: action.type,
      label: action.label,
      destructive: action.destructive,
      details: action.fields,
      message: `This ${action.label.toLowerCase()} requires user confirmation. Present the details and ask for explicit confirmation before proceeding.`,
    };
  }

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

// ─── Write Tool: Create Pending Action ─────────────────────────────

/**
 * When the AI calls a write tool, this function creates a pending action
 * instead of executing it. The pending action is returned to the frontend
 * for user confirmation.
 *
 * @param {string} toolName - The write tool name
 * @param {object} args - Arguments from the AI model
 * @param {string} clientId - Server-resolved client ID
 * @param {object} env - Worker env bindings (for KV access)
 * @returns {Promise<object|null>} Pending action object, or null if validation fails
 */
export async function createPendingAction(toolName, args, clientId, env) {
  // Define required fields per tool type
  const requiredFields = {
    create_booking: ["customerName", "serviceName", "date", "time"],
    create_customer: ["name"],
    create_product: ["name", "price"],
    create_service: ["name", "price", "durationMinutes"],
    create_invoice: ["clientName", "amount"],
    update_booking_status: ["bookingId", "status"],
    update_order_status: ["orderId", "status"],
    cancel_booking: ["bookingId"],
    mark_invoice_paid: ["invoiceId"],
  };

  // Validate required fields
  const required = requiredFields[toolName] || [];
  const missingFields = required.filter(field => !args[field]);
  if (missingFields.length > 0) {
    return {
      error: `Missing required fields: ${missingFields.join(", ")}`,
      missing_fields: missingFields,
    };
  }

  const actionId = generateActionId();
  const now = Date.now();

  // Define action metadata per tool type
  const actionConfig = {
    create_booking: {
      label: "Create booking",
      destructive: false,
      displayFields: {
        customer: args.customerName,
        service: args.serviceName,
        date: args.date,
        time: args.time,
        ...(args.staffName ? { staff: args.staffName } : {}),
        ...(args.amount ? { amount: `R${(args.amount / 100).toFixed(2)}` } : {}),
      },
      rawFields: {
        customerName: args.customerName,
        serviceName: args.serviceName,
        date: args.date,
        time: args.time,
        staffName: args.staffName || null,
        amount: args.amount || 0,
        notes: args.notes || null,
      },
    },
    create_customer: {
      label: "Create customer",
      destructive: false,
      displayFields: {
        name: args.name,
        ...(args.email ? { email: args.email } : {}),
        ...(args.phone ? { phone: args.phone } : {}),
      },
      rawFields: {
        name: args.name,
        email: args.email || "",
        phone: args.phone || "",
      },
    },
    create_product: {
      label: "Create product",
      destructive: false,
      displayFields: {
        name: args.name,
        price: `R${(args.price / 100).toFixed(2)}`,
        ...(args.sku ? { sku: args.sku } : {}),
        ...(args.category ? { category: args.category } : {}),
        ...(args.stock !== undefined ? { stock: args.stock } : {}),
      },
      rawFields: {
        name: args.name,
        price: args.price,
        sku: args.sku || generateReference("SKU"),
        category: args.category || "",
        stock: args.stock || 0,
      },
    },
    create_service: {
      label: "Create service",
      destructive: false,
      displayFields: {
        name: args.name,
        price: `R${(args.price / 100).toFixed(2)}`,
        duration: `${args.durationMinutes} min`,
        ...(args.category ? { category: args.category } : {}),
      },
      rawFields: {
        name: args.name,
        price: args.price,
        durationMinutes: args.durationMinutes,
        category: args.category || "",
      },
    },
    create_invoice: {
      label: "Create invoice",
      destructive: false,
      displayFields: {
        client: args.clientName,
        amount: `R${(args.amount / 100).toFixed(2)}`,
        ...(args.clientEmail ? { email: args.clientEmail } : {}),
        ...(args.dueDate ? { due: args.dueDate } : {}),
      },
      rawFields: {
        clientName: args.clientName,
        clientEmail: args.clientEmail || "",
        amount: args.amount,
        dueDate: args.dueDate || null,
      },
    },
    update_booking_status: {
      label: "Update booking status",
      destructive: false,
      displayFields: {
        bookingId: args.bookingId,
        status: args.status,
      },
      rawFields: {
        bookingId: args.bookingId,
        status: args.status,
      },
    },
    update_order_status: {
      label: "Update order status",
      destructive: false,
      displayFields: {
        orderId: args.orderId,
        status: args.status,
      },
      rawFields: {
        orderId: args.orderId,
        status: args.status,
      },
    },
    cancel_booking: {
      label: "Cancel booking",
      destructive: true,
      displayFields: {
        bookingId: args.bookingId,
      },
      rawFields: {
        bookingId: args.bookingId,
      },
    },
    mark_invoice_paid: {
      label: "Mark invoice as paid",
      destructive: false,
      displayFields: {
        invoiceId: args.invoiceId,
      },
      rawFields: {
        invoiceId: args.invoiceId,
      },
    },
  };

  const config = actionConfig[toolName];
  if (!config) {
    return null;
  }

  const action = {
    id: actionId,
    type: toolName,
    label: config.label,
    destructive: config.destructive,
    fields: config.displayFields,
    rawFields: config.rawFields,
    clientId,
    createdAt: now,
    executed: false,
  };

  // Store in KV with 5-minute TTL
  if (env.RATE_LIMIT_KV) {
    await env.RATE_LIMIT_KV.put(ACTION_KV_PREFIX + actionId, JSON.stringify(action), { expirationTtl: 300 });
  }

  return action;
}

/**
 * Get a pending action by ID. Validates ownership and expiration.
 *
 * @param {string} actionId - The action ID
 * @param {string} clientId - Server-resolved client ID (must match)
 * @param {object} env - Worker env bindings (for KV access)
 * @returns {Promise<object|null>} The pending action, or null if invalid
 */
export async function getPendingAction(actionId, clientId, env) {
  if (!env.RATE_LIMIT_KV) return null;

  const raw = await env.RATE_LIMIT_KV.get(ACTION_KV_PREFIX + actionId);
  if (!raw) return null;

  let action;
  try {
    action = JSON.parse(raw);
  } catch {
    return null;
  }

  if (action.clientId !== clientId) return null;
  if (action.executed) return null;
  if (Date.now() - action.createdAt > ACTION_TTL_MS) {
    await env.RATE_LIMIT_KV.delete(ACTION_KV_PREFIX + actionId);
    return null;
  }
  return action;
}

/**
 * Mark a pending action as executed (delete from KV to prevent reuse).
 */
export async function markActionExecuted(actionId, env) {
  if (env.RATE_LIMIT_KV) {
    await env.RATE_LIMIT_KV.delete(ACTION_KV_PREFIX + actionId);
  }
}

// ─── Write Tool: Execute Actions ───────────────────────────────────

/**
 * Execute a confirmed write action. This is called from the /api/ai/confirm
 * endpoint after the user has explicitly confirmed.
 *
 * @param {object} action - The pending action object
 * @param {object} env - Worker env bindings
 * @param {string} clientId - Server-resolved client ID
 * @returns {Promise<object>} Result of the operation
 */
export async function executeWriteAction(action, env, clientId) {
  switch (action.type) {
    case "create_booking":
      return await executeCreateBooking(action.rawFields, env, clientId);
    case "create_customer":
      return await executeCreateCustomer(action.rawFields, env, clientId);
    case "create_product":
      return await executeCreateProduct(action.rawFields, env, clientId);
    case "create_service":
      return await executeCreateService(action.rawFields, env, clientId);
    case "create_invoice":
      return await executeCreateInvoice(action.rawFields, env, clientId);
    case "update_booking_status":
      return await executeUpdateBookingStatus(action.rawFields, env, clientId);
    case "update_order_status":
      return await executeUpdateOrderStatus(action.rawFields, env, clientId);
    case "cancel_booking":
      return await executeCancelBooking(action.rawFields, env, clientId);
    case "mark_invoice_paid":
      return await executeMarkInvoicePaid(action.rawFields, env, clientId);
    default:
      return { error: `Unknown action type: ${action.type}` };
  }
}

async function executeCreateBooking(fields, env, clientId) {
  // Find or create customer
  const customers = await supabaseFetch(
    env,
    `customers?client_id=eq.${encodeURIComponent(clientId)}&name=eq.${encodeURIComponent(fields.customerName)}&select=id&limit=1`
  );
  let customerId;
  if (customers && customers.length) {
    customerId = customers[0].id;
  } else {
    const [newCustomer] = await supabaseFetch(env, "customers", {
      method: "POST",
      body: JSON.stringify({
        client_id: clientId,
        name: fields.customerName,
        email: "",
        phone: "",
      }),
    });
    customerId = newCustomer?.id;
  }

  // Find service by name
  const services = await supabaseFetch(
    env,
    `services?client_id=eq.${encodeURIComponent(clientId)}&name=ilike.${encodeURIComponent(fields.serviceName)}&select=id,price,duration_minutes&limit=1`
  );
  const service = services && services[0];
  const serviceId = service?.id || null;
  const durationMinutes = service?.duration_minutes || 30;

  // Compute start/end times
  const startTime = new Date(`${fields.date}T${fields.time}:00`).toISOString();
  const endTime = new Date(new Date(startTime).getTime() + durationMinutes * 60000).toISOString();

  const [booking] = await supabaseFetch(env, "bookings", {
    method: "POST",
    body: JSON.stringify({
      client_id: clientId,
      customer_id: customerId,
      service_id: serviceId,
      start_time: startTime,
      end_time: endTime,
      status: "upcoming",
      amount: fields.amount || service?.price || 0,
      notes: fields.notes || null,
    }),
  });

  if (!booking) return { error: "Failed to create booking." };
  return { success: true, booking };
}

async function executeCreateCustomer(fields, env, clientId) {
  const [customer] = await supabaseFetch(env, "customers", {
    method: "POST",
    body: JSON.stringify({
      client_id: clientId,
      name: fields.name,
      email: fields.email || "",
      phone: fields.phone || "",
    }),
  });

  if (!customer) return { error: "Failed to create customer." };
  return { success: true, customer };
}

async function executeCreateProduct(fields, env, clientId) {
  const payload = {
    client_id: clientId,
    name: fields.name,
    sku: fields.sku || generateReference("SKU"),
    price: fields.price,
    cost_price: 0,
    stock_qty: fields.stock || 0,
    low_stock_warning: 5,
    is_hidden: false,
  };

  if (fields.category) {
    const existing = await supabaseFetch(
      env,
      `categories?client_id=eq.${encodeURIComponent(clientId)}&name=eq.${encodeURIComponent(fields.category)}&select=id&limit=1`
    );
    if (existing && existing.length) {
      payload.category_id = existing[0].id;
    } else {
      const [newCat] = await supabaseFetch(env, "categories", {
        method: "POST",
        body: JSON.stringify({ client_id: clientId, name: fields.category }),
      });
      payload.category_id = newCat?.id || null;
    }
  }

  const [product] = await supabaseFetch(env, "products", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (!product) return { error: "Failed to create product." };
  return { success: true, product };
}

async function executeCreateService(fields, env, clientId) {
  const [service] = await supabaseFetch(env, "services", {
    method: "POST",
    body: JSON.stringify({
      client_id: clientId,
      name: fields.name,
      price: fields.price,
      duration_minutes: fields.durationMinutes,
      category: fields.category || "",
      active: true,
    }),
  });

  if (!service) return { error: "Failed to create service." };
  return { success: true, service };
}

async function executeCreateInvoice(fields, env, clientId) {
  // Find or create customer
  const customers = await supabaseFetch(
    env,
    `customers?client_id=eq.${encodeURIComponent(clientId)}&name=eq.${encodeURIComponent(fields.clientName)}&select=id&limit=1`
  );
  let customerId;
  if (customers && customers.length) {
    customerId = customers[0].id;
  } else {
    const [newCustomer] = await supabaseFetch(env, "customers", {
      method: "POST",
      body: JSON.stringify({
        client_id: clientId,
        name: fields.clientName,
        email: fields.clientEmail || "",
        phone: "",
      }),
    });
    customerId = newCustomer?.id;
  }

  const [invoice] = await supabaseFetch(env, "invoices", {
    method: "POST",
    body: JSON.stringify({
      client_id: clientId,
      customer_id: customerId,
      invoice_number: generateReference("INV"),
      total: fields.amount,
      subtotal: fields.amount,
      tax: 0,
      status: "draft",
      due_at: fields.dueDate || null,
    }),
  });

  if (!invoice) return { error: "Failed to create invoice." };
  return { success: true, invoice };
}

async function executeUpdateBookingStatus(fields, env, clientId) {
  const existing = await supabaseFetch(
    env,
    `bookings?id=eq.${encodeURIComponent(fields.bookingId)}&client_id=eq.${encodeURIComponent(clientId)}&select=id&limit=1`
  );
  if (!existing || !existing.length) {
    return { error: "Booking not found or does not belong to your business." };
  }

  await supabaseFetch(
    env,
    `bookings?id=eq.${encodeURIComponent(fields.bookingId)}`,
    { method: "PATCH", prefer: "return=minimal", body: JSON.stringify({ status: fields.status }) }
  );

  return { success: true, bookingId: fields.bookingId, newStatus: fields.status };
}

async function executeUpdateOrderStatus(fields, env, clientId) {
  const existing = await supabaseFetch(
    env,
    `orders?id=eq.${encodeURIComponent(fields.orderId)}&client_id=eq.${encodeURIComponent(clientId)}&select=id&limit=1`
  );
  if (!existing || !existing.length) {
    return { error: "Order not found or does not belong to your business." };
  }

  await supabaseFetch(
    env,
    `orders?id=eq.${encodeURIComponent(fields.orderId)}`,
    { method: "PATCH", prefer: "return=minimal", body: JSON.stringify({ status: fields.status }) }
  );

  return { success: true, orderId: fields.orderId, newStatus: fields.status };
}

async function executeCancelBooking(fields, env, clientId) {
  const existing = await supabaseFetch(
    env,
    `bookings?id=eq.${encodeURIComponent(fields.bookingId)}&client_id=eq.${encodeURIComponent(clientId)}&select=id&limit=1`
  );
  if (!existing || !existing.length) {
    return { error: "Booking not found or does not belong to your business." };
  }

  await supabaseFetch(
    env,
    `bookings?id=eq.${encodeURIComponent(fields.bookingId)}`,
    { method: "PATCH", prefer: "return=minimal", body: JSON.stringify({ status: "cancelled" }) }
  );

  return { success: true, bookingId: fields.bookingId };
}

async function executeMarkInvoicePaid(fields, env, clientId) {
  const existing = await supabaseFetch(
    env,
    `invoices?id=eq.${encodeURIComponent(fields.invoiceId)}&client_id=eq.${encodeURIComponent(clientId)}&select=id&limit=1`
  );
  if (!existing || !existing.length) {
    return { error: "Invoice not found or does not belong to your business." };
  }

  await supabaseFetch(
    env,
    `invoices?id=eq.${encodeURIComponent(fields.invoiceId)}`,
    { method: "PATCH", prefer: "return=minimal", body: JSON.stringify({ status: "paid" }) }
  );

  return { success: true, invoiceId: fields.invoiceId };
}
