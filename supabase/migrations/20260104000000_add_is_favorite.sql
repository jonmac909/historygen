-- Add is_favorite column to generation_projects table
ALTER TABLE public.generation_projects
ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN DEFAULT false;
