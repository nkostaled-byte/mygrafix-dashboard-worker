-- Migration: Paystack subscriptions
-- Adds subscription tracking to public.clients and a subscriptions history table.
-- All statements are idempotent.

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'starter',
  ADD COLUMN IF NOT EXISTS plan_started_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS paystack_customer_code TEXT NULL,
  ADD COLUMN IF NOT EXISTS paystack_subscription_code TEXT NULL,
  ADD COLUMN IF NOT EXISTS paystack_plan_code TEXT NULL,
  ADD COLUMN IF NOT EXISTS paystack_email TEXT NULL,
  ADD COLUMN IF NOT EXISTS paystack_pending_reference TEXT NULL,
  ADD COLUMN IF NOT EXISTS paystack_pending_plan TEXT NULL;

CREATE TABLE IF NOT EXISTS public.subscriptions (
    id BIGSERIAL PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES public.clients(client_id) ON DELETE CASCADE,
    plan TEXT NOT NULL DEFAULT 'starter',
    status TEXT NOT NULL DEFAULT 'active',
    currency TEXT NOT NULL DEFAULT 'ZAR',
    amount BIGINT NOT NULL DEFAULT 0,
    paystack_reference TEXT NULL,
    paystack_customer_code TEXT NULL,
    paystack_subscription_code TEXT NULL,
    started_at TIMESTAMPTZ NULL,
    expires_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Paystack plan_code (PLN_xxx) → Business OS plan id lookup table.
-- This is how webhook events are matched to a plan deterministically.
CREATE TABLE IF NOT EXISTS public.paystack_plans (
    plan_code TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    interval TEXT NOT NULL DEFAULT 'monthly',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_client_id ON public.subscriptions (client_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_sub_code ON public.subscriptions (paystack_subscription_code);
CREATE INDEX IF NOT EXISTS idx_subscriptions_reference ON public.subscriptions (paystack_reference);
CREATE INDEX IF NOT EXISTS idx_paystack_plans_plan_id ON public.paystack_plans (plan_id);

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paystack_plans ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'subscriptions' AND policyname = 'subscriptions_auth_select_own'
  ) THEN
    CREATE POLICY "subscriptions_auth_select_own" ON public.subscriptions FOR SELECT TO authenticated USING (client_id = public.auth_client_id());
  END IF;
END $$;
