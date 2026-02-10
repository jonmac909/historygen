import { useState, useEffect, useRef } from "react";
import { Download, ChevronLeft, ChevronDown, Video, Loader2, Sparkles, Square, CheckSquare, Play, Pause, Upload, FileText, Mic, MessageSquare, Palette, Image, Target, Film, Youtube, Save, Pencil, Check, X, Tag, Plus, Copy, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/hooks/use-toast";
import JSZip from "jszip";
import { supabase } from "@/integrations/supabase/client";
import { renderVideoStreaming, fetchProjectCosts, type ImagePromptWithTiming, type RenderVideoProgress, type VideoEffects, type ProjectCostStep } from "@/lib/api";
import { YouTubeUploadModal } from "./YouTubeUploadModal";
import { VideoRenderModal } from "./VideoRenderModal";
import { checkYouTubeConnection, authenticateYouTube, disconnectYouTube } from "@/lib/youtubeAuth";


export interface GeneratedAsset {
  id: string;
  name: string;
  type: string;
  size: string;
  icon: React.ReactNode;
  url?: string;
  content?: string;
}

// Pipeline step types for approval tracking
type PipelineStep = 'script' | 'audio' | 'captions' | 'clipPrompts' | 'clips' | 'prompts' | 'images' | 'thumbnails' | 'render' | 'youtube';

interface ProjectResultsProps {
  sourceUrl: string;
  onNewProject: () => void;
  onBack?: () => void;
  assets: GeneratedAsset[];
  srtContent?: string;
  // Additional props for FCPXML and video export
  imagePrompts?: ImagePromptWithTiming[];
  audioUrl?: string;
  audioDuration?: number;
  projectTitle?: string;
  projectId?: string;
  videoUrl?: string;  // Pre-rendered video URL (basic, from saved project)
  videoUrlCaptioned?: string;  // Pre-rendered captioned video URL (from saved project)
  embersVideoUrl?: string;  // Pre-rendered video URL with embers (from saved project)
  smokeEmbersVideoUrl?: string;  // Pre-rendered video URL with smoke+embers (from saved project)
  onVideoRendered?: (videoUrl: string) => void;  // Callback when video is rendered
  onCaptionedVideoRendered?: (videoUrl: string) => void;  // Callback when captioned video is rendered
  onEmbersVideoRendered?: (videoUrl: string) => void;  // Callback when embers video is rendered
  onSmokeEmbersVideoRendered?: (videoUrl: string) => void;  // Callback when smoke+embers video is rendered
  thumbnails?: string[];  // Generated thumbnails for YouTube upload
  selectedThumbnailIndex?: number;  // Index of previously selected thumbnail
  script?: string;  // Script content for YouTube metadata AI generation
  // YouTube metadata (shared with YouTubeUploadModal)
  youtubeTitle?: string;  // YouTube-specific title (different from project title)
  youtubeDescription?: string;  // YouTube description
  youtubeTags?: string;  // Comma-separated tags
  youtubeCategoryId?: string;  // YouTube category ID
  youtubePlaylistId?: string | null;  // Playlist to add video to
  onYouTubeMetadataChange?: (title: string, description: string, tags: string, categoryId: string, playlistId: string | null) => void;  // Callback to update metadata
  // Video clips (5 × 12s intro clips)
  clipPrompts?: string[];  // Prompts for video clip generation
  clipUrls?: string[];     // Generated video clip URLs
  // Navigation callbacks to go back to specific pipeline steps
  onGoToScript?: () => void;
  onGoToAudio?: () => void;
  onGoToCaptions?: () => void;
  onGoToClipPrompts?: () => void;
  onGoToClips?: () => void;
  onGoToPrompts?: () => void;
  onGoToImages?: () => void;
  onGoToThumbnails?: () => void;
  onGoToRender?: () => void;
  onGoToYouTube?: () => void;
  // Callback to heal/update image prompts when count doesn't match images
  onImagePromptsHealed?: (healedPrompts: ImagePromptWithTiming[]) => void;
  // Approval tracking
  approvedSteps?: PipelineStep[];
  onApproveStep?: (step: PipelineStep, approved: boolean) => void;
  // Save version & Duplicate
  onSaveVersion?: () => void;
  onDuplicate?: () => void;
  // Title change
  onTitleChange?: (newTitle: string) => void;
  // Thumbnail upload
  onThumbnailUpload?: (thumbnailUrl: string) => void;
  // Asset uploads (script, audio, captions, images, prompts)
  onScriptUpload?: (script: string) => void;
  onAudioUpload?: (audioUrl: string) => void;
  onCaptionsUpload?: (srtContent: string) => void;
  onImagesUpload?: (imageUrls: string[]) => void;
  onPromptsUpload?: (prompts: ImagePromptWithTiming[]) => void;
  onVideoUpload?: (videoUrl: string, type: 'basic' | 'smoke_embers') => void;
  // Tags
  tags?: string[];
  onTagsChange?: (tags: string[]) => void;
}

// Parse SRT to get timing info
const parseSRTTimings = (srtContent: string): { startTime: number; endTime: number }[] => {
  const segments: { startTime: number; endTime: number }[] = [];
  const blocks = srtContent.trim().split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length >= 2) {
      const timeLine = lines[1];
      const timeMatch = timeLine.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
      
      if (timeMatch) {
        const startTime = 
          parseInt(timeMatch[1]) * 3600 + 
          parseInt(timeMatch[2]) * 60 + 
          parseInt(timeMatch[3]) + 
          parseInt(timeMatch[4]) / 1000;
        
        const endTime = 
          parseInt(timeMatch[5]) * 3600 + 
          parseInt(timeMatch[6]) * 60 + 
          parseInt(timeMatch[7]) + 
          parseInt(timeMatch[8]) / 1000;
        
        segments.push({ startTime, endTime });
      }
    }
  }

  return segments;
};

// Format seconds to timestamp string (e.g., "00m00s-00m30s")
const formatTimestamp = (startSec: number, endSec: number): string => {
  const formatTime = (sec: number) => {
    const mins = Math.floor(sec / 60);
    const secs = Math.floor(sec % 60);
    return `${mins.toString().padStart(2, '0')}m${secs.toString().padStart(2, '0')}s`;
  };
  return `${formatTime(startSec)}-${formatTime(endSec)}`;
};

// Download file from URL - triggers browser's native download with progress
const downloadFromUrl = async (url: string, filename: string) => {
  // For Supabase storage URLs, add download parameter to force download instead of preview
  let downloadUrl = url;
  if (url.includes('supabase.co/storage')) {
    const separator = url.includes('?') ? '&' : '?';
    downloadUrl = `${url}${separator}download=${encodeURIComponent(filename)}`;
  }

  // Create a temporary anchor and click it to trigger native browser download
  // This shows the browser's download progress bar instead of loading into memory first
  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = filename;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

// Download text content as file
const downloadTextContent = (content: string, filename: string, mimeType: string = 'text/plain') => {
  const blob = new Blob([content], { type: mimeType });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
};

export function ProjectResults({
  sourceUrl,
  onNewProject,
  onBack,
  assets,
  srtContent,
  clipPrompts,
  clipUrls,
  imagePrompts,
  audioUrl,
  audioDuration,
  projectTitle,
  projectId,
  videoUrl,
  videoUrlCaptioned,
  embersVideoUrl: initialEmbersVideoUrl,
  smokeEmbersVideoUrl: initialSmokeEmbersVideoUrl,
  onVideoRendered,
  onCaptionedVideoRendered,
  onEmbersVideoRendered,
  onSmokeEmbersVideoRendered,
  thumbnails,
  selectedThumbnailIndex,
  script,
  youtubeTitle,
  youtubeDescription,
  youtubeTags,
  youtubeCategoryId,
  youtubePlaylistId,
  onYouTubeMetadataChange,
  onGoToScript,
  onGoToAudio,
  onGoToCaptions,
  onGoToClipPrompts,
  onGoToClips,
  onGoToPrompts,
  onGoToImages,
  onGoToThumbnails,
  onGoToRender,
  onGoToYouTube,
  onImagePromptsHealed,
  approvedSteps = [],
  onApproveStep,
  onSaveVersion,
  onDuplicate,
  onTitleChange,
  onThumbnailUpload,
  onScriptUpload,
  onAudioUpload,
  onCaptionsUpload,
  onImagesUpload,
  onPromptsUpload,
  onVideoUpload,
  tags = [],
  onTagsChange,
}: ProjectResultsProps) {
  // Helper to toggle step approval
  const toggleApproval = (step: PipelineStep, e: React.MouseEvent) => {
    e.stopPropagation();
    if (onApproveStep) {
      const isCurrentlyApproved = approvedSteps.includes(step);
      onApproveStep(step, !isCurrentlyApproved);
    }
  };

  // State for video rendering - three separate videos (basic, embers, smoke_embers)
  const [isRenderingBasic, setIsRenderingBasic] = useState(false);
  const [isRenderingEmbers, setIsRenderingEmbers] = useState(false);
  const [isRenderingSmokeEmbers, setIsRenderingSmokeEmbers] = useState(false);
  const [renderProgress, setRenderProgress] = useState<RenderVideoProgress | null>(null);
  const [basicVideoUrl, setBasicVideoUrl] = useState<string | null>(videoUrl || null);
  const [embersVideoUrl, setEmbersVideoUrl] = useState<string | null>(initialEmbersVideoUrl || null);
  const [smokeEmbersVideoUrl, setSmokeEmbersVideoUrl] = useState<string | null>(initialSmokeEmbersVideoUrl || null);
  const [currentRenderType, setCurrentRenderType] = useState<'basic' | 'embers' | 'smoke_embers'>('basic');

  // State for YouTube connection
  const [isYouTubeConnected, setIsYouTubeConnected] = useState(false);
  const [isConnectingYouTube, setIsConnectingYouTube] = useState(false);

  // State for title editing
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editedTitle, setEditedTitle] = useState(projectTitle || "");
  const titleInputRef = useRef<HTMLInputElement>(null);

  // State for tag input
  const [newTagInput, setNewTagInput] = useState("");

  // State for video render modal
  const [isVideoRenderModalOpen, setIsVideoRenderModalOpen] = useState(false);

  // State for Resume Full Auto
  const [isResuming, setIsResuming] = useState(false);
  const [pipelineStep, setPipelineStep] = useState<string | null>(null);
  const [pipelineStatus, setPipelineStatus] = useState<string | null>(null);

  // Pipeline step labels and progress percentages
  const PIPELINE_STEPS: Record<string, { label: string; percent: number }> = {
    transcript: { label: 'Transcript', percent: 5 },
    script: { label: 'Script', percent: 15 },
    audio: { label: 'Audio', percent: 25 },
    captions: { label: 'Captions', percent: 35 },
    imagePrompts: { label: 'Image Prompts', percent: 40 },
    prompts: { label: 'Image Prompts', percent: 40 },
    images: { label: 'Images', percent: 55 },
    clipPrompts: { label: 'Clip Prompts', percent: 65 },
    videoClips: { label: 'Video Clips', percent: 70 },
    thumbnail: { label: 'Thumbnails', percent: 80 },
    render: { label: 'Rendering', percent: 90 },
    upload: { label: 'Uploading', percent: 95 },
    complete: { label: 'Complete', percent: 100 },
  };

  // Auto-detect running pipeline on mount + poll while running
  useEffect(() => {
    if (!projectId) return;

    const poll = async () => {
      try {
        const { data } = await supabase
          .from('generation_projects')
          .select('current_step, status')
          .eq('id', projectId)
          .single();
        if (!data) return;

        setPipelineStep(data.current_step);
        setPipelineStatus(data.status);

        // Auto-detect: if DB says in_progress, show progress bar
        if (data.status === 'in_progress' && data.current_step && data.current_step !== 'complete') {
          setIsResuming(true);
        }

        if (data.status === 'completed' || data.current_step === 'complete') {
          if (isResuming) {
            toast({ title: "Pipeline Complete", description: "All steps finished. Refresh to see results." });
          }
          setIsResuming(false);
        }
      } catch { /* ignore poll errors */ }
    };

    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [projectId, isResuming]);

  // Determine the next pipeline step to resume from based on what data exists
  const getResumeStep = (): string | null => {
    if (!projectId) return null;
    const hasScript = !!script || !!assets.find(a => a.id === 'script');
    const hasAudio = !!audioUrl;
    const hasCaptions = !!srtContent;
    const hasImagePrompts = imagePrompts && imagePrompts.length > 0;
    const hasImages = assets.some(a => a.id.startsWith('image-')) || (imagePrompts && imagePrompts.some(p => (p as any).imageUrl));
    const hasClipPrompts = clipPrompts && clipPrompts.length > 0;
    const hasClips = clipUrls && clipUrls.length > 0;
    const hasThumbnails = thumbnails && thumbnails.length > 0;
    const hasVideo = !!basicVideoUrl || !!smokeEmbersVideoUrl;

    if (hasVideo) return null; // Already complete
    if (hasThumbnails) return 'render';
    if (hasClips) return 'thumbnail';
    if (hasClipPrompts) return 'videoClips';
    if (hasImages) return 'clipPrompts';
    if (hasImagePrompts) return 'images';
    if (hasCaptions) return 'imagePrompts';
    if (hasAudio) return 'captions';
    if (hasScript) return 'audio';
    return 'transcript';
  };

  const handleResumeFullAuto = async () => {
    const resumeFrom = getResumeStep();
    if (!resumeFrom || !projectId) return;

    setIsResuming(true);
    setPipelineStep(resumeFrom);
    const renderUrl = import.meta.env.VITE_RENDER_API_URL;
    try {
      const response = await fetch(`${renderUrl}/auto-clone/resume-project/${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resumeFrom }),
      });
      const data = await response.json();
      if (!data.success) {
        toast({ title: "Resume Failed", description: data.error, variant: "destructive" });
        setIsResuming(false);
        setPipelineStep(null);
      }
    } catch (error) {
      toast({ title: "Resume Failed", description: "Could not connect to API", variant: "destructive" });
      setIsResuming(false);
      setPipelineStep(null);
    }
  };

  // State for project costs
  const [costs, setCosts] = useState<{ steps: ProjectCostStep[]; totalCost: number } | null>(null);

  // Fetch project costs on mount/projectId change
  useEffect(() => {
    if (!projectId) return;

    fetchProjectCosts(projectId).then(result => {
      if (result.success && result.costs) {
        setCosts(result.costs);
      }
    }).catch(err => {
      console.error('[ProjectResults] Failed to fetch costs:', err);
    });
  }, [projectId]);

  // Helper to get cost for a specific step
  const getCostForStep = (stepName: string): number | null => {
    if (!costs) return null;
    const step = costs.steps.find(s => s.step === stepName);
    return step?.totalCost ?? null;
  };

  // Format cost for display
  const formatCost = (cost: number | null): string => {
    if (cost === null) return '';
    return `$${cost.toFixed(2)}`;
  };

  // Reset all video URLs when project changes
  useEffect(() => {
    console.log('[ProjectResults] Syncing video URLs:', {
      videoUrl,
      initialSmokeEmbersVideoUrl,
      initialEmbersVideoUrl
    });
    setBasicVideoUrl(videoUrl || null);
    setEmbersVideoUrl(initialEmbersVideoUrl || null);
    setSmokeEmbersVideoUrl(initialSmokeEmbersVideoUrl || null);
  }, [projectId, videoUrl, initialEmbersVideoUrl, initialSmokeEmbersVideoUrl]);

  // Sync edited title with projectTitle prop
  useEffect(() => {
    setEditedTitle(projectTitle || "");
    setIsEditingTitle(false);
  }, [projectTitle, projectId]);

  // Focus input when editing starts
  useEffect(() => {
    if (isEditingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [isEditingTitle]);

  // Handlers for title editing
  const handleSaveTitle = () => {
    const trimmedTitle = editedTitle.trim();
    if (trimmedTitle && trimmedTitle !== projectTitle) {
      onTitleChange?.(trimmedTitle);
    }
    setIsEditingTitle(false);
  };

  const handleCancelTitleEdit = () => {
    setEditedTitle(projectTitle || "");
    setIsEditingTitle(false);
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSaveTitle();
    } else if (e.key === 'Escape') {
      handleCancelTitleEdit();
    }
  };

  // State for YouTube upload
  const [isYouTubeModalOpen, setIsYouTubeModalOpen] = useState(false);

  // State for YouTube upload visibility/schedule
  const [privacyStatus, setPrivacyStatus] = useState<"private" | "unlisted">("private");
  const [isScheduled, setIsScheduled] = useState(false);
  const [scheduledDate, setScheduledDate] = useState(() => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.toISOString().split("T")[0];
  });
  const [scheduledTime, setScheduledTime] = useState("12:00");

  // State for video preview playback
  const [isPlaying, setIsPlaying] = useState(false);
  const [isHoveringPreview, setIsHoveringPreview] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Thumbnail upload
  const thumbnailUploadRef = useRef<HTMLInputElement>(null);
  const [isUploadingThumbnail, setIsUploadingThumbnail] = useState(false);

  // Asset upload refs and states
  const scriptUploadRef = useRef<HTMLInputElement>(null);
  const audioUploadRef = useRef<HTMLInputElement>(null);
  const captionsUploadRef = useRef<HTMLInputElement>(null);
  const imagesUploadRef = useRef<HTMLInputElement>(null);
  const promptsUploadRef = useRef<HTMLInputElement>(null);
  const videoUploadRef = useRef<HTMLInputElement>(null);
  const [isUploadingScript, setIsUploadingScript] = useState(false);
  const [isUploadingAudio, setIsUploadingAudio] = useState(false);
  const [isUploadingCaptions, setIsUploadingCaptions] = useState(false);
  const [isUploadingImages, setIsUploadingImages] = useState(false);
  const [isUploadingPrompts, setIsUploadingPrompts] = useState(false);
  const [isUploadingVideo, setIsUploadingVideo] = useState(false);

  // Check YouTube connection status on mount
  useEffect(() => {
    const checkConnection = async () => {
      const status = await checkYouTubeConnection();
      setIsYouTubeConnected(status.connected);
    };
    checkConnection();
  }, []);

  // Handle YouTube connect
  const handleYouTubeConnect = async () => {
    setIsConnectingYouTube(true);
    try {
      const success = await authenticateYouTube();
      if (success) {
        setIsYouTubeConnected(true);
        toast({
          title: "YouTube Connected",
          description: "Your YouTube account has been connected successfully.",
        });
      }
    } catch (error) {
      console.error('YouTube connect error:', error);
      toast({
        title: "Connection Failed",
        description: error instanceof Error ? error.message : "Failed to connect YouTube account.",
        variant: "destructive",
      });
    } finally {
      setIsConnectingYouTube(false);
    }
  };

  // Handle YouTube disconnect
  const handleYouTubeDisconnect = async () => {
    try {
      await disconnectYouTube();
      setIsYouTubeConnected(false);
      toast({
        title: "YouTube Disconnected",
        description: "Your YouTube account has been disconnected.",
      });
    } catch (error) {
      console.error('YouTube disconnect error:', error);
      toast({
        title: "Disconnect Failed",
        description: "Failed to disconnect YouTube account.",
        variant: "destructive",
      });
    }
  };

  // Handle thumbnail upload
  const handleThumbnailUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    const validTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
    if (!validTypes.includes(file.type)) {
      toast({
        title: "Invalid File Type",
        description: "Please upload a PNG, JPG, or WebP image.",
        variant: "destructive",
      });
      return;
    }

    // Validate file size (max 10MB)
    if (file.size > 10 * 1024 * 1024) {
      toast({
        title: "File Too Large",
        description: "Please upload an image under 10MB.",
        variant: "destructive",
      });
      return;
    }

    setIsUploadingThumbnail(true);
    try {
      // Upload to Supabase storage
      const fileName = `${projectId}/thumbnails/uploaded_${Date.now()}.${file.name.split('.').pop()}`;
      const { data, error } = await supabase.storage
        .from('generated-assets')
        .upload(fileName, file, { upsert: true });

      if (error) throw error;

      // Get public URL
      const { data: urlData } = supabase.storage
        .from('generated-assets')
        .getPublicUrl(fileName);

      if (urlData?.publicUrl && onThumbnailUpload) {
        onThumbnailUpload(urlData.publicUrl);
        toast({
          title: "Thumbnail Uploaded",
          description: "Your thumbnail has been added to the generated thumbnails.",
        });
      }
    } catch (error) {
      console.error('Thumbnail upload error:', error);
      toast({
        title: "Upload Failed",
        description: error instanceof Error ? error.message : "Failed to upload thumbnail.",
        variant: "destructive",
      });
    } finally {
      setIsUploadingThumbnail(false);
      // Reset file input
      if (thumbnailUploadRef.current) {
        thumbnailUploadRef.current.value = '';
      }
    }
  };

  // Handle script file upload
  const handleScriptUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !onScriptUpload) return;

    setIsUploadingScript(true);
    try {
      const text = await file.text();
      onScriptUpload(text);
      toast({
        title: "Script Uploaded",
        description: "Your script has been loaded.",
      });
    } catch (error) {
      console.error('Script upload error:', error);
      toast({
        title: "Upload Failed",
        description: error instanceof Error ? error.message : "Failed to read script file.",
        variant: "destructive",
      });
    } finally {
      setIsUploadingScript(false);
      if (scriptUploadRef.current) {
        scriptUploadRef.current.value = '';
      }
    }
  };

  // Handle audio file upload
  const handleAudioUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !onAudioUpload || !projectId) return;

    setIsUploadingAudio(true);
    try {
      const audioFileName = `${projectId}/voiceover.wav`;
      const { error: uploadError } = await supabase.storage
        .from("generated-assets")
        .upload(audioFileName, file, { upsert: true });

      if (uploadError) throw uploadError;

      const { data: { publicUrl } } = supabase.storage
        .from("generated-assets")
        .getPublicUrl(audioFileName);

      onAudioUpload(publicUrl);
      toast({
        title: "Audio Uploaded",
        description: "Your audio file has been uploaded.",
      });
    } catch (error) {
      console.error('Audio upload error:', error);
      toast({
        title: "Upload Failed",
        description: error instanceof Error ? error.message : "Failed to upload audio.",
        variant: "destructive",
      });
    } finally {
      setIsUploadingAudio(false);
      if (audioUploadRef.current) {
        audioUploadRef.current.value = '';
      }
    }
  };

  // Handle captions file upload
  const handleCaptionsUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !onCaptionsUpload) return;

    setIsUploadingCaptions(true);
    try {
      const text = await file.text();
      onCaptionsUpload(text);
      toast({
        title: "Captions Uploaded",
        description: "Your captions have been loaded.",
      });
    } catch (error) {
      console.error('Captions upload error:', error);
      toast({
        title: "Upload Failed",
        description: error instanceof Error ? error.message : "Failed to read captions file.",
        variant: "destructive",
      });
    } finally {
      setIsUploadingCaptions(false);
      if (captionsUploadRef.current) {
        captionsUploadRef.current.value = '';
      }
    }
  };

  // Handle images upload (multiple files)
  const handleImagesUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !onImagesUpload || !projectId) return;

    setIsUploadingImages(true);
    try {
      const uploadedUrls: string[] = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const imageFileName = `${projectId}/images/image_${String(i + 1).padStart(3, '0')}.png`;

        const { error: uploadError } = await supabase.storage
          .from("generated-assets")
          .upload(imageFileName, file, { upsert: true });

        if (uploadError) {
          console.error(`Failed to upload image ${i + 1}:`, uploadError);
          continue;
        }

        const { data: { publicUrl } } = supabase.storage
          .from("generated-assets")
          .getPublicUrl(imageFileName);

        uploadedUrls.push(publicUrl);
      }

      if (uploadedUrls.length > 0) {
        onImagesUpload(uploadedUrls);
        toast({
          title: "Images Uploaded",
          description: `${uploadedUrls.length} image(s) have been uploaded.`,
        });
      }
    } catch (error) {
      console.error('Images upload error:', error);
      toast({
        title: "Upload Failed",
        description: error instanceof Error ? error.message : "Failed to upload images.",
        variant: "destructive",
      });
    } finally {
      setIsUploadingImages(false);
      if (imagesUploadRef.current) {
        imagesUploadRef.current.value = '';
      }
    }
  };

  // Handle prompts file upload (JSON)
  const handlePromptsUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !onPromptsUpload) return;

    setIsUploadingPrompts(true);
    try {
      const text = await file.text();
      const prompts = JSON.parse(text) as ImagePromptWithTiming[];

      // Validate the structure
      if (!Array.isArray(prompts) || prompts.length === 0) {
        throw new Error("Invalid prompts file: expected an array of prompts");
      }

      onPromptsUpload(prompts);
      toast({
        title: "Prompts Uploaded",
        description: `${prompts.length} scene prompts have been loaded.`,
      });
    } catch (error) {
      console.error('Prompts upload error:', error);
      toast({
        title: "Upload Failed",
        description: error instanceof Error ? error.message : "Failed to parse prompts file. Make sure it's valid JSON.",
        variant: "destructive",
      });
    } finally {
      setIsUploadingPrompts(false);
      if (promptsUploadRef.current) {
        promptsUploadRef.current.value = '';
      }
    }
  };

  // Download prompts as JSON
  const handleDownloadPrompts = () => {
    if (!imagePrompts || imagePrompts.length === 0) return;

    const json = JSON.stringify(imagePrompts, null, 2);
    downloadTextContent(json, 'image-prompts.json', 'application/json');
    toast({
      title: "Download Complete",
      description: "image-prompts.json downloaded successfully.",
    });
  };

  // Download all thumbnails as ZIP
  const handleDownloadThumbnailsZip = async () => {
    if (!thumbnails || thumbnails.length === 0) {
      toast({
        title: "No Thumbnails",
        description: "No thumbnails available to download.",
        variant: "destructive",
      });
      return;
    }

    toast({
      title: "Preparing Download",
      description: `Creating zip file with ${thumbnails.length} thumbnails...`,
    });

    try {
      const zip = new JSZip();
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

      for (let i = 0; i < thumbnails.length; i++) {
        const url = thumbnails[i];
        const filename = `thumbnail_${i + 1}.png`;

        try {
          // Use edge function as proxy to bypass CORS restrictions
          const response = await fetch(`${supabaseUrl}/functions/v1/download-images-zip`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${supabaseKey}`,
              'apikey': supabaseKey,
            },
            body: JSON.stringify({ imageUrl: url })
          });

          if (!response.ok) {
            console.error(`Failed to fetch thumbnail ${i + 1}:`, response.status);
            continue;
          }

          const blob = await response.blob();
          if (blob.size > 0) {
            zip.file(filename, blob);
          }
        } catch (error) {
          console.error(`Error fetching thumbnail ${i + 1}:`, error);
          continue;
        }
      }

      const fileCount = Object.keys(zip.files).length;
      if (fileCount === 0) {
        toast({
          title: "No Thumbnails Downloaded",
          description: "Failed to fetch thumbnails. Please try again.",
          variant: "destructive",
        });
        return;
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const url = window.URL.createObjectURL(zipBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'thumbnails.zip';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);

      toast({
        title: "Download Complete",
        description: `thumbnails.zip downloaded with ${fileCount} thumbnails.`,
      });
    } catch (error) {
      console.error('Zip creation failed:', error);
      toast({
        title: "Download Failed",
        description: "Failed to create zip file. Please try again.",
        variant: "destructive",
      });
    }
  };

  // Handle video file upload (basic video)
  const handleVideoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !onVideoUpload || !projectId) return;

    setIsUploadingVideo(true);
    try {
      const videoFileName = `${projectId}/video.mp4`;
      const { error: uploadError } = await supabase.storage
        .from("generated-assets")
        .upload(videoFileName, file, { upsert: true });

      if (uploadError) throw uploadError;

      const { data: { publicUrl } } = supabase.storage
        .from("generated-assets")
        .getPublicUrl(videoFileName);

      onVideoUpload(publicUrl, 'basic');
      setBasicVideoUrl(publicUrl);
      toast({
        title: "Video Uploaded",
        description: "Your video has been uploaded.",
      });
    } catch (error) {
      console.error('Video upload error:', error);
      toast({
        title: "Upload Failed",
        description: error instanceof Error ? error.message : "Failed to upload video.",
        variant: "destructive",
      });
    } finally {
      setIsUploadingVideo(false);
      if (videoUploadRef.current) {
        videoUploadRef.current.value = '';
      }
    }
  };

  // NOTE: Auto-render has been REMOVED from ProjectResults.
  // Full automation mode uses the pipeline modals (review-render, review-youtube) instead.
  // This component is the final "Project Ready" page and should NEVER auto-trigger rendering.

  // Auto-heal image prompts when count doesn't match images
  useEffect(() => {
    const imageAssets = assets.filter(a => a.id.startsWith('image-') && a.url);
    const imageCount = imageAssets.length;
    const promptCount = imagePrompts?.length || 0;

    // Only heal if we have images, srt content, and a mismatch
    if (imageCount > 0 && srtContent && promptCount !== imageCount && onImagePromptsHealed) {
      console.log(`[ProjectResults] Healing image prompts: ${promptCount} prompts → ${imageCount} images`);

      const segments = parseSRTTimings(srtContent);
      if (segments.length === 0) return;

      const totalDuration = segments[segments.length - 1].endTime;
      const imageDuration = totalDuration / imageCount;

      // Create healed prompts with correct timing for each image
      const healedPrompts: ImagePromptWithTiming[] = imageAssets.map((_, index) => {
        const startSeconds = index * imageDuration;
        const endSeconds = (index + 1) * imageDuration;

        // Try to use existing prompt if it exists for this index
        const existingPrompt = imagePrompts?.[index];

        return {
          index,
          prompt: existingPrompt?.prompt || `Scene ${index + 1}`,
          sceneDescription: existingPrompt?.sceneDescription || `Scene ${index + 1}`,
          startSeconds,
          endSeconds,
        };
      });

      onImagePromptsHealed(healedPrompts);
    }
  }, [assets, imagePrompts, srtContent, onImagePromptsHealed]);

  // Calculate image timings based on SRT
  const getImageTimings = () => {
    const imageAssets = assets.filter(a => a.id.startsWith('image-') && a.url);
    if (!srtContent || imageAssets.length === 0) return [];

    const segments = parseSRTTimings(srtContent);
    if (segments.length === 0) return [];

    const totalDuration = segments[segments.length - 1].endTime;
    const imageDuration = totalDuration / imageAssets.length;

    return imageAssets.map((asset, index) => ({
      asset,
      startTime: index * imageDuration,
      endTime: (index + 1) * imageDuration,
    }));
  };

  const imageTimings = getImageTimings();

  const handleDownload = async (asset: GeneratedAsset, customFilename?: string) => {
    try {
      if (asset.content) {
        const extension = asset.type.toLowerCase() === 'markdown' ? 'md' : asset.type.toLowerCase();
        const mimeType = asset.type === 'Markdown' ? 'text/markdown' : 
                         asset.type === 'SRT' ? 'text/plain' : 'text/plain';
        const filename = customFilename || `${asset.name.replace(/\s+/g, '_')}.${extension}`;
        downloadTextContent(asset.content, filename, mimeType);
        toast({
          title: "Download Complete",
          description: `${filename} downloaded successfully.`,
        });
      } else if (asset.url) {
        toast({
          title: "Downloading...",
          description: `Downloading ${asset.name}...`,
        });
        const extension = asset.type.toLowerCase() === 'png' ? 'png' : 
                         asset.type.toLowerCase() === 'markdown' ? 'md' : asset.type.toLowerCase();
        const filename = customFilename || `${asset.name.replace(/\s+/g, '_')}.${extension}`;
        await downloadFromUrl(asset.url, filename);
        toast({
          title: "Download Complete",
          description: `${filename} downloaded successfully.`,
        });
      } else {
        toast({
          title: "Download Unavailable",
          description: "This asset is not available for download yet.",
          variant: "destructive",
        });
      }
    } catch (error) {
      toast({
        title: "Download Failed",
        description: "Failed to download the file. Please try again.",
        variant: "destructive",
      });
    }
  };


  const handleDownloadAllImagesAsZip = async () => {
    const imageAssets = assets.filter(a => a.id.startsWith('image-') && a.url);
    if (imageAssets.length === 0) {
      toast({
        title: "No Images",
        description: "No images available to download.",
        variant: "destructive",
      });
      return;
    }

    toast({
      title: "Preparing Download",
      description: `Creating zip file with ${imageAssets.length} images...`,
    });

    try {
      const zip = new JSZip();
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

      // Fetch each image via edge function proxy to bypass CORS restrictions
      for (let i = 0; i < imageAssets.length; i++) {
        const asset = imageAssets[i];
        if (!asset.url) continue;

        const timing = imageTimings.find(t => t.asset.id === asset.id);
        const filename = timing
          ? `image_${formatTimestamp(timing.startTime, timing.endTime)}.png`
          : `image_${i + 1}.png`;

        console.log(`Fetching image ${i + 1}/${imageAssets.length}: ${filename}`);

        try {
          // Use edge function as proxy to bypass CORS restrictions
          const response = await fetch(`${supabaseUrl}/functions/v1/download-images-zip`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${supabaseKey}`,
              'apikey': supabaseKey,
            },
            body: JSON.stringify({ imageUrl: asset.url })
          });

          if (!response.ok) {
            console.error(`Failed to fetch image ${i + 1}:`, response.status);
            const errorText = await response.text();
            console.error(`Error details:`, errorText);
            continue;
          }

          const blob = await response.blob();
          console.log(`Image ${i + 1} blob size:`, blob.size);

          if (blob.size === 0) {
            console.error(`Image ${i + 1} blob is empty`);
            continue;
          }

          zip.file(filename, blob);
        } catch (error) {
          console.error(`Error fetching image ${i + 1}:`, error);
          continue;
        }
      }

      // Check if any files were added to the ZIP
      const fileCount = Object.keys(zip.files).length;
      console.log(`ZIP contains ${fileCount} files`);

      if (fileCount === 0) {
        toast({
          title: "No Images Downloaded",
          description: "Failed to fetch images. Please try again.",
          variant: "destructive",
        });
        return;
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      console.log(`Generated ZIP blob size: ${zipBlob.size} bytes`);

      if (zipBlob.size === 0) {
        toast({
          title: "ZIP Creation Failed",
          description: "Generated ZIP file is empty. Please try again.",
          variant: "destructive",
        });
        return;
      }

      const url = window.URL.createObjectURL(zipBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'images.zip';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);

      toast({
        title: "Download Complete",
        description: `images.zip downloaded with ${fileCount} images.`,
      });
    } catch (error) {
      console.error('Zip creation failed:', error);
      toast({
        title: "Download Failed",
        description: "Failed to create zip file. Please try again.",
        variant: "destructive",
      });
    }
  };

  // Handle Render Video (MP4) - type determines basic, embers, or smoke_embers
  const handleRenderVideo = async (type: 'basic' | 'embers' | 'smoke_embers') => {
    // Validate required data
    if (!projectId) {
      toast({
        title: "Render Unavailable",
        description: "Project ID is required for video rendering.",
        variant: "destructive",
      });
      return;
    }

    if (!audioUrl) {
      toast({
        title: "Render Unavailable",
        description: "Audio is required for video rendering.",
        variant: "destructive",
      });
      return;
    }

    if (!srtContent) {
      toast({
        title: "Render Unavailable",
        description: "Captions are required for video rendering.",
        variant: "destructive",
      });
      return;
    }

    const imageAssets = assets.filter(a => a.id.startsWith('image-') && a.url);
    if (imageAssets.length === 0) {
      toast({
        title: "Render Unavailable",
        description: "Images are required for video rendering.",
        variant: "destructive",
      });
      return;
    }

    // Get image URLs and timings
    const imageUrls = imageAssets.map(a => a.url!);
    let timings: { startSeconds: number; endSeconds: number }[] = [];

    // Only use imagePrompts if they match image count exactly
    if (imagePrompts && imagePrompts.length === imageAssets.length) {
      timings = imagePrompts.map(p => ({
        startSeconds: p.startSeconds,
        endSeconds: p.endSeconds
      }));
    } else {
      // Calculate evenly distributed timings from SRT
      const srtTimings = parseSRTTimings(srtContent);
      const totalDuration = srtTimings.length > 0 ? srtTimings[srtTimings.length - 1].endTime : 0;
      const imageDuration = totalDuration / imageAssets.length;
      timings = imageAssets.map((_, i) => ({
        startSeconds: i * imageDuration,
        endSeconds: (i + 1) * imageDuration
      }));
    }

    // Set effects based on type
    const effects: VideoEffects = {
      embers: type === 'embers',
      smoke_embers: type === 'smoke_embers'
    };

    // Start rendering
    setCurrentRenderType(type);
    if (type === 'basic') {
      setIsRenderingBasic(true);
      setBasicVideoUrl(null);
    } else if (type === 'embers') {
      setIsRenderingEmbers(true);
      setEmbersVideoUrl(null);
    } else {
      setIsRenderingSmokeEmbers(true);
      setSmokeEmbersVideoUrl(null);
    }
    setRenderProgress({ stage: 'downloading', percent: 0, message: 'Starting...' });

    try {
      const result = await renderVideoStreaming(
        projectId,
        audioUrl,
        imageUrls,
        timings,
        srtContent,
        projectTitle || 'HistoryGenAI Export',
        {
          onProgress: (progress) => setRenderProgress(progress),
          onVideoReady: (url) => {
            // Video is ready - show preview immediately
            if (type === 'basic') {
              setBasicVideoUrl(url);
              if (onVideoRendered) onVideoRendered(url);
            } else if (type === 'embers') {
              setEmbersVideoUrl(url);
              if (onEmbersVideoRendered) onEmbersVideoRendered(url);
            } else {
              setSmokeEmbersVideoUrl(url);
              if (onSmokeEmbersVideoRendered) onSmokeEmbersVideoRendered(url);
            }
            toast({
              title: "Video Ready",
              description: type === 'embers' ? "Your video with embers effect has been rendered!" :
                          type === 'smoke_embers' ? "Your video with smoke & embers effect has been rendered!" :
                          "Your video has been rendered successfully!",
            });
          },
          onCaptionError: (error) => {
            // Caption errors are now ignored since we don't burn captions
            console.warn('Caption error (ignored):', error);
          }
        },
        effects
      );

      // Final result
      if (result.success && result.videoUrl) {
        if (type === 'basic') {
          setBasicVideoUrl(result.videoUrl);
          setIsRenderingBasic(false);
          if (onVideoRendered) onVideoRendered(result.videoUrl);
        } else if (type === 'embers') {
          setEmbersVideoUrl(result.videoUrl);
          setIsRenderingEmbers(false);
          if (onEmbersVideoRendered) onEmbersVideoRendered(result.videoUrl);
        } else {
          setSmokeEmbersVideoUrl(result.videoUrl);
          setIsRenderingSmokeEmbers(false);
          if (onSmokeEmbersVideoRendered) onSmokeEmbersVideoRendered(result.videoUrl);
        }
        toast({
          title: "Video Complete",
          description: "Your video is ready to download!",
        });
      } else {
        // Show error
        if (type === 'basic') {
          setIsRenderingBasic(false);
        } else if (type === 'embers') {
          setIsRenderingEmbers(false);
        } else {
          setIsRenderingSmokeEmbers(false);
        }
        toast({
          title: "Render Failed",
          description: result.error || "Failed to render video. Please try again.",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error('Render video error:', error);
      if (type === 'basic') {
        setIsRenderingBasic(false);
      } else if (type === 'embers') {
        setIsRenderingEmbers(false);
      } else {
        setIsRenderingSmokeEmbers(false);
      }
      toast({
        title: "Render Failed",
        description: error instanceof Error ? error.message : "Failed to render video. Please try again.",
        variant: "destructive",
      });
    }
  };

  // Sanitize project title for filename
  const getSafeFilename = (title: string | undefined, suffix: string = '') => {
    const base = (title || 'video').replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '_').substring(0, 50);
    return suffix ? `${base}_${suffix}.mp4` : `${base}.mp4`;
  };

  // Download rendered video
  const handleDownloadVideo = async (type: 'basic' | 'embers' | 'smoke_embers') => {
    const url = type === 'basic' ? basicVideoUrl : (type === 'embers' ? embersVideoUrl : smokeEmbersVideoUrl);
    if (!url) return;

    const suffix = type === 'embers' ? 'embers' : (type === 'smoke_embers' ? 'smoke_embers' : '');
    const filename = getSafeFilename(projectTitle, suffix);
    const description = type === 'smoke_embers' ? 'video with smoke + embers...' : (type === 'embers' ? 'video with embers...' : 'video...');
    toast({
      title: "Downloading...",
      description: `Downloading ${description}`,
    });

    try {
      await downloadFromUrl(url, filename);
      toast({
        title: "Download Complete",
        description: `${filename} downloaded successfully.`,
      });
    } catch (error) {
      toast({
        title: "Download Failed",
        description: "Failed to download video. Please try again.",
        variant: "destructive",
      });
    }
  };

  // Close render modal
  const handleCloseRenderModal = () => {
    const isRendering = isRenderingBasic || isRenderingEmbers;
    const hasVideo = currentRenderType === 'basic' ? basicVideoUrl : embersVideoUrl;
    if (!isRendering || hasVideo) {
      setIsRenderingBasic(false);
      setIsRenderingEmbers(false);
      setRenderProgress(null);
    }
  };

  // Get stage label for progress
  const getStageLabel = (stage: string): string => {
    switch (stage) {
      case 'downloading': return 'Downloading assets';
      case 'preparing': return 'Preparing timeline';
      case 'rendering': return 'Rendering video';
      case 'uploading': return 'Uploading video';
      default: return stage;
    }
  };

  // Get first image URL for fallback preview
  const firstImageUrl = assets.find(a => a.id.startsWith('image-') && a.url)?.url;
  // Get selected thumbnail for YouTube-style preview
  const selectedThumbnailUrl = thumbnails && selectedThumbnailIndex !== undefined && selectedThumbnailIndex >= 0
    ? thumbnails[selectedThumbnailIndex]
    : thumbnails?.[0]; // Fall back to first thumbnail if none selected
  // Get best available video for preview
  const previewVideoUrl = smokeEmbersVideoUrl || embersVideoUrl || basicVideoUrl || initialSmokeEmbersVideoUrl || initialEmbersVideoUrl || videoUrl;
  return (
    <div className="w-full max-w-4xl mx-auto px-4 py-8">
      {/* Header with Project Title */}
      <div className="mb-6">
        {isEditingTitle ? (
          <div className="flex items-center gap-2">
            <input
              ref={titleInputRef}
              type="text"
              value={editedTitle}
              onChange={(e) => setEditedTitle(e.target.value)}
              onKeyDown={handleTitleKeyDown}
              onBlur={handleSaveTitle}
              className="text-2xl font-bold bg-transparent border-b-2 border-primary outline-none flex-1 min-w-[200px]"
              maxLength={100}
            />
            <Button variant="ghost" size="icon" onClick={handleSaveTitle} className="shrink-0 h-8 w-8">
              <Check className="w-4 h-4 text-green-600" />
            </Button>
            <Button variant="ghost" size="icon" onClick={handleCancelTitleEdit} className="shrink-0 h-8 w-8">
              <X className="w-4 h-4 text-muted-foreground" />
            </Button>
          </div>
        ) : (
          <div className="flex items-start gap-2 group">
            <h1 className="text-2xl font-bold text-foreground break-words">
              {projectTitle || "Untitled Project"}
            </h1>
            {onTitleChange && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setIsEditingTitle(true)}
                className="shrink-0 h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
                title="Edit project name"
              >
                <Pencil className="w-4 h-4 text-muted-foreground" />
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Resume Full Auto Banner */}
      {(getResumeStep() || isResuming) && (
        <div className="mb-6 p-4 rounded-lg border border-primary/20 bg-primary/5 space-y-3">
          <div className="flex items-center gap-3">
            <Button
              onClick={handleResumeFullAuto}
              disabled={isResuming}
              className="gap-2 shrink-0"
            >
              {isResuming ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Zap className="w-4 h-4" />
              )}
              {isResuming ? 'Pipeline Running...' : 'Resume Full Auto'}
            </Button>
            <span className="text-sm text-muted-foreground">
              {isResuming && pipelineStep
                ? <><span className="font-medium text-foreground">{PIPELINE_STEPS[pipelineStep]?.label || pipelineStep}</span></>
                : <>from <span className="font-medium text-foreground">{PIPELINE_STEPS[getResumeStep() || '']?.label || getResumeStep()}</span></>
              }
            </span>
          </div>
          {isResuming && pipelineStep && (
            <div className="space-y-1">
              <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all duration-1000 ease-out"
                  style={{ width: `${PIPELINE_STEPS[pipelineStep]?.percent || 0}%` }}
                />
              </div>
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{PIPELINE_STEPS[pipelineStep]?.label || pipelineStep}</span>
                <span>{PIPELINE_STEPS[pipelineStep]?.percent || 0}%</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Two Column Layout */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-stretch">
        {/* Left Column: Pipeline Steps */}
        <div className="flex flex-col space-y-0 divide-y divide-border border rounded-lg p-4">
          {/* Script */}
          <div
            className={`flex items-center justify-between py-3 ${onGoToScript ? 'cursor-pointer hover:bg-muted/50' : ''} transition-colors px-2 -mx-2 rounded-lg`}
            onClick={onGoToScript}
          >
            <div className="flex items-center gap-3">
              <FileText className="w-5 h-5 text-muted-foreground" />
              <span className="font-medium text-foreground">Script</span>
              <span className="text-sm text-muted-foreground">
                {assets.find(a => a.id === 'script')
                  ? assets.find(a => a.id === 'script')!.size
                  : 'Pending'}
              </span>
              {getCostForStep('script') !== null && (
                <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                  {formatCost(getCostForStep('script'))}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => {
                  e.stopPropagation();
                  scriptUploadRef.current?.click();
                }}
                disabled={isUploadingScript || !onScriptUpload}
                className="h-8 w-8 text-muted-foreground hover:text-foreground disabled:opacity-30"
                title="Upload script"
              >
                {isUploadingScript ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Upload className="w-4 h-4" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => {
                  e.stopPropagation();
                  const scriptAsset = assets.find(a => a.id === 'script');
                  if (scriptAsset) handleDownload(scriptAsset, 'script.txt');
                }}
                disabled={!assets.find(a => a.id === 'script')}
                className="h-8 w-8 text-muted-foreground hover:text-foreground disabled:opacity-30"
                title="Download"
              >
                <Download className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => toggleApproval('script', e)}
                className={`h-8 w-8 ${
                  approvedSteps.includes('script')
                    ? 'text-green-600 dark:text-green-400'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                title={approvedSteps.includes('script') ? 'Mark as not approved' : 'Mark as approved'}
              >
                {approvedSteps.includes('script') ? (
                  <CheckSquare className="w-4 h-4" />
                ) : (
                  <Square className="w-4 h-4" />
                )}
              </Button>
            </div>
          </div>

          {/* Audio */}
          <div
            className={`flex items-center justify-between py-3 ${onGoToAudio ? 'cursor-pointer hover:bg-muted/50' : ''} transition-colors px-2 -mx-2 rounded-lg`}
            onClick={onGoToAudio}
          >
            <div className="flex items-center gap-3">
              <Mic className="w-5 h-5 text-muted-foreground" />
              <span className="font-medium text-foreground">Audio</span>
              <span className="text-sm text-muted-foreground">
                {assets.find(a => a.id === 'audio')
                  ? assets.find(a => a.id === 'audio')!.size
                  : 'Pending'}
              </span>
              {getCostForStep('audio') !== null && (
                <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                  {formatCost(getCostForStep('audio'))}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => {
                  e.stopPropagation();
                  audioUploadRef.current?.click();
                }}
                disabled={isUploadingAudio || !onAudioUpload}
                className="h-8 w-8 text-muted-foreground hover:text-foreground disabled:opacity-30"
                title="Upload audio"
              >
                {isUploadingAudio ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Upload className="w-4 h-4" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => {
                  e.stopPropagation();
                  const audioAsset = assets.find(a => a.id === 'audio');
                  if (audioAsset) handleDownload(audioAsset, 'voiceover.wav');
                }}
                disabled={!assets.find(a => a.id === 'audio')}
                className="h-8 w-8 text-muted-foreground hover:text-foreground disabled:opacity-30"
                title="Download"
              >
                <Download className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => toggleApproval('audio', e)}
                className={`h-8 w-8 ${
                  approvedSteps.includes('audio')
                    ? 'text-green-600 dark:text-green-400'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                title={approvedSteps.includes('audio') ? 'Mark as not approved' : 'Mark as approved'}
              >
                {approvedSteps.includes('audio') ? (
                  <CheckSquare className="w-4 h-4" />
                ) : (
                  <Square className="w-4 h-4" />
                )}
              </Button>
            </div>
          </div>

          {/* Captions */}
          <div
            className={`flex items-center justify-between py-3 ${onGoToCaptions ? 'cursor-pointer hover:bg-muted/50' : ''} transition-colors px-2 -mx-2 rounded-lg`}
            onClick={onGoToCaptions}
          >
            <div className="flex items-center gap-3">
              <MessageSquare className="w-5 h-5 text-muted-foreground" />
              <span className="font-medium text-foreground">Captions</span>
              <span className="text-sm text-muted-foreground">
                {srtContent
                  ? `${(srtContent.match(/^\d+$/gm) || []).length} segments`
                  : 'Pending'}
              </span>
              {getCostForStep('captions') !== null && (
                <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                  {formatCost(getCostForStep('captions'))}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => {
                  e.stopPropagation();
                  captionsUploadRef.current?.click();
                }}
                disabled={isUploadingCaptions || !onCaptionsUpload}
                className="h-8 w-8 text-muted-foreground hover:text-foreground disabled:opacity-30"
                title="Upload captions"
              >
                {isUploadingCaptions ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Upload className="w-4 h-4" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => {
                  e.stopPropagation();
                  if (srtContent) {
                    const blob = new Blob([srtContent], { type: 'text/plain' });
                    const url = window.URL.createObjectURL(blob);
                    const link = document.createElement('a');
                    link.href = url;
                    link.download = 'captions.srt';
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                    window.URL.revokeObjectURL(url);
                  }
                }}
                disabled={!srtContent}
                className="h-8 w-8 text-muted-foreground hover:text-foreground disabled:opacity-30"
                title="Download"
              >
                <Download className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => toggleApproval('captions', e)}
                className={`h-8 w-8 ${
                  approvedSteps.includes('captions')
                    ? 'text-green-600 dark:text-green-400'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                title={approvedSteps.includes('captions') ? 'Mark as not approved' : 'Mark as approved'}
              >
                {approvedSteps.includes('captions') ? (
                  <CheckSquare className="w-4 h-4" />
                ) : (
                  <Square className="w-4 h-4" />
                )}
              </Button>
            </div>
          </div>

          {/* Video Prompts (Clip Prompts) */}
          <div
            className={`flex items-center justify-between py-3 ${onGoToClipPrompts ? 'cursor-pointer hover:bg-muted/50' : ''} transition-colors px-2 -mx-2 rounded-lg`}
            onClick={onGoToClipPrompts}
          >
            <div className="flex items-center gap-3">
              <Sparkles className="w-5 h-5 text-muted-foreground" />
              <span className="font-medium text-foreground">Video Prompts</span>
              <span className="text-sm text-muted-foreground">
                {clipPrompts && clipPrompts.length > 0
                  ? `${clipPrompts.length} scenes`
                  : 'Pending'}
              </span>
              {getCostForStep('clip_prompts') !== null && (
                <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                  {formatCost(getCostForStep('clip_prompts'))}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => toggleApproval('clipPrompts', e)}
                className={`h-8 w-8 ${
                  approvedSteps.includes('clipPrompts')
                    ? 'text-green-600 dark:text-green-400'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                title={approvedSteps.includes('clipPrompts') ? 'Mark as not approved' : 'Mark as approved'}
              >
                {approvedSteps.includes('clipPrompts') ? (
                  <CheckSquare className="w-4 h-4" />
                ) : (
                  <Square className="w-4 h-4" />
                )}
              </Button>
            </div>
          </div>

          {/* Video Clips */}
          <div
            className={`flex items-center justify-between py-3 ${onGoToClips ? 'cursor-pointer hover:bg-muted/50' : ''} transition-colors px-2 -mx-2 rounded-lg`}
            onClick={onGoToClips}
          >
            <div className="flex items-center gap-3">
              <Film className="w-5 h-5 text-muted-foreground" />
              <span className="font-medium text-foreground">Video Clips</span>
              <span className="text-sm text-muted-foreground">
                {clipUrls && clipUrls.length > 0
                  ? `${clipUrls.length} × 12s clips`
                  : 'Pending'}
              </span>
              {getCostForStep('video_clips') !== null && (
                <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                  {formatCost(getCostForStep('video_clips'))}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => toggleApproval('clips', e)}
                className={`h-8 w-8 ${
                  approvedSteps.includes('clips')
                    ? 'text-green-600 dark:text-green-400'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                title={approvedSteps.includes('clips') ? 'Mark as not approved' : 'Mark as approved'}
              >
                {approvedSteps.includes('clips') ? (
                  <CheckSquare className="w-4 h-4" />
                ) : (
                  <Square className="w-4 h-4" />
                )}
              </Button>
            </div>
          </div>

          {/* Image Prompts */}
          <div
            className={`flex items-center justify-between py-3 ${onGoToPrompts ? 'cursor-pointer hover:bg-muted/50' : ''} transition-colors px-2 -mx-2 rounded-lg`}
            onClick={onGoToPrompts}
          >
            <div className="flex items-center gap-3">
              <Palette className="w-5 h-5 text-muted-foreground" />
              <span className="font-medium text-foreground">Prompts</span>
              <span className="text-sm text-muted-foreground">
                {imagePrompts && imagePrompts.length > 0
                  ? `${imagePrompts.length} scenes`
                  : 'Pending'}
              </span>
              {getCostForStep('image_prompts') !== null && (
                <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                  {formatCost(getCostForStep('image_prompts'))}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => {
                  e.stopPropagation();
                  promptsUploadRef.current?.click();
                }}
                disabled={isUploadingPrompts || !onPromptsUpload}
                className="h-8 w-8 text-muted-foreground hover:text-foreground disabled:opacity-30"
                title="Upload prompts (JSON)"
              >
                {isUploadingPrompts ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Upload className="w-4 h-4" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => {
                  e.stopPropagation();
                  if (imagePrompts && imagePrompts.length > 0) handleDownloadPrompts();
                }}
                disabled={!imagePrompts || imagePrompts.length === 0}
                className="h-8 w-8 text-muted-foreground hover:text-foreground disabled:opacity-30"
                title="Download prompts (JSON)"
              >
                <Download className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => toggleApproval('prompts', e)}
                className={`h-8 w-8 ${
                  approvedSteps.includes('prompts')
                    ? 'text-green-600 dark:text-green-400'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                title={approvedSteps.includes('prompts') ? 'Mark as not approved' : 'Mark as approved'}
              >
                {approvedSteps.includes('prompts') ? (
                  <CheckSquare className="w-4 h-4" />
                ) : (
                  <Square className="w-4 h-4" />
                )}
              </Button>
            </div>
          </div>

          {/* Images */}
          <div
            className={`flex items-center justify-between py-3 ${onGoToImages ? 'cursor-pointer hover:bg-muted/50' : ''} transition-colors px-2 -mx-2 rounded-lg`}
            onClick={onGoToImages}
          >
            <div className="flex items-center gap-3">
              <Image className="w-5 h-5 text-muted-foreground" />
              <span className="font-medium text-foreground">Images</span>
              <span className="text-sm text-muted-foreground">
                {assets.some(a => a.id.startsWith('image-') && a.url)
                  ? `${assets.filter(a => a.id.startsWith('image-') && a.url).length} generated`
                  : 'Pending'}
              </span>
              {getCostForStep('images') !== null && (
                <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                  {formatCost(getCostForStep('images'))}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => {
                  e.stopPropagation();
                  imagesUploadRef.current?.click();
                }}
                disabled={isUploadingImages || !onImagesUpload}
                className="h-8 w-8 text-muted-foreground hover:text-foreground disabled:opacity-30"
                title="Upload images"
              >
                {isUploadingImages ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Upload className="w-4 h-4" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => {
                  e.stopPropagation();
                  if (assets.some(a => a.id.startsWith('image-') && a.url)) handleDownloadAllImagesAsZip();
                }}
                disabled={!assets.some(a => a.id.startsWith('image-') && a.url)}
                className="h-8 w-8 text-muted-foreground hover:text-foreground disabled:opacity-30"
                title="Download ZIP"
              >
                <Download className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => toggleApproval('images', e)}
                className={`h-8 w-8 ${
                  approvedSteps.includes('images')
                    ? 'text-green-600 dark:text-green-400'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                title={approvedSteps.includes('images') ? 'Mark as not approved' : 'Mark as approved'}
              >
                {approvedSteps.includes('images') ? (
                  <CheckSquare className="w-4 h-4" />
                ) : (
                  <Square className="w-4 h-4" />
                )}
              </Button>
            </div>
          </div>

          {/* Video Render (2-pass: basic + effects) */}
          {(() => {
            const hasBasic = !!basicVideoUrl;
            const hasEmbers = !!embersVideoUrl;
            const hasSmokeEmbers = !!smokeEmbersVideoUrl;
            const hasAnyEffects = hasEmbers || hasSmokeEmbers;
            const statusText = hasAnyEffects
              ? (hasSmokeEmbers ? 'Smoke + Embers ready' : 'Embers ready')
              : hasBasic
                ? 'Basic ready'
                : 'Pending';

            return (
              <div
                className={`flex items-center justify-between py-3 ${onGoToRender ? 'cursor-pointer hover:bg-muted/50' : ''} transition-colors px-2 -mx-2 rounded-lg`}
                onClick={onGoToRender}
              >
                <div className="flex items-center gap-3">
                  <Film className="w-5 h-5 text-muted-foreground" />
                  <span className="font-medium text-foreground">Video Render</span>
                  <span className="text-sm text-muted-foreground">
                    {statusText}
                  </span>
                  {getCostForStep('render') !== null && (
                    <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                      {formatCost(getCostForStep('render'))}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      videoUploadRef.current?.click();
                    }}
                    disabled={isUploadingVideo || !onVideoUpload}
                    className="h-8 w-8 text-muted-foreground hover:text-foreground disabled:opacity-30"
                    title="Upload video"
                  >
                    {isUploadingVideo ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Upload className="w-4 h-4" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (smokeEmbersVideoUrl) handleDownloadVideo('smoke_embers');
                      else if (embersVideoUrl) handleDownloadVideo('embers');
                      else if (basicVideoUrl) handleDownloadVideo('basic');
                    }}
                    disabled={!smokeEmbersVideoUrl && !embersVideoUrl && !basicVideoUrl}
                    className="h-8 w-8 text-muted-foreground hover:text-foreground disabled:opacity-30"
                    title="Download Video"
                  >
                    <Download className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={(e) => toggleApproval('render', e)}
                    className={`h-8 w-8 ${
                      approvedSteps.includes('render')
                        ? 'text-green-600 dark:text-green-400'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                    title={approvedSteps.includes('render') ? 'Mark as not approved' : 'Mark as approved'}
                  >
                    {approvedSteps.includes('render') ? (
                      <CheckSquare className="w-4 h-4" />
                    ) : (
                      <Square className="w-4 h-4" />
                    )}
                  </Button>
                </div>
              </div>
            );
          })()}

          {/* Thumbnails */}
          <div
            className={`flex items-center justify-between py-3 ${onGoToThumbnails ? 'cursor-pointer hover:bg-muted/50' : ''} transition-colors px-2 -mx-2 rounded-lg`}
            onClick={onGoToThumbnails}
          >
            <div className="flex items-center gap-3">
              <Target className="w-5 h-5 text-muted-foreground" />
              <span className="font-medium text-foreground">Thumbnails</span>
              <span className="text-sm text-muted-foreground">
                {thumbnails && thumbnails.length > 0
                  ? selectedThumbnailIndex !== undefined && selectedThumbnailIndex >= 0
                    ? 'Selected'
                    : `${thumbnails.length} ready`
                  : 'Pending'}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => {
                  e.stopPropagation();
                  thumbnailUploadRef.current?.click();
                }}
                disabled={isUploadingThumbnail || !onThumbnailUpload}
                className="h-8 w-8 text-muted-foreground hover:text-foreground disabled:opacity-30"
                title="Upload thumbnail"
              >
                {isUploadingThumbnail ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Upload className="w-4 h-4" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => {
                  e.stopPropagation();
                  if (thumbnails && thumbnails.length > 0) handleDownloadThumbnailsZip();
                }}
                disabled={!thumbnails || thumbnails.length === 0}
                className="h-8 w-8 text-muted-foreground hover:text-foreground disabled:opacity-30"
                title="Download thumbnails (ZIP)"
              >
                <Download className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => toggleApproval('thumbnails', e)}
                className={`h-8 w-8 ${
                  approvedSteps.includes('thumbnails')
                    ? 'text-green-600 dark:text-green-400'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                title={approvedSteps.includes('thumbnails') ? 'Mark as not approved' : 'Mark as approved'}
              >
                {approvedSteps.includes('thumbnails') ? (
                  <CheckSquare className="w-4 h-4" />
                ) : (
                  <Square className="w-4 h-4" />
                )}
              </Button>
            </div>
          </div>

          {/* YouTube Upload */}
          {(() => {
            const hasVideo = basicVideoUrl || embersVideoUrl || smokeEmbersVideoUrl || videoUrl || initialEmbersVideoUrl || initialSmokeEmbersVideoUrl;

            return (
              <div
                className={`flex items-center justify-between py-3 ${hasVideo ? 'cursor-pointer hover:bg-muted/50' : ''} transition-colors px-2 -mx-2 rounded-lg`}
                onClick={hasVideo ? () => setIsYouTubeModalOpen(true) : undefined}
              >
                <div className="flex items-center gap-3">
                  <Youtube className="w-5 h-5 text-muted-foreground" />
                  <span className="font-medium text-foreground">YouTube</span>
                  <span className="text-sm text-muted-foreground">
                    {hasVideo ? 'Upload' : 'Pending'}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={(e) => toggleApproval('youtube', e)}
                  className={`h-8 w-8 ${
                    approvedSteps.includes('youtube')
                      ? 'text-green-600 dark:text-green-400'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  title={approvedSteps.includes('youtube') ? 'Mark as not approved' : 'Mark as approved'}
                >
                  {approvedSteps.includes('youtube') ? (
                    <CheckSquare className="w-4 h-4" />
                  ) : (
                    <Square className="w-4 h-4" />
                  )}
                </Button>
              </div>
            );
          })()}


          {/* Total Cost */}
          {costs && costs.totalCost > 0 && (
            <div className="flex items-center justify-between py-3 border-t border-dashed mt-2">
              <div className="flex items-center gap-3">
                <span className="font-medium text-foreground">Total Cost</span>
              </div>
              <span className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                ${costs.totalCost.toFixed(2)}
              </span>
            </div>
          )}

          {/* Tags Section */}
          <div className="py-3 space-y-3">
              <div className="flex items-center gap-3">
                <Tag className="w-5 h-5 text-muted-foreground" />
                <span className="font-medium text-foreground">Tags</span>
                <span className="text-sm text-muted-foreground">
                  {tags.length > 0 ? `${tags.length} tag${tags.length !== 1 ? 's' : ''}` : 'None'}
                </span>
              </div>
              {/* Existing tags */}
              {tags.length > 0 && (
                <div className="flex flex-wrap gap-2 pl-8">
                  {tags.map((tag, index) => (
                    <span
                      key={index}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-sm bg-primary/10 text-primary"
                    >
                      {tag}
                      {onTagsChange && (
                        <button
                          onClick={() => {
                            const newTags = tags.filter((_, i) => i !== index);
                            onTagsChange(newTags);
                          }}
                          className="ml-0.5 hover:text-destructive transition-colors"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </span>
                  ))}
                </div>
              )}
              {/* Add new tag */}
              {onTagsChange && (
                <div className="flex gap-2 pl-8">
                  <Input
                    value={newTagInput}
                    onChange={(e) => setNewTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newTagInput.trim()) {
                        e.preventDefault();
                        const trimmed = newTagInput.trim();
                        if (!tags.includes(trimmed)) {
                          onTagsChange([...tags, trimmed]);
                        }
                        setNewTagInput("");
                      }
                    }}
                    placeholder="Add tag (e.g., Medieval, Ancient Egypt)"
                    className="flex-1 h-8 text-sm"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (newTagInput.trim()) {
                        const trimmed = newTagInput.trim();
                        if (!tags.includes(trimmed)) {
                          onTagsChange([...tags, trimmed]);
                        }
                        setNewTagInput("");
                      }
                    }}
                    disabled={!newTagInput.trim()}
                    className="h-8 px-2"
                  >
                    <Plus className="w-4 h-4" />
                  </Button>
                </div>
              )}
            </div>

          {/* Update Title, Save Version & Duplicate Buttons */}
          {(onTitleChange || onSaveVersion || onDuplicate) && (
            <div className="pt-4 mt-auto border-t space-y-2">
              {onTitleChange && youtubeTitle && (
                <Button
                  variant="outline"
                  className="w-full gap-2"
                  onClick={() => {
                    onTitleChange(youtubeTitle);
                    toast({
                      title: "Title Updated",
                      description: "Project title updated from YouTube title.",
                    });
                  }}
                >
                  <Pencil className="w-4 h-4" />
                  Update Title
                </Button>
              )}
              <div className="flex gap-2">
                {onSaveVersion && (
                  <Button
                    variant="outline"
                    className="flex-1 gap-2"
                    onClick={onSaveVersion}
                  >
                    <Save className="w-4 h-4" />
                    Save Version
                  </Button>
                )}
                {onDuplicate && (
                  <Button
                    variant="outline"
                    className="flex-1 gap-2"
                    onClick={onDuplicate}
                  >
                    <Copy className="w-4 h-4" />
                    Duplicate
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Right Column: Video Preview */}
        <div className="flex flex-col space-y-4">
          {/* Video/Thumbnail Preview - YouTube-style */}
          <div
            className="relative aspect-video bg-muted rounded-xl overflow-hidden border flex-shrink-0"
            onMouseEnter={() => {
              setIsHoveringPreview(true);
              // Auto-play on hover if not already playing
              if (previewVideoUrl && videoRef.current && !isPlaying) {
                videoRef.current.currentTime = 0;
                videoRef.current.muted = true; // Mute for autoplay on hover
                videoRef.current.play().catch(() => {});
              }
            }}
            onMouseLeave={() => {
              setIsHoveringPreview(false);
              // Pause on mouse leave if it was just hover-playing (muted)
              if (videoRef.current && videoRef.current.muted && !isPlaying) {
                videoRef.current.pause();
              }
            }}
          >
            {/* Video element - shown when playing OR hovering */}
            {previewVideoUrl && (
              <video
                ref={videoRef}
                src={previewVideoUrl}
                poster={selectedThumbnailUrl || firstImageUrl}
                className={`w-full h-full object-cover ${!isPlaying && !isHoveringPreview ? 'hidden' : ''}`}
                playsInline
                onEnded={() => setIsPlaying(false)}
                onPause={() => {
                  // Only set isPlaying to false if not muted (i.e., user clicked play)
                  if (!videoRef.current?.muted) {
                    setIsPlaying(false);
                  }
                }}
                onPlay={() => {
                  // Only set isPlaying to true if not muted (i.e., user clicked play)
                  if (!videoRef.current?.muted) {
                    setIsPlaying(true);
                  }
                }}
              />
            )}

            {/* Show thumbnail/image when not playing and not hovering */}
            {!isPlaying && !isHoveringPreview && (
              selectedThumbnailUrl ? (
                <img
                  src={selectedThumbnailUrl}
                  alt="Thumbnail"
                  className="w-full h-full object-cover"
                />
              ) : firstImageUrl ? (
                <img
                  src={firstImageUrl}
                  alt="Preview"
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                  <Video className="w-12 h-12 opacity-30" />
                </div>
              )
            )}

            {/* Play/Pause button overlay - only show if video exists */}
            {previewVideoUrl && (
              <div className="absolute bottom-3 left-3">
                <Button
                  variant="secondary"
                  size="icon"
                  className="h-10 w-10 rounded-full bg-black/70 hover:bg-black/90 text-white"
                  onClick={() => {
                    if (videoRef.current) {
                      if (isPlaying) {
                        videoRef.current.pause();
                        setIsPlaying(false);
                      } else {
                        // Unmute for user-initiated play and enable sound
                        videoRef.current.muted = false;
                        videoRef.current.play();
                        setIsPlaying(true);
                      }
                    }
                  }}
                >
                  {isPlaying ? (
                    <Pause className="w-5 h-5" />
                  ) : (
                    <Play className="w-5 h-5 ml-0.5" />
                  )}
                </Button>
              </div>
            )}
          </div>

          {/* Title and description under preview - YouTube-style */}
          <div className="space-y-3 flex-grow">
            <h2 className="font-semibold text-foreground text-lg break-words">
              {youtubeTitle || projectTitle || "Untitled"}
            </h2>

            {/* Description preview - simulating YouTube */}
            <div className="text-sm text-muted-foreground min-h-[4rem]">
              {youtubeDescription ? (
                <p className="line-clamp-4 whitespace-pre-wrap">
                  {youtubeDescription}
                </p>
              ) : (
                <p className="text-muted-foreground/60 italic">
                  Click YouTube to set title & description
                </p>
              )}
            </div>
          </div>

          {/* YouTube Upload Controls */}
          <div className="border rounded-lg p-4 space-y-4">
            {/* Connection status */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Youtube className="w-5 h-5 text-muted-foreground" />
                <span className="font-medium">YouTube</span>
              </div>
              <span className={`text-sm ${isYouTubeConnected ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'}`}>
                {isYouTubeConnected ? 'Connected' : 'Not connected'}
              </span>
            </div>

            {/* Visibility Controls */}
            <div className="space-y-2">
              <label className="text-sm text-muted-foreground">Visibility</label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={!isScheduled && privacyStatus === "private" ? "default" : "outline"}
                  size="sm"
                  onClick={() => {
                    setIsScheduled(false);
                    setPrivacyStatus("private");
                  }}
                  className="flex-1"
                >
                  Private
                </Button>
                <Button
                  type="button"
                  variant={!isScheduled && privacyStatus === "unlisted" ? "default" : "outline"}
                  size="sm"
                  onClick={() => {
                    setIsScheduled(false);
                    setPrivacyStatus("unlisted");
                  }}
                  className="flex-1"
                >
                  Unlisted
                </Button>
                <Button
                  type="button"
                  variant={isScheduled ? "default" : "outline"}
                  size="sm"
                  onClick={() => setIsScheduled(true)}
                  className="flex-1"
                >
                  Schedule
                </Button>
              </div>
            </div>

            {/* Schedule Date/Time */}
            {isScheduled && (
              <div className="flex gap-2">
                <input
                  type="date"
                  value={scheduledDate}
                  onChange={(e) => setScheduledDate(e.target.value)}
                  min={new Date().toISOString().split("T")[0]}
                  className="flex-1 px-3 py-2 text-sm border rounded-md bg-background"
                />
                <input
                  type="time"
                  value={scheduledTime}
                  onChange={(e) => setScheduledTime(e.target.value)}
                  className="flex-1 px-3 py-2 text-sm border rounded-md bg-background"
                />
              </div>
            )}

            {/* Upload button */}
            <Button
              onClick={() => setIsYouTubeModalOpen(true)}
              disabled={!previewVideoUrl}
              className="w-full gap-2 bg-black hover:bg-black/90 text-white"
            >
              <Upload className="w-4 h-4" />
              Upload
            </Button>

            {/* Connect/Disconnect */}
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                if (isYouTubeConnected) {
                  handleYouTubeDisconnect();
                } else {
                  handleYouTubeConnect();
                }
              }}
              disabled={isConnectingYouTube}
              className="w-full text-muted-foreground"
            >
              {isConnectingYouTube ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Connecting...
                </>
              ) : isYouTubeConnected ? (
                'Disconnect YouTube'
              ) : (
                'Connect YouTube'
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* Render Progress Modal */}
      <Dialog open={isRenderingBasic || isRenderingEmbers || isRenderingSmokeEmbers} onOpenChange={handleCloseRenderModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {currentRenderType !== 'basic' ? <Sparkles className="w-5 h-5" /> : <Video className="w-5 h-5" />}
              {(currentRenderType === 'basic' ? basicVideoUrl : (currentRenderType === 'embers' ? embersVideoUrl : smokeEmbersVideoUrl))
                ? 'Video Ready'
                : `Rendering ${currentRenderType === 'smoke_embers' ? 'with Smoke + Embers' : currentRenderType === 'embers' ? 'with Embers' : 'Video'}`}
            </DialogTitle>
            <DialogDescription>
              {(currentRenderType === 'basic' ? basicVideoUrl : (currentRenderType === 'embers' ? embersVideoUrl : smokeEmbersVideoUrl))
                ? 'Your video has been rendered successfully.'
                : 'Please wait while your video is being rendered.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Video Preview Player */}
            {(currentRenderType === 'basic' ? basicVideoUrl : (currentRenderType === 'embers' ? embersVideoUrl : smokeEmbersVideoUrl)) && (
              <div className="space-y-3">
                <video
                  src={currentRenderType === 'basic' ? basicVideoUrl! : (currentRenderType === 'embers' ? embersVideoUrl! : smokeEmbersVideoUrl!)}
                  controls
                  preload="auto"
                  crossOrigin="anonymous"
                  className="w-full rounded-lg border"
                  style={{ maxHeight: '300px' }}
                />

                <Button onClick={() => handleDownloadVideo(currentRenderType)} className="w-full gap-2">
                  <Download className="w-4 h-4" />
                  Download Video
                </Button>
              </div>
            )}

            {/* Initial rendering progress (before video is ready) */}
            {!(currentRenderType === 'basic' ? basicVideoUrl : (currentRenderType === 'embers' ? embersVideoUrl : smokeEmbersVideoUrl)) && renderProgress && (
              <>
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">
                      {getStageLabel(renderProgress.stage)}
                    </span>
                    <span className="font-medium">{renderProgress.percent}%</span>
                  </div>
                  <Progress value={renderProgress.percent} className="h-2" />
                </div>
                <p className="text-sm text-muted-foreground">
                  {renderProgress.message}
                </p>
                {renderProgress.stage === 'rendering' && (
                  <p className="text-xs text-muted-foreground">
                    This may take a few minutes depending on video length...
                  </p>
                )}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Hidden file inputs */}
      <input
        ref={thumbnailUploadRef}
        type="file"
        accept="image/png,image/jpeg,image/jpg,image/webp"
        className="hidden"
        onChange={handleThumbnailUpload}
      />
      <input
        ref={scriptUploadRef}
        type="file"
        accept=".txt,.md,text/plain,text/markdown"
        className="hidden"
        onChange={handleScriptUpload}
      />
      <input
        ref={audioUploadRef}
        type="file"
        accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg"
        className="hidden"
        onChange={handleAudioUpload}
      />
      <input
        ref={captionsUploadRef}
        type="file"
        accept=".srt,.vtt,text/plain"
        className="hidden"
        onChange={handleCaptionsUpload}
      />
      <input
        ref={imagesUploadRef}
        type="file"
        accept="image/*,.png,.jpg,.jpeg,.webp"
        multiple
        className="hidden"
        onChange={handleImagesUpload}
      />
      <input
        ref={promptsUploadRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={handlePromptsUpload}
      />
      <input
        ref={videoUploadRef}
        type="file"
        accept="video/*,.mp4,.mov,.webm"
        className="hidden"
        onChange={handleVideoUpload}
      />

      {/* YouTube Metadata Modal */}
      <YouTubeUploadModal
        isOpen={isYouTubeModalOpen}
        projectTitle={projectTitle}
        script={script}
        initialTitle={youtubeTitle}
        initialDescription={youtubeDescription}
        initialTags={youtubeTags}
        initialCategoryId={youtubeCategoryId}
        initialPlaylistId={youtubePlaylistId}
        thumbnails={thumbnails}
        selectedThumbnailIndex={selectedThumbnailIndex}
        onMetadataChange={(title, description, tags, categoryId, playlistId) => {
          // Update parent with all metadata for persistence and preview
          if (onYouTubeMetadataChange) {
            onYouTubeMetadataChange(title, description, tags, categoryId, playlistId);
          }
        }}
        onClose={() => setIsYouTubeModalOpen(false)}
        onConfirm={() => {
          setIsYouTubeModalOpen(false);
        }}
      />

      {/* Video Render Modal (with visual effects selection) */}
      {projectId && audioUrl && imagePrompts && imagePrompts.length > 0 && srtContent && (
        <VideoRenderModal
          isOpen={isVideoRenderModalOpen}
          projectId={projectId}
          projectTitle={projectTitle}
          audioUrl={audioUrl}
          imageUrls={imagePrompts.filter(p => !!p.imageUrl).map(p => p.imageUrl as string)}
          imageTimings={imagePrompts.filter(p => !!p.imageUrl).map(p => ({ startSeconds: p.startTime, endSeconds: p.endTime }))}
          srtContent={srtContent}
          existingBasicVideoUrl={basicVideoUrl || undefined}
          existingEffectsVideoUrl={smokeEmbersVideoUrl || embersVideoUrl || undefined}
          onConfirm={(videoUrl) => {
            // Determine which effect was rendered based on URL pattern or just save to smoke_embers
            setSmokeEmbersVideoUrl(videoUrl);
            if (onSmokeEmbersVideoRendered) {
              onSmokeEmbersVideoRendered(videoUrl);
            }
            setIsVideoRenderModalOpen(false);
          }}
          onCancel={() => setIsVideoRenderModalOpen(false)}
          onForward={() => {
            // Close visual effects modal and open YouTube modal
            setIsVideoRenderModalOpen(false);
            setIsYouTubeModalOpen(true);
          }}
        />
      )}
    </div>
  );
}
