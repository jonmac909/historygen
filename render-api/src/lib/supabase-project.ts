/**
 * Supabase Project Helper
 *
 * This module provides functions to update project records directly from the backend.
 * This enables "fire and forget" generation where users can close their browser
 * and the work will still be saved.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Get Supabase credentials from environment
export function getSupabaseClient(): SupabaseClient | null {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.warn('[SupabaseProject] Missing Supabase credentials (SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY)');
    return null;
  }

  return createClient(supabaseUrl, supabaseKey);
}

// Project update fields - these MUST match exact database column names
export interface ProjectUpdate {
  script_content?: string;  // NOT "script" - database column is script_content
  audio_url?: string;
  audio_duration?: number;
  audio_segments?: any[];
  srt_content?: string;
  srt_url?: string;
  image_prompts?: any[];
  image_urls?: string[];
  video_url?: string;
  video_url_captioned?: string;
  embers_video_url?: string;
  smoke_embers_video_url?: string;
  clip_prompts?: any[];
  clips?: any[];
  thumbnails?: string[];
  current_step?: string;
  status?: string;
  updated_at?: string;
  video_title?: string;
  segments_need_recombine?: boolean;
  factory_batch_id?: string;
  settings?: Record<string, any>;
}

/**
 * Get existing project data for checkpoint/resume logic
 */
export async function getProjectData(projectId: string): Promise<{
  exists: boolean;
  script?: string;
  audioUrl?: string;
  audioDuration?: number;
  audioSegments?: any[];
  srtContent?: string;
  imagePrompts?: any[];
  imageUrls?: string[];
  clipPrompts?: any[];
  clips?: any[];
  videoUrl?: string;
  videoTitle?: string;
  settings?: Record<string, any>;
  error?: string;
}> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { exists: false, error: 'Supabase not configured' };
  }

  try {
    const { data, error } = await supabase
      .from('generation_projects')
      .select('script_content, audio_url, audio_duration, audio_segments, srt_content, image_prompts, image_urls, clip_prompts, clips, video_url, video_title, settings')
      .eq('id', projectId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return { exists: false };
      }
      console.error(`[SupabaseProject] Failed to get project ${projectId}:`, error);
      return { exists: false, error: error.message };
    }

    return {
      exists: true,
      script: data.script_content || undefined,
      audioUrl: data.audio_url || undefined,
      audioDuration: data.audio_duration || undefined,
      audioSegments: data.audio_segments || undefined,
      srtContent: data.srt_content || undefined,
      imagePrompts: data.image_prompts || undefined,
      imageUrls: data.image_urls || undefined,
      clipPrompts: data.clip_prompts || undefined,
      clips: data.clips || undefined,
      videoUrl: data.video_url || undefined,
      videoTitle: data.video_title || undefined,
      settings: data.settings || undefined,
    };
  } catch (err) {
    console.error(`[SupabaseProject] Exception getting project ${projectId}:`, err);
    return { exists: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

/**
 * Create or update project record in Supabase
 * Uses upsert to handle both new and existing projects
 */
export async function createProject(
  projectId: string,
  sourceUrl: string,
  title?: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { success: false, error: 'Supabase not configured' };
  }

  try {
    const now = new Date().toISOString();
    // Use upsert to handle both new and existing projects
    const { error } = await supabase
      .from('generation_projects')
      .upsert({
        id: projectId,
        source_url: sourceUrl,
        source_type: 'youtube',
        video_title: title || 'Untitled',
        status: 'running',
        updated_at: now,
      }, { onConflict: 'id' });

    if (error) {
      console.error(`[SupabaseProject] Failed to create/update project ${projectId}:`, error);
      return { success: false, error: error.message };
    }

    console.log(`[SupabaseProject] Created/updated project ${projectId}`);
    return { success: true };
  } catch (err) {
    console.error(`[SupabaseProject] Exception creating project ${projectId}:`, err);
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

/**
 * Update a project record in Supabase
 * Call this from backend endpoints to save progress directly to database
 */
export async function updateProject(
  projectId: string,
  updates: ProjectUpdate
): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { success: false, error: 'Supabase not configured' };
  }

  try {
    // Always update the timestamp
    updates.updated_at = new Date().toISOString();

    const { error } = await supabase
      .from('generation_projects')
      .update(updates)
      .eq('id', projectId);

    if (error) {
      console.error(`[SupabaseProject] Failed to update project ${projectId}:`, error);
      return { success: false, error: error.message };
    }

    console.log(`[SupabaseProject] Updated project ${projectId}:`, Object.keys(updates).join(', '));
    return { success: true };
  } catch (err) {
    console.error(`[SupabaseProject] Exception updating project ${projectId}:`, err);
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

/**
 * Update project with audio generation results
 */
export async function saveAudioToProject(
  projectId: string,
  audioUrl: string,
  audioDuration: number,
  audioSegments: any[]
): Promise<{ success: boolean; error?: string }> {
  return updateProject(projectId, {
    audio_url: audioUrl,
    audio_duration: audioDuration,
    audio_segments: audioSegments,
    current_step: 'captions',
    segments_need_recombine: false,
  });
}

/**
 * Mark a project as "audio generation starting".
 *
 * The frontend polling fallback in src/lib/api.ts guards on
 * `current_step === 'audio'` to decide whether the audio step is still in
 * flight. Without this call, a regen against a previously-completed project
 * starts with stale fields: old audio_url present and current_step === 'captions'.
 * The first poll tick (30s) then resolves with the previous run's snapshot
 * before the new run has produced any segments, leaving the frontend stuck
 * showing stale segments.
 *
 * Throws on failure — callers must return an error to the client instead of
 * silently proceeding, because a silent failure reproduces the exact bug
 * this helper exists to prevent.
 */
export async function markAudioGenerationStarted(projectId: string): Promise<void> {
  const result = await updateProject(projectId, { current_step: 'audio' });
  if (!result.success) {
    throw new Error(`Failed to mark audio generation started: ${result.error}`);
  }
}

/**
 * Update project with video render results
 */
export async function saveVideoToProject(
  projectId: string,
  videoUrl: string,
  smokeEmbersVideoUrl?: string
): Promise<{ success: boolean; error?: string }> {
  const updates: ProjectUpdate = {
    video_url: videoUrl,
    current_step: 'complete',
  };
  if (smokeEmbersVideoUrl) {
    updates.smoke_embers_video_url = smokeEmbersVideoUrl;
  }
  return updateProject(projectId, updates);
}

/**
 * Update project with image generation results
 */
export async function saveImagesToProject(
  projectId: string,
  imageUrls: string[],
  imagePrompts?: any[]
): Promise<{ success: boolean; error?: string }> {
  const updates: ProjectUpdate = {
    image_urls: imageUrls,
    current_step: 'complete',
  };
  if (imagePrompts) {
    updates.image_prompts = imagePrompts;
  }
  return updateProject(projectId, updates);
}

/**
 * Update project with script generation results
 */
export async function saveScriptToProject(
  projectId: string,
  script: string
): Promise<{ success: boolean; error?: string }> {
  return updateProject(projectId, {
    script_content: script,  // Database column is script_content, not script
    current_step: 'audio',
  });
}

/**
 * Update project with captions/SRT results
 */
export async function saveCaptionsToProject(
  projectId: string,
  srtContent: string,
  srtUrl?: string
): Promise<{ success: boolean; error?: string }> {
  const updates: ProjectUpdate = {
    srt_content: srtContent,
    current_step: 'prompts',
  };
  if (srtUrl) {
    updates.srt_url = srtUrl;
  }
  return updateProject(projectId, updates);
}

/**
 * Save partial audio progress (call after each segment completes)
 * This enables recovery of completed segments if generation fails mid-way.
 *
 * Returns `aborted: true` when the project's DB status is already 'cancelled'.
 * In that case the call is a no-op — it does NOT overwrite status or
 * audio_segments, so the user's stop request sticks. Callers should treat
 * `aborted: true` as a signal to stop scheduling more work.
 */
export async function saveAudioProgress(
  projectId: string,
  segments: any[],
  status: 'generating' | 'combining' | 'failed'
): Promise<{ success: boolean; error?: string; aborted?: boolean }> {
  const supabase = getSupabaseClient();
  if (supabase) {
    const { data: row } = await supabase
      .from('generation_projects')
      .select('status')
      .eq('id', projectId)
      .single();
    if (row?.status === 'cancelled') {
      return { success: true, aborted: true };
    }
  }
  return updateProject(projectId, {
    audio_segments: segments,
    current_step: 'audio',
    status: status === 'failed' ? 'audio_partial' : 'running',
  });
}

/**
 * Save partial image progress (call after each image completes)
 * This enables recovery of completed images if generation fails mid-way
 */
export async function saveImageProgress(
  projectId: string,
  imageUrls: (string | null)[],
  status: 'generating' | 'failed'
): Promise<{ success: boolean; error?: string }> {
  // IMPORTANT: Use empty string for failed slots to preserve index alignment!
  // Frontend uses prompt.index-1 to map to urls array, so indices must match.
  // Filtering out nulls would shift all subsequent images to wrong prompts.
  const urlsWithPlaceholders = imageUrls.map(url => url ?? '');
  return updateProject(projectId, {
    image_urls: urlsWithPlaceholders,
    current_step: 'images',
    status: status === 'failed' ? 'images_partial' : 'running',
  });
}

// =========================================================================
// Factory Batch CRUD
// =========================================================================

export interface FactoryBatch {
  id: string;
  created_at: string;
  updated_at: string;
  status: string;
  current_batch: number;
  current_step: string | null;
  current_project_index: number;
  project_ids: string[];
  project_statuses: Record<string, { status: string; failedAtStep?: string; error?: string }>;
  step_statuses: Record<string, Record<string, string>>;
  settings: Record<string, any>;
  project_settings_overrides: Record<string, Record<string, any>>;
  total_projects: number;
}

export async function createFactoryBatch(batch: {
  id: string;
  project_ids: string[];
  settings: Record<string, any>;
  project_settings_overrides: Record<string, Record<string, any>>;
  total_projects: number;
}): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabaseClient();
  if (!supabase) return { success: false, error: 'Supabase not configured' };

  const stepStatuses: Record<string, Record<string, string>> = {};
  for (const pid of batch.project_ids) {
    stepStatuses[pid] = {
      transcript: 'pending', script: 'pending', audio: 'pending',
      captions: 'pending', image_prompts: 'pending', images: 'pending',
      thumbnails: 'pending', clip_prompts: 'pending', clips: 'pending',
      render: 'pending',
    };
  }

  const projectStatuses: Record<string, { status: string }> = {};
  for (const pid of batch.project_ids) {
    projectStatuses[pid] = { status: 'ok' };
  }

  const { error } = await supabase
    .from('factory_batches')
    .insert({
      id: batch.id,
      project_ids: batch.project_ids,
      settings: batch.settings,
      project_settings_overrides: batch.project_settings_overrides,
      total_projects: batch.total_projects,
      project_statuses: projectStatuses,
      step_statuses: stepStatuses,
    });

  if (error) {
    console.error('[FactoryBatch] Failed to create:', error);
    return { success: false, error: error.message };
  }
  return { success: true };
}

export async function updateFactoryBatch(
  batchId: string,
  updates: Partial<Omit<FactoryBatch, 'id' | 'created_at'>>
): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) return;

  const { error } = await supabase
    .from('factory_batches')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', batchId);

  if (error) {
    console.error(`[FactoryBatch] Failed to update ${batchId}:`, error);
  }
}

export async function getFactoryBatch(batchId: string): Promise<FactoryBatch | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('factory_batches')
    .select('*')
    .eq('id', batchId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    console.error(`[FactoryBatch] Failed to get ${batchId}:`, error);
    return null;
  }
  return data as FactoryBatch;
}
