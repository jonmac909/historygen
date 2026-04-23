-- Update generation_projects table to match Project interface from projectStore.ts

-- Add missing columns
ALTER TABLE public.generation_projects
ADD COLUMN IF NOT EXISTS video_title TEXT,
ADD COLUMN IF NOT EXISTS current_step TEXT DEFAULT 'script',
ADD COLUMN IF NOT EXISTS audio_duration NUMERIC,
ADD COLUMN IF NOT EXISTS audio_segments JSONB DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS srt_content TEXT,
ADD COLUMN IF NOT EXISTS image_prompts JSONB DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS video_url TEXT,
ADD COLUMN IF NOT EXISTS video_url_captioned TEXT,
ADD COLUMN IF NOT EXISTS embers_video_url TEXT,
ADD COLUMN IF NOT EXISTS smoke_embers_video_url TEXT;

-- Rename existing columns for consistency with frontend interface
ALTER TABLE public.generation_projects RENAME COLUMN captions_url TO srt_url;
ALTER TABLE public.generation_projects RENAME COLUMN images TO image_urls;

-- Add delete policy (missing from original migration)
CREATE POLICY "Allow public delete"
ON public.generation_projects FOR DELETE
USING (true);
