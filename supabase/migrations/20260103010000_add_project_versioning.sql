-- Add project versioning support
-- Each project can have a parent (for version history), and we keep max 3 versions

-- Add parent_project_id column for version tracking
ALTER TABLE public.generation_projects
ADD COLUMN IF NOT EXISTS parent_project_id UUID REFERENCES public.generation_projects(id) ON DELETE SET NULL;

-- Add version number column (1 = original, 2 = first revision, etc.)
ALTER TABLE public.generation_projects
ADD COLUMN IF NOT EXISTS version_number INTEGER DEFAULT 1;

-- Create index for efficient version lookups
CREATE INDEX IF NOT EXISTS idx_generation_projects_parent_id
ON public.generation_projects(parent_project_id)
WHERE parent_project_id IS NOT NULL;
