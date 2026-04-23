-- Auto-Clone System Tables
-- Track processed videos and daily runs for automated video cloning

-- Track processed videos (deduplication)
CREATE TABLE IF NOT EXISTS processed_videos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id TEXT UNIQUE NOT NULL,
  channel_id TEXT NOT NULL,
  original_title TEXT NOT NULL,
  original_thumbnail_url TEXT,
  cloned_title TEXT,
  project_id TEXT,
  youtube_video_id TEXT,
  youtube_url TEXT,
  outlier_multiplier NUMERIC(10, 2),
  duration_seconds INT,
  status TEXT DEFAULT 'pending',  -- pending, processing, completed, failed
  error_message TEXT,
  processed_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Track daily runs (monitoring)
CREATE TABLE IF NOT EXISTS auto_clone_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_date DATE UNIQUE NOT NULL,
  status TEXT DEFAULT 'running',  -- running, completed, failed, no_candidates
  channels_scanned INT DEFAULT 0,
  outliers_found INT DEFAULT 0,
  video_selected_id TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_processed_videos_video_id ON processed_videos(video_id);
CREATE INDEX IF NOT EXISTS idx_processed_videos_status ON processed_videos(status);
CREATE INDEX IF NOT EXISTS idx_auto_clone_runs_date ON auto_clone_runs(run_date);

-- RLS policies (allow service role full access)
ALTER TABLE processed_videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE auto_clone_runs ENABLE ROW LEVEL SECURITY;

-- Service role can do everything
CREATE POLICY "Service role full access to processed_videos" ON processed_videos
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access to auto_clone_runs" ON auto_clone_runs
  FOR ALL USING (true) WITH CHECK (true);
