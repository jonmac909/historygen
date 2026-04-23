-- Add current_step column to track pipeline progress
ALTER TABLE auto_clone_runs ADD COLUMN IF NOT EXISTS current_step TEXT;
ALTER TABLE auto_clone_runs ADD COLUMN IF NOT EXISTS current_step_progress INT DEFAULT 0;
