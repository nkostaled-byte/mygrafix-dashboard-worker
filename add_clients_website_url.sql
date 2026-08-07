-- ==================================================
-- Add website_url to clients for the Website Manager page.
-- Lets each owner store the real public site URL so the
-- dashboard links/probes the correct address (no fabricated domain).
-- Idempotent — safe to run multiple times.
-- ==================================================

ALTER TABLE public.clients
    ADD COLUMN IF NOT EXISTS website_url TEXT NULL DEFAULT '';

-- Force PostgREST to reload its schema cache so the new column
-- is immediately visible to the Worker.
NOTIFY pgrst, 'reload schema';