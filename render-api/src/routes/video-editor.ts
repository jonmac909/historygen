/**
 * Video Editor API Routes
 * Handles template learning, video analysis, and automated editing
 */
import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';

const router = Router();

function setupSse(res: Response): NodeJS.Timeout {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const heartbeat = setInterval(() => {
    res.write(':\n\n');
  }, 15000);

  res.on('close', () => {
    clearInterval(heartbeat);
  });

  return heartbeat;
}

// Get Supabase client
function getSupabase() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing Supabase configuration');
  }
  return createClient(supabaseUrl, supabaseKey);
}

// GET /video-editor/templates - List all editing templates
router.get('/templates', async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('editing_templates')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ templates: data || [] });
  } catch (error: any) {
    console.error('Failed to fetch templates:', error);
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
});

// POST /video-editor/templates - Create a new template
router.post('/templates', async (req: Request, res: Response) => {
  try {
    const { name, description, source, textStyles, transitions, brollPatterns, pacing } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Template name is required' });
    }

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('editing_templates')
      .insert({
        name,
        description,
        source,
        text_styles: textStyles || [],
        transitions: transitions || {},
        broll_patterns: brollPatterns || {},
        pacing: pacing || {},
      })
      .select()
      .single();

    if (error) throw error;

    res.json({ template: data });
  } catch (error: any) {
    console.error('Failed to create template:', error);
    res.status(500).json({ error: 'Failed to create template' });
  }
});

// POST /video-editor/analyze-example - Analyze example video to extract template
router.post('/analyze-example', async (req: Request, res: Response) => {
  let heartbeat: NodeJS.Timeout | null = null;
  try {
    const { videoUrl, templateName } = req.body;

    if (!videoUrl || !templateName) {
      return res.status(400).json({ error: 'Video URL and template name are required' });
    }

    heartbeat = setupSse(res);

    // Import template extractor
    const { extractTemplate } = await import('../lib/template-extractor');

    // Extract template with progress updates
    const extractionResult = await extractTemplate(videoUrl, templateName, (progress, message) => {
      res.write(`event: progress\ndata: ${JSON.stringify({ progress, message })}\n\n`);
    });
    const { templateId } = extractionResult;

    // Fetch the created template
    const supabase = getSupabase();
    const { data: template, error } = await supabase
      .from('editing_templates')
      .select('*')
      .eq('id', templateId)
      .single();

    if (error) throw error;

    res.write(`event: complete\ndata: ${JSON.stringify({ template })}\n\n`);
    res.end();
  } catch (error: any) {
    console.error('Failed to analyze example:', error);
    res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
  }
});

// POST /video-editor/analyze-raw - Analyze raw video for editing
router.post('/analyze-raw', async (req: Request, res: Response) => {
  let heartbeat: NodeJS.Timeout | null = null;
  try {
    const { videoUrl, projectName, templateId } = req.body;

    if (!videoUrl || !projectName) {
      return res.status(400).json({ error: 'Video URL and project name are required' });
    }

    heartbeat = setupSse(res);

    const supabase = getSupabase();

    // Step 1: Download video and analyze (0-40%)
    res.write(`event: progress\ndata: ${JSON.stringify({ progress: 0, message: 'Downloading video...' })}\n\n`);
    const { analyzeRawVideo } = await import('../lib/video-analyzer');
    const analysis = await analyzeRawVideo(videoUrl, (progress, message) => {
      res.write(`event: progress\ndata: ${JSON.stringify({ progress: progress * 0.4, message })}\n\n`);
    });

    // Step 2: Get template (40-45%)
    res.write(`event: progress\ndata: ${JSON.stringify({ progress: 40, message: 'Loading template...' })}\n\n`);
    const { data: template, error: templateError } = await supabase
      .from('editing_templates')
      .select('*')
      .eq('id', templateId)
      .single();

    if (templateError) throw new Error('Template not found');

    // Step 3: Generate edit decisions with Claude (45-90%)
    res.write(`event: progress\ndata: ${JSON.stringify({ progress: 45, message: 'Generating edit decisions with AI...' })}\n\n`);
    const { generateEditDecisions } = await import('../lib/edit-decision-engine');
    const editDecisions = await generateEditDecisions(analysis, template, 30);
    res.write(`event: progress\ndata: ${JSON.stringify({ progress: 90, message: 'Edit decisions generated' })}\n\n`);

    // Step 4: Save project (90-100%)
    res.write(`event: progress\ndata: ${JSON.stringify({ progress: 90, message: 'Saving project...' })}\n\n`);
    const { data: project, error } = await supabase
      .from('editor_projects')
      .insert({
        name: projectName,
        raw_video_url: videoUrl,
        template_id: templateId,
        analysis,
        edit_decisions: editDecisions,
      })
      .select()
      .single();

    if (error) throw error;

    res.write(`event: progress\ndata: ${JSON.stringify({ progress: 100, message: 'Project created!' })}\n\n`);
    res.write(`event: complete\ndata: ${JSON.stringify({ project })}\n\n`);
    res.end();
  } catch (error: any) {
    console.error('Failed to analyze raw video:', error);
    res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
  }
});

// GET /video-editor/projects - List all editor projects
router.get('/projects', async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('editor_projects')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ projects: data || [] });
  } catch (error: any) {
    console.error('Failed to fetch projects:', error);
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

// POST /video-editor/render - Render video with Remotion
router.post('/render', async (req: Request, res: Response) => {
  let heartbeat: NodeJS.Timeout | null = null;
  try {
    const { projectId } = req.body;

    if (!projectId) {
      return res.status(400).json({ error: 'Project ID is required' });
    }

    heartbeat = setupSse(res);

    // Import renderer
    const { renderProject } = await import('../lib/remotion-renderer');

    // Render with progress updates
    const videoUrl = await renderProject(
      { projectId },
      (progress) => {
        res.write(`event: progress\ndata: ${JSON.stringify(progress)}\n\n`);
      }
    );

    res.write(`event: complete\ndata: ${JSON.stringify({ videoUrl })}\n\n`);
    res.end();
  } catch (error: any) {
    console.error('Failed to render video:', error);
    res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
  }
});

// GET /video-editor/render/:jobId - Check render status
router.get('/render/:jobId', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;

    const supabase = getSupabase();
    const { data: job, error } = await supabase
      .from('editor_render_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (error) throw error;

    res.json({ job });
  } catch (error: any) {
    console.error('Failed to get render status:', error);
    res.status(500).json({ error: 'Failed to get render status' });
  }
});

// Health check
router.get('/health', async (req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'video-editor' });
});

export default router;
