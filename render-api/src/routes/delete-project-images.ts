import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';

const router = Router();

// DELETE /delete-project-images/:projectId
// Deletes all images from Supabase storage for a project
router.delete('/:projectId', async (req: Request, res: Response) => {
  const { projectId } = req.params;

  if (!projectId) {
    return res.status(400).json({ error: 'Project ID is required' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Supabase configuration missing' });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    console.log(`[DeleteProjectImages] Listing files in generated-assets/${projectId}/images/`);

    // List all files in the project's images folder (where images are actually stored)
    const { data: files, error: listError } = await supabase.storage
      .from('generated-assets')
      .list(`${projectId}/images`, { limit: 1000 });

    if (listError) {
      console.error('[DeleteProjectImages] List error:', listError);
      return res.status(500).json({ error: `Failed to list files: ${listError.message}` });
    }

    if (!files || files.length === 0) {
      console.log(`[DeleteProjectImages] No files found for project ${projectId}`);
      return res.json({ success: true, deleted: 0, message: 'No files to delete' });
    }

    // Filter to only image files (not folders)
    const imageFiles = files.filter(file => file.name && !file.name.endsWith('/'));
    console.log(`[DeleteProjectImages] Found ${imageFiles.length} image files to delete`);

    if (imageFiles.length === 0) {
      return res.json({ success: true, deleted: 0, message: 'No image files to delete' });
    }

    // Build array of file paths to delete (images are in projectId/images/)
    const filePaths = imageFiles.map(file => `${projectId}/images/${file.name}`);

    // Delete all files
    const { data: deleteData, error: deleteError } = await supabase.storage
      .from('generated-assets')
      .remove(filePaths);

    if (deleteError) {
      console.error('[DeleteProjectImages] Delete error:', deleteError);
      return res.status(500).json({ error: `Failed to delete files: ${deleteError.message}` });
    }

    console.log(`[DeleteProjectImages] Successfully deleted ${imageFiles.length} images`);

    return res.json({
      success: true,
      deleted: imageFiles.length,
      message: `Deleted ${imageFiles.length} images from storage`
    });

  } catch (error) {
    console.error('[DeleteProjectImages] Error:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
