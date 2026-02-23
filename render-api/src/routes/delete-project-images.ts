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
    console.log(`[DeleteProjectImages] Listing files in generated-assets/${projectId}/`);

    // List all files in the project folder
    const { data: files, error: listError } = await supabase.storage
      .from('generated-assets')
      .list(projectId, { limit: 1000 });

    if (listError) {
      console.error('[DeleteProjectImages] List error:', listError);
      return res.status(500).json({ error: `Failed to list files: ${listError.message}` });
    }

    if (!files || files.length === 0) {
      console.log(`[DeleteProjectImages] No files found for project ${projectId}`);
      return res.json({ success: true, deleted: 0, message: 'No files to delete' });
    }

    console.log(`[DeleteProjectImages] Found ${files.length} files to delete`);

    // Build array of file paths to delete
    const filePaths = files.map(file => `${projectId}/${file.name}`);

    // Delete all files
    const { data: deleteData, error: deleteError } = await supabase.storage
      .from('generated-assets')
      .remove(filePaths);

    if (deleteError) {
      console.error('[DeleteProjectImages] Delete error:', deleteError);
      return res.status(500).json({ error: `Failed to delete files: ${deleteError.message}` });
    }

    console.log(`[DeleteProjectImages] Successfully deleted ${filePaths.length} files`);

    return res.json({
      success: true,
      deleted: filePaths.length,
      message: `Deleted ${filePaths.length} images from storage`
    });

  } catch (error) {
    console.error('[DeleteProjectImages] Error:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
