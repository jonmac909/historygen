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
      .select('script_content, audio_url, audio_duration, audio_segments, srt_content, image_prompts, image_urls, video_url, video_title, settings')
      .eq('id', projectId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        // Project doesn't exist
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
  });
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
 * This enables recovery of completed segments if generation fails mid-way
 */
export async function saveAudioProgress(
  projectId: string,
  segments: any[],
  status: 'generating' | 'combining' | 'failed'
): Promise<{ success: boolean; error?: string }> {
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
  // Filter out null values (failed/pending slots)
  const successfulUrls = imageUrls.filter((url): url is string => url !== null);
  return updateProject(projectId, {
    image_urls: successfulUrls,
    current_step: 'images',
    status: status === 'failed' ? 'images_partial' : 'running',
  });
}
