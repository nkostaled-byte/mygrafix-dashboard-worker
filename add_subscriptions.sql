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
  ADD COLUMN IF NOT EXISTS paystack_pending_plan TEXT NULL,
  -- Web hosting product (separate subscription from the OS plan)
  ADD COLUMN IF NOT EXISTS hosting_plan TEXT NULL,
  ADD COLUMN IF NOT EXISTS hosting_started_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS hosting_expires_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS hosting_subscription_code TEXT NULL,
  ADD COLUMN IF NOT EXISTS hosting_plan_code TEXT NULL;

-- Free is now the default tier (downgrade target on cancel); Starter is a paid tier.
ALTER TABLE public.clients ALTER COLUMN plan SET DEFAULT 'free';

-- Backfill: clients without an active OS subscription (never paid or cancelled/expired)
-- are moved to the Free tier. Active subscribers (have a subscription code) are kept.
UPDATE public.clients
SET plan = 'free'
WHERE plan <> 'free'
  AND paystack_subscription_code IS NULL
  AND (plan_expires_at IS NULL OR plan_expires_at < now());

CREATE TABLE IF NOT EXISTS public.subscriptions (
    id BIGSERIAL PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES public.clients(client_id) ON DELETE CASCADE,
    product TEXT NOT NULL DEFAULT 'os',
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
    product TEXT NOT NULL DEFAULT 'os',
    interval TEXT NOT NULL DEFAULT 'monthly',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_client_id ON public.subscriptions (client_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_sub_code ON public.subscriptions (paystack_subscription_code);
CREATE INDEX IF NOT EXISTS idx_subscriptions_reference ON public.subscriptions (paystack_reference);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_reference_unique
  ON public.subscriptions (paystack_reference) WHERE paystack_reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_paystack_plans_plan_id ON public.paystack_plans (plan_id);

-- Backfill for tables that may already exist from a previous run
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS product TEXT NOT NULL DEFAULT 'os';
ALTER TABLE public.paystack_plans ADD COLUMN IF NOT EXISTS product TEXT NOT NULL DEFAULT 'os';

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
