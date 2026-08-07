-- Fix: manually created bookings had no way to persist the admin-entered
-- Amount. The bookings table had no amount column and the Worker's
-- KNOWN_COLUMNS.bookings whitelist dropped the field silently.
-- Add the column and reload PostgREST's schema cache.
-- Run once in the Supabase SQL Editor.

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS amount NUMERIC(10,2) NOT NULL DEFAULT 0;

NOTIFY pgrst, 'reload schema';