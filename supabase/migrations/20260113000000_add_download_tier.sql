-- Add download_tier column to analyzed_videos table
-- Tracks which download method was used (1=InnerTube direct, 2=yt-dlp no proxy, 3=yt-dlp with proxy)

ALTER TABLE analyzed_videos
ADD COLUMN IF NOT EXISTS download_tier INTEGER CHECK (download_tier IN (1, 2, 3));

-- Add index for tier-based analytics
CREATE INDEX IF NOT EXISTS idx_analyzed_videos_download_tier ON analyzed_videos(download_tier);

-- Add comment
COMMENT ON COLUMN analyzed_videos.download_tier IS 'Download method used: 1=InnerTube direct (no proxy), 2=yt-dlp without proxy, 3=yt-dlp with proxy';
