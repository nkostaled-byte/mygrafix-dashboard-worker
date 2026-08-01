-- Migration: Add POS columns to public.orders
-- Run in Supabase SQL Editor (project kbbeejxyinslvvhwnwae)
-- Enables persistent POS history with itemized receipts.

ALTER TABLE public.orders
    ADD COLUMN IF NOT EXISTS is_pos BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS payment_method TEXT NULL,
    ADD COLUMN IF NOT EXISTS items JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS items_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS customer_name TEXT NULL;

-- Force PostgREST to reload its schema cache so the new columns
-- are immediately visible to the Worker.
NOTIFY pgrst, 'reload schema';
