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

// Project update fields (partial)
export interface ProjectUpdate {
  script?: string;
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
}

/**
 * Create a new project record in Supabase
 * Call this when starting a new pipeline
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
    const { error } = await supabase
      .from('generation_projects')
      .insert({
        id: projectId,
        source_url: sourceUrl,
        source_type: 'youtube',
        video_title: title || 'Untitled',
        status: 'running',
        current_step: 'transcript',
        created_at: now,
        updated_at: now,
      });

    if (error) {
      console.error(`[SupabaseProject] Failed to create project ${projectId}:`, error);
      return { success: false, error: error.message };
    }

    console.log(`[SupabaseProject] Created project ${projectId}`);
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
    script,
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
