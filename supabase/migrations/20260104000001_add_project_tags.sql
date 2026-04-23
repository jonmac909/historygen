-- Add tags column to generation_projects table
ALTER TABLE generation_projects ADD COLUMN IF NOT EXISTS tags text[] DEFAULT '{}';

-- Create index for tag searches
CREATE INDEX IF NOT EXISTS idx_generation_projects_tags ON generation_projects USING GIN (tags);
