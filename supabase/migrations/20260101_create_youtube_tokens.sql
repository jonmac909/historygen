-- Create youtube_tokens table for storing OAuth refresh tokens
-- This table uses a fixed UUID to ensure only one row exists (single-tenant app)

CREATE TABLE IF NOT EXISTS public.youtube_tokens (
    id UUID PRIMARY KEY DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
    refresh_token TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS but allow service role full access
ALTER TABLE public.youtube_tokens ENABLE ROW LEVEL SECURITY;

-- Service role bypass policy (for backend API access)
CREATE POLICY "Service role full access" ON public.youtube_tokens
    FOR ALL USING (true) WITH CHECK (true);

-- Add comment for documentation
COMMENT ON TABLE public.youtube_tokens IS 'Stores YouTube OAuth refresh tokens for the application';
