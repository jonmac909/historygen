-- Create storage bucket for generated assets
INSERT INTO storage.buckets (id, name, public)
VALUES ('generated-assets', 'generated-assets', true);

-- Allow public read access to generated assets
CREATE POLICY "Public read access for generated assets"
ON storage.objects FOR SELECT
USING (bucket_id = 'generated-assets');

-- Allow authenticated and anonymous users to upload (since we don't have auth)
CREATE POLICY "Allow all uploads to generated assets"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'generated-assets');

-- Allow updates
CREATE POLICY "Allow updates to generated assets"
ON storage.objects FOR UPDATE
USING (bucket_id = 'generated-assets');

-- Create a table to track generation projects
CREATE TABLE public.generation_projects (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  source_url TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'youtube',
  status TEXT NOT NULL DEFAULT 'pending',
  script_content TEXT,
  audio_url TEXT,
  captions_url TEXT,
  images JSONB DEFAULT '[]'::jsonb,
  settings JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS but allow public access for now (no auth)
ALTER TABLE public.generation_projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read access"
ON public.generation_projects FOR SELECT
USING (true);

CREATE POLICY "Allow public insert"
ON public.generation_projects FOR INSERT
WITH CHECK (true);

CREATE POLICY "Allow public update"
ON public.generation_projects FOR UPDATE
USING (true);