/**
 * Plan Access — Subscription plan gating helpers
 * ================================================
 * Determines which Business OS features a client may use based on their
 * active subscription plan. Plans are ordered:
 *   free (0) < starter (1) < business (2) < professional (3)
 *
 * A client's "effective plan" is the stored plan ONLY while their Paystack
 * subscription is active. If the subscription is absent, cancelled or expired,
 * the client is effectively on the Free tier.
 */

import { jsonResponse } from "./responses.js";

export const PLAN_TIERS = {
  free: 0,
  starter: 1,
  business: 2,
  professional: 3,
  // Kept for legacy stored values only — no longer sold or selectable.
  enterprise: 4,
};

export const PLAN_NAMES = {
  free: "Free",
  starter: "Starter",
  business: "Business",
  professional: "Professional",
  enterprise: "Enterprise",
};

/**
 * Effective plan for a client row.
 * A plan is active when it's a paid tier (anything above "free") with an expiry
 * still in the future. We deliberately do NOT require a stored subscription code:
 * the verify fallback can activate a plan (webhook already ran) without a
 * retrievable Paystack code, and gating must treat that as an active subscription.
 * Otherwise the client is on the Free tier.
 */
export function getEffectivePlan(client) {
  if (!client) return "free";
  const expires = client.plan_expires_at ? new Date(client.plan_expires_at).getTime() : null;
  const active = client.plan !== "free" && expires !== null && expires > Date.now();
  return active ? client.plan || "free" : "free";
}

export function getPlanTier(plan) {
  return PLAN_TIERS[plan] ?? PLAN_TIERS.free;
}

export function canAccessPlan(client, minPlan) {
  return getPlanTier(getEffectivePlan(client)) >= getPlanTier(minPlan);
}

/**
 * Build a 403 response explaining which plan is required.
 */
export function planAccessDenied(minPlan) {
  const name = PLAN_NAMES[minPlan] || minPlan;
  return jsonResponse(
    {
      success: false,
      error: `This feature requires the ${name} plan or higher.`,
      required_plan: minPlan,
    },
    403
  );
}
