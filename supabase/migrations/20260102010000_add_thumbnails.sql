-- Add thumbnail columns to generation_projects table
ALTER TABLE public.generation_projects
ADD COLUMN IF NOT EXISTS thumbnails JSONB DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS selected_thumbnail_index INTEGER;
