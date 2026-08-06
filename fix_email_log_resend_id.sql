-- Fix: email_log insert was failing with PGRST204 "Could not find the
-- 'resend_id' column of 'email_log' in the schema cache".
-- Add the missing column and notify PostgREST to reload its schema cache.
-- Run once in the Supabase SQL Editor.

ALTER TABLE public.email_log
  ADD COLUMN IF NOT EXISTS resend_id TEXT;

-- Refresh PostgREST's schema cache so the new column is immediately queryable.
NOTIFY pgrst, 'reload schema';