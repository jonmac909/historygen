-- Add YouTube metadata columns to generation_projects table
ALTER TABLE public.generation_projects
ADD COLUMN IF NOT EXISTS youtube_title TEXT,
ADD COLUMN IF NOT EXISTS youtube_description TEXT,
ADD COLUMN IF NOT EXISTS youtube_tags TEXT,
ADD COLUMN IF NOT EXISTS youtube_category_id TEXT,
ADD COLUMN IF NOT EXISTS youtube_playlist_id TEXT;
