-- Create a public bucket for voice samples
INSERT INTO storage.buckets (id, name, public)
VALUES ('voice-samples', 'voice-samples', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- Allow public read access to voice samples
CREATE POLICY "Public read access for voice samples"
ON storage.objects FOR SELECT
USING (bucket_id = 'voice-samples');

-- Allow anyone to upload voice samples (for now, can restrict later)
CREATE POLICY "Allow uploads to voice samples"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'voice-samples');