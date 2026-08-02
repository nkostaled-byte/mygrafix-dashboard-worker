/**
 * Paystack Subscriptions Handler
 * ================================
 * Supports two independent subscription products per workspace:
 *   - "os"       (Business OS plans: starter/business/professional/enterprise)
 *   - "hosting"  (Web hosting plans: hosting-basic/hosting-pro)
 *
 * Endpoints:
 * - POST /api/paystack/checkout    (auth) Start a subscription checkout { product, plan, billing }
 * - GET  /api/paystack/verify      (auth) Verify a transaction & activate the product
 * - GET  /api/paystack/status      (auth) Current OS + hosting subscription state
 * - POST /api/paystack/cancel      (auth) Cancel a product subscription { product }
 * - POST /api/paystack/webhook     (signed) Paystack event notifications
 * - GET  /api/pricing              Public OS plan list
 * - GET  /api/pricing/hosting      Public hosting plan list
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

// OS plan catalog — amounts are RAND values shown in R. Keep in sync with src/data/pricingData.ts
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

// Web hosting catalog — a separate subscription product for hosted clients.
const HOSTING_PLANS = [
  {
    id: "hosting-basic",
    name: "Basic Hosting",
    tagline: "For single websites & personal sites",
    monthlyPrice: 99,
    yearlyPrice: 79,
    monthlyBillingText: "Billed monthly",
    yearlyBillingText: "R948 billed annually",
    features: ["1 Website", "20GB SSD Storage", "Free SSL Certificate", "Business Email", "Basic Support"],
    includedFromPrevious: "",
  },
  {
    id: "hosting-pro",
    name: "Pro Hosting",
    tagline: "For growing sites with higher traffic",
    monthlyPrice: 199,
    yearlyPrice: 159,
    monthlyBillingText: "Billed monthly",
    yearlyBillingText: "R1,908 billed annually",
    badge: "Most Popular",
    isPopular: true,
    features: [
      "Unlimited Websites",
      "100GB SSD Storage",
      "Free SSL Certificates",
      "Business Email",
      "Daily Backups",
      "Priority Support",
    ],
    includedFromPrevious: "Everything in Basic +",
  },
];

function getCatalog(product) {
  return product === "hosting" ? HOSTING_PLANS : PLANS;
}

function getPlanById(product, planId) {
  return getCatalog(product).find((p) => p.id === planId) || null;
}

function amountInCents(product, planId, billing = "monthly") {
  const plan = getPlanById(product, planId);
  const price = billing === "yearly" ? plan.yearlyPrice : plan.monthlyPrice;
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

async function getOrCreatePlan(env, product, planId, billing, requestId) {
  const plan = getPlanById(product, planId);
  if (!plan) throw new Error(`Unknown ${product} plan: ${planId}`);

  const interval = billingInterval(billing);
  const isHosting = product === "hosting";

  // Allow a manual override via env:
  //   OS:       PAYSTACK_PLAN_BUSINESS_MONTHLY="PLN_xxx"
  //   Hosting:  PAYSTACK_PLAN_HOSTING_BASIC_MONTHLY="PLN_xxx"
  const override = env[
    `PAYSTACK_PLAN_${isHosting ? "HOSTING_" : ""}${plan.id.toUpperCase()}_${billing.toUpperCase()}`
  ];
  if (override) {
    await upsertPlanMapping(env, override, planId, product, interval, requestId);
    return override;
  }

  const planName = isHosting
    ? `My Grafix Hosting ${plan.name} (${CURRENCY} ${billing})`
    : `Business OS ${plan.name} (${CURRENCY} ${billing})`;

  // Try to reuse an existing plan with the same name
  const existing = await paystackRequest(env, "GET", `/plan?perPage=100`);
  const plans = Array.isArray(existing) ? existing : existing?.data || [];
  const match = plans.find(
    (p) => p.name === planName && Number(p.amount) === amountInCents(product, planId, billing) && p.interval === interval
  );
  if (match) {
    await upsertPlanMapping(env, match.plan_code, planId, product, interval, requestId);
    return match.plan_code;
  }

  const created = await paystackRequest(env, "POST", "/plan", {
    name: planName,
    amount: amountInCents(product, planId, billing),
    interval,
    currency: CURRENCY,
  });
  await upsertPlanMapping(env, created.plan_code, planId, product, interval, requestId);
  return created.plan_code;
}

/**
 * Record the Paystack plan_code → (plan_id, product) mapping (idempotent upsert).
 * This is the source of truth for matching webhook events to plans.
 */
async function upsertPlanMapping(env, planCode, planId, product, interval, requestId) {
  if (!planCode) return;
  try {
    await supabaseFetch(env, `paystack_plans?on_conflict=plan_code`, {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: JSON.stringify({ plan_code: planCode, plan_id: planId, product, interval }),
      requestId,
    });
  } catch (err) {
    console.error(`[${requestId}] upsertPlanMapping error:`, err.message);
  }
}

/**
 * Resolve { planId, product } from a Paystack plan_code (PLN_xxx).
 * Checks the local paystack_plans table first, then falls back to
 * fetching the plan from Paystack and parsing its name.
 */
async function resolvePlanByCode(env, planCode, requestId) {
  if (!planCode) return null;

  try {
    const rows = await supabaseFetch(
      env,
      `paystack_plans?plan_code=eq.${encodeURIComponent(planCode)}&select=plan_id,product`
    );
    if (rows && rows.length) return { planId: rows[0].plan_id, product: rows[0].product || "os" };
  } catch (err) {
    console.error(`[${requestId}] resolvePlanByCode lookup error:`, err.message);
  }

  // Fallback: fetch the plan from Paystack and parse its name
  try {
    const plan = await paystackRequest(env, "GET", `/plan/${encodeURIComponent(planCode)}`);
    const product = String(plan?.name || "").includes("Hosting") ? "hosting" : "os";
    const planId = planIdFromName(plan?.name, product);
    if (planId) {
      await upsertPlanMapping(
        env,
        planCode,
        planId,
        product,
        plan?.interval === YEARLY_INTERVAL ? "yearly" : "monthly",
        requestId
      );
      return { planId, product };
    }
  } catch (err) {
    console.error(`[${requestId}] resolvePlanByCode Paystack error:`, err.message);
  }
  return null;
}

/**
 * Activate (or refresh) a product subscription on the client row.
 * OS and hosting each have their own set of columns.
 */
async function updateProductSubscription(env, client, product, planId, subscription, requestId, months = 1) {
  const startedAt = subscription?.started_at || new Date().toISOString();
  const expiresAt = new Date(Date.now() + MONTH_MS * months).toISOString();
  const patch = {};

  if (product === "hosting") {
    patch.hosting_plan = planId;
    patch.hosting_started_at = startedAt;
    patch.hosting_expires_at = expiresAt;
    if (subscription?.subscription_code) patch.hosting_subscription_code = subscription.subscription_code;
    if (subscription?.plan_code) patch.hosting_plan_code = subscription.plan_code;
  } else {
    patch.plan = planId;
    patch.plan_started_at = startedAt;
    patch.plan_expires_at = expiresAt;
    patch.paystack_pending_reference = null;
    patch.paystack_pending_plan = null;
    if (subscription?.subscription_code) patch.paystack_subscription_code = subscription.subscription_code;
    if (subscription?.plan_code) patch.paystack_plan_code = subscription.plan_code;
  }

  if (subscription?.customer_code) patch.paystack_customer_code = subscription.customer_code;
  if (subscription?.email) patch.paystack_email = subscription.email;

  await supabaseFetch(env, `clients?client_id=eq.${encodeURIComponent(client.client_id)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify(patch),
    requestId,
  });
}

/**
 * Set a product subscription to inactive locally.
 * OS downgrades to starter; hosting clears its fields.
 */
async function deactivateProduct(env, clientId, product, requestId) {
  const patch =
    product === "hosting"
      ? {
          hosting_plan: null,
          hosting_expires_at: new Date().toISOString(),
          hosting_subscription_code: null,
          hosting_plan_code: null,
        }
      : {
          plan: "starter",
          plan_expires_at: new Date().toISOString(),
          paystack_subscription_code: null,
          paystack_plan_code: null,
          paystack_pending_reference: null,
          paystack_pending_plan: null,
        };
  await supabaseFetch(env, `clients?client_id=eq.${encodeURIComponent(clientId)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify(patch),
    requestId,
  });
}

/**
 * Best-effort disable of a product's previous Paystack subscription when a new
 * one is activated. Paystack has no "change plan" endpoint, so switching plans
 * means creating a brand-new subscription and disabling the old one — otherwise
 * the old subscription stays active and keeps billing the customer forever.
 */
async function disablePreviousSubscription(env, client, product, newSubscriptionCode, requestId) {
  const currentCode =
    product === "hosting" ? client.hosting_subscription_code : client.paystack_subscription_code;
  if (!currentCode || currentCode === newSubscriptionCode) return;
  try {
    await paystackRequest(env, "POST", `/subscription/${currentCode}/disable`, { code: currentCode });
    console.log(`[${requestId}] Disabled previous ${product} subscription ${currentCode}`);
  } catch (err) {
    console.error(`[${requestId}] Disabling previous ${product} subscription ${currentCode} failed:`, err.message);
  }
}

async function recordSubscription(env, clientId, product, planId, payload, requestId, months = 1) {
  await supabaseFetch(env, "subscriptions", {
    method: "POST",
    prefer: "return=minimal",
    body: JSON.stringify({
      client_id: clientId,
      product,
      plan: planId,
      status: "active",
      currency: payload.currency || CURRENCY,
      amount: payload.amount || amountInCents(product, planId),
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
  const product = payload.product === "hosting" ? "hosting" : "os";
  if (!getPlanById(product, payload.plan)) {
    return jsonResponse({ success: false, error: "Unknown plan." }, 400);
  }
  const planId = payload.plan;
  const billing = payload.billing === "yearly" ? "yearly" : "monthly";

  try {
    const client = await loadClient(env, clientId);
    if (!client) return jsonResponse({ success: false, error: "Client not found." }, 404);

    const customerCode = await getOrCreateCustomer(env, client, requestId);
    const planCode = await getOrCreatePlan(env, product, planId, billing, requestId);
    const reference = generateReference("PAY");

    // Store pending checkout so /verify can map the transaction to the plan.
    // Plan codes are kept per product so one never clobbers the other.
    const pendingPatch = { paystack_pending_reference: reference, paystack_pending_plan: planId };
    if (product === "hosting") pendingPatch.hosting_plan_code = planCode;
    else pendingPatch.paystack_plan_code = planCode;
    await supabaseFetch(env, `clients?client_id=eq.${encodeURIComponent(clientId)}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify(pendingPatch),
      requestId,
    });

    const origin = env.APP_URL ? env.APP_URL.replace(/\/$/, "") : new URL(request.url).origin;
    const init = await paystackRequest(env, "POST", "/transaction/initialize", {
      email: client.paystack_email || client.owner_email,
      amount: amountInCents(product, planId, billing),
      plan: planCode,
      currency: CURRENCY,
      reference,
      callback_url: `${origin}/app/paystack/callback?reference=${reference}`,
    });

    return jsonResponse({
      success: true,
      data: { product, authorization_url: init.authorization_url, reference, access_code: init.access_code },
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

    // Resolve plan id + product from the Paystack plan_code first, then fall
    // back to the stored pending plan, then to the transaction plan name.
    const planCode = txn.plan?.plan_code || null;
    let resolved = planCode ? await resolvePlanByCode(env, planCode, requestId) : null;
    let planId = resolved?.planId || null;
    let product = resolved?.product || "os";
    if (!planId) planId = client.paystack_pending_plan;
    if (!planId && txn.plan?.name) {
      const detectedProduct = String(txn.plan.name).includes("Hosting") ? "hosting" : "os";
      planId = planIdFromName(txn.plan.name, detectedProduct);
      if (planId) product = detectedProduct;
    }
    if (!planId) return jsonResponse({ success: false, error: "Could not determine plan for this payment." }, 400);

    const months = billingMonths(txn.plan?.interval === YEARLY_INTERVAL ? "yearly" : "monthly");
    const subscription = txn.subscription || {};
    await disablePreviousSubscription(env, client, product, subscription.subscription_code, requestId);
    await updateProductSubscription(env, client, product, planId, {
      customer_code: txn.customer?.customer_code || client.paystack_customer_code,
      email: txn.customer?.email || client.paystack_email,
      subscription_code: subscription.subscription_code,
      plan_code: planCode || undefined,
      started_at: txn.paid_at || new Date().toISOString(),
    }, requestId, months);

    await recordSubscription(env, clientId, product, planId, {
      reference,
      currency: txn.currency || CURRENCY,
      amount: txn.amount || amountInCents(product, planId),
      customer_code: txn.customer?.customer_code,
      subscription_code: subscription.subscription_code,
      started_at: txn.paid_at,
    }, requestId, months);

    const planInfo = getPlanById(product, planId);
    return jsonResponse({
      success: true,
      data: { product, plan: planId, plan_name: planInfo?.name || planId },
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

    const osExpires = client.plan_expires_at ? new Date(client.plan_expires_at).getTime() : null;
    const osActive = Boolean(client.paystack_subscription_code) && osExpires !== null && osExpires > now;

    const hostingExpires = client.hosting_expires_at ? new Date(client.hosting_expires_at).getTime() : null;
    const hostingActive =
      Boolean(client.hosting_subscription_code) && hostingExpires !== null && hostingExpires > now;

    const hostingPlanInfo = getPlanById("hosting", client.hosting_plan);

    return jsonResponse({
      success: true,
      data: {
        plan: client.plan || "starter",
        plan_name: getPlanById("os", client.plan)?.name || client.plan,
        plan_started_at: client.plan_started_at || null,
        plan_expires_at: client.plan_expires_at || null,
        subscription_active: osActive,
        has_subscription: Boolean(client.paystack_subscription_code),
        customer_code: client.paystack_customer_code || null,
        hosting_plan: client.hosting_plan || null,
        hosting_plan_name: hostingPlanInfo?.name || client.hosting_plan,
        hosting_started_at: client.hosting_started_at || null,
        hosting_expires_at: client.hosting_expires_at || null,
        hosting_subscription_active: hostingActive,
        hosting_has_subscription: Boolean(client.hosting_subscription_code),
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

  const payload = await parseJsonBody(request).catch(() => null);
  const product = payload?.product === "hosting" ? "hosting" : "os";

  try {
    const client = await loadClient(env, clientId);
    if (!client) return jsonResponse({ success: false, error: "Client not found." }, 404);

    const subscriptionCode =
      product === "hosting" ? client.hosting_subscription_code : client.paystack_subscription_code;

    if (subscriptionCode) {
      try {
        await paystackRequest(env, "POST", `/subscription/${subscriptionCode}/disable`, {
          code: subscriptionCode,
        });
      } catch (err) {
        // Ignore if already disabled — still deactivate locally
        console.error(`[${requestId}] Paystack disable error:`, err.message);
      }
    }

    await deactivateProduct(env, clientId, product, requestId);

    const data =
      product === "hosting"
        ? { hosting_plan: null, hosting_subscription_active: false }
        : { plan: "starter", subscription_active: false };

    return jsonResponse({ success: true, data });
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

function planIdFromName(name, product = "os") {
  if (!name) return null;
  const found = getCatalog(product).find((p) => String(name).includes(p.name));
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
      let resolved = planCode ? await resolvePlanByCode(env, planCode, requestId) : null;
      let planId = resolved?.planId || null;
      let product = resolved?.product || "os";
      if (!planId) {
        product = String(data.plan?.name || "").includes("Hosting") ? "hosting" : "os";
        planId = planIdFromName(data.plan?.name, product);
      }
      if (!customerCode || !planId) return ack;

      const rows = await supabaseFetch(
        env,
        `clients?paystack_customer_code=eq.${encodeURIComponent(customerCode)}&select=*`
      );
      if (!rows || !rows.length) return ack;
      const client = rows[0];

      const months = billingMonths(data.plan?.interval === YEARLY_INTERVAL ? "yearly" : "monthly");
      await disablePreviousSubscription(
        env,
        client,
        product,
        data.subscription?.subscription_code,
        requestId
      );
      await updateProductSubscription(env, client, product, planId, {
        subscription_code: data.subscription?.subscription_code,
        plan_code: planCode || undefined,
        customer_code: customerCode,
        started_at: data.paid_at || new Date().toISOString(),
      }, requestId, months);

      await recordSubscription(env, client.client_id, product, planId, {
        reference: data.reference,
        currency: data.currency || CURRENCY,
        amount: data.amount || amountInCents(product, planId),
        customer_code: customerCode,
        subscription_code: data.subscription?.subscription_code,
        started_at: data.paid_at,
      }, requestId, months);
    }

    if (eventType === "subscription.create" || eventType === "subscription.charge.success") {
      const customerCode = data.customer?.customer_code;
      const planCode = data.plan?.plan_code || data.plan_code || null;
      let resolved = planCode ? await resolvePlanByCode(env, planCode, requestId) : null;
      let planId = resolved?.planId || null;
      let product = resolved?.product || "os";
      if (!planId) {
        product = String(data.plan?.name || "").includes("Hosting") ? "hosting" : "os";
        planId = planIdFromName(data.plan?.name, product);
      }
      if (!customerCode || !planId) return ack;

      const rows = await supabaseFetch(
        env,
        `clients?paystack_customer_code=eq.${encodeURIComponent(customerCode)}&select=*`
      );
      if (!rows || !rows.length) return ack;
      const client = rows[0];

      const months = billingMonths(data.plan?.interval === YEARLY_INTERVAL ? "yearly" : "monthly");
      await disablePreviousSubscription(env, client, product, data.subscription_code, requestId);
      await updateProductSubscription(env, client, product, planId, {
        subscription_code: data.subscription_code,
        plan_code: planCode || undefined,
        customer_code: customerCode,
        started_at: new Date().toISOString(),
      }, requestId, months);
    }

    if (eventType === "subscription.disable" || eventType === "subscription.not_renew") {
      const customerCode = data.customer?.customer_code || data.customer_code;
      if (!customerCode) return ack;
      const rows = await supabaseFetch(
        env,
        `clients?paystack_customer_code=eq.${encodeURIComponent(customerCode)}&select=*`
      );
      if (!rows || !rows.length) return ack;
      const client = rows[0];

      const planCode = data.plan?.plan_code || null;
      let product = "os";
      if (planCode) {
        const resolved = await resolvePlanByCode(env, planCode, requestId);
        product = resolved?.product || product;
      } else if (String(data.plan?.name || "").includes("Hosting")) {
        product = "hosting";
      }

      // Only deactivate if the disabled subscription is still the current one
      // for that product. Subscriptions replaced by a plan switch (already
      // disabled via disablePreviousSubscription) must NOT clobber the new one.
      const disabledCode = data.subscription_code || data.subscription?.subscription_code || null;
      const currentCode =
        product === "hosting" ? client.hosting_subscription_code : client.paystack_subscription_code;
      if (disabledCode && currentCode && disabledCode !== currentCode) return ack;

      await deactivateProduct(env, client.client_id, product, requestId);
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

export async function handleHostingPricing() {
  return jsonResponse({ success: true, data: HOSTING_PLANS });
}
