-- VideoRAG: Video Analysis Tables
-- Stores analysis results for competitive video intelligence

-- Enable pgvector extension for embedding similarity search
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================
-- Analyzed Videos (main metadata table)
-- ============================================
CREATE TABLE IF NOT EXISTS analyzed_videos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id TEXT UNIQUE NOT NULL,           -- YouTube video ID (e.g., 'dQw4w9WgXcQ')
  video_url TEXT NOT NULL,                 -- Full YouTube URL
  channel_id TEXT,                         -- YouTube channel ID
  channel_name TEXT,                       -- Channel display name
  title TEXT,                              -- Video title
  duration_seconds INTEGER,                -- Video duration
  view_count BIGINT,                       -- Views at time of analysis
  published_at TIMESTAMPTZ,                -- Video publish date

  -- Analysis status
  status TEXT DEFAULT 'pending',           -- pending, downloading, extracting, analyzing, complete, failed
  progress NUMERIC DEFAULT 0,              -- 0-100 progress percentage
  source_video_url TEXT,                   -- Supabase storage URL for downloaded video
  error_message TEXT,                      -- Error details if failed

  -- Analysis results (JSON for flexibility)
  visual_analysis JSONB,                   -- Color palettes, composition, etc.
  audio_analysis JSONB,                    -- Energy, pace, music detection
  pacing_analysis JSONB,                   -- Scene durations, cuts, transitions

  -- Computed insights (indexed for queries)
  avg_scene_duration NUMERIC,              -- Average scene length in seconds
  hook_duration NUMERIC,                   -- First X seconds before main content
  cuts_per_minute NUMERIC,                 -- Scene transitions per minute
  voice_music_ratio NUMERIC,               -- Voice vs music balance (0-1)
  dominant_colors TEXT[],                  -- Top 5 hex colors
  transition_types TEXT[],                 -- Common transition types

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  analyzed_at TIMESTAMPTZ,                 -- When analysis completed
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_analyzed_videos_video_id ON analyzed_videos(video_id);
CREATE INDEX IF NOT EXISTS idx_analyzed_videos_channel_id ON analyzed_videos(channel_id);
CREATE INDEX IF NOT EXISTS idx_analyzed_videos_status ON analyzed_videos(status);
CREATE INDEX IF NOT EXISTS idx_analyzed_videos_view_count ON analyzed_videos(view_count DESC);

-- ============================================
-- Analyzed Scenes (per-scene granular data)
-- ============================================
CREATE TABLE IF NOT EXISTS analyzed_scenes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id TEXT NOT NULL REFERENCES analyzed_videos(video_id) ON DELETE CASCADE,
  scene_index INTEGER NOT NULL,            -- 0-indexed scene number
  start_seconds NUMERIC NOT NULL,          -- Scene start time
  end_seconds NUMERIC NOT NULL,            -- Scene end time

  -- Visual features
  dominant_color TEXT,                     -- Hex color for this scene
  brightness NUMERIC,                      -- 0-1 brightness level
  has_text_overlay BOOLEAN DEFAULT FALSE,  -- Detected text on screen
  transition_type TEXT,                    -- How scene ends: cut, fade, dissolve, zoom
  frame_url TEXT,                          -- Supabase URL to representative frame

  -- Audio features
  has_music BOOLEAN DEFAULT FALSE,         -- Music detected in scene
  has_voice BOOLEAN DEFAULT FALSE,         -- Voice/narration detected
  energy_level NUMERIC,                    -- 0-1 audio energy

  -- ImageBind visual embedding (768 dimensions)
  visual_embedding vector(768),            -- For similarity search

  -- Constraints
  UNIQUE(video_id, scene_index)
);

-- Indexes for scene queries
CREATE INDEX IF NOT EXISTS idx_analyzed_scenes_video_id ON analyzed_scenes(video_id);

-- pgvector index for similarity search (IVFFlat for speed)
CREATE INDEX IF NOT EXISTS idx_analyzed_scenes_embedding
  ON analyzed_scenes USING ivfflat (visual_embedding vector_cosine_ops)
  WITH (lists = 100);

-- ============================================
-- Video Style Profiles (extracted patterns)
-- ============================================
CREATE TABLE IF NOT EXISTS video_style_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id TEXT UNIQUE NOT NULL REFERENCES analyzed_videos(video_id) ON DELETE CASCADE,

  -- Script/narrative style
  words_per_minute NUMERIC,                -- Speaking pace
  hook_duration_seconds NUMERIC,           -- Seconds before main content
  tone TEXT,                               -- 'calm', 'engaging', 'dramatic'
  narrative_pattern TEXT,                  -- 'chronological', 'mystery', 'compare'

  -- Audio style
  energy_level NUMERIC,                    -- 0-1 average energy
  emotion_marker TEXT,                     -- TTS emotion like "(dramatic) (intense)"
  speaking_speed NUMERIC,                  -- Multiplier (1.0 = normal)

  -- Visual style
  dominant_colors TEXT[],                  -- Hex color palette
  composition_style TEXT,                  -- 'wide shots', 'close-ups', 'mixed'
  visual_elements TEXT[],                  -- ['maps', 'artifacts', 'faces']
  lighting_style TEXT,                     -- 'dramatic', 'soft', 'natural'

  -- Pacing style
  avg_scene_duration NUMERIC,              -- Seconds per scene
  cuts_per_minute NUMERIC,                 -- Transition frequency
  transition_types TEXT[],                 -- ['cut', 'fade', 'zoom']

  -- Overlay/effects style
  has_smoke_overlay BOOLEAN DEFAULT FALSE,
  has_film_grain BOOLEAN DEFAULT FALSE,
  color_grade TEXT,                        -- 'warm_sepia', 'cool_blue', 'neutral'
  vignette_level NUMERIC,                  -- 0-1

  -- Thumbnail style
  thumbnail_has_text BOOLEAN,
  thumbnail_has_face BOOLEAN,
  thumbnail_text_style TEXT,               -- 'bold yellow', 'white outline'
  thumbnail_composition TEXT,              -- 'face left, text right'

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for style profile lookup
CREATE INDEX IF NOT EXISTS idx_video_style_profiles_video_id ON video_style_profiles(video_id);

-- ============================================
-- Success Profiles (aggregated patterns)
-- ============================================
CREATE TABLE IF NOT EXISTS success_profiles (
  id TEXT PRIMARY KEY DEFAULT 'global',    -- 'global' or channel_id
  channel_id TEXT,                         -- NULL for global, channel_id for per-channel

  -- Aggregated profile (JSONB for flexibility)
  profile JSONB NOT NULL,                  -- Full SuccessProfile object

  -- Metadata
  video_count INTEGER NOT NULL DEFAULT 0,  -- Number of videos that contributed
  confidence_score NUMERIC,                -- Overall confidence (0-1)

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for per-channel lookup
CREATE INDEX IF NOT EXISTS idx_success_profiles_channel_id ON success_profiles(channel_id);

-- ============================================
-- RLS Policies (allow service role full access)
-- ============================================
ALTER TABLE analyzed_videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE analyzed_scenes ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_style_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE success_profiles ENABLE ROW LEVEL SECURITY;

-- Service role policies
CREATE POLICY "Service role full access to analyzed_videos" ON analyzed_videos
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access to analyzed_scenes" ON analyzed_scenes
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access to video_style_profiles" ON video_style_profiles
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access to success_profiles" ON success_profiles
  FOR ALL USING (true) WITH CHECK (true);

-- ============================================
-- Helper function: Find similar scenes
-- ============================================
CREATE OR REPLACE FUNCTION find_similar_scenes(
  query_embedding vector(768),
  match_count INT DEFAULT 10,
  similarity_threshold FLOAT DEFAULT 0.7
)
RETURNS TABLE (
  scene_id UUID,
  video_id TEXT,
  scene_index INT,
  similarity FLOAT,
  frame_url TEXT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.id AS scene_id,
    s.video_id,
    s.scene_index::INT,
    (1 - (s.visual_embedding <=> query_embedding))::FLOAT AS similarity,
    s.frame_url
  FROM analyzed_scenes s
  WHERE s.visual_embedding IS NOT NULL
    AND (1 - (s.visual_embedding <=> query_embedding)) >= similarity_threshold
  ORDER BY s.visual_embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
