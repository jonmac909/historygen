-- Add favorite_thumbnails column to generation_projects
ALTER TABLE public.generation_projects
ADD COLUMN IF NOT EXISTS favorite_thumbnails JSONB DEFAULT '[]'::jsonb;
