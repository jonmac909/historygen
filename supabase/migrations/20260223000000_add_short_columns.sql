-- Add columns for YouTube Shorts generation
ALTER TABLE generation_projects ADD COLUMN IF NOT EXISTS short_url TEXT;
ALTER TABLE generation_projects ADD COLUMN IF NOT EXISTS short_script TEXT;
ALTER TABLE generation_projects ADD COLUMN IF NOT EXISTS short_audio_url TEXT;
ALTER TABLE generation_projects ADD COLUMN IF NOT EXISTS short_srt_content TEXT;
ALTER TABLE generation_projects ADD COLUMN IF NOT EXISTS short_vertical_images JSONB DEFAULT '[]'::jsonb;
ALTER TABLE generation_projects ADD COLUMN IF NOT EXISTS short_hook_style TEXT;

-- Add comment for documentation
COMMENT ON COLUMN generation_projects.short_url IS 'URL of the rendered YouTube Short video';
COMMENT ON COLUMN generation_projects.short_script IS 'Script content for the Short (with hook + subscribe CTA)';
COMMENT ON COLUMN generation_projects.short_audio_url IS 'TTS audio URL for the Short';
COMMENT ON COLUMN generation_projects.short_srt_content IS 'SRT captions content for the Short';
COMMENT ON COLUMN generation_projects.short_vertical_images IS 'Array of vertical (9:16) image URLs for the Short';
COMMENT ON COLUMN generation_projects.short_hook_style IS 'Hook style used: story, didyouknow, question, or contrast';
