-- Add approved_steps column for pipeline approval tracking
-- Stores array of step names that have been explicitly approved by user
ALTER TABLE public.generation_projects
ADD COLUMN IF NOT EXISTS approved_steps JSONB DEFAULT '[]'::jsonb;
