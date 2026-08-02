/**
 * Paystack Subscriptions Handler
 * ================================
 * - POST /api/paystack/checkout    (auth) Start a subscription checkout
 * - GET  /api/paystack/verify      (auth) Verify a transaction & activate plan
 * - GET  /api/paystack/status      (auth) Current plan / subscription state
 * - POST /api/paystack/cancel      (auth) Cancel the active subscription
 * - POST /api/paystack/webhook     (signed) Paystack event notifications
 * - GET  /api/pricing              Public plan list used by the marketing site
 *
 * Requires env vars:
 *   PAYSTACK_SECRET_KEY  — Paystack secret key (test or live)
 *   APP_URL              — (optional) base URL used to build the callback URL.
 *                          Falls back to the request origin when absent.
 *
 * Amounts are expressed in the smallest currency unit (cents for ZAR).
 */

import { jsonResponse } from "../lib/responses.js";
import { parseJsonBody, generateRequestId, generateReference } from "../lib/utils.js";
import { verifySupabaseJwt, resolveUserRole } from "../lib/auth.js";
import { supabaseFetch } from "../lib/supabase.js";

const PAYSTACK_BASE = "https://api.paystack.co";
const CURRENCY = "ZAR";
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const SUBSCRIPTION_INTERVAL = "monthly";
const YEARLY_INTERVAL = "annually";

// Plan catalog — amounts in cents (R99 → 9900). Keep in sync with src/data/pricingData.ts
const PLANS = [
  {
    id: "starter",
    name: "Starter",
    tagline: "Small businesses & solo creators",
    monthlyPrice: 99,
    yearlyPrice: 79,
    monthlyBillingText: "Billed monthly",
    yearlyBillingText: "R948 billed annually",
    features: [
      "Website Dashboard",
      "CRM (Customers)",
      "Products & Services",
      "POS & Orders",
      "Bookings & Appointments",
      "Contact Forms",
      "Basic Analytics",
    ],
    includedFromPrevious: "",
  },
  {
    id: "business",
    name: "Business",
    tagline: "Growing brands & salons",
    monthlyPrice: 249,
    yearlyPrice: 199,
    monthlyBillingText: "Billed monthly",
    yearlyBillingText: "R2,388 billed annually",
    badge: "Most Popular",
    isPopular: true,
    features: [
      "Team Members & Staff Access",
      "Invoices & PDFs",
      "Website Manager",
      "Online Bookings & E-Commerce",
      "Gallery & Reviews",
      "Reports & Exports",
      "Custom Branding",
    ],
    includedFromPrevious: "Everything in Starter +",
  },
  {
    id: "professional",
    name: "Professional",
    tagline: "Scaling service & product businesses",
    monthlyPrice: 549,
    yearlyPrice: 439,
    monthlyBillingText: "Billed monthly",
    yearlyBillingText: "R5,268 billed annually",
    badge: "Best Value",
    isBestValue: true,
    features: ["Inventory Tracking", "Advanced Analytics", "Priority Support"],
    includedFromPrevious: "Everything in Business +",
  },
  {
    id: "enterprise",
    name: "Enterprise",
    tagline: "Large brands & high-volume businesses",
    monthlyPrice: 1499,
    yearlyPrice: 1199,
    monthlyBillingText: "Billed monthly",
    yearlyBillingText: "R14,388 billed annually",
    features: ["API Access", "Unlimited Staff", "Dedicated Support"],
    includedFromPrevious: "Everything in Professional +",
  },
];

const PLANS_BY_ID = Object.fromEntries(PLANS.map((p) => [p.id, p]));

function amountInCents(planId, billing = "monthly") {
  const price = billing === "yearly" ? PLANS_BY_ID[planId].yearlyPrice : PLANS_BY_ID[planId].monthlyPrice;
  return Math.round(price * 100);
}

function billingInterval(billing) {
  return billing === "yearly" ? YEARLY_INTERVAL : SUBSCRIPTION_INTERVAL;
}

function billingMonths(billing) {
  return billing === "yearly" ? 12 : 1;
}

// ==================================================
// Paystack API helper
// ==================================================

async function paystackRequest(env, method, path, body) {
  const key = env.PAYSTACK_SECRET_KEY;
  if (!key) {
    throw new Error("Paystack is not configured on this workspace.");
  }

  const resp = await fetch(`${PAYSTACK_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.status === false) {
    throw new Error(data.message || `Paystack error (HTTP ${resp.status}).`);
  }
  return data.data;
}

// ==================================================
// Auth helper (owner/admin only for billing actions)
// ==================================================

async function authenticateBillingRequest(request, env) {
  const claims = await verifySupabaseJwt(request, env);
  if (!claims) return { error: jsonResponse({ success: false, error: "Unauthorized." }, 401) };

  const resolved = await resolveUserRole(env, claims.sub);
  if (!resolved) {
    return { error: jsonResponse({ success: false, error: "No client account linked to this login." }, 403) };
  }
  if (resolved.role !== "owner" && resolved.role !== "admin") {
    return { error: jsonResponse({ success: false, error: "Only the workspace owner or an admin can manage billing." }, 403) };
  }
  return { claims, clientId: resolved.clientId, role: resolved.role };
}

async function loadClient(env, clientId) {
  const rows = await supabaseFetch(env, `clients?client_id=eq.${encodeURIComponent(clientId)}&select=*`);
  return rows && rows.length ? rows[0] : null;
}

async function getOrCreateCustomer(env, client, requestId) {
  if (client.paystack_customer_code) return client.paystack_customer_code;

  const email = client.paystack_email || client.owner_email || client.reply_email || "";
  if (!email) throw new Error("Client has no email address on file.");

  const customer = await paystackRequest(env, "POST", "/customer", { email });
  const customerCode = customer.customer_code;

  await supabaseFetch(env, `clients?client_id=eq.${encodeURIComponent(client.client_id)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify({ paystack_customer_code: customerCode, paystack_email: email }),
    requestId,
  });

  return customerCode;
}

async function getOrCreatePlan(env, planId, billing, requestId) {
  const plan = PLANS_BY_ID[planId];
  if (!plan) throw new Error(`Unknown plan: ${planId}`);

  const interval = billingInterval(billing);

  // Allow a manual override via env, e.g. PAYSTACK_PLAN_STARTER_MONTHLY="PLN_xxx"
  const override = env[`PAYSTACK_PLAN_${plan.id.toUpperCase()}_${billing.toUpperCase()}`];
  if (override) {
    await upsertPlanMapping(env, override, planId, interval, requestId);
    return override;
  }

  const planName = `Business OS ${plan.name} (${CURRENCY} ${billing})`;

  // Try to reuse an existing plan with the same name
  const existing = await paystackRequest(env, "GET", `/plan?perPage=100`);
  const plans = Array.isArray(existing) ? existing : existing?.data || [];
  const match = plans.find(
    (p) => p.name === planName && Number(p.amount) === amountInCents(planId, billing) && p.interval === interval
  );
  if (match) {
    await upsertPlanMapping(env, match.plan_code, planId, interval, requestId);
    return match.plan_code;
  }

  const created = await paystackRequest(env, "POST", "/plan", {
    name: planName,
    amount: amountInCents(planId, billing),
    interval,
    currency: CURRENCY,
  });
  await upsertPlanMapping(env, created.plan_code, planId, interval, requestId);
  return created.plan_code;
}

/**
 * Record the Paystack plan_code → Business OS plan_id mapping (idempotent upsert).
 * This is the source of truth for matching webhook events to plans.
 */
async function upsertPlanMapping(env, planCode, planId, interval, requestId) {
  if (!planCode) return;
  try {
    await supabaseFetch(env, `paystack_plans?on_conflict=plan_code`, {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: JSON.stringify({ plan_code: planCode, plan_id: planId, interval }),
      requestId,
    });
  } catch (err) {
    console.error(`[${requestId}] upsertPlanMapping error:`, err.message);
  }
}

/**
 * Resolve a Business OS plan id from a Paystack plan_code (PLN_xxx).
 * Checks the local paystack_plans table first, then falls back to
 * fetching the plan from Paystack and parsing its name.
 */
async function resolvePlanIdByCode(env, planCode, requestId) {
  if (!planCode) return null;

  try {
    const rows = await supabaseFetch(
      env,
      `paystack_plans?plan_code=eq.${encodeURIComponent(planCode)}&select=plan_id`
    );
    if (rows && rows.length) return rows[0].plan_id;
  } catch (err) {
    console.error(`[${requestId}] resolvePlanIdByCode lookup error:`, err.message);
  }

  // Fallback: fetch the plan from Paystack and parse its name
  try {
    const plan = await paystackRequest(env, "GET", `/plan/${encodeURIComponent(planCode)}`);
    const planId = planIdFromName(plan?.name);
    if (planId) {
      await upsertPlanMapping(
        env,
        planCode,
        planId,
        plan?.interval === YEARLY_INTERVAL ? "yearly" : "monthly",
        requestId
      );
      return planId;
    }
  } catch (err) {
    console.error(`[${requestId}] resolvePlanIdByCode Paystack error:`, err.message);
  }
  return null;
}

async function updateClientPlan(env, clientId, plan, subscription, requestId, months = 1) {
  const startedAt = subscription?.started_at || new Date().toISOString();
  const expiresAt = new Date(Date.now() + MONTH_MS * months).toISOString();
  const patch = {
    plan,
    plan_started_at: startedAt,
    plan_expires_at: expiresAt,
    paystack_pending_reference: null,
    paystack_pending_plan: null,
  };
  if (subscription) {
    if (subscription.customer_code) patch.paystack_customer_code = subscription.customer_code;
    if (subscription.email) patch.paystack_email = subscription.email;
    if (subscription.subscription_code) patch.paystack_subscription_code = subscription.subscription_code;
    if (subscription.plan_code) patch.paystack_plan_code = subscription.plan_code;
  }
  await supabaseFetch(env, `clients?client_id=eq.${encodeURIComponent(clientId)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify(patch),
    requestId,
  });
}

async function recordSubscription(env, clientId, plan, payload, requestId, months = 1) {
  await supabaseFetch(env, "subscriptions", {
    method: "POST",
    prefer: "return=minimal",
    body: JSON.stringify({
      client_id: clientId,
      plan,
      status: "active",
      currency: payload.currency || CURRENCY,
      amount: payload.amount || amountInCents(plan),
      paystack_reference: payload.reference || null,
      paystack_customer_code: payload.customer_code || null,
      paystack_subscription_code: payload.subscription_code || null,
      started_at: payload.started_at || new Date().toISOString(),
      expires_at: new Date(Date.now() + MONTH_MS * months).toISOString(),
    }),
    requestId,
  });
}

// ==================================================
// POST /api/paystack/checkout
// ==================================================

export async function handlePaystackCheckout(request, env) {
  const requestId = generateRequestId();
  const auth = await authenticateBillingRequest(request, env);
  if (auth.error) return auth.error;
  const { clientId } = auth;

  const payload = await parseJsonBody(request);
  if (!payload || !payload.plan) {
    return jsonResponse({ success: false, error: "Missing plan id." }, 400);
  }
  if (!PLANS_BY_ID[payload.plan]) {
    return jsonResponse({ success: false, error: "Unknown plan." }, 400);
  }
  const planId = payload.plan;
  const billing = payload.billing === "yearly" ? "yearly" : "monthly";

  try {
    const client = await loadClient(env, clientId);
    if (!client) return jsonResponse({ success: false, error: "Client not found." }, 404);

    const customerCode = await getOrCreateCustomer(env, client, requestId);
    const planCode = await getOrCreatePlan(env, planId, billing, requestId);
    const reference = generateReference("PAY");

    // Store pending checkout so /verify can map the transaction to the plan.
    // paystack_plan_code is the authoritative link to the Paystack plan.
    await supabaseFetch(env, `clients?client_id=eq.${encodeURIComponent(clientId)}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify({
        paystack_pending_reference: reference,
        paystack_pending_plan: planId,
        paystack_plan_code: planCode,
      }),
      requestId,
    });

    const origin = env.APP_URL ? env.APP_URL.replace(/\/$/, "") : new URL(request.url).origin;
    const init = await paystackRequest(env, "POST", "/transaction/initialize", {
      email: client.paystack_email || client.owner_email,
      amount: amountInCents(planId, billing),
      plan: planCode,
      currency: CURRENCY,
      reference,
      callback_url: `${origin}/app/paystack/callback?reference=${reference}`,
    });

    return jsonResponse({
      success: true,
      data: { authorization_url: init.authorization_url, reference, access_code: init.access_code },
    });
  } catch (err) {
    return jsonResponse({ success: false, error: err.message }, 400);
  }
}

// ==================================================
// GET /api/paystack/verify?reference=...
// ==================================================

export async function handlePaystackVerify(request, env) {
  const requestId = generateRequestId();
  const auth = await authenticateBillingRequest(request, env);
  if (auth.error) return auth.error;
  const { clientId } = auth;

  const url = new URL(request.url);
  const reference = url.searchParams.get("reference");
  if (!reference) return jsonResponse({ success: false, error: "Missing reference." }, 400);

  try {
    const client = await loadClient(env, clientId);
    if (!client) return jsonResponse({ success: false, error: "Client not found." }, 404);

    const txn = await paystackRequest(env, "GET", `/transaction/verify/${encodeURIComponent(reference)}`);

    if (txn.status !== "success") {
      return jsonResponse({ success: false, error: `Payment not completed (status: ${txn.status || "unknown"}).` }, 400);
    }

    // Resolve the plan id from the Paystack plan_code first, then fall back
    // to the stored pending plan, then to the transaction plan name.
    const planCode = txn.plan?.plan_code || null;
    let planId = planCode ? await resolvePlanIdByCode(env, planCode, requestId) : null;
    if (!planId) planId = client.paystack_pending_plan;
    if (!planId && txn.plan?.name) {
      const found = PLANS.find((p) => txn.plan.name.includes(p.name));
      planId = found?.id;
    }
    if (!planId) return jsonResponse({ success: false, error: "Could not determine plan for this payment." }, 400);

    const months = billingMonths(txn.plan?.interval === YEARLY_INTERVAL ? "yearly" : "monthly");
    const subscription = txn.subscription || {};
    await updateClientPlan(env, clientId, planId, {
      customer_code: txn.customer?.customer_code || client.paystack_customer_code,
      email: txn.customer?.email || client.paystack_email,
      subscription_code: subscription.subscription_code || client.paystack_subscription_code,
      plan_code: planCode || client.paystack_plan_code,
      started_at: txn.paid_at || new Date().toISOString(),
    }, requestId, months);

    await recordSubscription(env, clientId, planId, {
      reference,
      currency: txn.currency || CURRENCY,
      amount: txn.amount || amountInCents(planId),
      customer_code: txn.customer?.customer_code,
      subscription_code: subscription.subscription_code,
      started_at: txn.paid_at,
    }, requestId, months);

    return jsonResponse({
      success: true,
      data: { plan: planId, plan_name: PLANS_BY_ID[planId].name },
    });
  } catch (err) {
    return jsonResponse({ success: false, error: err.message }, 400);
  }
}

// ==================================================
// GET /api/paystack/status
// ==================================================

export async function handlePaystackStatus(request, env) {
  const requestId = generateRequestId();
  const auth = await authenticateBillingRequest(request, env);
  if (auth.error) return auth.error;
  const { clientId } = auth;

  try {
    const client = await loadClient(env, clientId);
    if (!client) return jsonResponse({ success: false, error: "Client not found." }, 404);

    const now = Date.now();
    const expires = client.plan_expires_at ? new Date(client.plan_expires_at).getTime() : null;
    const isActive = Boolean(client.paystack_subscription_code) && expires !== null && expires > now;

    return jsonResponse({
      success: true,
      data: {
        plan: client.plan || "starter",
        plan_name: PLANS_BY_ID[client.plan]?.name || client.plan,
        plan_started_at: client.plan_started_at || null,
        plan_expires_at: client.plan_expires_at || null,
        subscription_active: isActive,
        has_subscription: Boolean(client.paystack_subscription_code),
        customer_code: client.paystack_customer_code || null,
      },
    });
  } catch (err) {
    return jsonResponse({ success: false, error: err.message }, 400);
  }
}

// ==================================================
// POST /api/paystack/cancel
// ==================================================

export async function handlePaystackCancel(request, env) {
  const requestId = generateRequestId();
  const auth = await authenticateBillingRequest(request, env);
  if (auth.error) return auth.error;
  const { clientId } = auth;

  try {
    const client = await loadClient(env, clientId);
    if (!client) return jsonResponse({ success: false, error: "Client not found." }, 404);

    if (client.paystack_subscription_code) {
      try {
        await paystackRequest(env, "POST", `/subscription/${client.paystack_subscription_code}/disable`, {
          code: client.paystack_subscription_code,
        });
      } catch (err) {
        // Ignore if already disabled — still downgrade locally
        console.error(`[${requestId}] Paystack disable error:`, err.message);
      }
    }

    await supabaseFetch(env, `clients?client_id=eq.${encodeURIComponent(clientId)}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify({
        plan: "starter",
        plan_expires_at: new Date().toISOString(),
        paystack_subscription_code: null,
        paystack_plan_code: null,
        paystack_pending_reference: null,
        paystack_pending_plan: null,
      }),
      requestId,
    });

    return jsonResponse({ success: true, data: { plan: "starter", subscription_active: false } });
  } catch (err) {
    return jsonResponse({ success: false, error: err.message }, 400);
  }
}

// ==================================================
// POST /api/paystack/webhook
// ==================================================

async function verifyWebhookSignature(env, rawBody, signatureHeader) {
  const key = env.PAYSTACK_SECRET_KEY;
  if (!key || !signatureHeader) return false;
  const encoder = new TextEncoder();
  const keyData = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", keyData, encoder.encode(rawBody));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === signatureHeader;
}

function planIdFromName(name) {
  if (!name) return null;
  const found = PLANS.find((p) => String(name).includes(p.name));
  return found ? found.id : null;
}

export async function handlePaystackWebhook(request, env) {
  const requestId = generateRequestId();

  const rawBody = await request.text();
  const signature = request.headers.get("x-paystack-signature") || "";
  const valid = await verifyWebhookSignature(env, rawBody, signature);
  if (!valid) return jsonResponse({ success: false, error: "Invalid signature." }, 401);

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ success: false, error: "Invalid payload." }, 400);
  }

  const eventType = event.event || "";
  const data = event.data || {};

  // Acknowledge immediately — we do the work below
  const ack = jsonResponse({ success: true });

  try {
    if (eventType === "charge.success") {
      const customerCode = data.customer?.customer_code;
      const planCode = data.plan?.plan_code || null;
      let planId = planCode ? await resolvePlanIdByCode(env, planCode, requestId) : null;
      if (!planId) planId = planIdFromName(data.plan?.name);
      if (!customerCode || !planId) return ack;

      const rows = await supabaseFetch(
        env,
        `clients?paystack_customer_code=eq.${encodeURIComponent(customerCode)}&select=*`
      );
      if (!rows || !rows.length) return ack;
      const client = rows[0];

      const months = billingMonths(data.plan?.interval === YEARLY_INTERVAL ? "yearly" : "monthly");
      const expiresAt = new Date(Date.now() + MONTH_MS * months).toISOString();
      await supabaseFetch(env, `clients?client_id=eq.${encodeURIComponent(client.client_id)}`, {
        method: "PATCH",
        prefer: "return=minimal",
        body: JSON.stringify({
          plan: planId,
          plan_started_at: data.paid_at || new Date().toISOString(),
          plan_expires_at: expiresAt,
          paystack_plan_code: planCode || client.paystack_plan_code,
          paystack_subscription_code: data.subscription?.subscription_code || client.paystack_subscription_code,
        }),
        requestId,
      });

      await recordSubscription(env, client.client_id, planId, {
        reference: data.reference,
        currency: data.currency || CURRENCY,
        amount: data.amount || amountInCents(planId),
        customer_code: customerCode,
        subscription_code: data.subscription?.subscription_code,
        started_at: data.paid_at,
      }, requestId, months);
    }

    if (eventType === "subscription.create" || eventType === "subscription.charge.success") {
      const customerCode = data.customer?.customer_code;
      const planCode = data.plan?.plan_code || data.plan_code || null;
      let planId = planCode ? await resolvePlanIdByCode(env, planCode, requestId) : null;
      if (!planId) planId = planIdFromName(data.plan?.name);
      if (!customerCode || !planId) return ack;

      const rows = await supabaseFetch(
        env,
        `clients?paystack_customer_code=eq.${encodeURIComponent(customerCode)}&select=*`
      );
      if (!rows || !rows.length) return ack;
      const client = rows[0];

      const months = billingMonths(data.plan?.interval === YEARLY_INTERVAL ? "yearly" : "monthly");
      await supabaseFetch(env, `clients?client_id=eq.${encodeURIComponent(client.client_id)}`, {
        method: "PATCH",
        prefer: "return=minimal",
        body: JSON.stringify({
          plan: planId,
          plan_started_at: new Date().toISOString(),
          plan_expires_at: new Date(Date.now() + MONTH_MS * months).toISOString(),
          paystack_plan_code: planCode || client.paystack_plan_code,
          paystack_subscription_code: data.subscription_code || client.paystack_subscription_code,
        }),
        requestId,
      });
    }

    if (eventType === "subscription.disable" || eventType === "subscription.not_renew") {
      const customerCode = data.customer?.customer_code || data.customer_code;
      if (!customerCode) return ack;
      const rows = await supabaseFetch(
        env,
        `clients?paystack_customer_code=eq.${encodeURIComponent(customerCode)}&select=*`
      );
      if (!rows || !rows.length) return ack;
      await supabaseFetch(env, `clients?client_id=eq.${encodeURIComponent(rows[0].client_id)}`, {
        method: "PATCH",
        prefer: "return=minimal",
        body: JSON.stringify({
          plan: "starter",
          plan_expires_at: new Date().toISOString(),
          paystack_subscription_code: null,
          paystack_plan_code: null,
        }),
        requestId,
      });
    }
  } catch (err) {
    console.error(`[${requestId}] Paystack webhook error:`, err.message);
  }

  return ack;
}

// ==================================================
// GET /api/pricing
// ==================================================

export async function handlePricing() {
  return jsonResponse({ success: true, data: PLANS });
}
