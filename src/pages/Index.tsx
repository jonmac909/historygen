import { useState, useRef, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Youtube, FileText, Sparkles, Scroll, Mic, Image, RotateCcw, TrendingUp, Zap, Bot, Video, Wand2, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/hooks/use-toast";
import { SettingsPopover, type GenerationSettings } from "@/components/SettingsPopover";
import { ProcessingModal, type GenerationStep } from "@/components/ProcessingModal";
import { ConfigModal, type ScriptTemplate, type ImageTemplate, type CartesiaVoice } from "@/components/ConfigModal";
import { ProjectResults, type GeneratedAsset } from "@/components/ProjectResults";
import { ScriptReviewModal } from "@/components/ScriptReviewModal";
import { AudioPreviewModal } from "@/components/AudioPreviewModal";
import { AudioSegmentsPreviewModal } from "@/components/AudioSegmentsPreviewModal";
import { ImagesPreviewModal } from "@/components/ImagesPreviewModal";
import { ImagePromptsPreviewModal } from "@/components/ImagePromptsPreviewModal";
import { CaptionsPreviewModal } from "@/components/CaptionsPreviewModal";
import { VideoClipPromptsModal } from "@/components/VideoClipPromptsModal";
import { VideoClipsPreviewModal } from "@/components/VideoClipsPreviewModal";
import { ImageScannerModal } from "@/components/ImageScannerModal";
import { ThumbnailGeneratorModal } from "@/components/ThumbnailGeneratorModal";
import { VideoRenderModal } from "@/components/VideoRenderModal";
// VisualEffectsModal removed - now integrated into VideoRenderModal with 2-pass rendering
import { YouTubeUploadModal } from "@/components/YouTubeUploadModal";
import { AutoPosterModal } from "@/components/AutoPosterModal";
import { ShortHookModal } from "@/components/ShortHookModal";
import { ShortGenerationModal } from "@/components/ShortGenerationModal";
import { ShortPreviewModal } from "@/components/ShortPreviewModal";
import {
  getYouTubeTranscript,
  rewriteScriptStreaming,
  quickEditScript,
  generateAudioStreaming,
  regenerateAudioSegment,
  recombineAudioSegments,
  generateCaptions,
  generateImagesStreaming,
  generateImagePrompts,
  extendImagePrompts,
  generateClipPrompts,
  generateVideoClipsStreaming,
  saveScriptToStorage,
  startFullPipeline,
  stopPipeline,
  type ImagePromptWithTiming,
  type AudioSegment,
  type ClipPrompt,
  type GeneratedClip,
} from "@/lib/api";
import { defaultTemplates, defaultImageTemplates } from "@/data/defaultTemplates";
import { supabase } from "@/integrations/supabase/client";
import {
  upsertProject,
  getMostRecentInProgress,
  completeProject,
  archiveProject,
  migrateFromLocalStorage,
  getStepLabel,
  createProjectVersion,
  duplicateProject,
  getProject,
  toggleFavoriteThumbnail,
  type Project,
} from "@/lib/projectStore";
import { ProjectsDrawer } from "@/components/ProjectsDrawer";
import { OutlierFinderView } from "@/components/OutlierFinderView";
import { FavoritesView } from "@/components/FavoritesView";

type InputMode = "url" | "title";
type ViewState = "create" | "outlier-finder" | "favorites" | "processing" | "review-script" | "review-audio" | "review-captions" | "review-clip-prompts" | "review-clips" | "review-prompts" | "review-images" | "review-scanner" | "review-render" | "review-thumbnails" | "review-youtube" | "review-short-hook" | "review-short-generate" | "review-short-preview" | "results";
type EntryMode = "script" | "captions" | "images";

const LAST_SETTINGS_KEY = "historygenai-last-settings";
const CUSTOM_IMAGE_TEMPLATES_KEY = "historygenai-custom-image-templates";

// Default settings (used when no saved settings exist)
const DEFAULT_SETTINGS: GenerationSettings = {
  projectTitle: "",
  topic: "",  // Specific topic to prevent drift (e.g., "Viking Winters", "History of Bread")
  subjectFocus: "",  // Who the story focuses on (e.g., "servants, housemaids", "Viking farmers")
  expandWith: "",  // Optional expansion topics for short source videos
  fullAutomation: false,
  modernKeywordFilter: true,  // Filter anachronistic keywords by default (turn off for modern videos)
  scriptTemplate: "template-a",
  imageTemplate: "image-a",
  aiModel: "claude-sonnet-4-5",
  voiceSampleUrl: "https://autoaigen.com/voices/clone_voice.wav",
  speed: 1,
  imageCount: 10,
  wordCount: 1000,
  quality: "basic",
  ttsEmotionMarker: "(sincere) (soft tone)",
  ttsTemperature: 0.9,
  ttsTopP: 0.85,
  ttsRepetitionPenalty: 1.1,
};

// TTS Sentence Length Analysis
// Fish Speech TTS has a 250 character chunk limit - sentences longer than this
// get split at commas, which can cause audio artifacts at the split points
const MAX_TTS_SENTENCE_LENGTH = 250;

interface LongSentence {
  index: number;
  text: string;
  length: number;
}

function analyzeSentenceLengths(script: string): { longSentences: LongSentence[]; totalSentences: number } {
  if (!script.trim()) return { longSentences: [], totalSentences: 0 };

  // Split at sentence boundaries (. ! ?)
  const sentences = script.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
  const longSentences: LongSentence[] = [];

  sentences.forEach((sentence, index) => {
    const cleanSentence = sentence.trim();
    if (cleanSentence.length > MAX_TTS_SENTENCE_LENGTH) {
      longSentences.push({
        index: index + 1, // 1-based for display
        text: cleanSentence,
        length: cleanSentence.length,
      });
    }
  });

  return { longSentences, totalSentences: sentences.length };
}

// Load last used settings from localStorage
function loadLastSettings(): GenerationSettings {
  try {
    const saved = localStorage.getItem(LAST_SETTINGS_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);

      // Validate and fix voiceSampleUrl if it's an old/invalid URL
      // Old URLs: historygenai.netlify.app, old .mp3 default
      let voiceSampleUrl = parsed.voiceSampleUrl;
      if (voiceSampleUrl) {
        const isOldDomain = voiceSampleUrl.includes('netlify.app') ||
                           voiceSampleUrl.includes('historygenai.');
        // Reset old .mp3 default to new .wav default
        const isOldMp3Default = voiceSampleUrl === 'https://autoaigen.com/voices/clone_voice.mp3';
        if (isOldDomain || isOldMp3Default) {
          console.log('[Settings] Resetting old voiceSampleUrl:', voiceSampleUrl);
          voiceSampleUrl = DEFAULT_SETTINGS.voiceSampleUrl;
        }
      }

      // Merge with defaults to ensure all fields exist
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        voiceSampleUrl, // Use validated URL
        // Always reset project-specific fields for new projects
        projectTitle: "",
        topic: "",
        subjectFocus: "",  // Reset subject focus for new projects
        expandWith: "",  // Reset expansion topics for new projects
        // CRITICAL: fullAutomation must ALWAYS start as false
        // User must explicitly click "Full Auto Generate" each time
        fullAutomation: false,
      };
    }
  } catch (e) {
    console.error("[Index] Failed to load last settings:", e);
  }
  return { ...DEFAULT_SETTINGS };
}

// Save settings to localStorage (called when settings change)
function saveLastSettings(settings: GenerationSettings): void {
  try {
    // Don't save project-specific or session-specific fields
    // fullAutomation should NEVER persist - it must be explicitly chosen each time
    const { projectTitle, topic, customScript, fullAutomation, ...persistableSettings } = settings;
    localStorage.setItem(LAST_SETTINGS_KEY, JSON.stringify(persistableSettings));
  } catch (e) {
    console.error("[Index] Failed to save settings:", e);
  }
}

// Load custom image template overrides from localStorage
function loadCustomImageTemplates(): Record<string, { template: string; name?: string }> {
  try {
    const saved = localStorage.getItem(CUSTOM_IMAGE_TEMPLATES_KEY);
    if (saved) {
      return JSON.parse(saved);
    }
  } catch (e) {
    console.error("[Index] Failed to load custom image templates:", e);
  }
  return {};
}

// Save custom image template overrides to localStorage
function saveCustomImageTemplates(templates: ImageTemplate[]): void {
  try {
    // Only save templates that differ from defaults
    const customOverrides: Record<string, { template: string; name?: string }> = {};
    for (const template of templates) {
      const defaultTemplate = defaultImageTemplates.find(d => d.id === template.id);
      // Save if template content differs from default, or if it's a new custom template
      if (!defaultTemplate || template.template !== defaultTemplate.template || template.name !== defaultTemplate.name) {
        customOverrides[template.id] = { template: template.template, name: template.name };
      }
    }
    localStorage.setItem(CUSTOM_IMAGE_TEMPLATES_KEY, JSON.stringify(customOverrides));
  } catch (e) {
    console.error("[Index] Failed to save custom image templates:", e);
  }
}

// Merge default templates with custom overrides
function getImageTemplatesWithCustomOverrides(): ImageTemplate[] {
  const customOverrides = loadCustomImageTemplates();
  return defaultImageTemplates.map(template => {
    const override = customOverrides[template.id];
    if (override) {
      return {
        ...template,
        template: override.template,
        name: override.name || template.name,
      };
    }
    return template;
  });
}

// Helper to get next day at 5 PM PST as ISO string
function getNext5pmPST(): string {
  const now = new Date();
  // Create date for tomorrow at 5pm PST (UTC-8)
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  // Set to 5pm PST = 1am UTC next day (or 12am UTC if during DST)
  // PST is UTC-8, so 5pm PST = 1am UTC the next day
  tomorrow.setUTCHours(1, 0, 0, 0); // 5pm PST = 1am UTC (next day)
  return tomorrow.toISOString();
}

const Index = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [inputMode, setInputMode] = useState<InputMode>("url");
  const [inputValue, setInputValue] = useState("");
  const [viewState, setViewState] = useState<ViewState>("create");
  // Load settings from localStorage (persists across sessions)
  const [settings, setSettings] = useState<GenerationSettings>(loadLastSettings);
  const [processingSteps, setProcessingSteps] = useState<GenerationStep[]>([]);
  const [processingTitle, setProcessingTitle] = useState("Generating...");
  const [scriptTemplates, setScriptTemplates] = useState<ScriptTemplate[]>(defaultTemplates);
  const [imageTemplates, setImageTemplates] = useState<ImageTemplate[]>(getImageTemplatesWithCustomOverrides);
  const [cartesiaVoices, setCartesiaVoices] = useState<CartesiaVoice[]>([]);

  // Get the selected image template content for image generation
  const getSelectedImageStyle = () => {
    const selected = imageTemplates.find(t => t.id === settings.imageTemplate);
    return selected?.template || imageTemplates[0]?.template || "";
  };
  const [sourceUrl, setSourceUrl] = useState("");
  const [generatedAssets, setGeneratedAssets] = useState<GeneratedAsset[]>([]);
  const [audioUrl, setAudioUrl] = useState<string | undefined>();
  const [srtContent, setSrtContent] = useState<string | undefined>();
  
  // Step-by-step state
  const [pendingScript, setPendingScript] = useState("");
  const [confirmedScript, setConfirmedScript] = useState("");
  const [scriptRegenProgress, setScriptRegenProgress] = useState<number | null>(null);
  const [projectId, setProjectId] = useState("");
  const [projectStatus, setProjectStatus] = useState<'in_progress' | 'completed' | 'archived' | 'running' | 'cancelled' | 'failed'>('in_progress');
  const [pipelineCurrentStep, setPipelineCurrentStep] = useState<string | undefined>();
  const [videoTitle, setVideoTitle] = useState("History Documentary");
  const [pendingAudioUrl, setPendingAudioUrl] = useState("");
  const [pendingAudioDuration, setPendingAudioDuration] = useState<number>(0);
  const [pendingAudioSize, setPendingAudioSize] = useState<number>(0);
  // New: Audio segments state
  const [pendingAudioSegments, setPendingAudioSegments] = useState<AudioSegment[]>([]);
  const [regeneratingSegmentIndex, setRegeneratingSegmentIndex] = useState<number | null>(null);
  const [segmentsNeedRecombine, setSegmentsNeedRecombine] = useState(false);
  const [isRecombining, setIsRecombining] = useState(false);
  const [pendingSrtContent, setPendingSrtContent] = useState("");
  const [pendingSrtUrl, setPendingSrtUrl] = useState("");
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [generatedThumbnails, setGeneratedThumbnails] = useState<string[]>([]);
  const [selectedThumbnailIndex, setSelectedThumbnailIndex] = useState<number | undefined>();
  const [favoriteThumbnails, setFavoriteThumbnails] = useState<string[]>([]);
  const [renderedVideoUrl, setRenderedVideoUrl] = useState<string | undefined>();
  const [videoUrl, setVideoUrl] = useState<string | undefined>();
  const [videoUrlCaptioned, setVideoUrlCaptioned] = useState<string | undefined>();
  const [embersVideoUrl, setEmbersVideoUrl] = useState<string | undefined>();
  const [smokeEmbersVideoUrl, setSmokeEmbersVideoUrl] = useState<string | undefined>();
  const [imagePrompts, setImagePrompts] = useState<ImagePromptWithTiming[]>([]);
  const [regeneratingImageIndices, setRegeneratingImageIndices] = useState<Set<number>>(new Set());
  const [isRegeneratingPrompts, setIsRegeneratingPrompts] = useState(false);
  const [isAddingPrompts, setIsAddingPrompts] = useState(false);
  // Video clips state (LTX-2)
  const [clipPrompts, setClipPrompts] = useState<ClipPrompt[]>([]);
  const [generatedClips, setGeneratedClips] = useState<GeneratedClip[]>([]);
  const [isRegeneratingClipPrompts, setIsRegeneratingClipPrompts] = useState(false);
  const [regeneratingClipIndices, setRegeneratingClipIndices] = useState<Set<number>>(new Set());
  const [selectedClipsForRegen, setSelectedClipsForRegen] = useState<Set<number>>(new Set());
  const [enableVideoClips, setEnableVideoClips] = useState(false); // Toggle for video clips feature
  const [showAutoPosterModal, setShowAutoPosterModal] = useState(false);
  const [entryMode, setEntryMode] = useState<EntryMode>("script");
  const [uploadedAudioFile, setUploadedAudioFile] = useState<File | null>(null);
  const [uploadedScript, setUploadedScript] = useState("");
  const [uploadedCaptions, setUploadedCaptions] = useState("");
  const audioFileInputRef = useRef<HTMLInputElement>(null);
  const audioFileInputImagesRef = useRef<HTMLInputElement>(null);
  const scriptFileInputRef = useRef<HTMLInputElement>(null);
  const captionsFileInputRef = useRef<HTMLInputElement>(null);
  const [uploadedAudioFileForImages, setUploadedAudioFileForImages] = useState<File | null>(null);
  const [savedProject, setSavedProject] = useState<Project | null>(null);
  const [captionsProjectTitle, setCaptionsProjectTitle] = useState("");
  const [imagesProjectTitle, setImagesProjectTitle] = useState("");
  // customStylePrompt is now part of settings for persistence
  // Pipeline approval tracking
  type PipelineStep = 'script' | 'audio' | 'captions' | 'clipPrompts' | 'clips' | 'prompts' | 'images' | 'thumbnails' | 'render' | 'youtube';
  const [approvedSteps, setApprovedSteps] = useState<PipelineStep[]>([]);
  // YouTube metadata state
  const [youtubeTitle, setYoutubeTitle] = useState("");
  const [youtubeDescription, setYoutubeDescription] = useState("");
  const [youtubeTags, setYoutubeTags] = useState("");
  const [youtubeCategoryId, setYoutubeCategoryId] = useState("22"); // Default: People & Blogs
  const [youtubePlaylistId, setYoutubePlaylistId] = useState<string | null>(null);
  const [youtubePublishAt, setYoutubePublishAt] = useState<string | null>(null); // Scheduled publish time

  // Source video thumbnail (from Auto Poster - used as reference for thumbnail generation)
  const [sourceThumbnailUrl, setSourceThumbnailUrl] = useState<string | null>(null);

  // YouTube Short state
  const [shortHookStyle, setShortHookStyle] = useState<string>("");
  const [shortScript, setShortScript] = useState<string>("");
  const [shortUrl, setShortUrl] = useState<string>("");
  const [shortAudioUrl, setShortAudioUrl] = useState<string>("");
  const [shortSrtContent, setShortSrtContent] = useState<string>("");
  const [shortImageUrls, setShortImageUrls] = useState<string[]>([]);
  const [shortDuration, setShortDuration] = useState<number>(0);

  // Project tags state
  const [projectTags, setProjectTags] = useState<string[]>([]);

  // Migrate localStorage to Supabase on first load
  useEffect(() => {
    migrateFromLocalStorage();
  }, []);

  // Poll project status when running on server
  useEffect(() => {
    if (projectStatus !== 'running' || !projectId) return;

    const pollInterval = setInterval(async () => {
      try {
        const { data } = await supabase
          .from('generation_projects')
          .select('status, current_step')
          .eq('id', projectId)
          .single();

        if (data) {
          if (data.status !== 'running') {
            // Pipeline finished
            setProjectStatus(data.status as typeof projectStatus);
            setPipelineCurrentStep(undefined);
            clearInterval(pollInterval);

            // Show toast based on status
            if (data.status === 'completed') {
              toast({
                title: "Pipeline Complete",
                description: "Server-side generation finished successfully",
              });
            } else if (data.status === 'failed') {
              toast({
                title: "Pipeline Failed",
                description: "Server-side generation encountered an error",
                variant: "destructive",
              });
            } else if (data.status === 'cancelled') {
              toast({
                title: "Pipeline Cancelled",
                description: "Server-side generation was stopped",
              });
            }
          } else {
            // Update current step
            setPipelineCurrentStep(data.current_step ?? undefined);
          }
        }
      } catch (err) {
        console.error('[Index] Failed to poll project status:', err);
      }
    }, 3000); // Poll every 3 seconds

    return () => clearInterval(pollInterval);
  }, [projectStatus, projectId]);

  // Load project from ?project= query parameter (e.g., from Auto Poster "View Project" link)
  useEffect(() => {
    const projectIdParam = searchParams.get('project');
    if (!projectIdParam) return;

    console.log('[Index] Loading project from URL param:', projectIdParam);

    getProject(projectIdParam).then((project) => {
      if (!project) {
        console.error('[Index] Project not found:', projectIdParam);
        toast({
          title: "Project Not Found",
          description: `Could not find project ${projectIdParam}`,
          variant: "destructive",
        });
        // Clear the query param
        setSearchParams({});
        return;
      }

      console.log('[Index] Loaded project from URL:', project.id, project.videoTitle);
      console.log('[Index] Project thumbnails:', project.thumbnails?.length, project.thumbnails);

      // Disable fullAutomation when viewing a project
      setSettings(prev => ({ ...prev, fullAutomation: false }));

      // Restore state from project
      setProjectId(project.id);
      setSourceUrl(project.sourceUrl);
      setVideoTitle(project.videoTitle);
      // Restore pipeline status
      if (project.status) {
        setProjectStatus(project.status as typeof projectStatus);
      }
      if (project.currentStep) {
        setPipelineCurrentStep(project.currentStep);
      }

      if (project.script) {
        setPendingScript(project.script);
        setConfirmedScript(project.script);
      }
      if (project.audioUrl) setPendingAudioUrl(project.audioUrl);
      if (project.audioDuration) setPendingAudioDuration(project.audioDuration);
      if (project.audioSegments) setPendingAudioSegments(project.audioSegments);
      if (project.segmentsNeedRecombine) setSegmentsNeedRecombine(project.segmentsNeedRecombine);
      if (project.srtContent) setPendingSrtContent(project.srtContent);
      if (project.srtUrl) setPendingSrtUrl(project.srtUrl);
      if (project.imagePrompts) setImagePrompts(project.imagePrompts);
      if (project.imageUrls) setPendingImages(project.imageUrls);
      if (project.clipPrompts) setClipPrompts(project.clipPrompts);
      if (project.clips) setGeneratedClips(project.clips);
      if (project.videoUrl) setVideoUrl(project.videoUrl);
      if (project.videoUrlCaptioned) setVideoUrlCaptioned(project.videoUrlCaptioned);
      if (project.embersVideoUrl) setEmbersVideoUrl(project.embersVideoUrl);
      if (project.smokeEmbersVideoUrl) setSmokeEmbersVideoUrl(project.smokeEmbersVideoUrl);
      if (project.thumbnails) setGeneratedThumbnails(project.thumbnails);
      if (project.selectedThumbnailIndex !== undefined) setSelectedThumbnailIndex(project.selectedThumbnailIndex);
      if (project.favoriteThumbnails) setFavoriteThumbnails(project.favoriteThumbnails);
      if (project.approvedSteps) setApprovedSteps(project.approvedSteps);
      // Restore YouTube metadata
      if (project.youtubeTitle) setYoutubeTitle(project.youtubeTitle);
      if (project.youtubeDescription) setYoutubeDescription(project.youtubeDescription);
      if (project.youtubeTags) setYoutubeTags(project.youtubeTags);
      if (project.youtubeCategoryId) setYoutubeCategoryId(project.youtubeCategoryId);
      if (project.youtubePlaylistId !== undefined) setYoutubePlaylistId(project.youtubePlaylistId);

      // Build generated assets for results view
      const assets: GeneratedAsset[] = [];
      if (project.script) {
        assets.push({
          id: "script",
          name: "Rewritten Script",
          type: "Markdown",
          size: `${Math.round(project.script.length / 1024)} KB`,
          icon: <FileText className="w-5 h-5 text-muted-foreground" />,
          content: project.script,
        });
      }
      if (project.audioUrl) {
        assets.push({
          id: "audio",
          name: "Voiceover Audio",
          type: "MP3",
          size: project.audioDuration ? `${Math.round(project.audioDuration / 60)} min` : "Unknown",
          icon: <Mic className="w-5 h-5 text-muted-foreground" />,
          url: project.audioUrl,
        });
        setAudioUrl(project.audioUrl);
      }
      if (project.srtContent) {
        assets.push({
          id: "captions",
          name: "Captions",
          type: "SRT",
          size: `${Math.round(project.srtContent.length / 1024)} KB`,
          icon: <FileText className="w-5 h-5 text-muted-foreground" />,
          url: project.srtUrl,
          content: project.srtContent,
        });
        setSrtContent(project.srtContent);
      }
      if (project.imageUrls) {
        project.imageUrls.forEach((imageUrl, index) => {
          assets.push({
            id: `image-${index + 1}`,
            name: `Image ${index + 1}`,
            type: "PNG",
            size: "~1 MB",
            icon: <Image className="w-5 h-5 text-muted-foreground" />,
            url: imageUrl,
          });
        });
      }
      setGeneratedAssets(assets);

      // Go to results page and clear the query param
      setViewState("results");
      setSearchParams({});

      toast({
        title: "Project Loaded",
        description: `Viewing "${project.videoTitle}"`,
      });
    }).catch((err) => {
      console.error('[Index] Failed to load project:', err);
      toast({
        title: "Error Loading Project",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
      setSearchParams({});
    });
  }, [searchParams]);

  // Persist settings to localStorage whenever they change
  useEffect(() => {
    saveLastSettings(settings);
  }, [settings]);

  // Check for in-progress project on load and when returning to create view
  useEffect(() => {
    if (viewState === "create") {
      console.log("[Index] Checking for in-progress project...");
      getMostRecentInProgress().then((inProgress) => {
        console.log("[Index] In-progress project found:", !!inProgress, inProgress?.id);
        if (inProgress) {
          setSavedProject(inProgress);
        } else {
          setSavedProject(null);
        }
      });
    }
  }, [viewState]);

  // Full Automation: Auto-confirm script when ready
  // CRITICAL: Require projectId to prevent stale data from triggering auto-confirm
  useEffect(() => {
    if (settings.fullAutomation && projectId && viewState === "review-script" && pendingScript) {
      console.log("[Full Automation] Auto-confirming script...");
      const timer = setTimeout(() => {
        handleScriptConfirm(pendingScript);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [settings.fullAutomation, projectId, viewState, pendingScript]);

  // Full Automation: Auto-confirm audio when ready
  useEffect(() => {
    if (settings.fullAutomation && projectId && viewState === "review-audio" && pendingAudioUrl) {
      console.log("[Full Automation] Auto-confirming audio...");
      const timer = setTimeout(() => {
        handleAudioConfirm();
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [settings.fullAutomation, projectId, viewState, pendingAudioUrl]);

  // Full Automation: Auto-confirm captions when ready
  useEffect(() => {
    if (settings.fullAutomation && projectId && viewState === "review-captions" && pendingSrtContent) {
      console.log("[Full Automation] Auto-confirming captions...");
      const timer = setTimeout(() => {
        handleCaptionsConfirm(pendingSrtContent);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [settings.fullAutomation, projectId, viewState, pendingSrtContent]);

  // Full Automation: Auto-confirm prompts when ready
  useEffect(() => {
    if (settings.fullAutomation && projectId && viewState === "review-prompts" && imagePrompts.length > 0) {
      console.log(`[Full Automation] Auto-confirming ${imagePrompts.length} image prompts... (pendingImages: ${pendingImages.length})`);
      const timer = setTimeout(() => {
        // CRITICAL: For Full Auto, pass empty array to ensure we generate ALL images
        // This prevents stale pendingImages from triggering partial generation
        handlePromptsConfirm(imagePrompts, getSelectedImageStyle(), undefined, false, []);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [settings.fullAutomation, projectId, viewState, imagePrompts]);

  // Full Automation: Auto-confirm images when ready
  useEffect(() => {
    if (settings.fullAutomation && projectId && viewState === "review-images" && pendingImages.length > 0) {
      console.log("[Full Automation] Auto-confirming images...");
      const timer = setTimeout(() => {
        handleImagesConfirm();
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [settings.fullAutomation, projectId, viewState, pendingImages]);

  // Full Automation: Auto-confirm video clip prompts when ready
  useEffect(() => {
    if (settings.fullAutomation && projectId && viewState === "review-clip-prompts" && clipPrompts.length > 0) {
      console.log("[Full Automation] Auto-confirming clip prompts...");
      const timer = setTimeout(() => {
        // Pass clip prompts with the selected image style (Dutch Golden Age by default)
        handleClipPromptsConfirm(clipPrompts, getSelectedImageStyle());
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [settings.fullAutomation, projectId, viewState, clipPrompts]);

  // Full Automation: Auto-confirm video clips when ready
  useEffect(() => {
    if (settings.fullAutomation && projectId && viewState === "review-clips" && generatedClips.length > 0) {
      console.log("[Full Automation] Auto-confirming clips...");
      const timer = setTimeout(() => {
        handleClipsConfirm();
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [settings.fullAutomation, projectId, viewState, generatedClips]);

  // Auto-save helper - uses unified project store (upsert by id)
  // Fire-and-forget async to avoid blocking UI
  // IMPORTANT: Only include fields that have actual content to avoid overwriting existing data with empty values
  const autoSave = (step: Project["currentStep"], overrides?: Partial<Project>) => {
    const finalId = overrides?.id || projectId;
    const finalVideoTitle = overrides?.videoTitle || videoTitle;
    // Set status based on step - 'complete' step means project is completed
    const status = step === 'complete' ? 'completed' : 'in_progress';
    console.log(`[autoSave] Saving project id=${finalId}, title=${finalVideoTitle}, step=${step}, status=${status}`);

    // Build project object, only including fields that have actual content
    // This prevents overwriting database values with empty state
    const projectData: Partial<Project> & { id: string } = {
      id: finalId,
      sourceUrl: overrides?.sourceUrl || sourceUrl,
      videoTitle: finalVideoTitle,
      settings: overrides?.settings || settings,
      status: status,
      currentStep: step,
    };

    // Script - handle explicit deletions (empty string) from overrides
    if (overrides?.script !== undefined) {
      projectData.script = overrides.script;
    } else if (confirmedScript || pendingScript) {
      projectData.script = confirmedScript || pendingScript;
    }

    // Audio - ONLY save when explicitly provided in overrides
    // This prevents stale closure state from overwriting regenerated audio
    if (overrides?.audioUrl !== undefined) {
      projectData.audioUrl = overrides.audioUrl;
    }
    if (overrides?.audioDuration !== undefined) {
      projectData.audioDuration = overrides.audioDuration;
    }
    if (overrides?.audioSegments !== undefined) {
      projectData.audioSegments = overrides.audioSegments;
    }
    if (overrides?.segmentsNeedRecombine !== undefined) {
      projectData.segmentsNeedRecombine = overrides.segmentsNeedRecombine;
    }

    // Captions - ONLY save when explicitly provided in overrides
    if (overrides?.srtContent !== undefined) {
      projectData.srtContent = overrides.srtContent;
    }
    if (overrides?.srtUrl !== undefined) {
      projectData.srtUrl = overrides.srtUrl;
    }

    // Images - ONLY save when explicitly provided in overrides
    // This prevents stale closure state from overwriting regenerated images
    if (overrides?.imagePrompts !== undefined) {
      projectData.imagePrompts = overrides.imagePrompts;
    }
    if (overrides?.imageUrls !== undefined) {
      projectData.imageUrls = overrides.imageUrls;
    }

    // Videos - ONLY save when explicitly provided in overrides
    // This prevents stale closure state from overwriting rendered videos
    if (overrides?.videoUrl !== undefined) {
      projectData.videoUrl = overrides.videoUrl;
    }
    if (overrides?.videoUrlCaptioned !== undefined) {
      projectData.videoUrlCaptioned = overrides.videoUrlCaptioned;
    }
    if (overrides?.embersVideoUrl !== undefined) {
      projectData.embersVideoUrl = overrides.embersVideoUrl;
    }
    if (overrides?.smokeEmbersVideoUrl !== undefined) {
      projectData.smokeEmbersVideoUrl = overrides.smokeEmbersVideoUrl;
    }

    // Video clips - ONLY save when explicitly provided in overrides
    // This prevents stale closure state from overwriting regenerated clips
    if (overrides?.clipPrompts !== undefined) {
      projectData.clipPrompts = overrides.clipPrompts;
    }
    if (overrides?.clips !== undefined) {
      projectData.clips = overrides.clips;
    }

    // Thumbnails - ONLY save when explicitly provided in overrides
    // This prevents stale closure state from overwriting regenerated thumbnails
    if (overrides?.thumbnails !== undefined) {
      projectData.thumbnails = overrides.thumbnails;
      projectData.selectedThumbnailIndex = overrides.selectedThumbnailIndex;
    }

    // YouTube metadata - handle explicit deletions from overrides
    if (overrides?.youtubeTitle !== undefined) {
      projectData.youtubeTitle = overrides.youtubeTitle;
    } else if (youtubeTitle) {
      projectData.youtubeTitle = youtubeTitle;
    }
    if (overrides?.youtubeDescription !== undefined) {
      projectData.youtubeDescription = overrides.youtubeDescription;
    } else if (youtubeDescription) {
      projectData.youtubeDescription = youtubeDescription;
    }
    if (overrides?.youtubeTags !== undefined) {
      projectData.youtubeTags = overrides.youtubeTags;
    } else if (youtubeTags) {
      projectData.youtubeTags = youtubeTags;
    }
    if (overrides?.youtubeCategoryId !== undefined) {
      projectData.youtubeCategoryId = overrides.youtubeCategoryId;
    } else if (youtubeCategoryId) {
      projectData.youtubeCategoryId = youtubeCategoryId;
    }
    if (overrides?.youtubePlaylistId !== undefined) {
      projectData.youtubePlaylistId = overrides.youtubePlaylistId;
    } else if (youtubePlaylistId) {
      projectData.youtubePlaylistId = youtubePlaylistId;
    }

    // Tags - handle explicit deletions from overrides
    if (overrides?.tags !== undefined) {
      projectData.tags = overrides.tags;
    } else if (projectTags && projectTags.length > 0) {
      projectData.tags = projectTags;
    }

    upsertProject(projectData).catch(err => console.error('[autoSave] Failed to save project:', err));
  };

  // Resume saved project
  const handleResumeProject = () => {
    if (!savedProject) return;

    console.log('[handleResumeProject] Resuming project with video URLs:', {
      videoUrl: savedProject.videoUrl,
      smokeEmbersVideoUrl: savedProject.smokeEmbersVideoUrl,
      embersVideoUrl: savedProject.embersVideoUrl
    });

    // CRITICAL: Disable fullAutomation when manually resuming a project
    // User is reviewing/editing, not running full automation
    setSettings(prev => ({ ...prev, fullAutomation: false }));

    // Restore state from saved project (but keep current settings so user can change them)
    setProjectId(savedProject.id);
    setSourceUrl(savedProject.sourceUrl);
    setVideoTitle(savedProject.videoTitle);
    // Don't restore settings - use current settings so user can adjust image count, etc.

    if (savedProject.script) {
      setPendingScript(savedProject.script);
      setConfirmedScript(savedProject.script);
    }
    if (savedProject.audioUrl) setPendingAudioUrl(savedProject.audioUrl);
    if (savedProject.audioDuration) setPendingAudioDuration(savedProject.audioDuration);
    if (savedProject.audioSegments) setPendingAudioSegments(savedProject.audioSegments);
    if (savedProject.srtContent) setPendingSrtContent(savedProject.srtContent);
    if (savedProject.srtUrl) setPendingSrtUrl(savedProject.srtUrl);
    if (savedProject.imagePrompts) setImagePrompts(savedProject.imagePrompts);
    if (savedProject.imageUrls) setPendingImages(savedProject.imageUrls);
    if (savedProject.clipPrompts) setClipPrompts(savedProject.clipPrompts);
    if (savedProject.clips) setGeneratedClips(savedProject.clips);
    if (savedProject.videoUrl) setVideoUrl(savedProject.videoUrl);
    if (savedProject.videoUrlCaptioned) setVideoUrlCaptioned(savedProject.videoUrlCaptioned);
    if (savedProject.embersVideoUrl) setEmbersVideoUrl(savedProject.embersVideoUrl);
    if (savedProject.smokeEmbersVideoUrl) setSmokeEmbersVideoUrl(savedProject.smokeEmbersVideoUrl);
    if (savedProject.thumbnails) setGeneratedThumbnails(savedProject.thumbnails);
    if (savedProject.selectedThumbnailIndex !== undefined) setSelectedThumbnailIndex(savedProject.selectedThumbnailIndex);
    if (savedProject.favoriteThumbnails) setFavoriteThumbnails(savedProject.favoriteThumbnails);
    if (savedProject.approvedSteps) setApprovedSteps(savedProject.approvedSteps);
    // Restore YouTube metadata
    if (savedProject.youtubeTitle) setYoutubeTitle(savedProject.youtubeTitle);
    if (savedProject.youtubeDescription) setYoutubeDescription(savedProject.youtubeDescription);
    if (savedProject.youtubeTags) setYoutubeTags(savedProject.youtubeTags);
    if (savedProject.youtubeCategoryId) setYoutubeCategoryId(savedProject.youtubeCategoryId);
    if (savedProject.youtubePlaylistId !== undefined) setYoutubePlaylistId(savedProject.youtubePlaylistId);

    // Build generated assets for results view (same logic as handleOpenProject)
    const assets: GeneratedAsset[] = [];
    if (savedProject.script) {
      assets.push({
        id: "script",
        name: "Rewritten Script",
        type: "Markdown",
        size: `${Math.round(savedProject.script.length / 1024)} KB`,
        icon: <FileText className="w-5 h-5 text-muted-foreground" />,
        content: savedProject.script,
      });
    }
    if (savedProject.audioUrl) {
      assets.push({
        id: "audio",
        name: "Voiceover Audio",
        type: "MP3",
        size: savedProject.audioDuration ? `${Math.round(savedProject.audioDuration / 60)} min` : "Unknown",
        icon: <Mic className="w-5 h-5 text-muted-foreground" />,
        url: savedProject.audioUrl,
      });
      setAudioUrl(savedProject.audioUrl);
    }
    if (savedProject.srtContent) {
      assets.push({
        id: "captions",
        name: "Captions",
        type: "SRT",
        size: `${Math.round(savedProject.srtContent.length / 1024)} KB`,
        icon: <FileText className="w-5 h-5 text-muted-foreground" />,
        url: savedProject.srtUrl,
        content: savedProject.srtContent,
      });
      setSrtContent(savedProject.srtContent);
    }
    if (savedProject.imageUrls) {
      savedProject.imageUrls.forEach((imageUrl, index) => {
        assets.push({
          id: `image-${index + 1}`,
          name: `Image ${index + 1}`,
          type: "PNG",
          size: "~1 MB",
          icon: <Image className="w-5 h-5 text-muted-foreground" />,
          url: imageUrl,
        });
      });
    }
    setGeneratedAssets(assets);

    // Go directly to results page
    setViewState("results");

    setSavedProject(null);
    toast({
      title: "Project Opened",
      description: `Loaded "${savedProject.videoTitle}"`,
    });
  };

  // Dismiss saved project banner - only archive if in_progress (not completed)
  const handleDismissSavedProject = () => {
    if (savedProject) {
      // Only archive in-progress projects when dismissed
      // Completed projects should stay accessible in the Projects drawer
      if (savedProject.status === 'in_progress') {
        console.log("[handleDismissSavedProject] Archiving in-progress project:", savedProject.id);
        archiveProject(savedProject.id).catch(err =>
          console.error('[handleDismissSavedProject] Failed to archive:', err)
        );
      } else {
        console.log("[handleDismissSavedProject] Dismissed completed project (not archiving):", savedProject.id);
      }
    }
    setSavedProject(null);
  };

  const toggleInputMode = () => {
    setInputMode(prev => prev === "url" ? "title" : "url");
    setInputValue("");
  };

  const handleSaveScriptTemplates = (templates: ScriptTemplate[]) => {
    setScriptTemplates(templates);
  };

  const handleSaveImageTemplates = (templates: ImageTemplate[]) => {
    setImageTemplates(templates);
    // Persist custom template overrides to localStorage
    saveCustomImageTemplates(templates);
  };

  const handleSaveVoices = (voices: CartesiaVoice[]) => {
    setCartesiaVoices(voices);
  };

  const updateStep = (stepId: string, status: "pending" | "active" | "completed", sublabel?: string) => {
    setProcessingSteps(prev => prev.map(step =>
      step.id === stepId
        ? { ...step, status, sublabel: sublabel || step.sublabel }
        : step
    ));
  };

  // Handler for selecting a video from the outlier finder
  const handleSelectOutlierVideo = (videoUrl: string, title: string) => {
    setInputValue(videoUrl);
    setInputMode("url");
    setSettings(prev => ({ ...prev, projectTitle: title }));
    setViewState("create");
  };

  // Step 1: Generate transcript and script
  const handleGenerate = async (overrideUrl?: string, overrideWordCount?: number) => {
    // Use override URL if provided (for Auto Poster), otherwise use inputValue
    const effectiveUrl = overrideUrl || inputValue;
    // Use override word count if provided (fixes race condition with Auto Poster modal)
    const effectiveWordCount = overrideWordCount ?? settings.wordCount;

    // Check if using custom script (skip YouTube fetch and AI rewriting)
    const usingCustomScript = settings.customScript && settings.customScript.trim().length > 0;

    if (usingCustomScript) {
      // Using custom script - skip to audio generation
      if (!settings.voiceSampleUrl) {
        toast({
          title: "Voice Sample Required",
          description: "Please upload a voice sample for cloning in Settings.",
          variant: "destructive",
        });
        return;
      }

      // Set up project with custom script - ALWAYS new project from main page
      // CRITICAL: Reset all pending state FIRST to clear old project data
      resetPendingState();

      setSourceUrl("Custom Script");
      const useProjectId = crypto.randomUUID();
      setProjectId(useProjectId);
      const projectTitle = settings.projectTitle || "Custom Script";
      setVideoTitle(projectTitle);

      // Go straight to script review with custom script
      setPendingScript(settings.customScript!);

      // Auto-save the custom script project
      // CRITICAL: Explicitly reset ALL asset fields to prevent old project data from bleeding in
      // React state updates are batched, so resetPendingState() hasn't applied yet when autoSave runs
      autoSave("script", {
        id: useProjectId,
        sourceUrl: "Custom Script",
        videoTitle: projectTitle,
        script: settings.customScript!,
        // Explicitly clear all other fields for new project
        audioUrl: undefined,
        audioDuration: undefined,
        audioSegments: [],
        srtContent: undefined,
        srtUrl: undefined,
        imagePrompts: [],
        imageUrls: [],
        videoUrl: undefined,
        videoUrlCaptioned: undefined,
        embersVideoUrl: undefined,
        smokeEmbersVideoUrl: undefined,
        thumbnails: [],
        selectedThumbnailIndex: undefined,
      });

      setViewState("review-script");
      return;
    }

    // Normal flow - validate inputs for YouTube/AI generation
    if (!effectiveUrl.trim()) {
      toast({
        title: inputMode === "url" ? "URL Required" : "Title Required",
        description: inputMode === "url"
          ? "Please paste a YouTube URL to generate."
          : "Please enter a video title to generate.",
        variant: "destructive",
      });
      return;
    }

    // For title mode, require a project title in settings
    if (inputMode === "title" && !settings.projectTitle?.trim()) {
      toast({
        title: "Project Title Required",
        description: "Please enter a project title in Settings before generating.",
        variant: "destructive",
      });
      return;
    }

    if (inputMode === "url") {
      const youtubeRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/;
      if (!youtubeRegex.test(effectiveUrl)) {
        toast({
          title: "Invalid URL",
          description: "Please enter a valid YouTube URL.",
          variant: "destructive",
        });
        return;
      }
    }

    const currentTemplate = scriptTemplates.find(t => t.id === settings.scriptTemplate);
    if (!currentTemplate?.template) {
      toast({
        title: "Template Required",
        description: "Please configure a script template in Settings.",
        variant: "destructive",
      });
      return;
    }

    if (!settings.voiceSampleUrl) {
      toast({
        title: "Voice Sample Required",
        description: "Please upload a voice sample for cloning in Settings.",
        variant: "destructive",
      });
      return;
    }

    // CRITICAL: Reset pending state FIRST to clear any old project data
    resetPendingState();

    setSourceUrl(effectiveUrl);
    // ALWAYS generate a new projectId for new generations from the main page
    // This prevents overwriting existing project files when starting fresh
    const useProjectId = crypto.randomUUID();
    setProjectId(useProjectId);

    const steps: GenerationStep[] = [
      { id: "transcript", label: "Fetching YouTube Transcript", status: "pending" },
      { id: "script", label: "Rewriting Script", status: "pending" },
    ];

    setProcessingSteps(steps);
    setViewState("processing");

    try {
      updateStep("transcript", "active");
      const transcriptResult = await getYouTubeTranscript(effectiveUrl);
      
      if (!transcriptResult.success || !transcriptResult.transcript) {
        throw new Error(transcriptResult.message || transcriptResult.error || "Failed to fetch transcript");
      }
      
      const transcript = transcriptResult.transcript;
      setVideoTitle(settings.projectTitle || transcriptResult.title || "History Documentary");
      updateStep("transcript", "completed");

      updateStep("script", "active", "0%");

      const scriptResult = await rewriteScriptStreaming(
        transcript,
        currentTemplate.template,
        transcriptResult.title || "History Documentary",
        settings.aiModel,
        effectiveWordCount,
        (progress, wordCount) => {
          // Show only progress percentage and word count (no script preview)
          const progressText = `${progress}% (${wordCount.toLocaleString()} words)`;
          updateStep("script", "active", progressText);
        },
        undefined, // onToken - not used here
        settings.topic || undefined, // Topic for drift prevention
        settings.expandWith || undefined // Expansion topics for short sources
      );
      
      if (!scriptResult.success || !scriptResult.script) {
        throw new Error(scriptResult.error || "Failed to rewrite script");
      }
      
      updateStep("script", "completed");
      setPendingScript(scriptResult.script);

      // Auto-save after script generation (pass useProjectId since state hasn't updated yet)
      // CRITICAL: Explicitly reset ALL asset fields to prevent old project data from bleeding in
      // React state updates are batched, so resetPendingState() hasn't applied yet when autoSave runs
      autoSave("script", {
        id: useProjectId,
        sourceUrl: inputValue,
        videoTitle: settings.projectTitle || transcriptResult.title || "History Documentary",
        script: scriptResult.script,
        // Explicitly clear all other fields for new project
        audioUrl: undefined,
        audioDuration: undefined,
        audioSegments: [],
        srtContent: undefined,
        srtUrl: undefined,
        imagePrompts: [],
        imageUrls: [],
        videoUrl: undefined,
        videoUrlCaptioned: undefined,
        embersVideoUrl: undefined,
        smokeEmbersVideoUrl: undefined,
        thumbnails: [],
        selectedThumbnailIndex: undefined,
      });

      await new Promise(resolve => setTimeout(resolve, 300));
      setViewState("review-script");

    } catch (error) {
      console.error("Generation error:", error);
      toast({
        title: "Generation Failed",
        description: error instanceof Error ? error.message : "An error occurred during generation.",
        variant: "destructive",
      });
      setViewState("create");
    }
  };

  // Step 2: After script confirmed, generate audio (6 segments)
  const handleScriptConfirm = async (script: string) => {
    // Update both pending and confirmed script so edits persist when navigating back
    setPendingScript(script);
    setConfirmedScript(script);

    const steps: GenerationStep[] = [
      { id: "audio", label: "Generating Audio", status: "pending" },
    ];

    setProcessingSteps(steps);
    setViewState("processing");

    try {
      await saveScriptToStorage(script, projectId);

      updateStep("audio", "active", "0%");
      const audioRes = await generateAudioStreaming(
        script,
        settings.voiceSampleUrl!,
        projectId,
        (progress) => {
          updateStep("audio", "active", `${progress}%`);
        },
        settings.speed,
        {
          emotionMarker: settings.ttsEmotionMarker,
          temperature: settings.ttsTemperature,
          topP: settings.ttsTopP,
          repetitionPenalty: settings.ttsRepetitionPenalty,
        }
      );

      if (!audioRes.success) {
        throw new Error(audioRes.error || "Failed to generate audio");
      }

      updateStep("audio", "completed", "100%");

      // Handle audio response - prefer combined audioUrl for captions
      if (audioRes.audioUrl) {
        // Use combined audio URL for playback and captions
        setPendingAudioUrl(audioRes.audioUrl);
        setPendingAudioDuration(audioRes.duration || audioRes.totalDuration || 0);
        setPendingAudioSize(audioRes.size || 0);
        // Store segments for individual regeneration if available
        if (audioRes.segments && audioRes.segments.length > 0) {
          setPendingAudioSegments(audioRes.segments);
        } else {
          setPendingAudioSegments([]);
        }
      } else if (audioRes.segments && audioRes.segments.length > 0) {
        // Fallback: no combined URL, use first segment (shouldn't happen with new backend)
        console.warn("No combined audioUrl, falling back to first segment");
        setPendingAudioSegments(audioRes.segments);
        setPendingAudioDuration(audioRes.totalDuration || 0);
        const totalSize = audioRes.segments.reduce((sum, seg) => sum + seg.size, 0);
        setPendingAudioSize(totalSize);
        setPendingAudioUrl(audioRes.segments[0].audioUrl);
      } else {
        throw new Error("No audio generated");
      }

      // Auto-save after audio generation
      autoSave("audio", {
        audioUrl: audioRes.audioUrl || (audioRes.segments?.[0]?.audioUrl),
        audioDuration: audioRes.duration || audioRes.totalDuration || 0,
        audioSegments: audioRes.segments || [],
      });

      await new Promise(resolve => setTimeout(resolve, 300));
      setViewState("review-audio");

    } catch (error) {
      console.error("Audio generation error:", error);
      toast({
        title: "Audio Generation Failed",
        description: error instanceof Error ? error.message : "An error occurred.",
        variant: "destructive",
      });
      setViewState("create");
    }
  };

  // Regenerate audio (all segments)
  const handleAudioRegenerate = () => {
    handleScriptConfirm(confirmedScript);
  };

  // Regenerate a single audio segment
  const handleSegmentRegenerate = async (segmentIndex: number, editedText?: string) => {
    const segment = pendingAudioSegments.find(s => s.index === segmentIndex);
    if (!segment) {
      toast({
        title: "Error",
        description: "Segment not found",
        variant: "destructive",
      });
      return;
    }

    setRegeneratingSegmentIndex(segmentIndex);

    // Use edited text if provided, otherwise use original segment text
    const textToUse = editedText || segment.text;

    try {
      console.log(`Regenerating segment ${segmentIndex}${editedText ? ' with edited text' : ''}...`);

      const result = await regenerateAudioSegment(
        textToUse,
        segmentIndex,
        settings.voiceSampleUrl!,
        projectId
      );

      if (!result.success || !result.segment) {
        throw new Error(result.error || "Failed to regenerate segment");
      }

      // Compute updated segments array
      const updatedSegments = pendingAudioSegments.map(seg =>
        seg.index === segmentIndex
          ? { ...result.segment!, text: textToUse }
          : seg
      );

      // Update the segment in state
      setPendingAudioSegments(updatedSegments);

      // Recalculate totals
      const newTotalDuration = updatedSegments.reduce((sum, seg) => sum + seg.duration, 0);
      setPendingAudioDuration(newTotalDuration);

      // Mark that combined audio needs to be recombined before generating captions
      setSegmentsNeedRecombine(true);

      // CRITICAL: Save updated segments to database so they persist after page refresh
      autoSave("audio", {
        audioSegments: updatedSegments,
        audioDuration: newTotalDuration,
        segmentsNeedRecombine: true,
      });

      toast({
        title: "Segment Regenerated",
        description: `Segment ${segmentIndex} has been regenerated. Audio will be recombined on next render.`,
      });

    } catch (error) {
      console.error("Segment regeneration error:", error);
      toast({
        title: "Regeneration Failed",
        description: error instanceof Error ? error.message : "Failed to regenerate segment",
        variant: "destructive",
      });
    } finally {
      setRegeneratingSegmentIndex(null);
    }
  };

  // Skip captions and go directly to image prompts
  const handleSkipCaptions = async () => {
    // Use script text as fallback for captions (for timing, prompts will be evenly distributed)
    const scriptAsSrt = confirmedScript || pendingScript || "";

    // Create a simple SRT from script (single segment spanning full duration)
    const duration = pendingAudioDuration || 60;
    const formatTime = (seconds: number) => {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      const ms = Math.floor((seconds % 1) * 1000);
      return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
    };

    const simpleSrt = `1\n${formatTime(0)} --> ${formatTime(duration)}\n${scriptAsSrt.substring(0, 500)}...\n`;

    setPendingSrtContent(simpleSrt);

    // Auto-save and go to prompts
    autoSave("captions", { srtContent: simpleSrt });

    // Call the captions confirm handler with the script as SRT
    await handleCaptionsConfirm(simpleSrt);
  };

  // Step 3: After audio confirmed, generate captions (for image timing) then go to image prompts
  const handleAudioConfirm = async () => {
    const steps: GenerationStep[] = [];

    // Add recombine step if segments were modified
    if (segmentsNeedRecombine) {
      steps.push({ id: "recombine", label: "Recombining audio segments", status: "pending" });
    }

    // Always add captions step (for accurate image timing)
    steps.push({ id: "captions", label: "Transcribing audio for image timing", status: "pending" });

    setProcessingSteps(steps);
    setViewState("processing");

    try {
      let audioUrlToUse = pendingAudioUrl;

      // Recombine segments if any were regenerated
      if (segmentsNeedRecombine) {
        updateStep("recombine", "active");
        console.log("Recombining audio segments...");

        const recombineResult = await recombineAudioSegments(projectId, pendingAudioSegments.length);

        if (!recombineResult.success || !recombineResult.audioUrl) {
          throw new Error(recombineResult.error || "Failed to recombine audio segments");
        }

        audioUrlToUse = recombineResult.audioUrl;
        setPendingAudioUrl(audioUrlToUse);
        if (recombineResult.duration) setPendingAudioDuration(recombineResult.duration);
        if (recombineResult.size) setPendingAudioSize(recombineResult.size);
        setSegmentsNeedRecombine(false);

        // Save recombined audio URL and clear the flag
        autoSave("audio", {
          audioUrl: audioUrlToUse,
          audioDuration: recombineResult.duration,
          segmentsNeedRecombine: false,
        });

        updateStep("recombine", "completed");
        console.log(`Recombined audio: ${audioUrlToUse}`);
      }

      // Generate captions automatically (for accurate image timing)
      updateStep("captions", "active", "Transcribing audio...");
      console.log("Generating captions for image timing...");

      const captionsResult = await generateCaptions(
        audioUrlToUse,
        projectId,
        (progress, message) => {
          updateStep("captions", "active", message || `Transcribing... ${progress}%`);
        }
      );

      if (!captionsResult.success || !captionsResult.srtContent) {
        // Fall back to evenly distributed timing if captions fail
        console.warn("Captions generation failed, using even distribution:", captionsResult.error);
        updateStep("captions", "completed", "Using even distribution");
        await handleSkipCaptions();
        return;
      }

      updateStep("captions", "completed", "Transcription complete");
      console.log("Captions generated successfully");

      // Use the real SRT for image timing
      setPendingSrtContent(captionsResult.srtContent);
      autoSave("captions", { srtContent: captionsResult.srtContent });

      // Show captions preview modal for user to review and set image settings
      setViewState("review-captions");

    } catch (error) {
      console.error("Audio confirm error:", error);
      toast({
        title: "Audio Processing Failed",
        description: error instanceof Error ? error.message : "An error occurred.",
        variant: "destructive",
      });
      setViewState("create");
    }
  };

  // Step 4: After captions confirmed, generate image prompts
  // NEW FLOW: Generate ALL images first, then animate first 12 as video clips
  const handleCaptionsConfirm = async (srt: string) => {
    setPendingSrtContent(srt);

    // Auto-save captions immediately
    autoSave("captions", { srtContent: srt });

    // Both Full Auto and Step-by-step now go directly to image prompts
    // Video clips are generated AFTER images, using first 12 images
    if (settings.fullAutomation) {
      console.log("[Full Automation] Generating image prompts first (videos will use first 12 images)...");
    }

    // Generate image prompts (same flow for Full Auto and Step-by-step)
    const steps: GenerationStep[] = [
      { id: "prompts", label: "Generating Scene Descriptions", status: "pending" },
    ];

    setProcessingSteps(steps);
    setViewState("processing");

    try {
      updateStep("prompts", "active", "Analyzing script...");

      // Use confirmedScript if available, otherwise extract text from captions
      // This handles the "Generate Captions" flow where user uploads audio without a script
      let scriptForPrompts = confirmedScript;
      if (!scriptForPrompts.trim()) {
        // Extract plain text from SRT captions
        const srtLines = srt.split('\n');
        const textLines: string[] = [];
        for (let i = 0; i < srtLines.length; i++) {
          const line = srtLines[i].trim();
          // Skip empty lines, numbers, and timecodes
          if (line && !line.match(/^\d+$/) && !line.includes('-->')) {
            textLines.push(line);
          }
        }
        scriptForPrompts = textLines.join(' ');
        console.log('No script available, using captions text for image prompts');
      }

      const promptResult = await generateImagePrompts(
        scriptForPrompts,
        srt,
        settings.imageCount,
        getSelectedImageStyle(),
        true, // Always filter modern keywords
        pendingAudioDuration,
        settings.topic, // Era anchor for image generation
        settings.subjectFocus, // Who the story focuses on (e.g., servants, workers)
        (progress, message) => {
          updateStep("prompts", "active", message);
        }
      );

      if (!promptResult.success || !promptResult.prompts) {
        throw new Error(promptResult.error || "Failed to generate image prompts");
      }

      console.log(`Generated ${promptResult.prompts.length} AI-powered image prompts with timing`);
      setImagePrompts(promptResult.prompts);
      updateStep("prompts", "completed", `${promptResult.prompts.length} scenes`);

      // Auto-save after image prompts generation
      autoSave("prompts", { imagePrompts: promptResult.prompts });

      await new Promise(resolve => setTimeout(resolve, 300));
      setViewState("review-prompts");

    } catch (error) {
      console.error("Image prompt generation error:", error);
      toast({
        title: "Prompt Generation Failed",
        description: error instanceof Error ? error.message : "An error occurred.",
        variant: "destructive",
      });
      setViewState("create");
    }
  };

  // Step 5: After prompts reviewed/edited, generate images
  // generateOnlyNew: true = only generate images for new prompts (keep existing), false = regenerate all
  const handlePromptsConfirm = async (editedPrompts: ImagePromptWithTiming[], editedStylePrompt: string, _topic?: string, generateOnlyNew: boolean = false, existingImages?: string[]) => {
    // CRITICAL: Use passed-in existingImages if provided, otherwise check current state
    // This prevents stale closure data from affecting image generation
    const currentImages = existingImages ?? pendingImages;
    const existingImageCount = currentImages.length;

    // Determine which prompts to generate images for
    let promptsToGenerate: ImagePromptWithTiming[];
    let isPartialGeneration: boolean;

    // Only do partial generation if explicitly requested by user clicking "Generate X" button
    if (generateOnlyNew && existingImageCount > 0 && existingImageCount < editedPrompts.length) {
      // Generate only NEW prompts (keep existing images)
      promptsToGenerate = editedPrompts.slice(existingImageCount);
      isPartialGeneration = true;
    } else {
      // Regenerate ALL images (default for new projects)
      promptsToGenerate = editedPrompts;
      isPartialGeneration = false;
    }

    console.log(`[handlePromptsConfirm] Generating ${promptsToGenerate.length} images (${isPartialGeneration ? `keeping ${existingImageCount} existing` : 'full regeneration'})`);

    setImagePrompts(editedPrompts);
    // Save the edited style prompt to settings so it persists across refreshes
    setSettings(prev => ({ ...prev, customStylePrompt: editedStylePrompt }));

    const steps: GenerationStep[] = [
      { id: "images", label: isPartialGeneration ? `Generating ${promptsToGenerate.length} New Images` : "Generating Images", status: "pending" },
    ];

    setProcessingSteps(steps);
    setViewState("processing");

    try {
      updateStep("images", "active", `0/${promptsToGenerate.length}`);

      const imageResult = await generateImagesStreaming(
        promptsToGenerate,
        settings.quality,
        "16:9",
        (completed, total) => {
          updateStep("images", "active", `${completed}/${total}`);
        },
        projectId
        // topic removed - prompts already contain era info, no backend overrides
      );

      if (!imageResult.success) {
        console.error('Image generation failed:', imageResult.error);
        toast({
          title: "Image Generation Issue",
          description: imageResult.error || "Some images may not have generated",
          variant: "destructive",
        });
      }

      console.log(`[handlePromptsConfirm] Image generation complete. Requested: ${editedPrompts.length}, Received: ${imageResult.images?.length || 0}`);

      // CRITICAL: Check if we received images - if not, try to reconnect from storage
      if (!imageResult.images || imageResult.images.length === 0) {
        console.error('[handlePromptsConfirm] No images received from backend! Attempting to reconnect from storage...');

        // First try: Check if URLs are already in the project table
        const { data: savedProject, error: fetchError } = await supabase
          .from('projects')
          .select('imageUrls')
          .eq('id', projectId)
          .single();

        if (!fetchError && savedProject?.imageUrls && savedProject.imageUrls.length > 0) {
          console.log(`[handlePromptsConfirm] Found ${savedProject.imageUrls.length} images in project table`);
          setPendingImages(savedProject.imageUrls);
          updateStep("images", "completed", "Done");
          await new Promise(resolve => setTimeout(resolve, 300));
          setViewState("review-images");
          return;
        }

        // Second try: Scan storage for orphaned images and reconnect them
        console.log('[handlePromptsConfirm] No URLs in project table, scanning storage...');
        const { reconnectOrphanedImages } = await import('@/lib/api');
        const reconnectResult = await reconnectOrphanedImages(projectId);

        if (reconnectResult.success && reconnectResult.imageUrls) {
          console.log(`[handlePromptsConfirm] Reconnected ${reconnectResult.imageUrls.length} orphaned images from storage!`);
          setPendingImages(reconnectResult.imageUrls);
          updateStep("images", "completed", "Done");
          toast({
            title: "Images Reconnected",
            description: `Found and reconnected ${reconnectResult.imageUrls.length} images from storage`,
          });
          await new Promise(resolve => setTimeout(resolve, 300));
          setViewState("review-images");
          return;
        }

        console.error('[handlePromptsConfirm] All fallback attempts failed');
        toast({
          title: "Image Sync Error",
          description: "Images may have generated but couldn't be retrieved. Check Supabase storage manually.",
          variant: "destructive",
          duration: 10000,
        });
      }

      updateStep("images", "completed", "Done");

      // If partial generation, append new images to existing ones
      const allImages = isPartialGeneration
        ? [...currentImages, ...(imageResult.images || [])]
        : (imageResult.images || []);

      console.log(`[handlePromptsConfirm] Final image count: ${allImages.length} (${isPartialGeneration ? 'appended' : 'fresh'})`);
      setPendingImages(allImages);

      // Auto-save after images generation
      autoSave("images", { imageUrls: allImages });

      await new Promise(resolve => setTimeout(resolve, 300));
      setViewState("review-images");

    } catch (error) {
      console.error("Image generation error:", error);
      toast({
        title: "Image Generation Failed",
        description: error instanceof Error ? error.message : "An error occurred.",
        variant: "destructive",
      });
      setViewState("create");
    }
  };

  // ============================================================================
  // Video Clips Handlers (LTX-2)
  // ============================================================================

  // Generate clip prompts (for intro video clips)
  const handleGenerateClipPrompts = async () => {
    const srt = pendingSrtContent || srtContent || "";
    if (!srt) {
      toast({
        title: "Error",
        description: "No captions available for clip generation",
        variant: "destructive",
      });
      return;
    }

    const steps: GenerationStep[] = [
      { id: "clip-prompts", label: "Generating Video Prompts", status: "pending" },
    ];

    setProcessingSteps(steps);
    setProcessingTitle("Generating Video Prompts...");
    setViewState("processing");

    try {
      updateStep("clip-prompts", "active", "Analyzing script...");

      let scriptForClips = confirmedScript || pendingScript;
      if (!scriptForClips.trim()) {
        const srtLines = srt.split('\n');
        const textLines: string[] = [];
        for (const line of srtLines) {
          if (line.trim() && !line.match(/^\d+$/) && !line.includes('-->')) {
            textLines.push(line.trim());
          }
        }
        scriptForClips = textLines.join(' ');
      }

      const clipResult = await generateClipPrompts(
        scriptForClips,
        srt,
        getSelectedImageStyle(),
        (progress, message) => {
          updateStep("clip-prompts", "active", message);
        }
      );

      if (!clipResult.success || !clipResult.prompts) {
        throw new Error(clipResult.error || "Failed to generate clip prompts");
      }

      console.log(`Generated ${clipResult.prompts.length} video clip prompts`);
      setClipPrompts(clipResult.prompts);
      updateStep("clip-prompts", "completed", `${clipResult.prompts.length} clips`);

      // Save clip prompts to database immediately
      autoSave("prompts", { clipPrompts: clipResult.prompts });

      await new Promise(resolve => setTimeout(resolve, 300));
      setViewState("review-clip-prompts");

    } catch (error) {
      console.error("Clip prompt generation error:", error);
      toast({
        title: "Clip Prompt Generation Failed",
        description: error instanceof Error ? error.message : "An error occurred.",
        variant: "destructive",
      });
      // If we already have clip prompts (regenerating), stay on that view
      // Otherwise go back to captions
      if (clipPrompts.length > 0) {
        setViewState("review-clip-prompts");
      } else {
        setViewState("review-captions");
      }
    }
  };

  // After clip prompts reviewed, generate images first, then video clips
  const handleClipPromptsConfirm = async (editedPrompts: ClipPrompt[], editedStylePrompt: string) => {
    setClipPrompts(editedPrompts);

    const steps: GenerationStep[] = [
      { id: "images", label: "Creating Reference Images for Clips", status: "pending" },
      { id: "clips", label: "Generating AI Video Clips", status: "pending" },
    ];

    setProcessingSteps(steps);
    setProcessingTitle("Creating Video Intro Clips...");
    setViewState("processing");

    try {
      // Step 1: Generate images first (required for I2V)
      updateStep("images", "active", `0/${editedPrompts.length} (0%)`);

      // Convert clip prompts to image prompts format
      // Scene description FIRST (most important), then style (Flux prioritizes early tokens)
      const imagePrompts = editedPrompts.map(p => ({
        index: p.index,
        startTime: formatSecondsToSrt(p.startSeconds),
        endTime: formatSecondsToSrt(p.endSeconds),
        startSeconds: p.startSeconds,
        endSeconds: p.endSeconds,
        prompt: `${p.sceneDescription}${editedStylePrompt ? '. ' + editedStylePrompt : ''}`,
        sceneDescription: p.sceneDescription,
      }));

      const imageResult = await generateImagesStreaming(
        imagePrompts,
        "high",  // High quality for video source images
        "16:9",  // Match video aspect ratio
        (completed, total, message) => {
          const percent = Math.round((completed / total) * 100);
          updateStep("images", "active", `${completed}/${total} images (${percent}%)`);
        },
        projectId
        // topic removed - prompts already contain era info
      );

      if (!imageResult.success || !imageResult.images || imageResult.images.length === 0) {
        throw new Error(imageResult.error || "Failed to generate source images for video clips");
      }

      updateStep("images", "completed", `${imageResult.images.length} images`);
      console.log(`Generated ${imageResult.images.length} source images for video clips`);

      // Step 2: Add image URLs to clip prompts
      const promptsWithImages: ClipPrompt[] = editedPrompts.map((p, i) => ({
        ...p,
        imageUrl: imageResult.images![i] || imageResult.images![0],  // Fallback to first image if mismatch
      }));

      // Update state with image URLs
      setClipPrompts(promptsWithImages);

      // Step 3: Generate video clips from images
      updateStep("clips", "active", `0/${promptsWithImages.length} (0%)`);

      const clipsResult = await generateVideoClipsStreaming(
        projectId,
        promptsWithImages,
        (completed, total, message) => {
          const percent = Math.round((completed / total) * 100);
          updateStep("clips", "active", `${completed}/${total} clips (${percent}%)`);
        }
      );

      if (!clipsResult.success) {
        console.error('Video clip generation failed:', clipsResult.error);
        toast({
          title: "Clip Generation Issue",
          description: clipsResult.error || "Some clips may not have generated",
          variant: "destructive",
        });
      }

      updateStep("clips", "completed", "Done");
      setGeneratedClips(clipsResult.clips || []);

      // Clear existing video URLs since clips changed - user needs to re-render
      setVideoUrl(undefined);
      setSmokeEmbersVideoUrl(undefined);

      // Save clip prompts and generated clips to project
      autoSave("prompts", {
        clipPrompts: promptsWithImages,
        clips: clipsResult.clips || [],
        videoUrl: undefined,
        smokeEmbersVideoUrl: undefined
      });

      await new Promise(resolve => setTimeout(resolve, 300));
      setViewState("review-clips");

    } catch (error) {
      console.error("Video clip generation error:", error);
      toast({
        title: "Clip Generation Failed",
        description: error instanceof Error ? error.message : "An error occurred.",
        variant: "destructive",
      });
      setViewState("review-clip-prompts");
    }
  };

  // Helper to format seconds to SRT timestamp
  const formatSecondsToSrt = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.round((seconds % 1) * 1000);
    return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  };

  // After clips reviewed, continue to image prompts OR render (if images already exist)
  const handleClipsConfirm = async () => {
    // Save confirmed clips to project
    autoSave("prompts", {
      clipPrompts: clipPrompts,
      clips: generatedClips
    });

    // If images already exist, go directly to render instead of regenerating prompts
    if (pendingImages.length > 0 && imagePrompts.length > 0) {
      console.log("[handleClipsConfirm] Images already exist, going directly to render");
      handleGoToRender();
      return;
    }

    // Otherwise, continue to image prompt generation (fresh pipeline flow)
    const srt = pendingSrtContent || srtContent || "";
    if (!srt) {
      setViewState("create");
      return;
    }

    const steps: GenerationStep[] = [
      { id: "prompts", label: "Generating Scene Descriptions", status: "pending" },
    ];

    setProcessingSteps(steps);
    setViewState("processing");

    try {
      updateStep("prompts", "active", "Analyzing script...");

      let scriptForPrompts = confirmedScript || pendingScript;
      if (!scriptForPrompts.trim()) {
        const srtLines = srt.split('\n');
        const textLines: string[] = [];
        for (const line of srtLines) {
          if (line.trim() && !line.match(/^\d+$/) && !line.includes('-->')) {
            textLines.push(line.trim());
          }
        }
        scriptForPrompts = textLines.join(' ');
      }

      const promptResult = await generateImagePrompts(
        scriptForPrompts,
        srt,
        settings.imageCount,
        getSelectedImageStyle(),
        true, // Always filter modern keywords
        pendingAudioDuration,
        settings.topic, // Era anchor for image generation
        settings.subjectFocus, // Who the story focuses on (e.g., servants, workers)
        (progress, message) => {
          updateStep("prompts", "active", message);
        }
      );

      if (!promptResult.success || !promptResult.prompts) {
        throw new Error(promptResult.error || "Failed to generate image prompts");
      }

      setImagePrompts(promptResult.prompts);
      updateStep("prompts", "completed", `${promptResult.prompts.length} scenes`);
      autoSave("prompts", { imagePrompts: promptResult.prompts });

      await new Promise(resolve => setTimeout(resolve, 300));
      setViewState("review-prompts");

    } catch (error) {
      console.error("Image prompt generation error:", error);
      toast({
        title: "Prompt Generation Failed",
        description: error instanceof Error ? error.message : "An error occurred.",
        variant: "destructive",
      });
      setViewState("review-clips");
    }
  };

  // Regenerate clip prompts
  const handleRegenerateClipPrompts = async () => {
    setIsRegeneratingClipPrompts(true);
    try {
      await handleGenerateClipPrompts();
    } finally {
      setIsRegeneratingClipPrompts(false);
    }
  };

  // Regenerate a single video clip (uses existing image from pendingImages if available)
  const handleRegenerateVideoClip = async (clipIndex: number, editedPrompt?: string) => {
    setRegeneratingClipIndices(prev => new Set(prev).add(clipIndex));
    try {
      // Find the clip prompt for this index
      const clipPrompt = clipPrompts.find(p => p.index === clipIndex);
      if (!clipPrompt) {
        toast({
          title: "Error",
          description: `Could not find prompt for clip ${clipIndex}`,
          variant: "destructive",
        });
        return;
      }

      // Use edited prompt if provided, otherwise use original
      const sceneDescription = editedPrompt || clipPrompt.sceneDescription;

      // Update the clip prompt in state if edited
      if (editedPrompt && editedPrompt !== clipPrompt.sceneDescription) {
        const updatedPrompts = clipPrompts.map(p =>
          p.index === clipIndex ? { ...p, sceneDescription: editedPrompt, prompt: editedPrompt } : p
        );
        setClipPrompts(updatedPrompts);
        autoSave("prompts", { clipPrompts: updatedPrompts });
      }

      // Check if we have an existing image in pendingImages for this clip
      // Use the existing regenerated image instead of generating a new one
      // IMPORTANT: clipIndex is 1-based, pendingImages is 0-indexed
      let newImageUrl: string;
      const existingImage = pendingImages[clipIndex - 1];

      if (existingImage) {
        console.log(`Using existing image for clip ${clipIndex}: ${existingImage.substring(0, 60)}...`);
        newImageUrl = existingImage;
      } else {
        // No existing image, generate a new one
        console.log(`Regenerating image for clip ${clipIndex} with prompt: ${sceneDescription.substring(0, 50)}...`);
        const imagePrompt = {
          index: clipPrompt.index,
          startTime: formatSecondsToSrt(clipPrompt.startSeconds),
          endTime: formatSecondsToSrt(clipPrompt.endSeconds),
          startSeconds: clipPrompt.startSeconds,
          endSeconds: clipPrompt.endSeconds,
          prompt: `${getSelectedImageStyle()}. ${sceneDescription}`,
          sceneDescription: sceneDescription,
        };

        const imageResult = await generateImagesStreaming(
          [imagePrompt],
          "high",
          "16:9",
          (completed, total, message) => {
            console.log(`Regenerating image: ${message}`);
          },
          projectId
          // topic removed - prompts already contain era info
        );

        if (!imageResult.success || !imageResult.images || imageResult.images.length === 0) {
          throw new Error(imageResult.error || "Failed to regenerate source image");
        }

        newImageUrl = imageResult.images[0];
        console.log(`Regenerated image: ${newImageUrl}`);
      }

      // Step 2: Update clip prompt with new image URL
      const updatedPrompt: ClipPrompt = {
        ...clipPrompt,
        imageUrl: newImageUrl,
      };

      // Update clipPrompts state with new image URL
      setClipPrompts(prev => prev.map(p => p.index === clipIndex ? updatedPrompt : p));

      // Step 3: Generate video from the new image
      console.log(`Generating video from new image for clip ${clipIndex}...`);
      const clipsResult = await generateVideoClipsStreaming(
        projectId,
        [updatedPrompt],
        (completed, total, message, latestClip) => {
          console.log(`Regenerating clip ${clipIndex}: ${message}`);
        }
      );

      if (clipsResult.success && clipsResult.clips && clipsResult.clips.length > 0) {
        const newClip = clipsResult.clips[0];
        console.log(`[Regenerate] ===== CLIP ${clipIndex} REGENERATED =====`);
        console.log(`[Regenerate] OLD URL: ${generatedClips.find(c => c.index === clipIndex)?.videoUrl?.substring(0, 80) || 'none'}`);
        console.log(`[Regenerate] NEW URL: ${newClip.videoUrl.substring(0, 80)}`);

        // Update the clip in our array and persist to database
        const updatedClips = generatedClips.map(c => c.index === clipIndex ? newClip : c);
        console.log(`[Regenerate] Updated clips array:`);
        updatedClips.forEach((c, i) => console.log(`[Regenerate]   Clip ${c.index}: ${c.videoUrl.substring(0, 60)}...`));
        console.log(`[Regenerate] =====================================`);
        setGeneratedClips(updatedClips);

        // Clear existing video URLs since clips changed - user needs to re-render
        setVideoUrl(undefined);
        setSmokeEmbersVideoUrl(undefined);

        // Also update clipPrompts state with the new image URL
        const updatedClipPrompts = clipPrompts.map(p =>
          p.index === clipIndex ? { ...p, imageUrl: newImageUrl } : p
        );
        setClipPrompts(updatedClipPrompts);

        // CRITICAL: Persist to database so regenerated clip survives page refresh
        // Unlike autoSave (fire-and-forget), we MUST await this to ensure clips are saved
        console.log(`[Regenerate] Saving clip ${clipIndex} to database (awaiting completion)...`);
        console.log(`[Regenerate] Clips being saved:`, updatedClips.map(c => ({
          index: c.index,
          url: c.videoUrl?.substring(0, 80)
        })));
        try {
          const savedProject = await upsertProject({
            id: projectId,
            clips: updatedClips,
            clipPrompts: updatedClipPrompts,
            currentStep: "prompts",
          });
          console.log(`[Regenerate] Clip ${clipIndex} saved to database successfully`);
          console.log(`[Regenerate] Clips returned from DB:`, savedProject.clips?.map(c => ({
            index: c.index,
            url: c.videoUrl?.substring(0, 80)
          })));
          toast({
            title: "Clip Regenerated & Saved",
            description: `Clip ${clipIndex} has been regenerated and saved`,
          });
        } catch (saveError) {
          console.error(`[Regenerate] FAILED to save clip ${clipIndex} to database:`, saveError);
          toast({
            title: "Warning: Clip Not Saved",
            description: "Clip regenerated but failed to save. Please try again or manually save.",
            variant: "destructive",
          });
        }
      } else {
        toast({
          title: "Regeneration Failed",
          description: clipsResult.error || "Failed to regenerate clip",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error('Error regenerating video clip:', error);
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to regenerate clip",
        variant: "destructive",
      });
    } finally {
      setRegeneratingClipIndices(prev => {
        const next = new Set(prev);
        next.delete(clipIndex);
        return next;
      });
    }
  };

  // Regenerate multiple video clips in parallel
  const handleRegenerateMultipleClips = async (clipIndices: number[]) => {
    if (clipIndices.length === 0) return;

    // Mark all selected as regenerating
    setRegeneratingClipIndices(new Set(clipIndices));
    setSelectedClipsForRegen(new Set());

    try {
      // Build array of clip prompts with images
      const clipsToRegenerate: ClipPrompt[] = clipIndices.map(idx => {
        const prompt = clipPrompts.find(p => p.index === idx);
        if (!prompt) throw new Error(`Could not find prompt for clip ${idx}`);

        // Use existing image from pendingImages (clipIndex is 1-based, array is 0-indexed)
        const existingImage = pendingImages[idx - 1];
        return {
          ...prompt,
          imageUrl: existingImage || prompt.imageUrl,
        };
      });

      // Generate all clips in parallel (backend handles concurrency up to 12)
      const clipsResult = await generateVideoClipsStreaming(
        projectId,
        clipsToRegenerate,
        (completed, total, message, latestClip) => {
          console.log(`[MultiRegen] ${completed}/${total}: ${message}`);
          if (latestClip) {
            // Update individual clip as it completes
            setGeneratedClips(prev => prev.map(c =>
              c.index === latestClip.index ? latestClip : c
            ));
            // Remove from regenerating set
            setRegeneratingClipIndices(prev => {
              const next = new Set(prev);
              next.delete(latestClip.index);
              return next;
            });
          }
        }
      );

      if (clipsResult.success && clipsResult.clips && clipsResult.clips.length > 0) {
        // Final update with all clips
        const newClipsMap = new Map(clipsResult.clips.map(c => [c.index, c]));
        const updatedClips = generatedClips.map(c => newClipsMap.get(c.index) || c);
        setGeneratedClips(updatedClips);

        // Clear video URLs since clips changed
        setVideoUrl(undefined);
        setSmokeEmbersVideoUrl(undefined);

        // Save to database
        try {
          await upsertProject({
            id: projectId,
            clips: updatedClips,
            currentStep: "prompts",
          });
          toast({
            title: "Clips Regenerated",
            description: `${clipsResult.clips.length} clips regenerated successfully`,
          });
        } catch (saveError) {
          console.error('[MultiRegen] Failed to save:', saveError);
          toast({
            title: "Warning",
            description: "Clips regenerated but failed to save to database",
            variant: "destructive",
          });
        }
      } else {
        toast({
          title: "Regeneration Failed",
          description: clipsResult.error || "Failed to regenerate clips",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error('[MultiRegen] Error:', error);
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to regenerate clips",
        variant: "destructive",
      });
    } finally {
      setRegeneratingClipIndices(new Set());
    }
  };

  // ============================================================================

  // Regenerate all image prompts (re-call Claude to generate new scene descriptions)
  // Accepts optional overrides for topic and subjectFocus from the modal's edited fields
  const handleRegenerateImagePrompts = async (modernKeywordFilter: boolean, topicOverride?: string, focusOverride?: string) => {
    if (!pendingSrtContent && !srtContent) {
      toast({
        title: "Error",
        description: "No captions available to regenerate prompts",
        variant: "destructive",
      });
      return;
    }

    // Use override values if provided (from modal), otherwise use current settings
    const effectiveTopic = topicOverride !== undefined ? topicOverride : settings.topic;
    const effectiveFocus = focusOverride !== undefined ? focusOverride : settings.subjectFocus;

    // Update settings with new values if overrides were provided
    if (topicOverride !== undefined || focusOverride !== undefined) {
      setSettings(prev => ({
        ...prev,
        topic: effectiveTopic,
        subjectFocus: effectiveFocus,
      }));
    }

    setIsRegeneratingPrompts(true);

    try {
      // Use confirmedScript or pendingScript as the script context
      let scriptForPrompts = confirmedScript || pendingScript;
      const srt = pendingSrtContent || srtContent || "";

      // If no script, extract from captions
      if (!scriptForPrompts && srt) {
        const lines = srt.split('\n');
        const textLines: string[] = [];
        for (const line of lines) {
          if (line.trim() && !/^\d+$/.test(line.trim()) && !line.includes('-->')) {
            textLines.push(line.trim());
          }
        }
        scriptForPrompts = textLines.join(' ');
      }

      // ALWAYS use existing prompt count if available (for loaded projects with custom prompt counts)
      // This ensures regeneration maintains the same number of prompts, not the default setting
      const promptCount = imagePrompts.length > 0 ? imagePrompts.length : settings.imageCount;

      console.log(`[RegenerateImagePrompts] Using prompt count: ${promptCount} (imagePrompts.length: ${imagePrompts.length}, settings.imageCount: ${settings.imageCount})`);
      console.log(`[RegenerateImagePrompts] Modern keyword filter: ${modernKeywordFilter}`);
      console.log(`[RegenerateImagePrompts] Topic: ${effectiveTopic}, Focus: ${effectiveFocus}`);

      const promptResult = await generateImagePrompts(
        scriptForPrompts,
        srt,
        promptCount,
        getSelectedImageStyle(),
        true, // Always filter modern keywords
        pendingAudioDuration,
        effectiveTopic, // Era anchor for image generation (from modal or settings)
        effectiveFocus, // Who the story focuses on (from modal or settings)
        (progress, message) => {
          console.log(`[RegeneratePrompts] ${progress}%: ${message}`);
        }
      );

      if (!promptResult.success || !promptResult.prompts) {
        throw new Error(promptResult.error || "Failed to regenerate image prompts");
      }

      console.log(`Regenerated ${promptResult.prompts.length} image prompts`);
      setImagePrompts(promptResult.prompts);

      // Auto-save after regeneration
      autoSave("prompts", { imagePrompts: promptResult.prompts });

      toast({
        title: "Prompts Regenerated",
        description: `Generated ${promptResult.prompts.length} new scene descriptions`,
      });

    } catch (error) {
      console.error("Image prompt regeneration error:", error);
      toast({
        title: "Regeneration Failed",
        description: error instanceof Error ? error.message : "An error occurred.",
        variant: "destructive",
      });
    } finally {
      setIsRegeneratingPrompts(false);
    }
  };

  // Add N more prompts to the end of the existing prompt list
  const handleAddPrompts = async (count: number) => {
    if (!pendingSrtContent && !srtContent) {
      toast({
        title: "Error",
        description: "No captions available to generate prompts",
        variant: "destructive",
      });
      return;
    }

    if (imagePrompts.length === 0) {
      toast({
        title: "Error",
        description: "No existing prompts to extend",
        variant: "destructive",
      });
      return;
    }

    setIsAddingPrompts(true);

    try {
      const script = confirmedScript || pendingScript || "";
      const srt = pendingSrtContent || srtContent || "";

      // Get the end time of the last existing prompt
      const lastPrompt = imagePrompts[imagePrompts.length - 1];
      const startFromSeconds = lastPrompt.endSeconds;

      // Get total audio duration from the last SRT segment or audio
      const audioDuration = pendingAudioDuration || (lastPrompt.endSeconds + 60); // Fallback: add 60s

      console.log(`[handleAddPrompts] Adding ${count} prompts from ${startFromSeconds.toFixed(2)}s to ${audioDuration.toFixed(2)}s`);

      const result = await extendImagePrompts(
        script,
        srt,
        count,
        startFromSeconds,
        audioDuration,
        settings.customStylePrompt?.trim() || getSelectedImageStyle(),
        settings.topic,  // Era anchor for image generation
        settings.subjectFocus,  // Who the story focuses on
        projectId
      );

      if (!result.success || !result.prompts) {
        throw new Error(result.error || "Failed to generate additional prompts");
      }

      // Renumber new prompts to continue from existing count
      const startIndex = imagePrompts.length;
      const newPrompts = result.prompts.map((p, i) => ({
        ...p,
        index: startIndex + i + 1,
      }));

      // Append to existing prompts
      const updatedPrompts = [...imagePrompts, ...newPrompts];
      setImagePrompts(updatedPrompts);

      // Auto-save
      autoSave("prompts", { imagePrompts: updatedPrompts });

      toast({
        title: "Prompts Added",
        description: `Added ${newPrompts.length} new prompts (${updatedPrompts.length} total)`,
      });

    } catch (error) {
      console.error("Error adding prompts:", error);
      toast({
        title: "Failed to Add Prompts",
        description: error instanceof Error ? error.message : "An error occurred",
        variant: "destructive",
      });
    } finally {
      setIsAddingPrompts(false);
    }
  };

  // Regenerate a single image (optionally with edited prompt)
  // Uses Set-based tracking to allow multiple images to regenerate in parallel
  const handleRegenerateImage = async (index: number, editedSceneDescription?: string) => {
    if (!imagePrompts[index]) {
      toast({
        title: "Error",
        description: "Image prompt not found",
        variant: "destructive",
      });
      return;
    }

    // Add this index to the set of regenerating images (allows parallel regeneration)
    setRegeneratingImageIndices(prev => new Set([...prev, index]));

    try {
      // ALWAYS use the current style prompt (from settings or selected template)
      // This ensures regenerated images match the original style
      const currentStylePrompt = settings.customStylePrompt?.trim() || getSelectedImageStyle();

      // Get the scene description (use edited version if provided)
      const sceneDescription = editedSceneDescription || imagePrompts[index].sceneDescription;

      // Rebuild the prompt with current style + scene description
      const promptToUse: ImagePromptWithTiming = {
        ...imagePrompts[index],
        sceneDescription: sceneDescription,
        prompt: `${currentStylePrompt}. ${sceneDescription}`
      };

      // Update the prompts state with the rebuilt prompt
      setImagePrompts(prev => {
        const newPrompts = [...prev];
        newPrompts[index] = promptToUse;
        return newPrompts;
      });

      console.log(`Regenerating image ${index + 1}${editedSceneDescription ? ' with edited prompt' : ''}...`);
      console.log(`[handleRegenerateImage] Style prompt:`, currentStylePrompt.substring(0, 100));
      console.log(`[handleRegenerateImage] Full prompt being sent:`, promptToUse.prompt?.substring(0, 200));

      const imageResult = await generateImagesStreaming(
        [promptToUse], // Regenerate just this one prompt with timing
        settings.quality,
        "16:9",
        () => {}, // No progress callback needed for single image
        projectId
        // topic removed - prompts already contain era info
      );

      if (!imageResult.success || !imageResult.images || imageResult.images.length === 0) {
        throw new Error(imageResult.error || 'Failed to regenerate image');
      }

      // Update the image at the specific index and save to database
      const newImageUrl = imageResult.images![0];

      // Use functional update to get LATEST state (fixes race condition when regenerating multiple images)
      // This ensures parallel regenerations don't overwrite each other
      setPendingImages(prevImages => {
        const updatedImages = [...prevImages];
        updatedImages[index] = newImageUrl;

        // Save to database with the updated array (inside setter to ensure we have latest state)
        // Include imagePrompts to persist edited prompts
        autoSave("images", { imageUrls: updatedImages, imagePrompts: imagePrompts.map((p, i) =>
          i === index ? promptToUse : p
        ) });

        return updatedImages;
      });

      // Clear existing video URLs since images changed - user needs to re-render
      setVideoUrl(undefined);
      setSmokeEmbersVideoUrl(undefined);

      toast({
        title: "Image Regenerated",
        description: `Image ${index + 1} has been regenerated successfully.`,
      });

    } catch (error) {
      console.error("Image regeneration error:", error);
      toast({
        title: "Regeneration Failed",
        description: error instanceof Error ? error.message : "Failed to regenerate image",
        variant: "destructive",
      });
    } finally {
      // Remove this index from the set when done
      setRegeneratingImageIndices(prev => {
        const next = new Set(prev);
        next.delete(index);
        return next;
      });
    }
  };

  // Regenerate multiple images in parallel (with optional edited prompts)
  const handleRegenerateMultipleImages = async (indices: number[], editedPrompts?: Map<number, string>) => {
    if (indices.length === 0) return;

    // Set all indices as regenerating
    setRegeneratingImageIndices(new Set(indices));

    const MAX_CONCURRENT = 4; // Match RunPod worker limit

    // ALWAYS use the current style prompt (from settings or selected template)
    // This ensures regenerated images match the original style
    const currentStylePrompt = settings.customStylePrompt?.trim() || getSelectedImageStyle();
    console.log(`[handleRegenerateMultipleImages] Using style prompt:`, currentStylePrompt.substring(0, 100));

    try {
      // Process in batches of MAX_CONCURRENT
      for (let i = 0; i < indices.length; i += MAX_CONCURRENT) {
        const batch = indices.slice(i, i + MAX_CONCURRENT);

        await Promise.all(batch.map(async (index) => {
          // index is 1-based (Image 1 = index 1), but array is 0-based
          const arrayIndex = index - 1;
          if (arrayIndex < 0 || !imagePrompts[arrayIndex]) return;

          // Get scene description (use edited version if provided)
          // editedPrompts Map uses 1-based index as key
          const editedDescription = editedPrompts?.get(index);
          const sceneDescription = editedDescription || imagePrompts[arrayIndex].sceneDescription;

          // Rebuild the prompt with current style + scene description
          const promptToUse: ImagePromptWithTiming = {
            ...imagePrompts[arrayIndex],
            sceneDescription: sceneDescription,
            prompt: `${currentStylePrompt}. ${sceneDescription}`
          };

          // Update the prompts state with the rebuilt prompt
          setImagePrompts(prev => {
            const newPrompts = [...prev];
            newPrompts[arrayIndex] = promptToUse;
            return newPrompts;
          });

          try {
            const imageResult = await generateImagesStreaming(
              [promptToUse],
              settings.quality,
              "16:9",
              () => {},
              projectId
              // topic removed - prompts already contain era info
            );

            if (imageResult.success && imageResult.images && imageResult.images.length > 0) {
              // Update the image at the specific array index (0-based)
              // Don't autoSave here - save once at the end to avoid race conditions
              const newImageUrl = imageResult.images![0];
              setPendingImages(prev => {
                const newImages = [...prev];
                newImages[arrayIndex] = newImageUrl;
                return newImages;
              });
            }
          } catch (error) {
            console.error(`Failed to regenerate image ${index}:`, error);
          } finally {
            // Remove this index from regenerating set
            setRegeneratingImageIndices(prev => {
              const next = new Set(prev);
              next.delete(index);
              return next;
            });
          }
        }));
      }

      // Clear existing video URLs since images changed - user needs to re-render
      setVideoUrl(undefined);
      setSmokeEmbersVideoUrl(undefined);

      // Save all updated images to database ONCE after all regenerations complete
      // Use setTimeout to ensure React state updates are batched first
      setTimeout(() => {
        // Get the latest state by reading from the setter
        setPendingImages(currentImages => {
          setImagePrompts(currentPrompts => {
            autoSave("images", { imageUrls: currentImages, imagePrompts: currentPrompts });
            return currentPrompts; // No change, just reading
          });
          return currentImages; // No change, just reading
        });
      }, 100);

      toast({
        title: "Images Regenerated",
        description: `${indices.length} images have been regenerated.`,
      });

    } catch (error) {
      console.error("Batch regeneration error:", error);
      toast({
        title: "Regeneration Failed",
        description: error instanceof Error ? error.message : "Failed to regenerate images",
        variant: "destructive",
      });
    } finally {
      setRegeneratingImageIndices(new Set());
    }
  };

  // Step 5: Complete - show results
  const handleImagesConfirmWithImages = (images: string[]) => {
    const assets: GeneratedAsset[] = [
      {
        id: "script",
        name: "Rewritten Script",
        type: "Markdown",
        size: `${Math.round(confirmedScript.length / 1024)} KB`,
        icon: <FileText className="w-5 h-5 text-muted-foreground" />,
        content: confirmedScript,
      },
      {
        id: "audio",
        name: "Voiceover Audio",
        type: "MP3",
        size: pendingAudioSize ? `${(pendingAudioSize / (1024 * 1024)).toFixed(1)} MB` : "Unknown",
        icon: <Mic className="w-5 h-5 text-muted-foreground" />,
        url: pendingAudioUrl,
      },
      {
        id: "captions",
        name: "Captions",
        type: "SRT",
        size: pendingSrtContent ? `${Math.round(pendingSrtContent.length / 1024)} KB` : "Unknown",
        icon: <FileText className="w-5 h-5 text-muted-foreground" />,
        url: pendingSrtUrl,
        content: pendingSrtContent,
      },
    ];

    images.forEach((imageUrl, index) => {
      assets.push({
        id: `image-${index + 1}`,
        name: `Image ${index + 1}`,
        type: "PNG",
        size: "~1 MB",
        icon: <Image className="w-5 h-5 text-muted-foreground" />,
        url: imageUrl,
      });
    });

    setGeneratedAssets(assets);
    setAudioUrl(pendingAudioUrl);
    setSrtContent(pendingSrtContent);
    setViewState("results");

    // Mark project as completed in the unified store
    // No clearProject needed - just change status
    console.log("[finishGeneration] Marking project as completed:", projectId);
    completeProject(projectId).catch(err =>
      console.error('[finishGeneration] Failed to complete project:', err)
    );

    toast({
      title: "Generation Complete!",
      description: "Your history video assets are ready.",
    });
  };

  const handleImagesConfirm = async () => {
    // NEW WORKFLOW: After images confirmed, generate video clips from first 12 images
    // Full Auto: auto-generate clips and continue to render
    // Step-by-step: generate clips and show review

    if (pendingImages.length === 0) {
      console.warn("No images to generate videos from");
      handleGoToRender();
      return;
    }

    // Take first 12 images for video clips (60 seconds at 5s per clip)
    const VIDEO_CLIP_COUNT = 12;
    const CLIP_DURATION = 5; // seconds per clip
    const imagesToAnimate = pendingImages.slice(0, VIDEO_CLIP_COUNT);
    const promptsForClips = imagePrompts.slice(0, VIDEO_CLIP_COUNT);

    if (imagesToAnimate.length === 0) {
      console.warn("No images available for video clips");
      handleGoToRender();
      return;
    }

    console.log(`[Video Generation] Animating first ${imagesToAnimate.length} images as video clips`);
    console.log(`[Video Generation] Image URLs to animate:`, imagesToAnimate.map((url, i) => ({ clipIndex: i + 1, imageUrl: url?.substring(0, 80) + '...' })));
    console.log(`[Video Generation] Prompts for clips:`, promptsForClips.map((p, i) => ({ promptIndex: p.index, arrayIndex: i, prompt: p.prompt?.substring(0, 50) + '...' })));

    const steps: GenerationStep[] = [
      { id: "clips", label: "Generating Video Clips from Images", status: "pending" },
    ];

    setProcessingSteps(steps);
    setProcessingTitle("Creating Video Intro Clips...");
    setViewState("processing");

    try {
      updateStep("clips", "active", `0/${imagesToAnimate.length} (0%)`);

      // Create clip prompts from image prompts + image URLs
      // IMPORTANT: Use prompt.index (1-based) to get correct image from array (0-indexed)
      // This ensures clip N uses image N, regardless of array order
      const clipPromptsForVideo: ClipPrompt[] = promptsForClips.map((p) => ({
        index: p.index,  // Use the prompt's actual index
        startSeconds: (p.index - 1) * CLIP_DURATION,
        endSeconds: p.index * CLIP_DURATION,
        prompt: p.prompt,
        sceneDescription: p.prompt, // Use image prompt as scene description
        imageUrl: imagesToAnimate[p.index - 1],  // Use prompt.index-1 to get correct image
      }));

      console.log(`[Video Generation] Created ${clipPromptsForVideo.length} clip prompts:`,
        clipPromptsForVideo.map(c => ({ index: c.index, hasImageUrl: !!c.imageUrl, imageUrlPreview: c.imageUrl?.substring(0, 60) })));

      // Generate video clips
      const clipsResult = await generateVideoClipsStreaming(
        projectId,
        clipPromptsForVideo,
        (completed, total) => {
          const percent = Math.round((completed / total) * 100);
          updateStep("clips", "active", `${completed}/${total} clips (${percent}%)`);
        }
      );

      if (!clipsResult.success) {
        console.error('Video clip generation failed:', clipsResult.error);
        toast({
          title: "Clip Generation Issue",
          description: clipsResult.error || "Some clips may not have generated",
          variant: "destructive",
        });
      }

      updateStep("clips", "completed", "Done");
      setClipPrompts(clipPromptsForVideo);
      setGeneratedClips(clipsResult.clips || []);

      // Clear existing video URLs since clips changed - user needs to re-render
      setVideoUrl(undefined);
      setSmokeEmbersVideoUrl(undefined);

      // Save clips to project
      autoSave("prompts", {
        clipPrompts: clipPromptsForVideo,
        clips: clipsResult.clips || [],
        videoUrl: undefined,
        smokeEmbersVideoUrl: undefined
      });

      await new Promise(resolve => setTimeout(resolve, 300));

      // Full Auto: continue to render; Step-by-step: show clips review
      if (settings.fullAutomation) {
        console.log("[Full Automation] Video clips done, proceeding to render...");
        handleGoToRender();
      } else {
        setViewState("review-clips");
      }

    } catch (error) {
      console.error("Video clip generation error:", error);
      toast({
        title: "Video Generation Failed",
        description: error instanceof Error ? error.message : "An error occurred.",
        variant: "destructive",
      });
      // On error, skip videos and go to render
      handleGoToRender();
    }
  };

  // Thumbnail handlers
  const handleThumbnailsConfirm = (thumbnails: string[], selectedIndex: number | undefined) => {
    setGeneratedThumbnails(thumbnails);
    setSelectedThumbnailIndex(selectedIndex);
    // Save thumbnails to project
    autoSave("complete", {
      thumbnails,
      selectedThumbnailIndex: selectedIndex,
    });
    // Go to YouTube upload step
    setViewState("review-youtube");
  };

  const handleThumbnailsSkip = () => {
    setGeneratedThumbnails([]);
    setSelectedThumbnailIndex(undefined);
    // Go to YouTube upload step
    setViewState("review-youtube");
  };

  // Favorite thumbnail toggle (persisted to Supabase)
  const handleFavoriteThumbnailToggle = async (url: string) => {
    if (!projectId) return;
    // Optimistic update
    setFavoriteThumbnails(prev =>
      prev.includes(url) ? prev.filter(u => u !== url) : [...prev, url]
    );
    try {
      const updated = await toggleFavoriteThumbnail(projectId, url);
      setFavoriteThumbnails(updated);
    } catch (error) {
      console.error('Failed to toggle favorite thumbnail:', error);
    }
  };

  // Video render handler (2-pass: basic + effects)
  const handleRenderConfirm = (basicVideoUrl: string, effectsVideoUrl: string) => {
    // Save both video URLs
    setVideoUrl(basicVideoUrl);
    setRenderedVideoUrl(effectsVideoUrl);
    setSmokeEmbersVideoUrl(effectsVideoUrl);
    autoSave("complete", { videoUrl: basicVideoUrl, smokeEmbersVideoUrl: effectsVideoUrl });
    // Go to thumbnails step
    setViewState("review-thumbnails");
  };

  const handleRenderSkip = () => {
    // Skip to thumbnails without rendering
    setViewState("review-thumbnails");
  };

  const handleBackToImages = () => {
    setSettings(prev => ({ ...prev, fullAutomation: false }));
    // Delay viewState change to ensure fullAutomation: false is processed first
    setTimeout(() => setViewState("review-images"), 50);
  };

  const handleBackToRender = () => {
    setSettings(prev => ({ ...prev, fullAutomation: false }));
    handleGoToRender();
  };

  // Ensure audio is recombined before going to render (if segments were regenerated)
  const handleGoToRender = async () => {
    // If segments were regenerated, recombine audio first
    if (segmentsNeedRecombine && pendingAudioSegments.length > 0) {
      console.log("Recombining audio before render...");

      // Show a quick toast to indicate recombining
      toast({
        title: "Updating Audio",
        description: "Recombining audio segments before render...",
      });

      try {
        const recombineResult = await recombineAudioSegments(projectId, pendingAudioSegments.length);

        if (!recombineResult.success || !recombineResult.audioUrl) {
          throw new Error(recombineResult.error || "Failed to recombine audio segments");
        }

        // Update the audio URL with the recombined version
        setPendingAudioUrl(recombineResult.audioUrl);
        if (recombineResult.duration) setPendingAudioDuration(recombineResult.duration);
        if (recombineResult.size) setPendingAudioSize(recombineResult.size);
        setSegmentsNeedRecombine(false);

        // Save recombined audio URL and clear the flag
        autoSave("audio", {
          audioUrl: recombineResult.audioUrl,
          audioDuration: recombineResult.duration,
          segmentsNeedRecombine: false,
        });

        console.log(`Recombined audio ready: ${recombineResult.audioUrl}`);

        toast({
          title: "Audio Updated",
          description: "Audio segments recombined successfully.",
        });
      } catch (error) {
        console.error("Failed to recombine audio:", error);
        toast({
          title: "Audio Update Failed",
          description: error instanceof Error ? error.message : "Failed to recombine audio",
          variant: "destructive",
        });
        // Still proceed to render - the user can re-render after fixing
      }
    }

    setViewState("review-render");
  };

  // Recombine audio and return the new URL (for VideoRenderModal to call before rendering)
  const handleRecombineForRender = async (): Promise<string> => {
    console.log("Recombining audio for render...");

    const recombineResult = await recombineAudioSegments(projectId, pendingAudioSegments.length);

    if (!recombineResult.success || !recombineResult.audioUrl) {
      throw new Error(recombineResult.error || "Failed to recombine audio segments");
    }

    // Update state
    setPendingAudioUrl(recombineResult.audioUrl);
    if (recombineResult.duration) setPendingAudioDuration(recombineResult.duration);
    if (recombineResult.size) setPendingAudioSize(recombineResult.size);
    setSegmentsNeedRecombine(false);

    // Save recombined audio URL and clear the flag
    autoSave("audio", {
      audioUrl: recombineResult.audioUrl,
      audioDuration: recombineResult.duration,
      segmentsNeedRecombine: false,
    });

    console.log(`Recombined audio for render: ${recombineResult.audioUrl}`);
    return recombineResult.audioUrl;
  };

  const handleBackToThumbnails = () => {
    setSettings(prev => ({ ...prev, fullAutomation: false }));
    // Delay viewState change to ensure fullAutomation: false is processed first
    setTimeout(() => setViewState("review-thumbnails"), 50);
  };

  // YouTube upload handlers
  const handleYouTubeComplete = () => {
    // Go to Short Hook selection
    disableAutoAndGoTo("review-short-hook");
  };

  const handleYouTubeSkip = () => {
    // Go to Short Hook selection
    disableAutoAndGoTo("review-short-hook");
  };

  // Short handlers
  const handleShortHookConfirm = (hookStyle: string, script: string) => {
    setShortHookStyle(hookStyle);
    setShortScript(script);
    setViewState("review-short-generate");
  };

  const handleShortGenerationComplete = (result: {
    shortUrl: string;
    audioUrl: string;
    srtContent: string;
    imageUrls: string[];
    duration: number;
  }) => {
    setShortUrl(result.shortUrl);
    setShortAudioUrl(result.audioUrl);
    setShortSrtContent(result.srtContent);
    setShortImageUrls(result.imageUrls);
    setShortDuration(result.duration);
    setViewState("review-short-preview");
  };

  const handleShortPreviewComplete = () => {
    // Go to results
    handleImagesConfirmWithImages(pendingImages);
  };

  const handleShortSkipToResults = () => {
    // Go directly to results
    handleImagesConfirmWithImages(pendingImages);
  };

  const handleBackToYouTube = () => {
    disableAutoAndGoTo("review-youtube");
  };

  const handleBackToShortHook = () => {
    disableAutoAndGoTo("review-short-hook");
  };

  const handleShortRegenerate = () => {
    // Go back to hook selection to regenerate with different hook
    disableAutoAndGoTo("review-short-hook");
  };

  const resetPendingState = () => {
    // CRITICAL: Reset projectId to ensure new projects get new UUIDs
    // This prevents overwriting existing project files
    setProjectId("");
    setGeneratedAssets([]);
    setAudioUrl(undefined);
    setSrtContent(undefined);
    setPendingScript("");
    setConfirmedScript("");
    setPendingAudioUrl("");
    setPendingAudioDuration(0);
    setPendingAudioSize(0);
    setPendingAudioSegments([]);
    setRegeneratingSegmentIndex(null);
    setPendingSrtContent("");
    setPendingSrtUrl("");
    setPendingImages([]);
    setGeneratedThumbnails([]);
    setSelectedThumbnailIndex(undefined);
    setFavoriteThumbnails([]);
    setRenderedVideoUrl(undefined);
    setVideoUrl(undefined);
    setVideoUrlCaptioned(undefined);
    setEmbersVideoUrl(undefined);
    setSmokeEmbersVideoUrl(undefined);
    setImagePrompts([]);
    // Reset YouTube metadata
    setYoutubeTitle("");
    setYoutubeDescription("");
    setYoutubeTags("");
    setYoutubeCategoryId("27");
    setYoutubePlaylistId(null);
    // Reset Short state
    setShortHookStyle("");
    setShortScript("");
    setShortUrl("");
    setShortAudioUrl("");
    setShortSrtContent("");
    setShortImageUrls([]);
    setShortDuration(0);
  };

  const handleCancelRequest = () => {
    // Auto-save is always enabled, so no confirmation needed
    // CRITICAL: Disable fullAutomation when closing modals to prevent auto-generation
    // when user is just viewing assets (not actively generating)
    setSettings(prev => ({ ...prev, fullAutomation: false }));

    // Delay viewState change to ensure fullAutomation: false is processed first
    // This prevents race conditions where useEffect sees new viewState with old settings
    setTimeout(() => {
      // If we have a loaded project, go back to results without resetting assets
      // Otherwise reset everything and go to create page
      if (generatedAssets.length > 0) {
        setViewState("results");
      } else {
        resetPendingState();
        setViewState("create");
      }
    }, 50);
  };

  // Back navigation handlers - disable fullAutomation when manually navigating back
  // Use setTimeout to ensure settings update is processed before viewState change
  // This prevents race conditions where useEffect sees new viewState with old settings
  const disableAutoAndGoTo = (view: ViewState) => {
    setSettings(prev => ({ ...prev, fullAutomation: false }));
    // Delay viewState change to ensure fullAutomation: false is processed first
    setTimeout(() => setViewState(view), 50);
  };

  const handleBackToCreate = () => {
    disableAutoAndGoTo("create");
  };

  const handleBackToScript = () => {
    disableAutoAndGoTo("review-script");
  };

  // Quick edit script with AI fix prompt (targeted edits, much faster)
  const handleScriptRegenerate = async (fixPrompt: string) => {
    // Stay on review-script, show progress inline
    setScriptRegenProgress(10); // Show some initial progress

    try {
      // Use quick edit for targeted fixes (much faster than full regeneration)
      const editResult = await quickEditScript(pendingScript, fixPrompt);

      if (!editResult.success || !editResult.script) {
        throw new Error(editResult.error || "Failed to edit script");
      }

      setScriptRegenProgress(90);

      setPendingScript(editResult.script);

      // Auto-save the edited script
      if (projectId) {
        autoSave("script", {
          id: projectId,
          script: editResult.script
        });
      }

      toast({
        title: "Script Updated",
        description: "Targeted edits applied. Re-rating...",
      });
    } catch (error) {
      console.error("Script edit error:", error);
      toast({
        title: "Edit Failed",
        description: error instanceof Error ? error.message : "Failed to edit script",
        variant: "destructive",
      });
    } finally {
      setScriptRegenProgress(null);
    }
  };

  const handleBackToAudio = () => {
    disableAutoAndGoTo("review-audio");
  };

  const handleBackToCaptions = () => {
    disableAutoAndGoTo("review-captions");
  };

  const handleBackToPrompts = () => {
    disableAutoAndGoTo("review-prompts");
  };

  const handleBackToClipPrompts = () => {
    disableAutoAndGoTo("review-clip-prompts");
  };

  const handleBackToClips = () => {
    disableAutoAndGoTo("review-clips");
  };

  // Forward navigation handlers (to skip ahead if data already exists)
  // These disable fullAutomation because user is manually navigating
  const handleForwardToAudio = () => {
    if (pendingAudioUrl || pendingAudioSegments.length > 0) {
      disableAutoAndGoTo("review-audio");
    }
  };

  const handleForwardToCaptions = () => {
    if (pendingSrtContent) {
      disableAutoAndGoTo("review-captions");
    }
  };

  const handleForwardToClipPrompts = () => {
    if (clipPrompts.length > 0) {
      disableAutoAndGoTo("review-clip-prompts");
    }
  };

  const handleForwardToPrompts = () => {
    if (imagePrompts.length > 0) {
      disableAutoAndGoTo("review-prompts");
    }
  };

  const handleForwardToImages = () => {
    if (pendingImages.length > 0) {
      disableAutoAndGoTo("review-images");
    }
  };

  // Check if forward navigation is available for each step
  const canGoForwardFromScript = () => pendingAudioUrl || pendingAudioSegments.length > 0;
  const canGoForwardFromAudio = () => !!pendingSrtContent;
  const canGoForwardFromCaptionsToClipPrompts = () => clipPrompts.length > 0;
  const canGoForwardFromCaptions = () => imagePrompts.length > 0;
  const canGoForwardFromPrompts = () => pendingImages.length > 0;

  // Handle pipeline step approval
  const handleApproveStep = (step: PipelineStep, approved: boolean) => {
    setApprovedSteps(prev => {
      if (approved) {
        // Add step if not already approved
        return prev.includes(step) ? prev : [...prev, step];
      } else {
        // Remove step from approved list
        return prev.filter(s => s !== step);
      }
    });
    // Save approval to project
    const newApprovedSteps = approved
      ? (approvedSteps.includes(step) ? approvedSteps : [...approvedSteps, step])
      : approvedSteps.filter(s => s !== step);
    autoSave("complete", { approvedSteps: newApprovedSteps });
  };

  // Save a version of the current project
  const handleSaveVersion = async () => {
    if (!projectId) {
      toast({
        title: "No Project",
        description: "No project to save a version of.",
        variant: "destructive",
      });
      return;
    }

    try {
      const newVersionId = await createProjectVersion(projectId);
      toast({
        title: "Version Saved",
        description: `Saved version of "${videoTitle}"`,
      });
      console.log(`[handleSaveVersion] Created version ${newVersionId} for project ${projectId}`);
    } catch (error) {
      console.error('[handleSaveVersion] Error:', error);
      toast({
        title: "Save Failed",
        description: "Failed to save version.",
        variant: "destructive",
      });
    }
  };

  // Duplicate the current project as an independent copy
  const handleDuplicate = async () => {
    if (!projectId) {
      toast({
        title: "No Project",
        description: "No project to duplicate.",
        variant: "destructive",
      });
      return;
    }

    try {
      const newId = await duplicateProject(projectId);
      toast({
        title: "Project Duplicated",
        description: `Created copy of "${videoTitle}"`,
      });
      console.log(`[handleDuplicate] Duplicated project ${projectId} as ${newId}`);
      // Optionally navigate to the new project - for now just show success
    } catch (error) {
      console.error('[handleDuplicate] Error:', error);
      toast({
        title: "Duplicate Failed",
        description: "Failed to duplicate project.",
        variant: "destructive",
      });
    }
  };

  // Handle audio file upload for "Generate Captions" mode
  const handleAudioFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setUploadedAudioFile(file);
    }
  };

  // Handle script file upload for "Generate Images" mode
  const handleScriptFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const text = await file.text();
      setUploadedScript(text);
    }
  };

  // Handle captions file upload for "Generate Images" mode
  const handleCaptionsFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const text = await file.text();
      setUploadedCaptions(text);
    }
  };

  // Handle audio file upload for "Generate Images" mode
  const handleAudioFileChangeForImages = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setUploadedAudioFileForImages(file);
    }
  };

  // Generate captions from uploaded audio file
  const handleGenerateCaptionsFromAudio = async () => {
    if (!uploadedAudioFile) {
      toast({ title: "No audio file", description: "Please upload an audio file first.", variant: "destructive" });
      return;
    }

    // CRITICAL: Reset all pending state FIRST to clear old project data
    resetPendingState();

    // Set project title
    const title = captionsProjectTitle.trim() || "Untitled Project";
    setVideoTitle(title);

    setViewState("processing");
    setProcessingSteps([{ id: "upload", label: "Uploading audio", status: "active", sublabel: "0%" }]);

    try {
      // Upload the audio file to Supabase storage with progress tracking
      // ALWAYS new project from main page caption mode
      const useProjectId = crypto.randomUUID();
      setProjectId(useProjectId);
      const audioFileName = `${useProjectId}/voiceover.wav`;

      // Use XMLHttpRequest for upload progress
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
      const uploadUrl = `${supabaseUrl}/storage/v1/object/generated-assets/${audioFileName}`;

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', uploadUrl, true);
        xhr.setRequestHeader('Authorization', `Bearer ${supabaseKey}`);
        xhr.setRequestHeader('apikey', supabaseKey);
        xhr.setRequestHeader('x-upsert', 'true');

        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            const percent = Math.round((event.loaded / event.total) * 100);
            setProcessingSteps([{ id: "upload", label: "Uploading audio", status: "active", sublabel: `${percent}%` }]);
          }
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            reject(new Error(`Upload failed: ${xhr.status} ${xhr.statusText}`));
          }
        };

        xhr.onerror = () => reject(new Error('Upload failed'));
        xhr.send(uploadedAudioFile);
      });

      const { data: { publicUrl } } = supabase.storage
        .from("generated-assets")
        .getPublicUrl(audioFileName);

      setPendingAudioUrl(publicUrl);

      // Update to show captions step
      setProcessingSteps([
        { id: "upload", label: "Uploading audio", status: "completed" },
        { id: "captions", label: "Generating captions", status: "active", sublabel: "5%" }
      ]);

      // Generate captions
      const captionsResult = await generateCaptions(
        publicUrl,
        useProjectId,
        (progress, message) => {
          const sublabel = message || `${progress}%`;
          setProcessingSteps([
            { id: "upload", label: "Uploading audio", status: "completed" },
            { id: "captions", label: "Generating captions", status: "active", sublabel }
          ]);
        }
      );

      if (!captionsResult.srtContent) throw new Error("No captions generated");

      setPendingSrtContent(captionsResult.srtContent);
      if (captionsResult.srtUrl) setPendingSrtUrl(captionsResult.srtUrl);
      if (captionsResult.audioDuration) setPendingAudioDuration(captionsResult.audioDuration);

      // Auto-save after captions generation
      // CRITICAL: Explicitly reset asset fields not yet generated to prevent old data bleeding in
      autoSave("captions", {
        id: useProjectId,
        videoTitle: title,
        audioUrl: publicUrl,
        audioDuration: captionsResult.audioDuration,
        srtContent: captionsResult.srtContent,
        srtUrl: captionsResult.captionsUrl || "",
        // Explicitly clear fields not yet generated for new project
        script: undefined,
        audioSegments: [],
        imagePrompts: [],
        imageUrls: [],
        videoUrl: undefined,
        videoUrlCaptioned: undefined,
        embersVideoUrl: undefined,
        smokeEmbersVideoUrl: undefined,
        thumbnails: [],
        selectedThumbnailIndex: undefined,
      });

      setProcessingSteps([
        { id: "upload", label: "Uploading audio", status: "completed" },
        { id: "captions", label: "Captions generated", status: "completed" }
      ]);
      setViewState("review-captions");

    } catch (error) {
      console.error("Error generating captions:", error);
      toast({ title: "Error", description: error instanceof Error ? error.message : "Failed to generate captions", variant: "destructive" });
      setViewState("create");
    }
  };

  // Generate image prompts from uploaded script/captions
  const handleGenerateImagePrompts = async () => {
    const scriptText = uploadedScript.trim();
    const captionsText = uploadedCaptions.trim();

    console.log("Script length:", scriptText.length);
    console.log("Captions length:", captionsText.length);
    console.log("Image count:", settings.imageCount);
    console.log("Style prompt length:", getSelectedImageStyle().length);
    console.log("Audio file:", uploadedAudioFileForImages?.name);

    if (!scriptText) {
      toast({ title: "No script", description: "Please upload or paste a script first.", variant: "destructive" });
      return;
    }
    if (!captionsText) {
      toast({ title: "No captions", description: "Please upload or paste captions (SRT) first.", variant: "destructive" });
      return;
    }

    // CRITICAL: Reset all pending state FIRST to clear old project data
    resetPendingState();

    // Set project title
    const title = imagesProjectTitle.trim() || "Untitled Project";
    setVideoTitle(title);

    // ALWAYS generate new projectId for new entries from main page images mode
    const useProjectId = crypto.randomUUID();
    setProjectId(useProjectId);

    setViewState("processing");
    setProcessingSteps([{ id: "prompts", label: "Generating image prompts...", status: "loading", progress: 10 }]);
    setPendingScript(scriptText);
    setConfirmedScript(scriptText);
    setPendingSrtContent(captionsText);

    try {
      let audioDuration: number | undefined;

      // If audio file provided, upload it and get duration
      if (uploadedAudioFileForImages) {
        setProcessingSteps([{ id: "prompts", label: "Uploading audio file...", status: "loading", progress: 5 }]);

        const audioFileName = `${useProjectId}/voiceover.wav`;
        const { error: uploadError } = await supabase.storage
          .from("generated-assets")
          .upload(audioFileName, uploadedAudioFileForImages);

        if (uploadError) {
          console.error("Audio upload error:", uploadError);
          // Continue without audio duration if upload fails
        } else {
          const { data: { publicUrl } } = supabase.storage
            .from("generated-assets")
            .getPublicUrl(audioFileName);

          setPendingAudioUrl(publicUrl);

          // Get audio duration using Audio element
          audioDuration = await new Promise<number>((resolve) => {
            const audio = new Audio(publicUrl);
            audio.addEventListener('loadedmetadata', () => {
              resolve(audio.duration);
            });
            audio.addEventListener('error', () => {
              console.error("Failed to get audio duration");
              resolve(0);
            });
          });

          if (audioDuration > 0) {
            setPendingAudioDuration(audioDuration);
            console.log("Audio duration:", audioDuration);
          }
        }

        setProcessingSteps([{ id: "prompts", label: "Generating image prompts...", status: "loading", progress: 10 }]);
      }

      const promptsResult = await generateImagePrompts(
        scriptText,
        captionsText,
        settings.imageCount,
        getSelectedImageStyle(),
        true, // Always filter modern keywords
        audioDuration,
        settings.topic, // Era anchor for image generation
        settings.subjectFocus // Who the story focuses on (e.g., servants, workers)
      );

      if (!promptsResult.success) {
        throw new Error(promptsResult.error || "Failed to generate image prompts");
      }

      if (!promptsResult.prompts || promptsResult.prompts.length === 0) {
        throw new Error("No image prompts generated");
      }

      setImagePrompts(promptsResult.prompts);

      // Auto-save after image prompts generation (projectId was set at start of this handler)
      // CRITICAL: Explicitly reset fields not yet generated to prevent old data bleeding in
      autoSave("prompts", {
        id: useProjectId,
        videoTitle: title,
        script: scriptText,
        srtContent: captionsText,
        audioUrl: pendingAudioUrl,
        audioDuration: audioDuration || pendingAudioDuration,
        imagePrompts: promptsResult.prompts,
        // Explicitly clear fields not yet generated for new project
        audioSegments: [],
        imageUrls: [],
        videoUrl: undefined,
        videoUrlCaptioned: undefined,
        embersVideoUrl: undefined,
        smokeEmbersVideoUrl: undefined,
        thumbnails: [],
        selectedThumbnailIndex: undefined,
      });

      setProcessingSteps([{ id: "prompts", label: "Image prompts generated", status: "complete", progress: 100 }]);
      setViewState("review-prompts");

    } catch (error) {
      console.error("Error generating image prompts:", error);
      toast({ title: "Error", description: error instanceof Error ? error.message : "Failed to generate image prompts", variant: "destructive" });
      setViewState("create");
    }
  };

  const handleNewProject = () => {
    console.log("[handleNewProject] User clicked New Project from results page");
    setViewState("create");
    setInputValue("");
    setSourceUrl("");
    setVideoTitle("History Documentary"); // Reset to default title
    resetPendingState(); // This also resets projectId to "" so new project gets new UUID
    setApprovedSteps([]);  // Clear approvals for new project
    // No clearProject needed - new project will be a new entry in the store
  };

  // Open a project from history
  // Helper to reconstruct audio segments from storage for old projects
  const reconstructAudioSegments = async (projectId: string, script: string): Promise<AudioSegment[]> => {
    const segments: AudioSegment[] = [];
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;

    // Try to find segment files (1-10)
    for (let i = 1; i <= 10; i++) {
      const segmentPath = `${projectId}/voiceover-segment-${i}.wav`;
      const { data } = await supabase.storage
        .from('generated-assets')
        .createSignedUrl(segmentPath, 3600);

      if (data?.signedUrl) {
        // Split script into roughly equal parts for text approximation
        const scriptParts = script.split(/[.!?]+/).filter(s => s.trim());
        const partSize = Math.ceil(scriptParts.length / 10);
        const startIdx = (i - 1) * partSize;
        const endIdx = Math.min(i * partSize, scriptParts.length);
        const segmentText = scriptParts.slice(startIdx, endIdx).join('. ').trim() + '.';

        segments.push({
          index: i,
          audioUrl: data.signedUrl,
          text: segmentText || `Segment ${i}`,
          duration: 0, // Unknown without fetching audio
          size: 0,
        });
      }
    }

    return segments;
  };

  const handleOpenProject = async (projectFromList: Project) => {
    // Fetch full project data (drawer only has minimal fields for performance)
    const project = await getProject(projectFromList.id);
    if (!project) {
      toast({
        title: "Error",
        description: "Failed to load project data",
        variant: "destructive",
      });
      return;
    }

    // Disable fullAutomation when manually opening a project
    // User wants to review/edit, not auto-skip steps
    setSettings(prev => ({ ...prev, fullAutomation: false }));

    // CRITICAL: Reset ALL state first before loading new project
    // Without this, old project data persists when new project lacks certain fields
    setPendingScript("");
    setConfirmedScript("");
    setPendingAudioUrl("");
    setAudioUrl("");
    setPendingAudioDuration(0);
    setPendingAudioSegments([]);
    setPendingSrtContent("");
    setSrtContent("");
    setPendingSrtUrl("");
    setPendingImages([]);
    setImagePrompts([]);
    setVideoUrl(undefined);
    setVideoUrlCaptioned(undefined);
    setEmbersVideoUrl(undefined);
    setSmokeEmbersVideoUrl(undefined);
    setRenderedVideoUrl(undefined);
    setGeneratedThumbnails([]);
    setSelectedThumbnailIndex(undefined);
    setFavoriteThumbnails([]);
    setApprovedSteps([]);
    setYoutubeTitle("");
    setYoutubeDescription("");
    setYoutubeTags("");
    setYoutubeCategoryId("27");
    setYoutubePlaylistId(null);
    setClipPrompts([]);
    setGeneratedClips([]);
    setGeneratedAssets([]);

    // Set project state
    setProjectId(project.id);
    setVideoTitle(project.videoTitle);
    setSourceUrl(project.sourceUrl || "");
    // Restore pipeline status
    if (project.status) {
      setProjectStatus(project.status as typeof projectStatus);
    }
    if (project.currentStep) {
      setPipelineCurrentStep(project.currentStep);
    }

    // Set asset state for ALL views (so back navigation works)
    if (project.script) {
      setPendingScript(project.script);
      setConfirmedScript(project.script);
    }
    if (project.audioUrl) {
      setPendingAudioUrl(project.audioUrl);
      setAudioUrl(project.audioUrl);
    }
    if (project.audioDuration) setPendingAudioDuration(project.audioDuration);

    // Load audio segments - reconstruct from storage if missing
    if (project.audioSegments && project.audioSegments.length > 0) {
      setPendingAudioSegments(project.audioSegments);
      if (project.segmentsNeedRecombine) setSegmentsNeedRecombine(project.segmentsNeedRecombine);
    } else if (project.audioUrl && project.script) {
      // Old project without segments - try to reconstruct from storage
      const reconstructed = await reconstructAudioSegments(project.id, project.script);
      if (reconstructed.length > 0) {
        setPendingAudioSegments(reconstructed);
        // Save reconstructed segments to project for future
        upsertProject({
          id: project.id,
          audioSegments: reconstructed,
        }).catch(err => console.error('[handleOpenProject] Failed to save reconstructed segments:', err));
      }
    }

    if (project.srtContent) {
      setPendingSrtContent(project.srtContent);
      setSrtContent(project.srtContent);
    }
    if (project.srtUrl) setPendingSrtUrl(project.srtUrl);

    // Load images - with AUTO-RECOVERY if images seem missing
    const expectedImageCount = project.imagePrompts?.length || 0;
    const actualImageCount = project.imageUrls?.length || 0;

    // Auto-recover if images are suspiciously low (less than 50% of prompts)
    if (expectedImageCount > 0 && actualImageCount < expectedImageCount * 0.5) {
      console.log(`[handleOpenProject] Image count mismatch: ${actualImageCount} images vs ${expectedImageCount} prompts. Auto-recovering from storage...`);

      // Try to reconnect images from storage
      const { reconnectOrphanedImages } = await import('@/lib/api');
      const reconnectResult = await reconnectOrphanedImages(project.id);

      if (reconnectResult.success && reconnectResult.imageUrls && reconnectResult.imageUrls.length > actualImageCount) {
        console.log(`[handleOpenProject] Recovered ${reconnectResult.imageUrls.length} images from storage!`);
        setPendingImages(reconnectResult.imageUrls);
        // Save recovered images back to database
        upsertProject({
          id: project.id,
          imageUrls: reconnectResult.imageUrls,
        }).catch(err => console.error('[handleOpenProject] Failed to save recovered images:', err));

        toast({
          title: "Images Recovered",
          description: `Found ${reconnectResult.imageUrls.length} images in storage (was showing ${actualImageCount})`,
        });
      } else if (project.imageUrls) {
        // Fallback to whatever we have
        setPendingImages(project.imageUrls);
      }
    } else if (project.imageUrls) {
      setPendingImages(project.imageUrls);
    }

    // Use stored image prompts if available, otherwise create basic ones
    if (project.imagePrompts && project.imagePrompts.length > 0) {
      // Validate and re-index prompts if needed (ensure 1-based indexing)
      const reindexedPrompts = project.imagePrompts.map((p, arrayIndex) => ({
        ...p,
        index: arrayIndex + 1,  // Force 1-based indexing based on array position
      }));
      console.log(`[handleOpenProject] Loading ${reindexedPrompts.length} imagePrompts (re-indexed to 1-based)`);
      setImagePrompts(reindexedPrompts);
    } else if (project.imageUrls) {
      const basicPrompts: ImagePromptWithTiming[] = project.imageUrls.map((url, index) => ({
        index: index + 1,
        startTime: "",
        endTime: "",
        startSeconds: 0,
        endSeconds: 0,
        prompt: "",
        sceneDescription: `Image ${index + 1}`,
      }));
      setImagePrompts(basicPrompts);
    }
    // Load clip prompts and video clips with validation
    if (project.clipPrompts) {
      // Filter out any prompts with invalid indexes and re-index if needed
      const validPrompts = project.clipPrompts.filter(p => p.index >= 1);
      if (validPrompts.length !== project.clipPrompts.length) {
        console.warn(`[handleOpenProject] Filtered out ${project.clipPrompts.length - validPrompts.length} invalid clipPrompts (index < 1)`);
      }
      console.log(`[handleOpenProject] Loading ${validPrompts.length} clipPrompts:`, validPrompts.map(p => ({ index: p.index, hasImageUrl: !!p.imageUrl })));
      setClipPrompts(validPrompts);
    }
    if (project.clips) {
      // Filter out any clips with invalid indexes
      const validClips = project.clips.filter(c => c.index >= 1);
      if (validClips.length !== project.clips.length) {
        console.warn(`[handleOpenProject] Filtered out ${project.clips.length - validClips.length} invalid clips (index < 1). Original indexes:`, project.clips.map(c => c.index));
      }
      console.log(`[handleOpenProject] Loading ${validClips.length} clips:`, validClips.map(c => ({ index: c.index, hasVideoUrl: !!c.videoUrl })));
      setGeneratedClips(validClips);
    }

    // Load video URLs if available
    if (project.videoUrl) {
      setVideoUrl(project.videoUrl);
    }
    if (project.videoUrlCaptioned) {
      setVideoUrlCaptioned(project.videoUrlCaptioned);
    }
    if (project.embersVideoUrl) {
      setEmbersVideoUrl(project.embersVideoUrl);
    }
    if (project.smokeEmbersVideoUrl) {
      setSmokeEmbersVideoUrl(project.smokeEmbersVideoUrl);
    }
    if (project.thumbnails) {
      setGeneratedThumbnails(project.thumbnails);
    }
    if (project.selectedThumbnailIndex !== undefined) {
      setSelectedThumbnailIndex(project.selectedThumbnailIndex);
    }
    if (project.favoriteThumbnails) {
      setFavoriteThumbnails(project.favoriteThumbnails);
    }
    if (project.approvedSteps) {
      setApprovedSteps(project.approvedSteps);
    }
    // Restore YouTube metadata
    if (project.youtubeTitle) setYoutubeTitle(project.youtubeTitle);
    if (project.youtubeDescription) setYoutubeDescription(project.youtubeDescription);
    if (project.youtubeTags) setYoutubeTags(project.youtubeTags);
    if (project.youtubeCategoryId) setYoutubeCategoryId(project.youtubeCategoryId);
    if (project.youtubePlaylistId !== undefined) setYoutubePlaylistId(project.youtubePlaylistId);

    // Restore project tags
    if (project.tags) setProjectTags(project.tags);

    // Build generated assets for results view
    const assets: GeneratedAsset[] = [];
    if (project.script) {
      assets.push({
        id: "script",
        name: "Rewritten Script",
        type: "Markdown",
        size: `${Math.round(project.script.length / 1024)} KB`,
        icon: <FileText className="w-5 h-5 text-muted-foreground" />,
        content: project.script,
      });
    }
    if (project.audioUrl) {
      assets.push({
        id: "audio",
        name: "Voiceover Audio",
        type: "MP3",
        size: project.audioDuration ? `${Math.round(project.audioDuration / 60)} min` : "Unknown",
        icon: <Mic className="w-5 h-5 text-muted-foreground" />,
        url: project.audioUrl,
      });
    }
    if (project.srtContent) {
      assets.push({
        id: "captions",
        name: "Captions",
        type: "SRT",
        size: `${Math.round(project.srtContent.length / 1024)} KB`,
        icon: <FileText className="w-5 h-5 text-muted-foreground" />,
        url: project.srtUrl,
        content: project.srtContent,
      });
    }
    if (project.imageUrls) {
      project.imageUrls.forEach((imageUrl, index) => {
        assets.push({
          id: `image-${index + 1}`,
          name: `Image ${index + 1}`,
          type: "PNG",
          size: "~1 MB",
          icon: <Image className="w-5 h-5 text-muted-foreground" />,
          url: imageUrl,
        });
      });
    }
    setGeneratedAssets(assets);

    // Go to results page (last step with all downloads)
    setViewState("results");

    // Update project's updated_at to bring it to top of list
    try {
      await upsertProject({ id: project.id });
      console.log('[handleOpenProject] Updated timestamp for project:', project.id);
    } catch (err) {
      console.error('[handleOpenProject] Failed to update timestamp:', err);
    }

    toast({
      title: "Project Opened",
      description: `Loaded "${project.videoTitle}"`,
    });
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="container mx-auto px-6 h-16 flex items-center justify-between">
          <button
            onClick={() => setViewState("create")}
            className="flex items-center gap-3 hover:opacity-80 transition-opacity"
          >
            <div className="w-9 h-9 bg-primary rounded-lg flex items-center justify-center">
              <Zap className="w-5 h-5 text-primary-foreground" />
            </div>
            <span className="text-lg font-semibold text-foreground">
              AUTO AI GEN
            </span>
          </button>
          
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="gap-2 text-muted-foreground hover:text-foreground"
              onClick={() => navigate('/auto-poster')}
            >
              <Bot className="w-4 h-4" />
              <span className="hidden sm:inline">Auto Poster</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="gap-2 text-muted-foreground hover:text-foreground"
              onClick={() => navigate('/video-analysis')}
            >
              <Video className="w-4 h-4" />
              <span className="hidden sm:inline">Analysis</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="gap-2 text-muted-foreground hover:text-foreground"
              onClick={() => navigate('/video-editor')}
            >
              <Wand2 className="w-4 h-4" />
              <span className="hidden sm:inline">Editor</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={`gap-2 ${viewState === "outlier-finder" ? "text-foreground bg-accent" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => setViewState("outlier-finder")}
            >
              <TrendingUp className="w-4 h-4" />
              <span className="hidden sm:inline">Outliers</span>
            </Button>
            <ConfigModal
              scriptTemplates={scriptTemplates}
              onSaveScriptTemplates={handleSaveScriptTemplates}
              imageTemplates={imageTemplates}
              onSaveImageTemplates={handleSaveImageTemplates}
              cartesiaVoices={cartesiaVoices}
              onSaveVoices={handleSaveVoices}
              voiceSettings={{
                voiceSampleUrl: settings.voiceSampleUrl,
                ttsEmotionMarker: settings.ttsEmotionMarker,
                ttsTemperature: settings.ttsTemperature,
                ttsTopP: settings.ttsTopP,
                ttsRepetitionPenalty: settings.ttsRepetitionPenalty,
                speed: settings.speed,
              }}
              onVoiceSettingsChange={(voiceSettings) => {
                setSettings(prev => ({ ...prev, ...voiceSettings }));
              }}
            />
            <ProjectsDrawer onOpenProject={handleOpenProject} onViewFavorites={() => setViewState("favorites")} />
          </div>
        </div>
      </header>

      {/* Main Content */}
      {viewState === "outlier-finder" ? (
        <OutlierFinderView
          onBack={() => setViewState("create")}
          onSelectVideo={handleSelectOutlierVideo}
        />
      ) : viewState === "favorites" ? (
        <FavoritesView
          onSelectProject={handleOpenProject}
          onBack={() => setViewState("create")}
        />
      ) : viewState === "results" ? (
        <ProjectResults
          sourceUrl={sourceUrl}
          onNewProject={handleNewProject}
          onBack={handleBackToThumbnails}
          assets={generatedAssets}
          srtContent={srtContent}
          imagePrompts={imagePrompts}
          audioUrl={audioUrl}
          audioDuration={pendingAudioDuration}
          projectTitle={videoTitle}
          projectId={projectId}
          videoUrl={videoUrl}
          videoUrlCaptioned={videoUrlCaptioned}
          embersVideoUrl={embersVideoUrl}
          smokeEmbersVideoUrl={smokeEmbersVideoUrl}
          onVideoRendered={(url) => {
            setVideoUrl(url);
            // Save to current project (upsert handles both in_progress and completed)
            autoSave("complete", { videoUrl: url });
          }}
          onCaptionedVideoRendered={(url) => {
            setVideoUrlCaptioned(url);
            autoSave("complete", { videoUrlCaptioned: url });
          }}
          onEmbersVideoRendered={(url) => {
            setEmbersVideoUrl(url);
            autoSave("complete", { embersVideoUrl: url });
          }}
          onSmokeEmbersVideoRendered={(url) => {
            console.log('[Index] onSmokeEmbersVideoRendered called with:', url);
            setSmokeEmbersVideoUrl(url);
            autoSave("complete", { smokeEmbersVideoUrl: url });
          }}
          thumbnails={generatedThumbnails}
          selectedThumbnailIndex={selectedThumbnailIndex}
          script={confirmedScript}
          clipPrompts={clipPrompts.map(p => p.sceneDescription)}
          clipUrls={generatedClips.map(c => c.videoUrl)}
          onGoToScript={handleBackToScript}
          onGoToAudio={handleBackToAudio}
          onGoToCaptions={handleBackToCaptions}
          onGoToClipPrompts={handleBackToClipPrompts}
          onGoToClips={handleBackToClips}
          onGoToPrompts={handleBackToPrompts}
          onGoToImages={handleBackToImages}
          onGoToScanner={() => setViewState("review-scanner")}
          onGoToThumbnails={handleBackToThumbnails}
          onGoToRender={handleBackToRender}
          onImagePromptsHealed={(healedPrompts) => {
            console.log(`[Index] Healed image prompts: ${healedPrompts.length}`);
            setImagePrompts(healedPrompts);
            // Save healed prompts to project
            autoSave("images", { imagePrompts: healedPrompts });
          }}
          approvedSteps={approvedSteps}
          onApproveStep={handleApproveStep}
          youtubeTitle={youtubeTitle}
          youtubeDescription={youtubeDescription}
          youtubeTags={youtubeTags}
          youtubeCategoryId={youtubeCategoryId}
          youtubePlaylistId={youtubePlaylistId}
          onYouTubeMetadataChange={(title, description, tags, categoryId, playlistId) => {
            setYoutubeTitle(title);
            setYoutubeDescription(description);
            setYoutubeTags(tags);
            setYoutubeCategoryId(categoryId);
            setYoutubePlaylistId(playlistId);
            // Save YouTube metadata to project
            autoSave("complete", {
              youtubeTitle: title,
              youtubeDescription: description,
              youtubeTags: tags,
              youtubeCategoryId: categoryId,
              youtubePlaylistId: playlistId,
            });
          }}
          onSaveVersion={handleSaveVersion}
          onDuplicate={handleDuplicate}
          onTitleChange={(newTitle) => {
            setVideoTitle(newTitle);
            // Save title change to project
            autoSave("complete", { videoTitle: newTitle });
          }}
          onThumbnailUpload={(thumbnailUrl) => {
            // Add uploaded thumbnail to the list
            const updatedThumbnails = [...generatedThumbnails, thumbnailUrl];
            setGeneratedThumbnails(updatedThumbnails);
            // Auto-select the newly uploaded thumbnail
            setSelectedThumbnailIndex(updatedThumbnails.length - 1);
            // Save to project
            autoSave("complete", {
              thumbnails: updatedThumbnails,
              selectedThumbnailIndex: updatedThumbnails.length - 1
            });
          }}
          onScriptUpload={(script) => {
            setConfirmedScript(script);
            setPendingScript(script);
            autoSave("complete", { script });
          }}
          onAudioUpload={(url) => {
            setPendingAudioUrl(url);
            setAudioUrl(url);
            autoSave("complete", { audioUrl: url });
          }}
          onCaptionsUpload={(content) => {
            setPendingSrtContent(content);
            setSrtContent(content);
            autoSave("complete", { srtContent: content });
          }}
          onImagesUpload={(urls) => {
            setPendingImages(urls);
            // Update imagePrompts with new URLs
            const updatedPrompts = imagePrompts.map((prompt, i) => ({
              ...prompt,
              imageUrl: urls[i] || prompt.imageUrl
            }));
            setImagePrompts(updatedPrompts);
            autoSave("complete", { imageUrls: urls, imagePrompts: updatedPrompts });
          }}
          onPromptsUpload={(prompts) => {
            setImagePrompts(prompts);
            autoSave("complete", { imagePrompts: prompts });
          }}
          onVideoUpload={(url, type) => {
            if (type === 'basic') {
              setVideoUrl(url);
              autoSave("complete", { videoUrl: url });
            } else {
              setSmokeEmbersVideoUrl(url);
              autoSave("complete", { smokeEmbersVideoUrl: url });
            }
          }}
          tags={projectTags}
          onTagsChange={(newTags) => {
            setProjectTags(newTags);
            // Save tags to project
            autoSave("complete", { tags: newTags });
          }}
          projectStatus={projectStatus}
          currentStep={pipelineCurrentStep}
          onStopPipeline={async () => {
            try {
              const result = await stopPipeline(projectId);
              if (result.success) {
                toast({
                  title: "Pipeline Stopping",
                  description: result.message,
                });
                // Update local status
                setProjectStatus('cancelled');
                setPipelineCurrentStep(undefined);
              } else {
                toast({
                  title: "Failed to Stop",
                  description: result.error || "Could not stop pipeline",
                  variant: "destructive",
                });
              }
            } catch (err) {
              console.error('[Index] Failed to stop pipeline:', err);
              toast({
                title: "Error",
                description: "Failed to stop pipeline",
                variant: "destructive",
              });
            }
          }}
          // Delete callbacks - clear state and database for regeneration
          onDeleteScript={() => {
            setConfirmedScript("");
            setPendingScript("");
            setGeneratedAssets(prev => prev.filter(a => a.id !== 'script'));
            autoSave("complete", { script: undefined });
          }}
          onDeleteAudio={() => {
            setPendingAudioUrl(undefined);
            setAudioUrl("");
            setPendingAudioDuration(0);
            setGeneratedAssets(prev => prev.filter(a => a.id !== 'audio'));
            autoSave("complete", { audioUrl: undefined, audioDuration: undefined });
          }}
          onDeleteCaptions={() => {
            setPendingSrtContent("");
            setSrtContent("");
            autoSave("complete", { srtContent: undefined });
          }}
          onDeleteImagePrompts={() => {
            // Remember the prompt count before deleting so regeneration uses the same count
            const originalCount = imagePrompts.length;
            if (originalCount > 0) {
              setSettings(prev => ({ ...prev, imageCount: originalCount }));
            }
            setImagePrompts([]);
            autoSave("complete", { imagePrompts: [] });
          }}
          onDeleteImages={async () => {
            // Delete from storage FIRST (permanently removes files)
            if (projectId) {
              const { deleteProjectImages } = await import('@/lib/api');
              const result = await deleteProjectImages(projectId);
              if (result.success) {
                toast({
                  title: "Images Deleted",
                  description: `Removed ${result.deleted} images from storage`,
                });
              } else {
                console.error('[onDeleteImages] Storage deletion failed:', result.error);
              }
            }
            // Then clear local state
            setPendingImages([]);
            setGeneratedAssets(prev => prev.filter(a => !a.id.startsWith('image-')));
            autoSave("complete", { imageUrls: [] });
          }}
          onDeleteVideoClips={() => {
            setGeneratedClips([]);
            // Clear video URLs since clips changed - user needs to re-render
            setVideoUrl(undefined);
            setSmokeEmbersVideoUrl(undefined);
            autoSave("complete", { clips: [], videoUrl: undefined, smokeEmbersVideoUrl: undefined });
          }}
          onDeleteRender={() => {
            setVideoUrl(undefined);
            setVideoUrlCaptioned(undefined);
            setEmbersVideoUrl(undefined);
            setSmokeEmbersVideoUrl(undefined);
            // Use null to clear from Supabase (undefined is ignored)
            autoSave("complete", { videoUrl: null as unknown as string, videoUrlCaptioned: null as unknown as string, embersVideoUrl: null as unknown as string, smokeEmbersVideoUrl: null as unknown as string });
          }}
        />
      ) : (
        <main className="flex flex-col items-center justify-center px-4 py-32">
          {/* Resume saved project banner */}
          {savedProject && viewState === "create" && (
            <div className="w-full max-w-3xl mx-auto mb-8">
              <div className="bg-primary/10 border border-primary/20 rounded-xl p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <RotateCcw className="w-5 h-5 text-primary" />
                  <div className="text-left">
                    <p className="text-sm font-medium text-foreground">
                      Resume previous project?
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {savedProject.videoTitle} - {getStepLabel(savedProject.currentStep)}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleDismissSavedProject}
                  >
                    Dismiss
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleResumeProject}
                  >
                    Resume
                  </Button>
                </div>
              </div>
            </div>
          )}

          <div className="w-full max-w-3xl mx-auto text-center space-y-8">
            <div className="space-y-3">
              <h1 className="text-4xl md:text-5xl font-bold text-foreground tracking-tight">
                Create Your AI Video
              </h1>
              <p className="text-lg text-muted-foreground">
                {settings.customScript && settings.customScript.trim().length > 0
                  ? "Using custom script - click Generate to start audio production"
                  : "From YouTube URL to full production ready assets in minutes"}
              </p>
            </div>

            {/* Inline settings on main page */}
            <div className="w-full max-w-2xl mx-auto bg-card rounded-xl border border-border p-4 space-y-4">
              {/* Project Title */}
              <div className="flex items-center gap-3">
                <label className="text-sm font-medium text-muted-foreground w-28 text-left shrink-0">Title</label>
                <Input
                  value={settings.projectTitle}
                  onChange={(e) => setSettings(prev => ({ ...prev, projectTitle: e.target.value }))}
                  placeholder="e.g., Regency Courting, Viking Winters..."
                  className="flex-1"
                />
              </div>

              {/* Topic/Era - anchors image generation to specific period */}
              <div className="flex items-center gap-3">
                <div className="w-28 shrink-0">
                  <label className="text-sm font-medium text-muted-foreground text-left block">Topic</label>
                  <span className="text-xs text-muted-foreground/70">Era for images</span>
                </div>
                <Input
                  value={settings.topic}
                  onChange={(e) => setSettings(prev => ({ ...prev, topic: e.target.value }))}
                  placeholder="e.g., Regency England 1810s, Ancient Rome..."
                  className="flex-1"
                />
              </div>

              {/* Subject Focus - who the story is about (servants, workers, etc.) */}
              <div className="flex items-center gap-3">
                <div className="w-28 shrink-0">
                  <label className="text-sm font-medium text-muted-foreground text-left block">Focus</label>
                  <span className="text-xs text-muted-foreground/70">Who's the story about?</span>
                </div>
                <div className="flex-1 space-y-1">
                  <Input
                    value={settings.subjectFocus}
                    onChange={(e) => setSettings(prev => ({ ...prev, subjectFocus: e.target.value }))}
                    placeholder="e.g., servants, housemaids, coachmen..."
                  />
                  <p className="text-xs text-muted-foreground/70">
                    Ideas: servants, maids, footmen, soldiers, monks, farmers, sailors, merchants, workers
                  </p>
                </div>
              </div>

              {/* Expand With - optional expansion topics for short source videos */}
              <div className="flex items-center gap-3">
                <div className="w-28 shrink-0">
                  <label className="text-sm font-medium text-muted-foreground text-left block">Expand With</label>
                  <span className="text-xs text-muted-foreground/70">Extra topics (optional)</span>
                </div>
                <div className="flex-1 space-y-1">
                  <div className="flex gap-2">
                    <Input
                      value={settings.expandWith || ""}
                      onChange={(e) => setSettings(prev => ({ ...prev, expandWith: e.target.value }))}
                      placeholder="e.g., men's fashion, accessories, grooming..."
                      className="flex-1"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={async () => {
                        if (!settings.topic && !settings.projectTitle) {
                          toast({
                            title: "Topic Required",
                            description: "Enter a Topic first to generate expansion ideas",
                            variant: "destructive",
                          });
                          return;
                        }
                        try {
                          toast({
                            title: "Generating...",
                            description: "Finding expansion topics for your video",
                          });
                          const response = await fetch(`${API_BASE_URL}/rewrite-script/generate-expansion-topics`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              topic: settings.topic || settings.projectTitle,
                              title: settings.projectTitle,
                            }),
                          });
                          const data = await response.json();
                          if (data.success && data.topics) {
                            setSettings(prev => ({ ...prev, expandWith: data.topics.join(", ") }));
                            toast({
                              title: "Topics Generated",
                              description: `Added ${data.topics.length} expansion topics`,
                            });
                          } else {
                            toast({
                              title: "Generation Failed",
                              description: data.error || "Failed to generate topics",
                              variant: "destructive",
                            });
                          }
                        } catch (error) {
                          toast({
                            title: "Error",
                            description: "Failed to generate expansion topics",
                            variant: "destructive",
                          });
                        }
                      }}
                      disabled={!settings.topic && !settings.projectTitle}
                    >
                      ✨ Generate
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground/70">
                    For short source videos: AI will add content on these topics
                  </p>
                </div>
              </div>

              {/* Word Count */}
              <div className="flex items-center gap-3">
                <label className="text-sm font-medium text-muted-foreground w-28 text-left shrink-0">Word Count</label>
                <div className="flex items-center gap-3 flex-1">
                  <Slider
                    value={[settings.wordCount]}
                    min={500}
                    max={30000}
                    step={100}
                    onValueChange={([value]) => setSettings(prev => ({ ...prev, wordCount: value }))}
                    className="flex-1"
                  />
                  <span className="text-sm text-muted-foreground w-16 text-right">{settings.wordCount.toLocaleString()}</span>
                </div>
              </div>

              {/* Step-by-Step vs Full Auto toggle */}
              <div className="flex items-center gap-3">
                <label className="text-sm font-medium text-muted-foreground w-28 text-left shrink-0">Mode</label>
                <div className="flex bg-muted rounded-lg p-1 flex-1">
                  <button
                    onClick={() => setSettings(prev => ({ ...prev, fullAutomation: false }))}
                    className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors ${
                      !settings.fullAutomation
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Step-by-Step
                  </button>
                  <button
                    onClick={() => setSettings(prev => ({ ...prev, fullAutomation: true }))}
                    className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors ${
                      settings.fullAutomation
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Full Auto
                  </button>
                </div>
              </div>

              {/* Full Auto Settings - only visible when Full Auto mode is selected */}
              {settings.fullAutomation && (
                <>
                  {/* Painting Style - visual aesthetic only, not era content */}
                  <div className="flex items-center gap-3">
                    <div className="w-28 shrink-0">
                      <label className="text-sm font-medium text-muted-foreground text-left block">Painting Style</label>
                      <span className="text-xs text-muted-foreground/70">Visual only</span>
                    </div>
                    <Select
                      value={settings.imageTemplate}
                      onValueChange={(value) => setSettings(prev => ({ ...prev, imageTemplate: value }))}
                    >
                      <SelectTrigger className="flex-1">
                        <SelectValue placeholder="Select painting style" />
                      </SelectTrigger>
                      <SelectContent>
                        {imageTemplates.map((template) => (
                          <SelectItem key={template.id} value={template.id}>
                            {template.name || template.id}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Image Count */}
                  <div className="flex items-center gap-3">
                    <label className="text-sm font-medium text-muted-foreground w-28 text-left shrink-0">Image Count</label>
                    <div className="flex items-center gap-3 flex-1">
                      <Slider
                        value={[settings.imageCount]}
                        min={1}
                        max={500}
                        step={1}
                        onValueChange={([value]) => setSettings(prev => ({ ...prev, imageCount: value }))}
                        className="flex-1"
                      />
                      <span className="text-sm text-muted-foreground w-16 text-right">{settings.imageCount}</span>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Two input modes: YouTube URL or Custom Script */}
            <div className="w-full max-w-2xl mx-auto space-y-4">
              {/* Mode toggle tabs */}
              <div className="flex bg-muted rounded-lg p-1">
                <button
                  onClick={() => {
                    setInputMode("url");
                    setSettings(prev => ({ ...prev, customScript: "" }));
                  }}
                  className={`flex-1 flex items-center justify-center gap-2 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
                    inputMode === "url" && !settings.customScript?.trim()
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Youtube className="w-4 h-4" />
                  YouTube URL
                </button>
                <button
                  onClick={() => setInputMode("title")}
                  className={`flex-1 flex items-center justify-center gap-2 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
                    inputMode === "title" || settings.customScript?.trim()
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <FileText className="w-4 h-4" />
                  Paste Script
                </button>
              </div>

              {/* YouTube URL mode */}
              {inputMode === "url" && !settings.customScript?.trim() && (
                <div className="bg-card rounded-2xl shadow-sm border border-border p-4 space-y-4">
                  <div className="flex items-center gap-2">
                    <Youtube className="w-5 h-5 text-red-500 shrink-0" />
                    <Input
                      type="url"
                      value={inputValue}
                      onChange={(e) => setInputValue(e.target.value)}
                      placeholder="Paste YouTube URL..."
                      className="flex-1 border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 text-base"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Scroll className="w-4 h-4 text-muted-foreground shrink-0" />
                    <Select
                      value={settings.scriptTemplate}
                      onValueChange={(value) => setSettings(prev => ({ ...prev, scriptTemplate: value }))}
                    >
                      <SelectTrigger className="flex-1 border-0 bg-muted/50 focus:ring-0 focus:ring-offset-0">
                        <SelectValue placeholder="Select script template..." />
                      </SelectTrigger>
                      <SelectContent>
                        {scriptTemplates.map((template) => (
                          <SelectItem key={template.id} value={template.id}>
                            {template.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    onClick={() => {
                      if (settings.fullAutomation) {
                        toast({
                          title: "Full Auto Mode Active",
                          description: "You're in Full Auto mode. Use 'Full Auto Generate' below, or switch to Step-by-Step mode.",
                          variant: "destructive",
                        });
                        return;
                      }
                      handleGenerate();
                    }}
                    disabled={viewState !== "create" || !inputValue.trim() || settings.fullAutomation}
                    className={`w-full bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl py-6 text-base ${settings.fullAutomation ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    <Sparkles className="w-5 h-5 mr-2" />
                    Generate Script
                  </Button>
                  <Button
                    onClick={() => {
                      setSettings(prev => ({ ...prev, fullAutomation: true }));
                      handleGenerate();
                    }}
                    disabled={viewState !== "create" || !inputValue.trim()}
                    variant="outline"
                    className="w-full rounded-xl py-6 text-base border-primary/30 hover:bg-primary/10"
                  >
                    <Zap className="w-5 h-5 mr-2" />
                    Full Auto Generate
                  </Button>
                  <Button
                    onClick={async () => {
                      if (!inputValue.trim()) return;

                      // Create a new project ID
                      const newProjectId = crypto.randomUUID();

                      toast({
                        title: "Starting Server Pipeline",
                        description: `Project ID: ${newProjectId.slice(0, 8)} - Pipeline will run on server.`,
                      });

                      const result = await startFullPipeline({
                        projectId: newProjectId,
                        youtubeUrl: inputValue.trim(),
                        title: settings.projectTitle,
                        topic: settings.topic,
                        wordCount: settings.wordCount,
                        imageCount: settings.imageCount,
                        generateClips: true,
                        clipCount: 12,
                        clipDuration: 5,
                        effects: { smoke_embers: true },
                      });

                      if (result.success) {
                        toast({
                          title: `Pipeline Started (${newProjectId.slice(0, 8)})`,
                          description: `Title: "${settings.projectTitle || 'Untitled'}" - Check Projects page for progress.`,
                        });
                        // Set project state to track running pipeline
                        setProjectId(newProjectId);
                        setProjectStatus('running');
                        setPipelineCurrentStep('transcript');
                        setVideoTitle(settings.projectTitle || "History Documentary");
                        // Navigate to results page to show progress
                        setViewState("results");
                      } else {
                        toast({
                          title: "Failed to Start Pipeline",
                          description: result.error || "Unknown error",
                          variant: "destructive",
                        });
                      }
                    }}
                    disabled={viewState !== "create" || !inputValue.trim()}
                    variant="outline"
                    className="w-full rounded-xl py-6 text-base border-green-500/30 hover:bg-green-500/10 text-green-400"
                  >
                    <Video className="w-5 h-5 mr-2" />
                    Run on Server (Fire & Forget)
                  </Button>
                  <Button
                    onClick={() => setShowAutoPosterModal(true)}
                    variant="outline"
                    className="w-full rounded-xl py-6 text-base border-orange-500/30 hover:bg-orange-500/10 text-orange-400"
                  >
                    <Bot className="w-5 h-5 mr-2" />
                    Auto Poster
                  </Button>
                </div>
              )}

              {/* Custom Script mode */}
              {(inputMode === "title" || settings.customScript?.trim()) && (
                <div className="bg-card rounded-2xl shadow-sm border border-border p-4 space-y-4">
                  <textarea
                    value={settings.customScript || ""}
                    onChange={(e) => setSettings(prev => ({ ...prev, customScript: e.target.value }))}
                    placeholder="Paste your script here..."
                    className="w-full h-40 p-3 text-sm border rounded-lg resize-none bg-background focus:outline-none focus:ring-2 focus:ring-primary/20"
                  />
                  {settings.customScript?.trim() && (() => {
                    const wordCount = settings.customScript.trim().split(/\s+/).length;
                    const { longSentences, totalSentences } = analyzeSentenceLengths(settings.customScript);
                    const hasLongSentences = longSentences.length > 0;

                    return (
                      <div className="space-y-2">
                        <p className="text-xs text-muted-foreground text-center">
                          {wordCount} words • {totalSentences} sentences
                        </p>

                        {hasLongSentences && (
                          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
                            <div className="flex items-center gap-2 text-yellow-500">
                              <AlertTriangle className="w-4 h-4 shrink-0" />
                              <span className="text-sm font-medium">
                                {longSentences.length} sentence{longSentences.length > 1 ? 's' : ''} may cause audio glitches
                              </span>
                            </div>
                            <p className="text-xs text-muted-foreground mt-1 ml-6">
                              Sentences over 250 characters get split at commas during TTS, which can cause artifacts.
                            </p>
                            <details className="mt-2 ml-6">
                              <summary className="text-xs text-yellow-500 cursor-pointer hover:underline">
                                View long sentences
                              </summary>
                              <ul className="mt-2 space-y-2 text-xs">
                                {longSentences.map((s) => (
                                  <li key={s.index} className="p-2 bg-background/50 rounded border border-border">
                                    <span className="text-yellow-500 font-medium">#{s.index}</span>
                                    <span className="text-red-400 ml-2">({s.length} chars)</span>
                                    <p className="text-muted-foreground mt-1 line-clamp-2">{s.text}</p>
                                  </li>
                                ))}
                              </ul>
                            </details>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                  <Button
                    onClick={() => {
                      if (settings.fullAutomation) {
                        toast({
                          title: "Full Auto Mode Active",
                          description: "You're in Full Auto mode. Use 'Full Auto Generate' below, or switch to Step-by-Step mode.",
                          variant: "destructive",
                        });
                        return;
                      }
                      handleGenerate();
                    }}
                    disabled={viewState !== "create" || !settings.customScript?.trim() || settings.fullAutomation}
                    className={`w-full bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl py-6 text-base ${settings.fullAutomation ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    <Mic className="w-5 h-5 mr-2" />
                    Generate Audio
                  </Button>
                  <Button
                    onClick={() => {
                      if (!settings.customScript?.trim()) return;
                      setSettings(prev => ({ ...prev, fullAutomation: true }));
                      handleGenerate();
                    }}
                    disabled={viewState !== "create" || !settings.customScript?.trim()}
                    variant="outline"
                    className="w-full rounded-xl py-6 text-base border-primary/30 hover:bg-primary/10"
                  >
                    <Zap className="w-5 h-5 mr-2" />
                    Full Auto Generate
                  </Button>
                  <Button
                    onClick={async () => {
                      if (!settings.customScript?.trim()) return;

                      // Create a new project ID
                      const newProjectId = crypto.randomUUID();

                      toast({
                        title: "Starting Server Pipeline",
                        description: `Project ID: ${newProjectId.slice(0, 8)} - Pipeline will run on server.`,
                      });

                      const result = await startFullPipeline({
                        projectId: newProjectId,
                        script: settings.customScript.trim(),  // Use script directly instead of YouTube URL
                        title: settings.projectTitle || 'Untitled',
                        topic: settings.topic,
                        wordCount: settings.wordCount,
                        imageCount: settings.imageCount,
                        generateClips: true,
                        clipCount: 12,
                        clipDuration: 5,
                        effects: { smoke_embers: true },
                      });

                      if (result.success) {
                        toast({
                          title: `Pipeline Started (${newProjectId.slice(0, 8)})`,
                          description: `Title: "${settings.projectTitle || 'Untitled'}" - Check Projects page for progress.`,
                        });
                        // Set project state to track running pipeline
                        setProjectId(newProjectId);
                        setProjectStatus('running');
                        setPipelineCurrentStep('audio');  // Script is already provided, start at audio
                        setVideoTitle(settings.projectTitle || "History Documentary");
                        // Navigate to results page to show progress
                        setViewState("results");
                      } else {
                        toast({
                          title: "Failed to Start Pipeline",
                          description: result.error || "Unknown error",
                          variant: "destructive",
                        });
                      }
                    }}
                    disabled={viewState !== "create" || !settings.customScript?.trim()}
                    variant="outline"
                    className="w-full rounded-xl py-6 text-base border-green-500/30 hover:bg-green-500/10 text-green-400"
                  >
                    <Video className="w-5 h-5 mr-2" />
                    Run on Server (Fire & Forget)
                  </Button>
                  <Button
                    onClick={() => setShowAutoPosterModal(true)}
                    variant="outline"
                    className="w-full rounded-xl py-6 text-base border-orange-500/30 hover:bg-orange-500/10 text-orange-400"
                  >
                    <Bot className="w-5 h-5 mr-2" />
                    Auto Poster
                  </Button>
                </div>
              )}
            </div>

            {entryMode === "images" && (
              <div className="bg-card rounded-2xl shadow-sm border border-border p-6 space-y-4">
                <p className="text-muted-foreground text-sm">
                  Upload or paste your script and captions (SRT) to generate image prompts.
                </p>

                {/* Project Title input */}
                <div className="space-y-2">
                  <label className="text-sm font-medium text-left block">Project Title</label>
                  <Input
                    value={imagesProjectTitle}
                    onChange={(e) => setImagesProjectTitle(e.target.value)}
                    placeholder="Enter project title..."
                    className="w-full"
                  />
                </div>

                {/* Script input */}
                <div className="space-y-2">
                  <label className="text-sm font-medium text-left block">Script</label>
                  <input
                    ref={scriptFileInputRef}
                    type="file"
                    accept=".txt,.md"
                    onChange={handleScriptFileChange}
                    className="hidden"
                  />
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => scriptFileInputRef.current?.click()}
                    >
                      Upload .txt
                    </Button>
                    <span className="text-xs text-muted-foreground self-center">or paste below</span>
                  </div>
                  <textarea
                    value={uploadedScript}
                    onChange={(e) => setUploadedScript(e.target.value)}
                    placeholder="Paste your script here..."
                    className="w-full h-32 p-3 text-sm border rounded-lg resize-none bg-background"
                  />
                </div>

                {/* Captions input */}
                <div className="space-y-2">
                  <label className="text-sm font-medium text-left block">Captions (SRT)</label>
                  <input
                    ref={captionsFileInputRef}
                    type="file"
                    accept=".srt,.txt"
                    onChange={handleCaptionsFileChange}
                    className="hidden"
                  />
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => captionsFileInputRef.current?.click()}
                    >
                      Upload .srt
                    </Button>
                    <span className="text-xs text-muted-foreground self-center">or paste below</span>
                  </div>
                  <textarea
                    value={uploadedCaptions}
                    onChange={(e) => setUploadedCaptions(e.target.value)}
                    placeholder="Paste your SRT captions here..."
                    className="w-full h-32 p-3 text-sm border rounded-lg resize-none bg-background font-mono"
                  />
                </div>

                {/* Audio file input (optional) */}
                <div className="space-y-2">
                  <label className="text-sm font-medium text-left block">
                    Audio File <span className="text-muted-foreground font-normal">(optional - for accurate timing)</span>
                  </label>
                  <input
                    ref={audioFileInputImagesRef}
                    type="file"
                    accept="audio/*"
                    onChange={handleAudioFileChangeForImages}
                    className="hidden"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => audioFileInputImagesRef.current?.click()}
                    className="w-full justify-start"
                  >
                    <Mic className="w-4 h-4 mr-2" />
                    {uploadedAudioFileForImages ? uploadedAudioFileForImages.name : "Choose Audio File"}
                  </Button>
                </div>

                <Button
                  onClick={handleGenerateImagePrompts}
                  disabled={!uploadedScript.trim() || !uploadedCaptions.trim() || viewState !== "create"}
                  className="w-full"
                >
                  <Sparkles className="w-4 h-4 mr-2" />
                  Generate Image Prompts
                </Button>
              </div>
            )}

          </div>
        </main>
      )}

      {/* Processing Modal */}
      <ProcessingModal
        isOpen={viewState === "processing"}
        onClose={handleCancelRequest}
        steps={processingSteps}
        title={processingTitle}
      />

      {/* Script Review Modal */}
      <ScriptReviewModal
        isOpen={viewState === "review-script"}
        script={pendingScript}
        title={videoTitle}
        topic={settings.topic || undefined}
        template={scriptTemplates.find(t => t.id === settings.scriptTemplate)?.template}
        onConfirm={handleScriptConfirm}
        onCancel={handleCancelRequest}
        onBack={handleBackToCreate}
        onForward={canGoForwardFromScript() ? handleForwardToAudio : undefined}
        onRegenerate={handleScriptRegenerate}
        regenerationProgress={scriptRegenProgress}
      />

      {/* Audio Preview Modal - Show segments modal if we have segments, otherwise legacy single audio */}
      {pendingAudioSegments.length > 0 ? (
        <AudioSegmentsPreviewModal
          isOpen={viewState === "review-audio"}
          segments={pendingAudioSegments}
          combinedAudioUrl={pendingAudioUrl}
          totalDuration={pendingAudioDuration}
          onConfirmAll={handleAudioConfirm}
          onRegenerate={handleSegmentRegenerate}
          onCancel={handleCancelRequest}
          onBack={handleBackToScript}
          onForward={canGoForwardFromAudio() ? handleForwardToCaptions : undefined}
          regeneratingIndex={regeneratingSegmentIndex}
          projectId={projectId}
          voiceSampleUrl={settings.voiceSampleUrl || undefined}
          ttsSettings={{
            temperature: settings.ttsTemperature,
            topP: settings.ttsTopP,
            repetitionPenalty: settings.ttsRepetitionPenalty,
          }}
          onAudioUpdated={(newUrl) => setPendingAudioUrl(newUrl)}
          segmentsNeedRecombine={segmentsNeedRecombine}
          onRecombineAudio={async () => {
            const newUrl = await handleRecombineForRender();
            setPendingAudioUrl(newUrl);
          }}
        />
      ) : (
        <AudioPreviewModal
          isOpen={viewState === "review-audio"}
          audioUrl={pendingAudioUrl}
          duration={pendingAudioDuration}
          onConfirm={handleAudioConfirm}
          onRegenerate={handleAudioRegenerate}
          onCancel={handleCancelRequest}
          onBack={handleBackToScript}
        />
      )}

      {/* Captions Preview Modal - Review captions and set image count */}
      {/* Image Prompts is the next step after Captions (images first, then video clips) */}
      <CaptionsPreviewModal
        isOpen={viewState === "review-captions"}
        srtContent={pendingSrtContent || ""}
        onConfirm={handleCaptionsConfirm}
        onCancel={handleCancelRequest}
        onBack={handleBackToAudio}
        onForward={canGoForwardFromCaptionsToClipPrompts() ? () => handleCaptionsConfirm(pendingSrtContent || "") : undefined}
        forwardLabel="Image Prompts"
        imageCount={settings.imageCount}
        onImageCountChange={(count) => setSettings(prev => ({ ...prev, imageCount: count }))}
        topic={settings.topic}
        onTopicChange={(topic) => setSettings(prev => ({ ...prev, topic }))}
        subjectFocus={settings.subjectFocus}
        onSubjectFocusChange={(subjectFocus) => setSettings(prev => ({ ...prev, subjectFocus }))}
      />

      {/* Video Clip Prompts Modal (LTX-2) - Review clip descriptions */}
      <VideoClipPromptsModal
        isOpen={viewState === "review-clip-prompts"}
        prompts={clipPrompts}
        stylePrompt={getSelectedImageStyle()}
        onConfirm={handleClipPromptsConfirm}
        onCancel={handleCancelRequest}
        onBack={() => setViewState("review-captions")}
        onRegenerate={handleRegenerateClipPrompts}
        isRegenerating={isRegeneratingClipPrompts}
      />

      {/* Video Clips Preview Modal (I2V) - Preview generated clips */}
      <VideoClipsPreviewModal
        isOpen={viewState === "review-clips"}
        clips={generatedClips}
        clipPrompts={clipPrompts}
        onConfirm={handleClipsConfirm}
        onCancel={handleCancelRequest}
        onBack={() => setViewState("review-clip-prompts")}
        onRegenerate={handleRegenerateVideoClip}
        onRegenerateMultiple={handleRegenerateMultipleClips}
        regeneratingIndices={regeneratingClipIndices}
        selectedIndices={selectedClipsForRegen}
        onSelectionChange={setSelectedClipsForRegen}
      />

      {/* Image Prompts Preview Modal */}
      <ImagePromptsPreviewModal
        isOpen={viewState === "review-prompts"}
        prompts={imagePrompts}
        stylePrompt={settings.customStylePrompt?.trim() || getSelectedImageStyle()}
        imageTemplates={imageTemplates}
        onConfirm={handlePromptsConfirm}
        onCancel={handleCancelRequest}
        onBack={handleBackToCaptions}
        onForward={canGoForwardFromPrompts() ? handleForwardToImages : undefined}
        onRegenerate={(topic, focus) => handleRegenerateImagePrompts(true, topic, focus)}
        isRegenerating={isRegeneratingPrompts}
        topic={settings.topic}
        onTopicChange={(topic) => setSettings(prev => ({ ...prev, topic }))}
        subjectFocus={settings.subjectFocus}
        onSubjectFocusChange={(subjectFocus) => setSettings(prev => ({ ...prev, subjectFocus }))}
        onAddPrompts={handleAddPrompts}
        isAddingPrompts={isAddingPrompts}
        existingImageCount={pendingImages.length}
        existingImages={pendingImages}
        audioDuration={pendingAudioDuration}
      />

      {/* Images Preview Modal */}
      <ImagesPreviewModal
        isOpen={viewState === "review-images"}
        images={pendingImages}
        prompts={imagePrompts}
        srtContent={pendingSrtContent || srtContent}
        projectId={projectId}
        onConfirm={handleImagesConfirm}
        onCancel={handleCancelRequest}
        onBack={handleBackToPrompts}
        onForward={() => {
          // Go to image scanner before generating video clips
          setSettings(prev => ({ ...prev, fullAutomation: false }));
          setViewState("review-scanner");
        }}
        onRegenerate={handleRegenerateImage}
        onRegenerateMultiple={handleRegenerateMultipleImages}
        onReconnectImages={async () => {
          const { reconnectOrphanedImages } = await import('@/lib/api');
          const result = await reconnectOrphanedImages(projectId);
          if (result.success && result.imageUrls) {
            setPendingImages(result.imageUrls);
            // Save to database
            autoSave("images", { imageUrls: result.imageUrls });
            toast({
              title: "Images Reconnected!",
              description: `Found ${result.imageUrls.length} images in storage`,
            });
          } else {
            toast({
              title: "Reconnect Failed",
              description: result.error || "No images found in storage",
              variant: "destructive",
            });
          }
        }}
        regeneratingIndices={regeneratingImageIndices}
      />

      {/* Image Scanner Modal - Content moderation and historical accuracy check */}
      <ImageScannerModal
        isOpen={viewState === "review-scanner"}
        images={pendingImages}
        prompts={imagePrompts}
        srtContent={pendingSrtContent || srtContent}
        eraTopic={settings.topic || videoTitle || "Historical documentary"}
        projectId={projectId}
        onCancel={handleCancelRequest}
        onBack={() => setViewState("review-images")}
        onContinue={(updatedPrompts) => {
          // If prompts were updated, save them
          if (updatedPrompts) {
            setImagePrompts(updatedPrompts);
            autoSave("prompts", { imagePrompts: updatedPrompts });
          }
          // Continue to video clip generation
          handleImagesConfirm();
        }}
        onRegenerate={async (indices, editedPrompts) => {
          // Regenerate specific images with edited prompts
          const promptsMap = editedPrompts;
          for (const index of indices) {
            const editedPrompt = promptsMap.get(index);
            if (editedPrompt) {
              // Update imagePrompts state
              setImagePrompts(prev => prev.map(p =>
                p.index === index ? { ...p, sceneDescription: editedPrompt, prompt: editedPrompt } : p
              ));
            }
          }
          // Regenerate the images
          await handleRegenerateMultipleImages(indices, editedPrompts);
        }}
      />

      {/* Video Render Modal (2-pass: basic + effects) */}
      <VideoRenderModal
        isOpen={viewState === "review-render"}
        projectId={projectId}
        projectTitle={videoTitle}
        audioUrl={pendingAudioUrl}
        imageUrls={(() => {
          // Skip first N images that were used for video clips, use remaining images
          const clipCount = generatedClips.length;
          if (clipCount === 0) return pendingImages;
          // Skip images that became clips (first 12), use the rest
          return pendingImages.slice(clipCount);
        })()}
        imageTimings={(() => {
          // Calculate timings dynamically from audio duration
          const audioDuration = pendingAudioDuration || 0;
          const clipCount = generatedClips.length;
          const clipEndTime = clipCount > 0
            ? Math.max(...generatedClips.map(c => c.endSeconds))
            : 0;
          // Skip images that became clips, use the rest
          const imagesToRender = pendingImages.slice(clipCount);
          const remainingDuration = audioDuration - clipEndTime;
          const perImageTime = remainingDuration / imagesToRender.length;
          return imagesToRender.map((_, i) => ({
            startSeconds: clipEndTime + (i * perImageTime),
            endSeconds: clipEndTime + ((i + 1) * perImageTime)
          }));
        })()}
        srtContent={pendingSrtContent}
        introClips={generatedClips.length > 0 ? generatedClips.map(c => ({
          index: c.index,
          url: c.videoUrl,
          startSeconds: c.startSeconds,
          endSeconds: c.endSeconds
        })) : undefined}
        onRefreshData={async () => {
          // Fetch latest clips and images from database before rendering
          console.log('[Render] ===== FETCHING FRESH DATA FROM DATABASE =====');
          const freshProject = await getProject(projectId);
          if (!freshProject) {
            console.warn('[Render] Could not fetch fresh project data');
            return {
              clips: generatedClips.map(c => ({
                index: c.index,
                url: c.videoUrl,
                startSeconds: c.startSeconds,
                endSeconds: c.endSeconds
              })),
              images: pendingImages.slice(generatedClips.length)
            };
          }

          const freshClips = freshProject.clips || [];
          const freshImages = freshProject.imageUrls || [];
          const clipCount = freshClips.length;

          // Log EACH clip URL from database
          console.log('[Render] CLIP URLs FROM DATABASE:');
          freshClips.forEach((c, i) => {
            console.log(`[Render] Clip ${c.index}: ${c.videoUrl?.substring(0, 100)}...`);
          });
          console.log('[Render] ==========================================');

          console.log('[Render] Fetched fresh data from DB:', {
            clips: freshClips.length,
            images: freshImages.length,
            usingImages: freshImages.slice(clipCount).length
          });

          // Also update local state so UI reflects latest data
          if (freshClips.length > 0) {
            setGeneratedClips(freshClips);
          }
          if (freshImages.length > 0) {
            setPendingImages(freshImages);
          }

          return {
            clips: freshClips.map(c => ({
              index: c.index,
              url: c.videoUrl,
              startSeconds: c.startSeconds,
              endSeconds: c.endSeconds
            })),
            images: freshImages.slice(clipCount)
          };
        }}
        existingBasicVideoUrl={videoUrl}
        existingEffectsVideoUrl={smokeEmbersVideoUrl}
        autoRender={settings.fullAutomation}
        segmentsNeedRecombine={segmentsNeedRecombine}
        onRecombineAudio={handleRecombineForRender}
        onConfirm={handleRenderConfirm}
        onCancel={handleCancelRequest}
        onBack={handleBackToImages}
        onSkip={handleRenderSkip}
        onForward={() => disableAutoAndGoTo("review-thumbnails")}
      />

      {/* Thumbnail Generator Modal */}
      <ThumbnailGeneratorModal
        isOpen={viewState === "review-thumbnails"}
        projectId={projectId}
        projectTitle={videoTitle}
        script={confirmedScript}
        initialThumbnails={generatedThumbnails}
        initialSelectedIndex={selectedThumbnailIndex}
        favoriteThumbnails={favoriteThumbnails}
        onFavoriteToggle={handleFavoriteThumbnailToggle}
        onConfirm={handleThumbnailsConfirm}
        onSelectionChange={(thumbnails, selectedIndex) => {
          // Only update state if values actually changed to prevent re-render loops
          const thumbnailsChanged = JSON.stringify(thumbnails) !== JSON.stringify(generatedThumbnails);
          if (thumbnailsChanged) setGeneratedThumbnails(thumbnails);
          if (selectedIndex !== selectedThumbnailIndex) setSelectedThumbnailIndex(selectedIndex);
          // Only save if something changed
          if (thumbnailsChanged || selectedIndex !== selectedThumbnailIndex) {
            autoSave("review-thumbnails", { thumbnails, selectedThumbnailIndex: selectedIndex });
          }
        }}
        onCancel={handleCancelRequest}
        onBack={handleBackToRender}
        onSkip={handleThumbnailsSkip}
        onForward={() => disableAutoAndGoTo("review-youtube")}
        sourceThumbnailUrl={sourceThumbnailUrl || undefined}
        autoGenerate={settings.fullAutomation && !!sourceThumbnailUrl}
      />

      {/* YouTube Upload Modal */}
      {viewState === "review-youtube" && console.log('[Index] YouTube Modal opening with:', {
        smokeEmbersVideoUrl,
        videoUrl,
        viewState,
        generatedThumbnails,
        thumbnailsLength: generatedThumbnails?.length,
        selectedThumbnailIndex,
        hasThumbnails: generatedThumbnails && generatedThumbnails.length > 0,
        hasSelectedIndex: selectedThumbnailIndex !== undefined
      })}
      <YouTubeUploadModal
        isOpen={viewState === "review-youtube"}
        videoUrl={smokeEmbersVideoUrl || videoUrl || ""}
        projectTitle={videoTitle}
        script={confirmedScript}
        thumbnails={generatedThumbnails}
        selectedThumbnailIndex={selectedThumbnailIndex}
        onClose={handleYouTubeComplete}
        onSuccess={handleYouTubeComplete}
        onBack={handleBackToThumbnails}
        onSkip={handleYouTubeSkip}
        initialTitle={youtubeTitle}
        initialDescription={youtubeDescription}
        initialTags={youtubeTags}
        initialCategoryId={youtubeCategoryId}
        initialPlaylistId={youtubePlaylistId}
        onMetadataChange={(title, description, tags, categoryId, playlistId) => {
          // Only update state if values actually changed to prevent re-render loops
          const titleChanged = title !== youtubeTitle;
          const descChanged = description !== youtubeDescription;
          const tagsChanged = tags !== youtubeTags;
          const catChanged = categoryId !== youtubeCategoryId;
          const playlistChanged = playlistId !== youtubePlaylistId;

          if (titleChanged) setYoutubeTitle(title);
          if (descChanged) setYoutubeDescription(description);
          if (tagsChanged) setYoutubeTags(tags);
          if (catChanged) setYoutubeCategoryId(categoryId);
          if (playlistChanged) setYoutubePlaylistId(playlistId);

          // Only save if something actually changed
          if (titleChanged || descChanged || tagsChanged || catChanged || playlistChanged) {
            autoSave("review-youtube", {
              youtubeTitle: title,
              youtubeDescription: description,
              youtubeTags: tags,
              youtubeCategoryId: categoryId,
              youtubePlaylistId: playlistId,
            });
          }
        }}
        autoUpload={settings.fullAutomation && !!youtubePublishAt}
        initialPublishAt={youtubePublishAt || undefined}
      />

      {/* Short Hook Modal - Step 1: Select hook style */}
      <ShortHookModal
        isOpen={viewState === "review-short-hook"}
        projectId={projectId}
        script={confirmedScript}
        onConfirm={handleShortHookConfirm}
        onCancel={handleCancelRequest}
        onBack={handleBackToYouTube}
        onSkip={handleShortSkipToResults}
      />

      {/* Short Generation Modal - Step 2: Generate Short with progress */}
      <ShortGenerationModal
        isOpen={viewState === "review-short-generate"}
        projectId={projectId}
        hookStyle={shortHookStyle}
        shortScript={shortScript}
        voiceSampleUrl={settings.voiceSampleUrl || "https://autoaigen.com/voices/clone_voice.wav"}
        settings={{
          ttsEmotionMarker: settings.ttsEmotionMarker,
          ttsTemperature: settings.ttsTemperature,
          ttsTopP: settings.ttsTopP,
          ttsRepetitionPenalty: settings.ttsRepetitionPenalty,
        }}
        onComplete={handleShortGenerationComplete}
        onCancel={handleCancelRequest}
        onBack={handleBackToShortHook}
      />

      {/* Short Preview Modal - Step 3: Preview and upload */}
      <ShortPreviewModal
        isOpen={viewState === "review-short-preview"}
        projectId={projectId}
        shortUrl={shortUrl}
        duration={shortDuration}
        hookStyle={shortHookStyle}
        onComplete={handleShortPreviewComplete}
        onCancel={handleCancelRequest}
        onBack={handleBackToShortHook}
        onSkip={handleShortSkipToResults}
        onRegenerate={handleShortRegenerate}
      />

      {/* Auto Poster Modal */}
      <AutoPosterModal
        open={showAutoPosterModal}
        onClose={() => setShowAutoPosterModal(false)}
        onSelectVideo={(videoUrl, targetWordCount, thumbnailUrl, videoTitle) => {
          // Set up for Full Auto Generate with the selected video
          setInputValue(videoUrl);
          setInputMode("url");
          setSettings(prev => ({ ...prev, wordCount: targetWordCount, fullAutomation: true }));
          // Store source thumbnail for reference in thumbnail generation
          setSourceThumbnailUrl(thumbnailUrl);
          // Set video title for YouTube upload
          setVideoTitle(videoTitle);
          // Reset YouTube settings for Auto Poster
          setYoutubeCategoryId("22"); // People & Blogs
          setYoutubePlaylistId(null); // Will auto-select Complete Histories
          // Schedule for 5pm PST next day
          const nextDay5pmPST = getNext5pmPST();
          setYoutubePublishAt(nextDay5pmPST);
          console.log(`[Auto Poster] Scheduled for: ${nextDay5pmPST}`);
          // Trigger the generate flow with URL and word count directly (fixes race condition)
          handleGenerate(videoUrl, targetWordCount);
        }}
      />
    </div>
  );
};

export default Index;
