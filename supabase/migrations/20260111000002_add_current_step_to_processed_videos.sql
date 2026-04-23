-- Add current_step column to track pipeline progress for individual videos
ALTER TABLE processed_videos ADD COLUMN IF NOT EXISTS current_step TEXT;
