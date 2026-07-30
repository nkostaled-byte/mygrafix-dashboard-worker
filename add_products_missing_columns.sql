-- ==================================================
-- MIGRATION: Add cost_price column to products table
-- ==================================================
-- Safely adds cost_price to the products table if it doesn't already exist.
-- Run this in Supabase SQL Editor, then refresh the PostgREST schema cache.
--
-- After running, execute: NOTIFY pgrst, 'reload schema';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'products' AND column_name = 'cost_price'
    ) THEN
        ALTER TABLE public.products ADD COLUMN cost_price NUMERIC(10,2) NOT NULL DEFAULT 0;
        RAISE NOTICE 'Added column: cost_price';
    ELSE
        RAISE NOTICE 'Column cost_price already exists';
    END IF;
END;
$$;
