-- Migration: Add contact & specialty columns to public.staff
-- Run in Supabase SQL Editor (project kbbeejxyinslvvhwnwae)
-- Allows dashboard add/edit for email, phone, specialties, and photo.

ALTER TABLE public.staff
    ADD COLUMN IF NOT EXISTS email TEXT NULL,
    ADD COLUMN IF NOT EXISTS phone TEXT NULL,
    ADD COLUMN IF NOT EXISTS specialties JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS photo_url TEXT NULL;

-- Optional index for lookups by contact email
CREATE INDEX IF NOT EXISTS idx_staff_email ON public.staff (email);
