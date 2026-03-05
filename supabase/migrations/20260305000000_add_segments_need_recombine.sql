-- Add segments_need_recombine column to track when audio segments have been regenerated
-- and need to be recombined before rendering

ALTER TABLE generation_projects
ADD COLUMN IF NOT EXISTS segments_need_recombine BOOLEAN DEFAULT FALSE;

-- Add comment for documentation
COMMENT ON COLUMN generation_projects.segments_need_recombine IS 'True when audio segments have been regenerated and need to be recombined into a single audio file before rendering';
