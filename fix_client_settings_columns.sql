-- ==================================================
-- Fix client settings save: ensure all columns used by
-- PUT /api/client-settings exist on the clients table.
-- Idempotent — safe to run multiple times.
-- ==================================================

ALTER TABLE public.clients
    ADD COLUMN IF NOT EXISTS phone TEXT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS address TEXT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS opening_hours TEXT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS bank_name TEXT NULL,
    ADD COLUMN IF NOT EXISTS bank_account_name TEXT NULL,
    ADD COLUMN IF NOT EXISTS bank_account_number TEXT NULL,
    ADD COLUMN IF NOT EXISTS bank_branch_code TEXT NULL,
    ADD COLUMN IF NOT EXISTS bank_account_type TEXT NULL,
    ADD COLUMN IF NOT EXISTS bank_reference TEXT NULL,
    ADD COLUMN IF NOT EXISTS payment_instructions TEXT NULL,
    ADD COLUMN IF NOT EXISTS logo_url TEXT NULL,
    ADD COLUMN IF NOT EXISTS primary_color TEXT NULL DEFAULT '#111111',
    ADD COLUMN IF NOT EXISTS secondary_color TEXT NULL DEFAULT '#f5f5f5';

-- Force PostgREST to reload its schema cache so the new columns
-- are immediately visible to the Worker.
NOTIFY pgrst, 'reload schema';
