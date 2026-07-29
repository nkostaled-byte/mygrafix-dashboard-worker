-- ==================================================
-- FIX SCHEMA MIGRATION — Add missing columns
-- ==================================================
-- Run this in Supabase SQL Editor to fix the
-- "category" column issue on products and services.
--
-- SAFE: Idempotent (IF NOT EXISTS), no data deletion
-- ==================================================

-- ==================================================
-- 1. Products already use category_id UUID FK
--    No changes needed to products table.
--    The Worker now handles category name→ID mapping.
-- ==================================================

-- ==================================================
-- 2. Services: Add category, description, image_url
--    These are used by the frontend ServicesPage
--    and stored in KNOWN_COLUMNS mapping.
-- ==================================================
ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'General',
  ADD COLUMN IF NOT EXISTS description TEXT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS image_url TEXT NULL;

-- ==================================================
-- 3. Products KNOWN_COLUMNS now uses category_id
--    No further DB changes needed. The Worker
--    code auto-resolves category names to IDs.
-- ==================================================

-- ==================================================
-- 4. Verify all columns are present
-- ==================================================
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('products', 'services')
ORDER BY table_name, ordinal_position;
</｜DSML｜parameter>
</｜DSML｜create_file>
