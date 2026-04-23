-- Fix storage RLS policies for generated-assets bucket

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Public read access for generated assets" ON storage.objects;
DROP POLICY IF EXISTS "Allow all uploads to generated assets" ON storage.objects;
DROP POLICY IF EXISTS "Allow updates to generated assets" ON storage.objects;
DROP POLICY IF EXISTS "Allow deletes to generated assets" ON storage.objects;

-- Recreate policies with proper permissions
CREATE POLICY "Public read access for generated assets"
ON storage.objects FOR SELECT
USING (bucket_id = 'generated-assets');

CREATE POLICY "Allow all uploads to generated assets"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'generated-assets');

CREATE POLICY "Allow updates to generated assets"
ON storage.objects FOR UPDATE
USING (bucket_id = 'generated-assets')
WITH CHECK (bucket_id = 'generated-assets');

CREATE POLICY "Allow deletes to generated assets"
ON storage.objects FOR DELETE
USING (bucket_id = 'generated-assets');
