-- Video Editor Tables Migration
-- Creates tables for editing templates, projects, and video analysis

-- Editing Templates Table
CREATE TABLE IF NOT EXISTS editing_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  source TEXT, -- Example video URL that template was learned from
  
  -- Template configuration (stored as JSONB for flexibility)
  text_styles JSONB NOT NULL DEFAULT '[]'::jsonb,
  transitions JSONB NOT NULL DEFAULT '{}'::jsonb,
  broll_patterns JSONB NOT NULL DEFAULT '{}'::jsonb,
  pacing JSONB NOT NULL DEFAULT '{}'::jsonb,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Editor Projects Table
CREATE TABLE IF NOT EXISTS editor_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  raw_video_url TEXT NOT NULL,
  template_id UUID REFERENCES editing_templates(id) ON DELETE SET NULL,
  
  -- Video analysis results
  analysis JSONB,
  
  -- Edit decisions (array of EditDecision objects)
  edit_decisions JSONB NOT NULL DEFAULT '[]'::jsonb,
  
  -- Rendered output
  rendered_video_url TEXT,
  render_status TEXT DEFAULT 'pending', -- 'pending', 'rendering', 'complete', 'failed'
  render_progress INTEGER DEFAULT 0,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Video Analysis Cache Table (for analyzed example videos)
CREATE TABLE IF NOT EXISTS video_editor_analysis_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_url TEXT NOT NULL UNIQUE,
  duration REAL NOT NULL,
  
  -- Analysis results
  scenes JSONB NOT NULL DEFAULT '[]'::jsonb,
  transcript JSONB NOT NULL DEFAULT '[]'::jsonb,
  key_moments JSONB NOT NULL DEFAULT '[]'::jsonb,
  audio_beats JSONB NOT NULL DEFAULT '[]'::jsonb,
  
  -- Style extraction
  detected_fonts JSONB DEFAULT '[]'::jsonb,
  color_palette JSONB DEFAULT '[]'::jsonb,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days') -- Cache for 7 days
);

-- Render Jobs Table (for video editor renders)
CREATE TABLE IF NOT EXISTS editor_render_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES editor_projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued', -- 'queued', 'bundling', 'rendering', 'uploading', 'complete', 'failed'
  progress INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  error TEXT,
  video_url TEXT,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_editor_projects_template_id ON editor_projects(template_id);
CREATE INDEX IF NOT EXISTS idx_editor_projects_created_at ON editor_projects(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_editor_render_jobs_project_id ON editor_render_jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_editor_render_jobs_status ON editor_render_jobs(status);
CREATE INDEX IF NOT EXISTS idx_video_editor_analysis_cache_video_url ON video_editor_analysis_cache(video_url);
CREATE INDEX IF NOT EXISTS idx_video_editor_analysis_cache_expires_at ON video_editor_analysis_cache(expires_at);

-- Enable Row Level Security (RLS)
ALTER TABLE editing_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE editor_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_editor_analysis_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE editor_render_jobs ENABLE ROW LEVEL SECURITY;

-- RLS Policies (allow all for now - adjust based on auth requirements)
CREATE POLICY "Allow all operations on editing_templates" ON editing_templates
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all operations on editor_projects" ON editor_projects
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all operations on video_editor_analysis_cache" ON video_editor_analysis_cache
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all operations on editor_render_jobs" ON editor_render_jobs
  FOR ALL USING (true) WITH CHECK (true);

-- Function to auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
CREATE TRIGGER update_editing_templates_updated_at
  BEFORE UPDATE ON editing_templates
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_editor_projects_updated_at
  BEFORE UPDATE ON editor_projects
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_editor_render_jobs_updated_at
  BEFORE UPDATE ON editor_render_jobs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Create storage bucket for editor assets (if not exists)
INSERT INTO storage.buckets (id, name, public)
VALUES ('video-editor-assets', 'video-editor-assets', true)
ON CONFLICT (id) DO NOTHING;

-- Storage bucket policy
CREATE POLICY "Allow public read access on video-editor-assets"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'video-editor-assets');

CREATE POLICY "Allow authenticated uploads to video-editor-assets"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'video-editor-assets');
