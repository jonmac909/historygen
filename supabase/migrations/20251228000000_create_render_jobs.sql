-- Create render_jobs table for background video rendering
CREATE TABLE IF NOT EXISTS render_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  progress INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  video_url TEXT,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for looking up jobs by project
CREATE INDEX IF NOT EXISTS idx_render_jobs_project ON render_jobs(project_id);

-- Index for finding recent/active jobs
CREATE INDEX IF NOT EXISTS idx_render_jobs_status ON render_jobs(status, created_at DESC);

-- Enable RLS but allow service role full access
ALTER TABLE render_jobs ENABLE ROW LEVEL SECURITY;

-- Policy for service role (Railway API uses service role key)
CREATE POLICY "Service role has full access to render_jobs" ON render_jobs
  FOR ALL
  USING (true)
  WITH CHECK (true);
