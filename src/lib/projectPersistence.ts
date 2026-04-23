import type { GenerationSettings } from "@/components/SettingsPopover";
import type { ImagePromptWithTiming, AudioSegment } from "@/lib/api";

export interface SavedProject {
  id: string;
  savedAt: number;
  sourceUrl: string;
  videoTitle: string;
  settings: GenerationSettings;

  // Pipeline progress
  step: "script" | "audio" | "captions" | "prompts" | "images" | "complete";

  // Generated content
  script?: string;
  audioUrl?: string;
  audioDuration?: number;
  audioSegments?: AudioSegment[];
  srtContent?: string;
  srtUrl?: string;
  imagePrompts?: ImagePromptWithTiming[];
  imageUrls?: string[];
  videoUrl?: string;  // Rendered video URL (basic, no effects)
  videoUrlCaptioned?: string;  // Rendered video URL with captions
  embersVideoUrl?: string;  // Rendered video URL with embers overlay
  smokeEmbersVideoUrl?: string;  // Rendered video URL with smoke+embers overlay
}

// Project info for history list (includes data to reopen)
export interface ProjectHistoryItem {
  id: string;
  videoTitle: string;
  completedAt: number;
  imageCount: number;
  audioDuration?: number;
  // Asset URLs for reopening
  script?: string;
  audioUrl?: string;
  srtContent?: string;
  srtUrl?: string;
  imageUrls?: string[];
  imagePrompts?: ImagePromptWithTiming[];
  videoUrl?: string;  // Rendered video URL (basic, no effects)
  videoUrlCaptioned?: string;  // Rendered video URL with captions
  embersVideoUrl?: string;  // Rendered video URL with embers overlay
  smokeEmbersVideoUrl?: string;  // Rendered video URL with smoke+embers overlay
}

const STORAGE_KEY = "historygenai-saved-project";
const HISTORY_KEY = "historygenai-project-history";

export function saveProject(project: SavedProject): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
    console.log(`Project saved at step: ${project.step}`, {
      hasVideoUrl: !!project.videoUrl,
      hasEmbersVideoUrl: !!project.embersVideoUrl,
      hasSmokeEmbersVideoUrl: !!project.smokeEmbersVideoUrl,
      smokeEmbersVideoUrl: project.smokeEmbersVideoUrl,
    });
  } catch (error) {
    console.error("Failed to save project:", error);
  }
}

export function loadProject(): SavedProject | null {
  try {
    console.log(`[loadProject] Checking localStorage key: ${STORAGE_KEY}`);
    const saved = localStorage.getItem(STORAGE_KEY);
    console.log(`[loadProject] Raw data found:`, saved ? `${saved.substring(0, 100)}...` : null);
    if (!saved) return null;

    const project = JSON.parse(saved) as SavedProject;
    console.log(`Project loaded at step: ${project.step}`, {
      hasVideoUrl: !!project.videoUrl,
      hasEmbersVideoUrl: !!project.embersVideoUrl,
      hasSmokeEmbersVideoUrl: !!project.smokeEmbersVideoUrl,
      smokeEmbersVideoUrl: project.smokeEmbersVideoUrl,
    });

    // Check if project is older than 24 hours
    const hoursSinceLastSave = (Date.now() - project.savedAt) / (1000 * 60 * 60);
    if (hoursSinceLastSave > 24) {
      console.log("Saved project expired (>24 hours old)");
      clearProject();
      return null;
    }

    return project;
  } catch (error) {
    console.error("Failed to load project:", error);
    return null;
  }
}

export function clearProject(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    console.log("Saved project cleared");
    console.trace("clearProject called from:");
  } catch (error) {
    console.error("Failed to clear project:", error);
  }
}

export function getStepLabel(step: SavedProject["step"]): string {
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

// Project History Management
export function getProjectHistory(): ProjectHistoryItem[] {
  try {
    const saved = localStorage.getItem(HISTORY_KEY);
    if (!saved) return [];
    return JSON.parse(saved) as ProjectHistoryItem[];
  } catch (error) {
    console.error("Failed to load project history:", error);
    return [];
  }
}

export function addToProjectHistory(item: ProjectHistoryItem): void {
  try {
    const history = getProjectHistory();
    // Remove any existing entry with same ID (in case of re-run)
    const filtered = history.filter(h => h.id !== item.id);
    // Add new item at the beginning
    filtered.unshift(item);
    // Keep only last 50 projects
    const trimmed = filtered.slice(0, 50);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
    console.log(`Added project to history: ${item.videoTitle}`);
  } catch (error) {
    console.error("Failed to add to project history:", error);
  }
}

export function updateProjectInHistory(projectId: string, updates: Partial<ProjectHistoryItem>): void {
  try {
    const history = getProjectHistory();
    const index = history.findIndex(h => h.id === projectId);
    if (index !== -1) {
      history[index] = { ...history[index], ...updates };
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
      console.log(`Updated project in history: ${projectId}`, updates);
    } else {
      console.warn(`Project not found in history: ${projectId}`);
    }
  } catch (error) {
    console.error("Failed to update project in history:", error);
  }
}

export function removeFromProjectHistory(projectId: string): void {
  try {
    const history = getProjectHistory();
    const filtered = history.filter(h => h.id !== projectId);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(filtered));
    console.log(`Removed project from history: ${projectId}`);
  } catch (error) {
    console.error("Failed to remove from project history:", error);
  }
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}
