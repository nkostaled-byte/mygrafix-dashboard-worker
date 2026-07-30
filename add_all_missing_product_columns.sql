-- ==================================================
-- MIGRATION: Add all potentially missing columns to products table
-- ==================================================
-- Safe to run multiple times — uses IF NOT EXISTS for every column.
-- Run this in Supabase SQL Editor, then reload schema cache:
--    NOTIFY pgrst, 'reload schema';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'products' AND column_name = 'category_id') THEN
        ALTER TABLE public.products ADD COLUMN category_id UUID NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'products' AND column_name = 'barcode') THEN
        ALTER TABLE public.products ADD COLUMN barcode TEXT NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'products' AND column_name = 'cost_price') THEN
        ALTER TABLE public.products ADD COLUMN cost_price NUMERIC(10,2) NOT NULL DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'products' AND column_name = 'stock_qty') THEN
        ALTER TABLE public.products ADD COLUMN stock_qty INTEGER NOT NULL DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'products' AND column_name = 'low_stock_warning') THEN
        ALTER TABLE public.products ADD COLUMN low_stock_warning INTEGER NOT NULL DEFAULT 5;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'products' AND column_name = 'image_url') THEN
        ALTER TABLE public.products ADD COLUMN image_url TEXT NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'products' AND column_name = 'variants') THEN
        ALTER TABLE public.products ADD COLUMN variants JSONB NULL DEFAULT '[]'::jsonb;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'products' AND column_name = 'is_hidden') THEN
        ALTER TABLE public.products ADD COLUMN is_hidden BOOLEAN NOT NULL DEFAULT false;
    END IF;
END;
$$;
