-- Factory Pipeline: batch orchestration table + project tagging

CREATE TABLE factory_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending',
  current_batch INT DEFAULT 0,
  current_step TEXT,
  current_project_index INT DEFAULT 0,
  project_ids UUID[] NOT NULL,
  project_statuses JSONB DEFAULT '{}',
  step_statuses JSONB DEFAULT '{}',
  settings JSONB DEFAULT '{}',
  project_settings_overrides JSONB DEFAULT '{}',
  total_projects INT NOT NULL
);

ALTER TABLE factory_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access" ON factory_batches FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE generation_projects ADD COLUMN factory_batch_id UUID REFERENCES factory_batches(id);
CREATE INDEX idx_gen_projects_factory_batch ON generation_projects(factory_batch_id) WHERE factory_batch_id IS NOT NULL;
