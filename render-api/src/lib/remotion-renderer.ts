/**
 * Remotion Renderer - Server-side video rendering with Remotion
 */

import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { randomUUID } from 'crypto';

let supabase: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (!supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Supabase credentials not configured');
    supabase = createClient(url, key);
  }
  return supabase;
}

export interface RenderOptions {
  projectId: string;
  fps?: number;
  width?: number;
  height?: number;
  codec?: 'h264' | 'h265';
  quality?: number;
}

export interface RenderProgress {
  progress: number; // 0-100
  message: string;
  renderedFrames?: number;
  totalFrames?: number;
}

interface RenderProgressInternal extends RenderProgress {
  totalFrames: number;
}

/**
 * Render a video project using Remotion
 */
export async function renderProject(
  options: RenderOptions,
  onProgress?: (progress: RenderProgress) => void
): Promise<string> {
  const { projectId, fps = 30, width = 1920, height = 1080, codec = 'h264', quality = 80 } = options;

  onProgress?.({ progress: 0, message: 'Loading project...' });

  // Step 1: Load project from Supabase
  const supabase = getSupabase();
  const { data: project, error: projectError } = await supabase
    .from('editor_projects')
    .select('*')
    .eq('id', projectId)
    .single();

  if (projectError || !project) {
    throw new Error('Project not found');
  }

  // Step 2: Bundle Remotion project (10-30%)
  onProgress?.({ progress: 10, message: 'Bundling Remotion project...' });
  const bundleLocation = await bundleRemotionProject();
  onProgress?.({ progress: 30, message: 'Bundle complete' });

  // Step 3: Select composition (30-35%)
  onProgress?.({ progress: 30, message: 'Loading composition...' });
  const analysis = project.analysis as any;
  const durationInFrames = Math.floor((analysis?.duration || 60) * fps);

  const inputProps = {
    rawVideoUrl: project.raw_video_url,
    editDecisions: project.edit_decisions,
    fps,
    durationInFrames,
    width,
    height,
  };

  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id: 'DynamicVideo',
    inputProps,
  });
  onProgress?.({ progress: 35, message: 'Composition loaded' });

  // Step 4: Render video (35-90%)
  onProgress?.({ progress: 35, message: 'Rendering video...' });
  const outputPath = path.join(os.tmpdir(), `render-${randomUUID()}.mp4`);

  await renderMedia({
    composition,
    serveUrl: bundleLocation,
    codec,
    outputLocation: outputPath,
    inputProps,
    onProgress: ({ renderedFrames, encodedFrames }) => {
      // Calculate total frames from composition
      const total = durationInFrames;
      const percent = Math.floor((renderedFrames / total) * 55) + 35; // 35-90%
      onProgress?.({
        progress: percent,
        message: `Rendering... ${renderedFrames}/${total} frames`,
        renderedFrames,
        totalFrames: total,
      } as RenderProgress);
    },
    // quality is not a valid renderMedia parameter - use crf instead if needed
  });
  onProgress?.({ progress: 90, message: 'Render complete' });

  // Step 5: Upload to Supabase (90-100%)
  onProgress?.({ progress: 90, message: 'Uploading video...' });
  const videoUrl = await uploadVideo(outputPath, projectId);
  onProgress?.({ progress: 95, message: 'Upload complete' });

  // Step 6: Update project
  await supabase
    .from('editor_projects')
    .update({
      rendered_video_url: videoUrl,
      render_status: 'complete',
      updated_at: new Date().toISOString(),
    })
    .eq('id', projectId);

  onProgress?.({ progress: 100, message: 'Done!' });

  // Cleanup
  try {
    fs.unlinkSync(outputPath);
  } catch (error) {
    console.error('Failed to cleanup temp file:', error);
  }

  return videoUrl;
}

/**
 * Bundle the Remotion project
 */
async function bundleRemotionProject(): Promise<string> {
  // Path to the Remotion entry point
  const entryPoint = path.resolve(__dirname, '../../src/editor/remotion/Root.tsx');

  // Bundle the project
  const bundleLocation = await bundle({
    entryPoint,
    webpackOverride: (config) => config,
  });

  return bundleLocation;
}

/**
 * Upload rendered video to Supabase
 */
async function uploadVideo(filePath: string, projectId: string): Promise<string> {
  const supabase = getSupabase();
  const fileName = `${projectId}/rendered-${Date.now()}.mp4`;

  const fileBuffer = fs.readFileSync(filePath);

  const { data, error } = await supabase.storage
    .from('video-editor-assets')
    .upload(fileName, fileBuffer, {
      contentType: 'video/mp4',
      upsert: false,
    });

  if (error) throw error;

  // Get public URL
  const { data: publicUrlData } = supabase.storage
    .from('video-editor-assets')
    .getPublicUrl(data.path);

  return publicUrlData.publicUrl;
}

/**
 * Create or update render job in database
 */
export async function createRenderJob(projectId: string): Promise<string> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('editor_render_jobs')
    .insert({
      project_id: projectId,
      status: 'queued',
      progress: 0,
      message: 'Queued',
    })
    .select('id')
    .single();

  if (error) throw error;
  return data.id;
}

/**
 * Update render job status
 */
export async function updateRenderJob(
  jobId: string,
  status: string,
  progress: number,
  message: string,
  extras?: { video_url?: string; error?: string }
): Promise<void> {
  const supabase = getSupabase();

  const updateData: Record<string, any> = {
    status,
    progress,
    message,
    updated_at: new Date().toISOString(),
  };

  if (extras?.video_url) updateData.video_url = extras.video_url;
  if (extras?.error) updateData.error = extras.error;

  const { error } = await supabase
    .from('editor_render_jobs')
    .update(updateData)
    .eq('id', jobId);

  if (error) {
    console.error('Failed to update render job:', error);
  }
}
