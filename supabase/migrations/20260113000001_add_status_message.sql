-- Add status_message column to analyzed_videos table
-- Stores detailed progress messages for UI display (e.g. "Frame extraction: 11.5% (598 frames)")

ALTER TABLE analyzed_videos
ADD COLUMN IF NOT EXISTS status_message TEXT;

-- Add index for status lookups
CREATE INDEX IF NOT EXISTS idx_analyzed_videos_status_message ON analyzed_videos(status, status_message);

-- Add comment
COMMENT ON COLUMN analyzed_videos.status_message IS 'Detailed progress message displayed in UI (e.g. "Frame extraction: 11.5% (598 frames)")';
