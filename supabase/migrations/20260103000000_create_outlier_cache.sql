-- Cache tables for TubeLab/YouTube API responses
-- Reduces API costs by storing and reusing channel/outlier data

-- Cached channels from niche searches and channel analyses
CREATE TABLE IF NOT EXISTS cached_channels (
  id TEXT PRIMARY KEY,  -- YouTube channel ID (e.g., UC...)
  title TEXT NOT NULL,
  handle TEXT,
  thumbnail_url TEXT,
  subscriber_count BIGINT DEFAULT 0,
  view_count BIGINT DEFAULT 0,
  video_count INT DEFAULT 0,
  views_to_subs_ratio NUMERIC(10, 2) DEFAULT 0,
  avg_views BIGINT DEFAULT 0,
  is_breakout BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ,  -- Channel creation date from YouTube
  monetization JSONB,  -- { adsense, rpmEstimationFrom, rpmEstimationTo }
  source TEXT DEFAULT 'tubelab',  -- 'tubelab' or 'youtube'
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days')
);

-- Index for expiration queries
CREATE INDEX IF NOT EXISTS idx_cached_channels_expires_at ON cached_channels(expires_at);

-- Cached outlier videos
CREATE TABLE IF NOT EXISTS cached_outliers (
  video_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  title TEXT NOT NULL,
  thumbnail_url TEXT,
  published_at TIMESTAMPTZ,
  duration_seconds INT DEFAULT 0,
  view_count BIGINT DEFAULT 0,
  like_count BIGINT DEFAULT 0,
  comment_count BIGINT DEFAULT 0,
  outlier_multiplier NUMERIC(10, 2) DEFAULT 0,
  z_score NUMERIC(10, 2) DEFAULT 0,
  views_per_subscriber NUMERIC(10, 2) DEFAULT 0,
  is_positive_outlier BOOLEAN DEFAULT FALSE,
  is_negative_outlier BOOLEAN DEFAULT FALSE,
  monetization JSONB,  -- { rpmEstimationFrom, rpmEstimationTo, revenueEstimationFrom, revenueEstimationTo }
  classification JSONB,  -- { isFaceless, quality }
  source TEXT DEFAULT 'tubelab',
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days')
);

-- Indexes for outlier queries
CREATE INDEX IF NOT EXISTS idx_cached_outliers_channel_id ON cached_outliers(channel_id);
CREATE INDEX IF NOT EXISTS idx_cached_outliers_expires_at ON cached_outliers(expires_at);
CREATE INDEX IF NOT EXISTS idx_cached_outliers_outlier_multiplier ON cached_outliers(outlier_multiplier DESC);

-- Cached niche search results (topic -> channel IDs mapping)
CREATE TABLE IF NOT EXISTS cached_niche_searches (
  topic TEXT PRIMARY KEY,
  channel_ids TEXT[] NOT NULL,
  metrics JSONB NOT NULL,  -- { channelCount, avgSubscribers, avgViewsPerVideo, avgViewsToSubsRatio, saturationLevel, saturationScore }
  total_in_database INT DEFAULT 0,
  source TEXT DEFAULT 'tubelab',
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '3 days')  -- Shorter TTL for search results
);

-- Index for expiration
CREATE INDEX IF NOT EXISTS idx_cached_niche_searches_expires_at ON cached_niche_searches(expires_at);

-- Function to clean up expired cache entries (can be called via cron)
CREATE OR REPLACE FUNCTION cleanup_expired_cache()
RETURNS void AS $$
BEGIN
  DELETE FROM cached_channels WHERE expires_at < NOW();
  DELETE FROM cached_outliers WHERE expires_at < NOW();
  DELETE FROM cached_niche_searches WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- RLS policies (service role can read/write, anon cannot)
ALTER TABLE cached_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE cached_outliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE cached_niche_searches ENABLE ROW LEVEL SECURITY;

-- Service role policies
CREATE POLICY "Service role can manage cached_channels"
  ON cached_channels FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role can manage cached_outliers"
  ON cached_outliers FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role can manage cached_niche_searches"
  ON cached_niche_searches FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
