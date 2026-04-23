-- Add scene_description column to analyzed_scenes table
-- Run this in Supabase SQL Editor: https://supabase.com/dashboard/project/udqfdeoullsxttqguupz/sql

-- Add scene_description column (text, nullable)
ALTER TABLE analyzed_scenes
ADD COLUMN IF NOT EXISTS scene_description TEXT;

-- Add index for faster text searches
CREATE INDEX IF NOT EXISTS idx_analyzed_scenes_description
ON analyzed_scenes USING gin(to_tsvector('english', scene_description));

-- Comment for documentation
COMMENT ON COLUMN analyzed_scenes.scene_description IS 'AI-generated visual description of the frame (Claude Vision API)';
