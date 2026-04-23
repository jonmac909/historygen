-- Create project_costs table for tracking generation costs per step
CREATE TABLE IF NOT EXISTS project_costs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  video_id TEXT,
  source TEXT NOT NULL DEFAULT 'manual', -- 'manual' or 'auto_poster'
  step TEXT NOT NULL, -- 'script', 'audio', 'captions', 'image_prompts', 'images', 'clip_prompts', 'video_clips', 'render', 'thumbnail'
  service TEXT NOT NULL, -- 'claude', 'fish_speech', 'z_image', 'seedance', 'whisper', 'runpod_cpu'
  units NUMERIC NOT NULL,
  unit_type TEXT NOT NULL, -- 'input_tokens', 'output_tokens', 'minutes', 'images', 'seconds'
  unit_cost NUMERIC NOT NULL,
  total_cost NUMERIC NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_project_costs_project_id ON project_costs(project_id);
CREATE INDEX IF NOT EXISTS idx_project_costs_step ON project_costs(step);

-- Enable RLS (Row Level Security) but allow all for now (API uses service role)
ALTER TABLE project_costs ENABLE ROW LEVEL SECURITY;

-- Policy to allow service role full access
CREATE POLICY "Allow service role full access" ON project_costs
  FOR ALL
  USING (true)
  WITH CHECK (true);
