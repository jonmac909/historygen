-- Add clip_prompts and clips columns to generation_projects table
ALTER TABLE generation_projects
ADD COLUMN IF NOT EXISTS clip_prompts jsonb DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS clips jsonb DEFAULT '[]'::jsonb;
