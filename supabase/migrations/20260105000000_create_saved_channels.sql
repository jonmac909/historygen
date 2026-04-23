-- Saved channels for Outliers feature
-- Persists across all browsers/computers (app-wide, no auth required)

CREATE TABLE IF NOT EXISTS saved_channels (
  id TEXT PRIMARY KEY,  -- YouTube channel ID
  title TEXT NOT NULL,
  thumbnail_url TEXT,
  subscriber_count_formatted TEXT,
  average_views BIGINT DEFAULT 0,
  average_views_formatted TEXT,
  input TEXT NOT NULL,  -- Original input used to find channel (@handle or URL)
  saved_at TIMESTAMPTZ DEFAULT NOW(),
  sort_order INT DEFAULT 0  -- For manual ordering
);

-- Index for sort order
CREATE INDEX IF NOT EXISTS idx_saved_channels_sort_order ON saved_channels(sort_order);

-- RLS - allow public read/write (no auth in this app)
ALTER TABLE saved_channels ENABLE ROW LEVEL SECURITY;

-- Allow anonymous users to read saved channels
CREATE POLICY "Anyone can read saved_channels"
  ON saved_channels FOR SELECT
  TO anon, authenticated
  USING (true);

-- Allow anonymous users to insert saved channels
CREATE POLICY "Anyone can insert saved_channels"
  ON saved_channels FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

-- Allow anonymous users to update saved channels
CREATE POLICY "Anyone can update saved_channels"
  ON saved_channels FOR UPDATE
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- Allow anonymous users to delete saved channels
CREATE POLICY "Anyone can delete saved_channels"
  ON saved_channels FOR DELETE
  TO anon, authenticated
  USING (true);

-- NOTE: No pre-populated data - channels are saved when users analyze them
-- Pre-populating with placeholder IDs causes duplicates when real YouTube IDs are fetched
