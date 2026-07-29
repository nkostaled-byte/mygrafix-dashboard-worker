-- ==================================================
-- Add missing columns to clients table
-- The original migration omitted country, currency, timezone
-- which are needed by the claim-account handler
-- ==================================================

ALTER TABLE public.clients
    ADD COLUMN IF NOT EXISTS country TEXT NULL,
    ADD COLUMN IF NOT EXISTS currency TEXT NULL,
    ADD COLUMN IF NOT EXISTS timezone TEXT NULL;
