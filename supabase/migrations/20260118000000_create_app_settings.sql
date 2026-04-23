-- Create app_settings table for storing application configuration
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
CREATE POLICY "Service role has full access to app_settings"
  ON app_settings
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Insert default value for auto poster cron (enabled by default)
INSERT INTO app_settings (key, value) VALUES ('auto_poster_cron_enabled', 'true')
ON CONFLICT (key) DO NOTHING;
