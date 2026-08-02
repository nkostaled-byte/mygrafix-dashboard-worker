/**
 * Plan Access — Subscription plan gating helpers
 * ================================================
 * Determines which Business OS features a client may use based on their
 * active subscription plan. Plans are ordered:
 *   starter (1) < business (2) < professional (3) < enterprise (4)
 *
 * A client's "effective plan" is the stored plan ONLY while their Paystack
 * subscription is active. If the subscription is absent, cancelled or expired,
 * the client is effectively on the free Starter tier.
 */

import { jsonResponse } from "./responses.js";

export const PLAN_TIERS = {
  starter: 1,
  business: 2,
  professional: 3,
  enterprise: 4,
};

export const PLAN_NAMES = {
  starter: "Starter",
  business: "Business",
  professional: "Professional",
  enterprise: "Enterprise",
};

/**
 * Effective plan for a client row.
 * - Requires an active subscription (paystack_subscription_code set) AND
 *   a plan_expires_at that is still in the future.
 * - Otherwise the client is on Starter (free tier).
 */
export function getEffectivePlan(client) {
  if (!client) return "starter";
  const active =
    Boolean(client.paystack_subscription_code) &&
    (!client.plan_expires_at || new Date(client.plan_expires_at).getTime() > Date.now());
  return active ? client.plan || "starter" : "starter";
}

export function getPlanTier(plan) {
  return PLAN_TIERS[plan] || PLAN_TIERS.starter;
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
