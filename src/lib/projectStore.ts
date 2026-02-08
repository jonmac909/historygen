import type { GenerationSettings } from "@/components/SettingsPopover";
import type { ImagePromptWithTiming, AudioSegment, ClipPrompt, GeneratedClip } from "@/lib/api";
import { supabase } from "@/integrations/supabase/client";

// Helper to merge imageUrls array into imagePrompts
// This fixes the issue where imageUrls are stored separately from imagePrompts
function mergeImageUrlsIntoPrompts(
  prompts: ImagePromptWithTiming[] | undefined,
  urls: string[] | undefined
): ImagePromptWithTiming[] | undefined {
  if (!prompts || prompts.length === 0) return prompts;
  if (!urls || urls.length === 0) return prompts;

  // Only merge if prompts don't already have imageUrls
  const needsMerge = prompts.some(p => !p.imageUrl);
  if (!needsMerge) return prompts;

  return prompts.map((prompt, index) => ({
    ...prompt,
    imageUrl: prompt.imageUrl || urls[index] || undefined
  }));
}

export interface Project {
  id: string;
  createdAt: number;
  updatedAt: number;
  videoTitle: string;
  sourceUrl: string;
  settings: GenerationSettings;

  // Status replaces the old dual-storage system
  status: 'in_progress' | 'completed' | 'archived';
  currentStep: 'script' | 'audio' | 'captions' | 'prompts' | 'images' | 'complete';

  // Version tracking (max 3 versions per project)
  parentProjectId?: string;  // ID of parent project (null = root project)
  versionNumber: number;     // 1 = original, 2+ = versions

  // All assets (populated as generated)
  script?: string;
  audioUrl?: string;
  audioDuration?: number;
  audioSegments?: AudioSegment[];
  srtContent?: string;
  srtUrl?: string;
  imagePrompts?: ImagePromptWithTiming[];
  imageUrls?: string[];
  videoUrl?: string;
  videoUrlCaptioned?: string;
  embersVideoUrl?: string;
  smokeEmbersVideoUrl?: string;

  // Video Clips (intro clips for video)
  clipPrompts?: ClipPrompt[];
  clips?: GeneratedClip[];

  // Thumbnails
  thumbnails?: string[];  // Array of generated thumbnail URLs
  selectedThumbnailIndex?: number;  // Index of selected thumbnail for YouTube upload
  favoriteThumbnails?: string[];  // Array of favorited thumbnail URLs

  // Approval tracking for pipeline steps
  approvedSteps?: ('script' | 'audio' | 'captions' | 'prompts' | 'images' | 'thumbnails' | 'render' | 'youtube')[];

  // Favorites
  isFavorite?: boolean;

  // Tags for organization
  tags?: string[];

  // YouTube metadata
  youtubeTitle?: string;
  youtubeDescription?: string;
  youtubeTags?: string;
  youtubeCategoryId?: string;
  youtubePlaylistId?: string | null;
}

// Legacy localStorage keys for migration
const LEGACY_PROJECTS_KEY = "historygenai-projects-v2";
const LEGACY_SAVED_KEY = "historygenai-saved-project";
const LEGACY_HISTORY_KEY = "historygenai-project-history";
const SUPABASE_MIGRATION_KEY = "historygenai-supabase-migration-done";

// Convert database row to Project interface
function rowToProject(row: {
  id: string;
  source_url: string;
  source_type: string;
  status: string;
  video_title: string | null;
  current_step: string | null;
  script_content: string | null;
  audio_url: string | null;
  audio_duration: number | null;
  audio_segments: unknown;
  srt_url: string | null;
  srt_content: string | null;
  image_prompts: unknown;
  image_urls: unknown;
  video_url: string | null;
  video_url_captioned: string | null;
  embers_video_url: string | null;
  smoke_embers_video_url: string | null;
  clip_prompts: unknown;
  clips: unknown;
  settings: unknown;
  thumbnails: unknown;
  selected_thumbnail_index: number | null;
  approved_steps: unknown;
  parent_project_id: string | null;
  version_number: number | null;
  is_favorite: boolean | null;
  tags: unknown;
  youtube_title: string | null;
  youtube_description: string | null;
  youtube_tags: string | null;
  youtube_category_id: string | null;
  youtube_playlist_id: string | null;
  created_at: string;
  updated_at: string;
}): Project {
  return {
    id: row.id,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
    videoTitle: row.video_title || 'Untitled',
    sourceUrl: row.source_url,
    settings: (row.settings as GenerationSettings) || {} as GenerationSettings,
    status: (row.status as Project['status']) || 'in_progress',
    currentStep: (row.current_step as Project['currentStep']) || 'script',
    parentProjectId: row.parent_project_id || undefined,
    versionNumber: row.version_number || 1,
    script: row.script_content || undefined,
    audioUrl: row.audio_url || undefined,
    audioDuration: row.audio_duration || undefined,
    audioSegments: (row.audio_segments as AudioSegment[]) || undefined,
    srtContent: row.srt_content || undefined,
    srtUrl: row.srt_url || undefined,
    imagePrompts: mergeImageUrlsIntoPrompts(
      (row.image_prompts as ImagePromptWithTiming[]) || undefined,
      (row.image_urls as string[]) || undefined
    ),
    imageUrls: (row.image_urls as string[]) || undefined,
    videoUrl: row.video_url || undefined,
    videoUrlCaptioned: row.video_url_captioned || undefined,
    embersVideoUrl: row.embers_video_url || undefined,
    smokeEmbersVideoUrl: row.smoke_embers_video_url || undefined,
    clipPrompts: (row.clip_prompts as ClipPrompt[]) || undefined,
    clips: (row.clips as GeneratedClip[]) || undefined,
    thumbnails: (row.thumbnails as string[]) || undefined,
    selectedThumbnailIndex: row.selected_thumbnail_index ?? undefined,
    favoriteThumbnails: (row.favorite_thumbnails as string[]) || undefined,
    approvedSteps: (row.approved_steps as Project['approvedSteps']) || undefined,
    isFavorite: row.is_favorite || false,
    tags: (row.tags as string[]) || undefined,
    youtubeTitle: row.youtube_title || undefined,
    youtubeDescription: row.youtube_description || undefined,
    youtubeTags: row.youtube_tags || undefined,
    youtubeCategoryId: row.youtube_category_id || undefined,
    youtubePlaylistId: row.youtube_playlist_id || undefined,
  };
}

// Convert Project to database row format
// IMPORTANT: Only include fields that are explicitly provided to avoid overwriting existing values
function projectToRow(project: Partial<Project> & { id: string }, isNew: boolean = false) {
  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    id: project.id,
    updated_at: now,
  };

  // Only include fields that are explicitly provided (not undefined)
  if (project.sourceUrl !== undefined) row.source_url = project.sourceUrl || '';
  if (isNew) row.source_type = 'youtube';
  if (project.status !== undefined) row.status = project.status;
  if (project.videoTitle !== undefined) row.video_title = project.videoTitle || null;
  if (project.currentStep !== undefined) row.current_step = project.currentStep;
  if (project.parentProjectId !== undefined) row.parent_project_id = project.parentProjectId || null;
  if (project.versionNumber !== undefined) row.version_number = project.versionNumber;
  if (project.script !== undefined) row.script_content = project.script || null;
  if (project.audioUrl !== undefined) row.audio_url = project.audioUrl || null;
  if (project.audioDuration !== undefined) row.audio_duration = project.audioDuration || null;
  if (project.audioSegments !== undefined) row.audio_segments = project.audioSegments || [];
  if (project.srtUrl !== undefined) row.srt_url = project.srtUrl || null;
  if (project.srtContent !== undefined) row.srt_content = project.srtContent || null;
  if (project.imagePrompts !== undefined) row.image_prompts = project.imagePrompts || [];
  if (project.imageUrls !== undefined) row.image_urls = project.imageUrls || [];
  if (project.videoUrl !== undefined) row.video_url = project.videoUrl || null;
  if (project.videoUrlCaptioned !== undefined) row.video_url_captioned = project.videoUrlCaptioned || null;
  if (project.embersVideoUrl !== undefined) row.embers_video_url = project.embersVideoUrl || null;
  if (project.smokeEmbersVideoUrl !== undefined) row.smoke_embers_video_url = project.smokeEmbersVideoUrl || null;
  if (project.clipPrompts !== undefined) row.clip_prompts = project.clipPrompts || [];
  if (project.clips !== undefined) row.clips = project.clips || [];
  if (project.settings !== undefined) row.settings = project.settings || null;
  if (project.thumbnails !== undefined) row.thumbnails = project.thumbnails || [];
  if (project.selectedThumbnailIndex !== undefined) row.selected_thumbnail_index = project.selectedThumbnailIndex ?? null;
  if (project.favoriteThumbnails !== undefined) row.favorite_thumbnails = project.favoriteThumbnails || [];
  if (project.approvedSteps !== undefined) row.approved_steps = project.approvedSteps || [];
  if (project.isFavorite !== undefined) row.is_favorite = project.isFavorite;
  if (project.tags !== undefined) row.tags = project.tags || [];
  if (project.youtubeTitle !== undefined) row.youtube_title = project.youtubeTitle || null;
  if (project.youtubeDescription !== undefined) row.youtube_description = project.youtubeDescription || null;
  if (project.youtubeTags !== undefined) row.youtube_tags = project.youtubeTags || null;
  if (project.youtubeCategoryId !== undefined) row.youtube_category_id = project.youtubeCategoryId || null;
  if (project.youtubePlaylistId !== undefined) row.youtube_playlist_id = project.youtubePlaylistId;

  // For new projects, set defaults for required fields
  if (isNew) {
    row.created_at = now;
    if (!row.source_url) row.source_url = '';
    if (!row.status) row.status = 'in_progress';
    if (!row.current_step) row.current_step = 'script';
    if (!row.version_number) row.version_number = 1;
  }

  return row;
}

export async function getProject(id: string): Promise<Project | null> {
  const { data, error } = await supabase
    .from('generation_projects')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !data) {
    console.error('[projectStore] Error fetching project:', error);
    return null;
  }

  return rowToProject(data);
}

export async function getAllProjects(): Promise<Project[]> {
  const { data, error } = await supabase
    .from('generation_projects')
    .select('*')
    .neq('status', 'archived')
    .order('updated_at', { ascending: false });

  if (error) {
    console.error('[projectStore] Error fetching projects:', error);
    return [];
  }

  return (data || []).map(rowToProject);
}

export async function upsertProject(project: Partial<Project> & { id: string }): Promise<Project> {
  // Check if project exists to determine if this is a new insert
  const { data: existing } = await supabase
    .from('generation_projects')
    .select('id')
    .eq('id', project.id)
    .single();

  const isNew = !existing;
  const row = projectToRow(project, isNew);

  const { data, error } = await supabase
    .from('generation_projects')
    .upsert(row, { onConflict: 'id' })
    .select()
    .single();

  if (error) {
    console.error('[projectStore] Error upserting project:', error);
    throw error;
  }

  console.log(`[projectStore] ${isNew ? 'Created' : 'Updated'} project: ${project.id}`, {
    status: project.status,
    step: project.currentStep,
    updated_at: data.updated_at
  });

  return rowToProject(data);
}

export async function deleteProject(id: string): Promise<void> {
  const { error } = await supabase
    .from('generation_projects')
    .delete()
    .eq('id', id);

  if (error) {
    console.error('[projectStore] Error deleting project:', error);
    throw error;
  }

  console.log(`[projectStore] Deleted project: ${id}`);
}

export async function archiveProject(id: string): Promise<void> {
  const { error } = await supabase
    .from('generation_projects')
    .update({ status: 'archived', updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) {
    console.error('[projectStore] Error archiving project:', error);
    throw error;
  }

  console.log(`[projectStore] Archived project: ${id}`);
}

export async function getInProgressProjects(): Promise<Project[]> {
  const { data, error } = await supabase
    .from('generation_projects')
    .select('*')
    .eq('status', 'in_progress')
    .order('updated_at', { ascending: false });

  if (error) {
    console.error('[projectStore] Error fetching in-progress projects:', error);
    return [];
  }

  return (data || []).map(rowToProject);
}

export async function getCompletedProjects(): Promise<Project[]> {
  const { data, error } = await supabase
    .from('generation_projects')
    .select('*')
    .eq('status', 'completed')
    .order('updated_at', { ascending: false });

  if (error) {
    console.error('[projectStore] Error fetching completed projects:', error);
    return [];
  }

  return (data || []).map(rowToProject);
}

export async function getArchivedProjects(): Promise<Project[]> {
  const { data, error } = await supabase
    .from('generation_projects')
    .select('*')
    .eq('status', 'archived')
    .order('updated_at', { ascending: false });

  if (error) {
    console.error('[projectStore] Error fetching archived projects:', error);
    return [];
  }

  return (data || []).map(rowToProject);
}

export async function getFavoriteProjects(): Promise<Project[]> {
  const { data, error } = await supabase
    .from('generation_projects')
    .select('*')
    .eq('is_favorite', true)
    .neq('status', 'archived')
    .order('updated_at', { ascending: false });

  if (error) {
    console.error('[projectStore] Error fetching favorite projects:', error);
    return [];
  }

  return (data || []).map(rowToProject);
}

export async function toggleFavorite(id: string): Promise<boolean> {
  // First get current state
  const { data: current, error: fetchError } = await supabase
    .from('generation_projects')
    .select('is_favorite')
    .eq('id', id)
    .single();

  if (fetchError) {
    console.error('[projectStore] Error fetching project for favorite toggle:', fetchError);
    throw fetchError;
  }

  const newValue = !current?.is_favorite;

  const { error } = await supabase
    .from('generation_projects')
    .update({ is_favorite: newValue, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) {
    console.error('[projectStore] Error toggling favorite:', error);
    throw error;
  }

  console.log(`[projectStore] Toggled favorite for ${id}: ${newValue}`);
  return newValue;
}

export async function toggleFavoriteThumbnail(projectId: string, url: string): Promise<string[]> {
  const { data: current, error: fetchError } = await supabase
    .from('generation_projects')
    .select('favorite_thumbnails')
    .eq('id', projectId)
    .single();

  if (fetchError) {
    console.error('[projectStore] Error fetching favorite thumbnails:', fetchError);
    throw fetchError;
  }

  const existing: string[] = (current?.favorite_thumbnails as string[]) || [];
  const updated = existing.includes(url)
    ? existing.filter(u => u !== url)
    : [...existing, url];

  const { error } = await supabase
    .from('generation_projects')
    .update({ favorite_thumbnails: updated, updated_at: new Date().toISOString() })
    .eq('id', projectId);

  if (error) {
    console.error('[projectStore] Error updating favorite thumbnails:', error);
    throw error;
  }

  return updated;
}

export async function getMostRecentInProgress(): Promise<Project | null> {
  const now = Date.now();
  const twentyFourHoursAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('generation_projects')
    .select('*')
    .eq('status', 'in_progress')
    .gte('updated_at', twentyFourHoursAgo)
    .order('updated_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !data) {
    // No recent in-progress project found - not an error
    return null;
  }

  return rowToProject(data);
}

export async function completeProject(id: string): Promise<void> {
  const { error } = await supabase
    .from('generation_projects')
    .update({
      status: 'completed',
      current_step: 'complete',
      updated_at: new Date().toISOString()
    })
    .eq('id', id);

  if (error) {
    console.error('[projectStore] Error completing project:', error);
    throw error;
  }

  console.log(`[projectStore] Completed project: ${id}`);
}

export function getStepLabel(step: Project["currentStep"]): string {
  switch (step) {
    case "script": return "Script Ready";
    case "audio": return "Audio Ready";
    case "captions": return "Captions Ready";
    case "prompts": return "Image Prompts Ready";
    case "images": return "Images Ready";
    case "complete": return "Complete";
    default: return "In Progress";
  }
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function formatDate(timestamp: number, dateOnly: boolean = false): string {
  const date = new Date(timestamp);
  const now = new Date();
  const isThisYear = date.getFullYear() === now.getFullYear();

  if (dateOnly) {
    // Show year if not current year
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      ...(isThisYear ? {} : { year: 'numeric' }),
    });
  }
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(isThisYear ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit'
  });
}

// Migration from localStorage to Supabase (runs once)
export async function migrateFromLocalStorage(): Promise<void> {
  // Check if migration already done
  const migrationDone = localStorage.getItem(SUPABASE_MIGRATION_KEY);
  if (migrationDone) {
    console.log("[projectStore] Supabase migration already completed");
    return;
  }

  console.log("[projectStore] Starting migration from localStorage to Supabase...");

  // Try to migrate from new unified storage first
  const projectsRaw = localStorage.getItem(LEGACY_PROJECTS_KEY);
  if (projectsRaw) {
    try {
      const projects: Project[] = JSON.parse(projectsRaw);
      console.log(`[projectStore] Migrating ${projects.length} projects from localStorage`);

      for (const project of projects) {
        try {
          await upsertProject(project);
          console.log(`[projectStore] Migrated project: ${project.id} - ${project.videoTitle}`);
        } catch (err) {
          console.error(`[projectStore] Failed to migrate project ${project.id}:`, err);
        }
      }
    } catch (e) {
      console.error('[projectStore] Failed to parse localStorage projects:', e);
    }
  }

  // Also try legacy storage formats
  const savedRaw = localStorage.getItem(LEGACY_SAVED_KEY);
  if (savedRaw) {
    try {
      const saved = JSON.parse(savedRaw);
      console.log("[projectStore] Migrating legacy saved project:", saved.id);
      await upsertProject({
        id: saved.id,
        createdAt: saved.savedAt,
        updatedAt: saved.savedAt,
        videoTitle: saved.videoTitle || 'Untitled',
        sourceUrl: saved.sourceUrl || '',
        settings: saved.settings || {} as GenerationSettings,
        status: 'in_progress',
        currentStep: saved.step || 'script',
        versionNumber: 1,
        script: saved.script,
        audioUrl: saved.audioUrl,
        audioDuration: saved.audioDuration,
        audioSegments: saved.audioSegments,
        srtContent: saved.srtContent,
        srtUrl: saved.srtUrl,
        imagePrompts: saved.imagePrompts,
        imageUrls: saved.imageUrls,
        videoUrl: saved.videoUrl,
        videoUrlCaptioned: saved.videoUrlCaptioned,
        embersVideoUrl: saved.embersVideoUrl,
        smokeEmbersVideoUrl: saved.smokeEmbersVideoUrl,
      });
    } catch (e) {
      console.error('[projectStore] Failed to migrate legacy saved project:', e);
    }
  }

  const historyRaw = localStorage.getItem(LEGACY_HISTORY_KEY);
  if (historyRaw) {
    try {
      const history = JSON.parse(historyRaw);
      console.log(`[projectStore] Migrating ${history.length} legacy history projects`);
      for (const item of history) {
        try {
          await upsertProject({
            id: item.id,
            createdAt: item.completedAt,
            updatedAt: item.completedAt,
            videoTitle: item.videoTitle || 'Untitled',
            sourceUrl: item.videoTitle || '',
            settings: {} as GenerationSettings,
            status: 'completed',
            currentStep: 'complete',
            versionNumber: 1,
            script: item.script,
            audioUrl: item.audioUrl,
            audioDuration: item.audioDuration,
            srtContent: item.srtContent,
            srtUrl: item.srtUrl,
            imagePrompts: item.imagePrompts,
            imageUrls: item.imageUrls,
            videoUrl: item.videoUrl,
            videoUrlCaptioned: item.videoUrlCaptioned,
            embersVideoUrl: item.embersVideoUrl,
            smokeEmbersVideoUrl: item.smokeEmbersVideoUrl,
          });
        } catch (err) {
          console.error(`[projectStore] Failed to migrate history item ${item.id}:`, err);
        }
      }
    } catch (e) {
      console.error('[projectStore] Failed to migrate legacy history:', e);
    }
  }

  // Mark migration as done
  localStorage.setItem(SUPABASE_MIGRATION_KEY, 'true');

  // Clear localStorage after successful migration
  localStorage.removeItem(LEGACY_PROJECTS_KEY);
  localStorage.removeItem(LEGACY_SAVED_KEY);
  localStorage.removeItem(LEGACY_HISTORY_KEY);

  console.log("[projectStore] Migration to Supabase complete");
}

// Get project versions (including the parent and all children)
export async function getProjectVersions(projectId: string): Promise<Project[]> {
  // First get the project to find its root
  const project = await getProject(projectId);
  if (!project) return [];

  // Find the root project ID (either this project or its parent)
  const rootId = project.parentProjectId || project.id;

  // Get the root project and all its versions
  const { data, error } = await supabase
    .from('generation_projects')
    .select('*')
    .or(`id.eq.${rootId},parent_project_id.eq.${rootId}`)
    .order('version_number', { ascending: false });

  if (error) {
    console.error('[projectStore] Error fetching project versions:', error);
    return [];
  }

  return (data || []).map(rowToProject);
}

// Create a new version of a project (keeps max 3 versions)
const MAX_VERSIONS = 3;

export async function createProjectVersion(parentId: string): Promise<string> {
  // Get the parent project
  const parent = await getProject(parentId);
  if (!parent) {
    throw new Error('Parent project not found');
  }

  // Find the root project ID
  const rootId = parent.parentProjectId || parent.id;

  // Get all existing versions
  const versions = await getProjectVersions(rootId);

  // Calculate next version number
  const maxVersion = Math.max(...versions.map(v => v.versionNumber), 0);
  const newVersionNumber = maxVersion + 1;

  // Create new version as copy of parent
  // Versions are NOT favorited by default - only root projects can be favorites
  const newId = crypto.randomUUID();
  const newProject: Project = {
    ...parent,
    id: newId,
    parentProjectId: rootId,
    versionNumber: newVersionNumber,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'in_progress',
    isFavorite: false,  // Versions should not inherit favorite status
  };

  await upsertProject(newProject);
  console.log(`[projectStore] Created version ${newVersionNumber} of project ${rootId}`);

  // Prune old versions if we exceed max
  if (versions.length >= MAX_VERSIONS) {
    // Sort by version number ascending, remove oldest (excluding root)
    const toDelete = versions
      .filter(v => v.id !== rootId && v.parentProjectId)  // Don't delete root
      .sort((a, b) => a.versionNumber - b.versionNumber)
      .slice(0, versions.length - MAX_VERSIONS + 1);

    for (const old of toDelete) {
      await deleteProject(old.id);
      console.log(`[projectStore] Pruned old version ${old.versionNumber} (${old.id})`);
    }
  }

  return newId;
}

// Create a duplicate of a project (completely independent copy with new ID)
export async function duplicateProject(sourceId: string): Promise<string> {
  // Get the source project
  const source = await getProject(sourceId);
  if (!source) {
    throw new Error('Source project not found');
  }

  // Create new project as a complete copy with new ID
  const newId = crypto.randomUUID();
  const newProject: Project = {
    ...source,
    id: newId,
    parentProjectId: undefined,  // Not a version, independent project
    versionNumber: 0,
    videoTitle: `${source.videoTitle} (Copy)`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'in_progress',
    isFavorite: false,
  };

  await upsertProject(newProject);
  console.log(`[projectStore] Duplicated project ${sourceId} as ${newId}`);

  return newId;
}

// Auto-backup interval tracking
const BACKUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const lastBackupTimes: Map<string, number> = new Map();

// Check if a project needs a backup based on time elapsed
export function shouldCreateBackup(projectId: string): boolean {
  const lastBackup = lastBackupTimes.get(projectId) || 0;
  return Date.now() - lastBackup > BACKUP_INTERVAL_MS;
}

// Create an auto-backup version of a project (time-based)
export async function createAutoBackup(projectId: string): Promise<string | null> {
  if (!shouldCreateBackup(projectId)) {
    console.log(`[projectStore] Skipping backup for ${projectId} - too recent`);
    return null;
  }

  try {
    const newVersionId = await createProjectVersion(projectId);
    lastBackupTimes.set(projectId, Date.now());
    console.log(`[projectStore] Auto-backup created: ${newVersionId} for project ${projectId}`);
    return newVersionId;
  } catch (error) {
    console.error(`[projectStore] Failed to create auto-backup for ${projectId}:`, error);
    return null;
  }
}

// Get root projects only (for Projects drawer - hides versions)
export async function getRootProjects(): Promise<Project[]> {
  const { data, error } = await supabase
    .from('generation_projects')
    .select('*')
    .is('parent_project_id', null)
    .neq('status', 'archived')
    .order('updated_at', { ascending: false });

  if (error) {
    console.error('[projectStore] Error fetching root projects:', error);
    return [];
  }

  return (data || []).map(rowToProject);
}
