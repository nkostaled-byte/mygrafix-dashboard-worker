-- ==================================================
-- MIGRATION: Add category, description, image_url to services
-- ==================================================
-- Safely adds new columns to the services table if they don't already exist.
-- Run this in Supabase SQL Editor.

DO $$
BEGIN
    -- Add category column
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'services' AND column_name = 'category'
    ) THEN
        ALTER TABLE public.services ADD COLUMN category TEXT NOT NULL DEFAULT 'General';
        RAISE NOTICE 'Added column: category';
    ELSE
        RAISE NOTICE 'Column category already exists';
    END IF;

    -- Add description column
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'services' AND column_name = 'description'
    ) THEN
        ALTER TABLE public.services ADD COLUMN description TEXT NULL DEFAULT '';
        RAISE NOTICE 'Added column: description';
    ELSE
        RAISE NOTICE 'Column description already exists';
    END IF;

    -- Add image_url column
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'services' AND column_name = 'image_url'
    ) THEN
        ALTER TABLE public.services ADD COLUMN image_url TEXT NULL;
        RAISE NOTICE 'Added column: image_url';
    ELSE
        RAISE NOTICE 'Column image_url already exists';
    END IF;
END;
$$;
