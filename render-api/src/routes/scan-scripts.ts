/**
 * Scan Scripts - Batch scan existing scripts for YouTube policy violations
 */

import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { moderateScript, sanitizeScript, ScriptModerationResult, ScriptContentIssue } from '../lib/content-moderator';

const router = Router();

interface ProjectWithScript {
  id: string;
  video_title: string;
  script_content: string | null;
  status: string;
}

interface ScanResult {
  projectId: string;
  title: string;
  safe: boolean;
  issues: ScriptContentIssue[];
  summary: string;
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Supabase credentials not configured');
  }
  return createClient(url, key);
}

/**
 * POST /scan-scripts
 * Scan all scripts (or specific project) for YouTube policy violations
 *
 * Body:
 *   - projectId?: string - Scan specific project (optional)
 *   - limit?: number - Max projects to scan (default 50)
 *   - autoFix?: boolean - Auto-sanitize low/medium severity issues
 */
router.post('/', async (req: Request, res: Response) => {
  const { projectId, limit = 50, autoFix = false } = req.body;

  console.log(`[scan-scripts] Starting scan, projectId=${projectId || 'all'}, limit=${limit}, autoFix=${autoFix}`);

  const supabase = getSupabase();
  const results: ScanResult[] = [];
  const flaggedProjects: ScanResult[] = [];

  try {
    // Fetch projects with scripts
    let query = supabase
      .from('generation_projects')
      .select('id, video_title, script_content, status')
      .not('script_content', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(limit);

    if (projectId) {
      query = query.eq('id', projectId);
    }

    const { data: projects, error } = await query;

    if (error) {
      console.error('[scan-scripts] Database error:', error);
      return res.status(500).json({ error: 'Failed to fetch projects' });
    }

    if (!projects || projects.length === 0) {
      return res.json({
        success: true,
        message: 'No projects with scripts found',
        scanned: 0,
        flagged: 0,
        results: []
      });
    }

    console.log(`[scan-scripts] Found ${projects.length} projects with scripts`);

    // Scan each script
    for (const project of projects as ProjectWithScript[]) {
      if (!project.script_content) continue;

      console.log(`[scan-scripts] Scanning: ${project.video_title || project.id}`);

      const modResult = await moderateScript(project.script_content);

      const scanResult: ScanResult = {
        projectId: project.id,
        title: project.video_title || 'Untitled',
        safe: modResult.safe,
        issues: modResult.issues,
        summary: modResult.summary
      };

      results.push(scanResult);

      if (!modResult.safe) {
        flaggedProjects.push(scanResult);
        console.log(`[scan-scripts] ⚠️ FLAGGED: ${project.video_title}`);
        console.log(`[scan-scripts]   Issues: ${modResult.issues.map(i => `${i.category}(${i.severity})`).join(', ')}`);

        // Auto-fix if requested and issues are fixable
        if (autoFix && modResult.issues.some(i => i.severity !== 'high')) {
          console.log(`[scan-scripts] Auto-fixing: ${project.video_title}`);
          const { sanitized, changes } = await sanitizeScript(project.script_content, modResult.issues);

          if (changes.length > 0) {
            // Save sanitized script back to database
            const { error: updateError } = await supabase
              .from('generation_projects')
              .update({ script_content: sanitized })
              .eq('id', project.id);

            if (updateError) {
              console.error(`[scan-scripts] Failed to save sanitized script: ${updateError.message}`);
            } else {
              console.log(`[scan-scripts] ✅ Saved sanitized script for: ${project.video_title}`);
              scanResult.summary += ` [AUTO-FIXED: ${changes.length} issues]`;
            }
          }
        }
      }

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 500));
    }

    console.log(`[scan-scripts] Scan complete: ${results.length} scanned, ${flaggedProjects.length} flagged`);

    return res.json({
      success: true,
      scanned: results.length,
      flagged: flaggedProjects.length,
      flaggedProjects: flaggedProjects,
      allResults: results
    });

  } catch (error) {
    console.error('[scan-scripts] Error:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /scan-scripts/single/:projectId
 * Quick scan of a single project's script
 */
router.get('/single/:projectId', async (req: Request, res: Response) => {
  const { projectId } = req.params;

  if (!projectId) {
    return res.status(400).json({ error: 'Project ID required' });
  }

  const supabase = getSupabase();

  try {
    const { data: project, error } = await supabase
      .from('generation_projects')
      .select('id, video_title, script_content')
      .eq('id', projectId)
      .single();

    if (error || !project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!project.script_content) {
      return res.json({
        projectId,
        title: project.video_title,
        safe: true,
        issues: [],
        summary: 'No script content'
      });
    }

    const result = await moderateScript(project.script_content);

    return res.json({
      projectId,
      title: project.video_title,
      safe: result.safe,
      issues: result.issues,
      summary: result.summary
    });

  } catch (error) {
    console.error('[scan-scripts] Error:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
