import { useState, useEffect, useRef } from "react";
import {
  Youtube,
  Loader2,
  Check,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  ChevronDown,
  ChevronUp,
  X
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/hooks/use-toast";
import {
  checkYouTubeConnection,
  fetchYouTubeChannels,
  fetchYouTubePlaylists,
  disconnectYouTube,
  authenticateYouTube,
  getValidAccessToken,
  type YouTubeChannel,
  type YouTubePlaylist,
} from "@/lib/youtubeAuth";
import { generateYouTubeMetadata, uploadToYouTube } from "@/lib/api";
import { Progress } from "@/components/ui/progress";

interface YouTubeUploadModalProps {
  isOpen: boolean;
  videoUrl?: string; // URL of video to upload
  projectTitle?: string;
  script?: string;
  thumbnails?: string[]; // Generated thumbnails
  selectedThumbnailIndex?: number; // Index of selected thumbnail
  onClose: () => void;
  onSuccess?: () => void; // Called after successful upload
  onConfirm?: () => void; // Called when metadata is confirmed (without upload)
  onBack?: () => void;
  onSkip?: () => void;
  onMetadataChange?: (title: string, description: string, tags: string, categoryId: string, playlistId: string | null) => void;
  initialTitle?: string;
  initialDescription?: string;
  initialTags?: string;
  initialCategoryId?: string;
  initialPlaylistId?: string | null;
  // Full Auto mode props
  autoUpload?: boolean;           // Auto-start upload when modal opens
  initialPublishAt?: string;      // ISO timestamp for scheduled publish (e.g., 5 PM PST next day)
}

// YouTube video categories
const CATEGORIES = [
  { id: "27", name: "Education" },
  { id: "22", name: "People & Blogs" },
  { id: "24", name: "Entertainment" },
  { id: "25", name: "News & Politics" },
  { id: "28", name: "Science & Technology" },
  { id: "17", name: "Sports" },
  { id: "10", name: "Music" },
  { id: "1", name: "Film & Animation" },
];

export function YouTubeUploadModal({
  isOpen,
  videoUrl,
  projectTitle,
  script,
  thumbnails,
  selectedThumbnailIndex,
  onClose,
  onSuccess,
  onConfirm,
  onBack,
  onSkip,
  onMetadataChange,
  initialTitle,
  initialDescription,
  initialTags,
  initialCategoryId,
  initialPlaylistId,
  autoUpload = false,
  initialPublishAt,
}: YouTubeUploadModalProps) {
  // Debug: Log props on open
  useEffect(() => {
    if (isOpen) {
      console.log('[YouTubeUploadModal] Modal opened with props:', {
        videoUrl: videoUrl?.substring(0, 100),
        thumbnails: thumbnails,
        thumbnailsLength: thumbnails?.length,
        selectedThumbnailIndex,
        hasThumbnails: !!thumbnails,
        hasSelectedIndex: selectedThumbnailIndex !== undefined,
        shouldShowThumbnail: !!(thumbnails && thumbnails.length > 0 && selectedThumbnailIndex !== undefined)
      });
    }
  }, [isOpen, thumbnails, selectedThumbnailIndex, videoUrl]);
  // Connection state
  const [isConnected, setIsConnected] = useState<boolean | null>(null);

  // Channel state
  const [channels, setChannels] = useState<YouTubeChannel[]>([]);
  const [isLoadingChannels, setIsLoadingChannels] = useState(false);

  // Playlist state
  const [playlists, setPlaylists] = useState<YouTubePlaylist[]>([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState<string | null>(initialPlaylistId || null);
  const [isLoadingPlaylists, setIsLoadingPlaylists] = useState(false);

  // Form state
  const [title, setTitle] = useState(initialTitle || projectTitle || "");
  const [description, setDescription] = useState(initialDescription || "");
  const [tags, setTags] = useState(initialTags || "");
  const [categoryId, setCategoryId] = useState(initialCategoryId || "22"); // Default: People & Blogs

  // AI generation state
  const [isGeneratingMetadata, setIsGeneratingMetadata] = useState(false);
  const [generatedTitles, setGeneratedTitles] = useState<string[]>([]);
  const [showTitleSelector, setShowTitleSelector] = useState(false);

  // Upload state
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadMessage, setUploadMessage] = useState("");
  const [uploadedVideoId, setUploadedVideoId] = useState<string | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState<string | null>(null);

  // Privacy and scheduling state
  const [privacyStatus, setPrivacyStatus] = useState<'private' | 'unlisted' | 'scheduled'>('private');
  const [scheduleDate, setScheduleDate] = useState<string>("");
  const [scheduleTime, setScheduleTime] = useState<string>("12:00");

  // Altered content declaration (AI-generated content)
  const [isAlteredContent, setIsAlteredContent] = useState(true); // Default to Yes for AI-generated videos

  // Track last notified metadata to prevent redundant callbacks
  const lastNotifiedMetadataRef = useRef<string | null>(null);

  // Track if we've already initialized for this modal session
  const hasInitializedRef = useRef(false);

  // Track if API calls are in progress to prevent duplicate calls
  const isLoadingRef = useRef(false);

  // Track last open timestamp to debounce rapid open/close cycles
  const lastOpenTimeRef = useRef(0);

  // Check connection status on open - only run ONCE per modal open
  useEffect(() => {
    const now = Date.now();

    if (isOpen && !hasInitializedRef.current) {
      // Debounce: ignore if opened within 500ms of last open
      if (now - lastOpenTimeRef.current < 500) {
        console.log('[YouTubeModal] Debounced - opened too quickly after last open');
        return;
      }

      lastOpenTimeRef.current = now;
      hasInitializedRef.current = true;

      // Only call checkConnection if not already loading
      if (!isLoadingRef.current) {
        isLoadingRef.current = true;
        checkConnection().finally(() => {
          isLoadingRef.current = false;
        });
      }

      // Reset the notification ref so initial values trigger a save
      lastNotifiedMetadataRef.current = null;
      // Use saved values if available, otherwise fall back to project title
      setTitle(initialTitle || projectTitle || "");
      setDescription(initialDescription || "");
      // Default tags for sleep history channel
      const defaultTags = "history for sleep, sleepy history, sleepy history";
      setTags(initialTags || defaultTags);
      setCategoryId(initialCategoryId || "22"); // Default: People & Blogs
      setSelectedPlaylist(initialPlaylistId || null);
      setGeneratedTitles([]);
      setShowTitleSelector(false);
    }
    // Reset initialized flag when modal closes
    if (!isOpen) {
      hasInitializedRef.current = false;
    }
  }, [isOpen]); // Only depend on isOpen - initial values are captured on first run

  // Notify parent when any metadata changes
  // Note: onMetadataChange excluded from deps to prevent infinite loops with inline callbacks
  useEffect(() => {
    if (isOpen && onMetadataChange) {
      const fingerprint = `${title}|${description}|${tags}|${categoryId}|${selectedPlaylist}`;
      if (fingerprint !== lastNotifiedMetadataRef.current) {
        lastNotifiedMetadataRef.current = fingerprint;
        onMetadataChange(title, description, tags, categoryId, selectedPlaylist);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, description, tags, categoryId, selectedPlaylist, isOpen]);

  // Track if auto-upload has been triggered for this session
  const autoUploadTriggeredRef = useRef(false);

  // Full Auto mode: Auto-generate metadata and upload with scheduled publish
  useEffect(() => {
    if (!isOpen || !autoUpload || !videoUrl || autoUploadTriggeredRef.current) {
      return;
    }

    // Wait for connection check to complete
    if (isConnected === null) {
      return;
    }

    // Need to be connected to proceed
    if (!isConnected) {
      console.log("[Full Auto YouTube] Not connected, skipping auto-upload");
      return;
    }

    // Mark as triggered to prevent re-running
    autoUploadTriggeredRef.current = true;

    const runAutoUpload = async () => {
      console.log("[Full Auto YouTube] Starting auto-upload...");

      // Generate metadata if title is empty or just project title
      let currentTitle = title;
      let currentDescription = description;
      let currentTags = tags;

      if (!currentTitle || currentTitle === projectTitle) {
        console.log("[Full Auto YouTube] Generating metadata with script length:", script?.length || 0);
        setIsGeneratingMetadata(true);

        try {
          const result = await generateYouTubeMetadata(projectTitle || "Historical Documentary", script || "");
          if (result.success && result.titles && result.titles.length > 0) {
            currentTitle = result.titles[0];
            setTitle(currentTitle);
            setGeneratedTitles(result.titles);
          }
          if (result.description) {
            currentDescription = result.description;
            setDescription(currentDescription);
          }
          if (result.tags) {
            // result.tags is string[], convert to comma-separated string
            currentTags = Array.isArray(result.tags) ? result.tags.join(', ') : result.tags;
            setTags(currentTags);
          }
        } catch (error) {
          console.error("[Full Auto YouTube] Metadata generation failed:", error);
          // Continue with existing title
        } finally {
          setIsGeneratingMetadata(false);
        }
      }

      // Set scheduled publish if provided
      if (initialPublishAt) {
        const publishDate = new Date(initialPublishAt);
        setPrivacyStatus('scheduled');
        setScheduleDate(publishDate.toISOString().split('T')[0]);
        setScheduleTime(publishDate.toTimeString().slice(0, 5));
        console.log(`[Full Auto YouTube] Scheduled for: ${publishDate.toLocaleString()}`);
      }

      // Wait a moment for state to settle
      await new Promise(resolve => setTimeout(resolve, 500));

      // Trigger upload
      console.log("[Full Auto YouTube] Starting upload...");
      setIsUploading(true);

      try {
        // Get access token first
        const accessToken = await getValidAccessToken();
        if (!accessToken) {
          console.error("[Full Auto YouTube] No access token - user not authenticated");
          toast({
            title: "YouTube Not Connected",
            description: "Please connect your YouTube account to enable auto-upload.",
            variant: "destructive",
          });
          setIsUploading(false);
          return;
        }

        // Get thumbnail URL if available
        const thumbnailUrl = (thumbnails && selectedThumbnailIndex !== undefined)
          ? thumbnails[selectedThumbnailIndex]
          : undefined;

        console.log('[Full Auto Upload] Thumbnail info:', {
          hasThumbnails: !!thumbnails,
          thumbnailsLength: thumbnails?.length,
          selectedThumbnailIndex,
          thumbnailUrl
        });

        // Determine publish time
        const publishAt = initialPublishAt || undefined;

        // Ensure tags is an array (handle both string and array inputs) - limit to 5 max
        const tagsArray = (Array.isArray(currentTags)
          ? currentTags
          : (typeof currentTags === 'string' ? currentTags.split(',').map(t => t.trim()).filter(Boolean) : [])
        ).slice(0, 5);

        const result = await uploadToYouTube(
          {
            videoUrl,
            accessToken,
            title: currentTitle || projectTitle || "Untitled Video",
            description: currentDescription,
            tags: tagsArray,
            categoryId, // Use selected category
            privacyStatus: publishAt ? 'private' : 'private', // Always private until scheduled
            publishAt,
            thumbnailUrl,
            isAlteredContent: true, // AI-generated content
            playlistId: selectedPlaylist || undefined,
          },
          (progress) => {
            setUploadProgress(progress.percent);
            setUploadMessage(progress.message || "");
          }
        );

        if (result.success && result.videoId) {
          console.log("[Full Auto YouTube] Upload successful:", result.videoId);
          setUploadedVideoId(result.videoId);
          setYoutubeUrl(result.youtubeUrl || null);

          toast({
            title: "Video Uploaded",
            description: publishAt
              ? `Scheduled to publish at ${new Date(publishAt).toLocaleString()}`
              : "Your video has been uploaded to YouTube.",
          });

          // Auto-close and notify success
          setTimeout(() => {
            onSuccess?.();
          }, 1000);
        } else {
          console.error("[Full Auto YouTube] Upload failed:", result.error);
          toast({
            title: "Upload Failed",
            description: result.error || "Failed to upload video to YouTube.",
            variant: "destructive",
          });
        }
      } catch (error) {
        console.error("[Full Auto YouTube] Upload error:", error);
        toast({
          title: "Upload Failed",
          description: error instanceof Error ? error.message : "Failed to upload video.",
          variant: "destructive",
        });
      } finally {
        setIsUploading(false);
      }
    };

    runAutoUpload();
  }, [isOpen, autoUpload, videoUrl, isConnected, initialPublishAt, title, projectTitle, script, thumbnails, selectedThumbnailIndex, categoryId, onSuccess]);

  // Reset auto-upload trigger when modal closes
  useEffect(() => {
    if (!isOpen) {
      autoUploadTriggeredRef.current = false;
    }
  }, [isOpen]);

  const checkConnection = async () => {
    const status = await checkYouTubeConnection();
    setIsConnected(status.connected);

    // Fetch channels and playlists when connected
    if (status.connected) {
      await Promise.all([loadChannels(), loadPlaylists()]);
    }
  };

  const loadChannels = async () => {
    setIsLoadingChannels(true);
    try {
      const result = await fetchYouTubeChannels();
      if (result.channels.length > 0) {
        setChannels(result.channels);
      }
    } catch (error) {
      console.error('Error loading channels:', error);
    } finally {
      setIsLoadingChannels(false);
    }
  };

  const loadPlaylists = async () => {
    setIsLoadingPlaylists(true);
    try {
      const result = await fetchYouTubePlaylists();
      const loadedPlaylists = result.playlists || [];
      setPlaylists(loadedPlaylists);

      // Auto-select "Complete Histories" playlist if not already selected
      if (!selectedPlaylist && !initialPlaylistId) {
        const completeHistoriesPlaylist = loadedPlaylists.find(
          p => p.title.toLowerCase().includes('complete histories')
        );
        if (completeHistoriesPlaylist) {
          setSelectedPlaylist(completeHistoriesPlaylist.id);
          console.log('[YouTubeModal] Auto-selected Complete Histories playlist:', completeHistoriesPlaylist.id);
        }
      }
    } catch (error) {
      console.error('Error loading playlists:', error);
    } finally {
      setIsLoadingPlaylists(false);
    }
  };

  // AI-powered metadata generation
  const handleGenerateMetadata = async () => {
    if (!script || script.trim().length === 0) {
      toast({
        title: "Script Required",
        description: "No script available for metadata generation.",
        variant: "destructive",
      });
      return;
    }

    setIsGeneratingMetadata(true);
    try {
      const result = await generateYouTubeMetadata(projectTitle || "Historical Documentary", script);

      if (result.success && result.titles) {
        setGeneratedTitles(result.titles);
        setShowTitleSelector(true);

        // Auto-fill description and tags
        if (result.description) {
          setDescription(result.description);
        }
        if (result.tags && result.tags.length > 0) {
          setTags(result.tags.join(", "));
        }

        toast({
          title: "Metadata Generated",
          description: "Select a title and review the description & tags.",
        });
      } else {
        toast({
          title: "Generation Failed",
          description: result.error || "Failed to generate metadata.",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error("Metadata generation error:", error);
      toast({
        title: "Generation Failed",
        description: error instanceof Error ? error.message : "Failed to generate metadata.",
        variant: "destructive",
      });
    } finally {
      setIsGeneratingMetadata(false);
    }
  };

  // Ensure title ends with "| History for Sleep"
  const ensureTitleSuffix = (t: string): string => {
    const suffix = "| History for Sleep";
    if (t.endsWith(suffix)) return t;
    // Remove any existing suffix variations before adding the correct one
    const cleaned = t.replace(/\s*\|\s*History for Sleep\s*$/i, "").trim();
    return `${cleaned} ${suffix}`;
  };

  const handleSelectTitle = (selectedTitle: string) => {
    setTitle(ensureTitleSuffix(selectedTitle));
    setShowTitleSelector(false);
  };

  // Handle switching YouTube channel
  const handleSwitchChannel = async () => {
    try {
      await disconnectYouTube();
      setIsConnected(false);
      setChannels([]);
      setPlaylists([]);

      // Re-authenticate
      const success = await authenticateYouTube();
      if (success) {
        await checkConnection();
      }
    } catch (error) {
      console.error('Error switching channel:', error);
      toast({
        title: "Error",
        description: "Failed to switch YouTube channel. Please try again.",
        variant: "destructive",
      });
    }
  };

  // Handle confirm - save metadata and close
  const handleConfirm = () => {
    try {
      console.log('[YouTubeUploadModal] handleConfirm called', {
        title,
        description: description?.substring(0, 50),
        tags,
        categoryId,
        selectedPlaylist,
        hasOnMetadataChange: !!onMetadataChange,
        hasOnConfirm: !!onConfirm,
        hasOnSuccess: !!onSuccess,
        hasOnClose: !!onClose
      });

      // Ensure title has the suffix before saving
      const finalTitle = ensureTitleSuffix(title);
      console.log('[YouTubeUploadModal] Final title:', finalTitle);

      // Notify parent with final metadata
      if (onMetadataChange) {
        console.log('[YouTubeUploadModal] Calling onMetadataChange');
        onMetadataChange(finalTitle, description, tags, categoryId, selectedPlaylist);
      }

      // Support both onConfirm and onSuccess for compatibility
      if (onConfirm) {
        console.log('[YouTubeUploadModal] Calling onConfirm');
        onConfirm();
      }
      if (onSuccess) {
        console.log('[YouTubeUploadModal] Calling onSuccess');
        onSuccess();
      }

      console.log('[YouTubeUploadModal] Calling onClose');
      onClose();
      console.log('[YouTubeUploadModal] handleConfirm complete');
    } catch (error) {
      console.error('[YouTubeUploadModal] Error in handleConfirm:', error);
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to confirm metadata.",
        variant: "destructive",
      });
    }
  };

  // Handle upload to YouTube
  const handleUpload = async () => {
    if (!videoUrl) {
      toast({
        title: "No Video",
        description: "No video URL available for upload. Please render a video first.",
        variant: "destructive",
      });
      return;
    }

    // Get access token
    const accessToken = await getValidAccessToken();
    if (!accessToken) {
      toast({
        title: "Not Authenticated",
        description: "Please connect your YouTube account first.",
        variant: "destructive",
      });
      return;
    }

    const finalTitle = ensureTitleSuffix(title);
    const tagsArray = tags.split(",").map(t => t.trim()).filter(t => t.length > 0);

    // Get thumbnail URL if selected
    const thumbnailUrl = thumbnails && selectedThumbnailIndex !== undefined
      ? thumbnails[selectedThumbnailIndex]
      : undefined;

    console.log('[Manual Upload] Upload params:', {
      hasThumbnails: !!thumbnails,
      thumbnailsLength: thumbnails?.length,
      selectedThumbnailIndex,
      thumbnailUrl,
      categoryId,
      selectedPlaylist,
      playlistId: selectedPlaylist && selectedPlaylist !== "none" ? selectedPlaylist : undefined
    });

    setIsUploading(true);
    setUploadProgress(0);
    setUploadMessage("Starting upload...");

    try {
      // Determine actual privacy status and publishAt date
      const actualPrivacyStatus: 'private' | 'unlisted' | 'public' =
        privacyStatus === 'scheduled' ? 'private' : privacyStatus;

      // For scheduled uploads, create ISO 8601 date
      const publishAt = privacyStatus === 'scheduled' && scheduleDate
        ? new Date(`${scheduleDate}T${scheduleTime || '12:00'}:00`).toISOString()
        : undefined;

      const result = await uploadToYouTube(
        {
          videoUrl,
          accessToken,
          title: finalTitle,
          description,
          tags: tagsArray.slice(0, 5), // Limit to 5 tags max
          categoryId, // Use selected category
          privacyStatus: actualPrivacyStatus,
          publishAt,
          thumbnailUrl,
          isAlteredContent,
          playlistId: selectedPlaylist && selectedPlaylist !== "none" ? selectedPlaylist : undefined,
        },
        (progress) => {
          setUploadProgress(progress.percent);
          setUploadMessage(progress.message);
        }
      );

      if (result.success && result.videoId) {
        setUploadedVideoId(result.videoId);
        setYoutubeUrl(result.youtubeUrl || null);

        // Playlist is now handled by the backend
        if (selectedPlaylist && selectedPlaylist !== "none") {
          console.log(`[YouTubeUpload] Video added to playlist via backend`);
        }

        // Notify parent with final metadata
        if (onMetadataChange) {
          onMetadataChange(finalTitle, description, tags, categoryId, selectedPlaylist);
        }

        // Determine status message based on privacy/scheduling
        let statusMessage = "Your video has been uploaded to YouTube as a private draft.";
        if (privacyStatus === 'scheduled' && publishAt) {
          const scheduleDateTime = new Date(publishAt);
          statusMessage = `Your video has been scheduled to publish on ${scheduleDateTime.toLocaleDateString()} at ${scheduleDateTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
        } else if (privacyStatus === 'unlisted') {
          statusMessage = "Your video has been uploaded as unlisted.";
        }

        toast({
          title: "Upload Complete!",
          description: statusMessage,
        });

        // Mark upload as complete (stop showing progress)
        setIsUploading(false);

        // Call success callback
        onSuccess?.();
      } else {
        throw new Error(result.error || "Upload failed");
      }
    } catch (error) {
      console.error("Upload error:", error);
      toast({
        title: "Upload Failed",
        description: error instanceof Error ? error.message : "Failed to upload video.",
        variant: "destructive",
      });
      setIsUploading(false);
    }
  };

  // Check if we have a valid video URL (not empty string)
  const hasVideo = videoUrl && videoUrl.trim().length > 0;

  // Check if we can upload
  const canUpload = isConnected && hasVideo && title.trim().length > 0;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Youtube className="w-5 h-5 text-red-600" />
            YouTube Metadata
          </DialogTitle>
          <DialogDescription>
            Set title, description, and tags for your YouTube video
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Channel Info - show which channel will receive the upload */}
          {isConnected === null ? (
            <div className="flex items-center justify-center py-2">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          ) : isLoadingChannels ? (
            <div className="flex items-center gap-2 p-3 bg-muted/50 rounded-lg">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-sm text-muted-foreground">Loading channel info...</span>
            </div>
          ) : channels.length > 0 ? (
            <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
              <div className="flex items-center gap-2">
                {channels[0].thumbnailUrl && (
                  <img
                    src={channels[0].thumbnailUrl}
                    alt={channels[0].title}
                    className="w-8 h-8 rounded-full"
                  />
                )}
                <div>
                  <p className="text-sm font-medium">{channels[0].title}</p>
                  <p className="text-xs text-muted-foreground">Upload destination</p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleSwitchChannel}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Switch
              </Button>
            </div>
          ) : !isConnected ? (
            <div className="p-3 bg-muted/50 rounded-lg text-sm text-muted-foreground">
              Connect YouTube account from the main page to see channel info
            </div>
          ) : null}

          {/* AI Auto-fill Button */}
          {script && (
            <Button
              onClick={handleGenerateMetadata}
              disabled={isGeneratingMetadata}
              variant="outline"
              className="w-full gap-2 border-primary/50 text-primary hover:bg-primary/10"
            >
              {isGeneratingMetadata ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Generating with AI...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  Auto-fill with AI (Title, Description, Tags)
                </>
              )}
            </Button>
          )}

          {/* Title Selector (shown after AI generation) */}
          {showTitleSelector && generatedTitles.length > 0 && (
            <div className="space-y-2 p-3 bg-muted/50 rounded-lg border border-primary/20">
              <div className="flex items-center justify-between">
                <Label className="text-primary font-medium">Select a Title:</Label>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowTitleSelector(false)}
                  className="h-6 px-2 text-xs"
                >
                  {showTitleSelector ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                </Button>
              </div>
              <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
                {generatedTitles.map((generatedTitle, index) => (
                  <Button
                    key={index}
                    type="button"
                    variant={title === generatedTitle ? "default" : "outline"}
                    onClick={() => handleSelectTitle(generatedTitle)}
                    className={`w-full justify-start text-left p-2 h-auto text-sm whitespace-normal ${
                      title === generatedTitle ? '' : 'hover:bg-accent'
                    }`}
                  >
                    <span className={title === generatedTitle ? 'text-primary-foreground/70' : 'text-muted-foreground'}>
                      {index + 1}.
                    </span>
                    <span className="ml-2">{generatedTitle}</span>
                  </Button>
                ))}
              </div>
            </div>
          )}

          {/* Title */}
          <div className="space-y-2">
            <Label htmlFor="title">Title *</Label>
            <Input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Enter video title"
              maxLength={100}
            />
            <p className="text-xs text-muted-foreground text-right">
              {title.length}/100
            </p>
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Enter video description"
              className="min-h-[100px] resize-y"
            />
          </div>

          {/* Tags */}
          <div className="space-y-2">
            <Label htmlFor="tags">Tags</Label>
            <Input
              id="tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="history, documentary, educational (comma-separated)"
            />
          </div>

          {/* Category */}
          <div className="space-y-2">
            <Label>Category</Label>
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger>
                <SelectValue placeholder="Select category" />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((cat) => (
                  <SelectItem key={cat.id} value={cat.id}>
                    {cat.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Privacy Status */}
          <div className="space-y-2">
            <Label>Visibility</Label>
            <Select value={privacyStatus} onValueChange={(value) => setPrivacyStatus(value as 'private' | 'unlisted' | 'scheduled')}>
              <SelectTrigger>
                <SelectValue placeholder="Select visibility" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="private">Private (Draft)</SelectItem>
                <SelectItem value="unlisted">Unlisted</SelectItem>
                <SelectItem value="scheduled">Schedule for Later</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Schedule Date/Time - only shown when scheduled is selected */}
          {privacyStatus === 'scheduled' && (
            <div className="space-y-2 p-3 bg-muted/50 rounded-lg">
              <Label>Schedule Publish Date & Time</Label>
              <div className="flex gap-2">
                <Input
                  type="date"
                  value={scheduleDate}
                  onChange={(e) => setScheduleDate(e.target.value)}
                  min={new Date().toISOString().split('T')[0]}
                  className="flex-1"
                />
                <Input
                  type="time"
                  value={scheduleTime}
                  onChange={(e) => setScheduleTime(e.target.value)}
                  className="w-28"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Video will be private until the scheduled time, then published automatically.
              </p>
            </div>
          )}

          {/* Altered Content Declaration */}
          <div className="space-y-2">
            <Label>Altered/Synthetic Content</Label>
            <Select value={isAlteredContent ? "yes" : "no"} onValueChange={(value) => setIsAlteredContent(value === "yes")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="yes">Yes - Contains AI-generated content</SelectItem>
                <SelectItem value="no">No - No AI-generated content</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              YouTube requires disclosure if your video contains AI-generated or altered content.
            </p>
          </div>

          {/* Playlist Selection */}
          <div className="space-y-2">
            <Label>Add to Playlist</Label>
            <Select
              value={selectedPlaylist || "none"}
              onValueChange={(value) => setSelectedPlaylist(value === "none" ? null : value)}
              disabled={isLoadingPlaylists}
            >
              <SelectTrigger>
                {isLoadingPlaylists ? (
                  <div className="flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Loading playlists...</span>
                  </div>
                ) : (
                  <SelectValue placeholder="Select a playlist (optional)" />
                )}
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No playlist</SelectItem>
                {playlists.map((playlist) => (
                  <SelectItem key={playlist.id} value={playlist.id}>
                    {playlist.title} ({playlist.itemCount} videos)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Thumbnail Preview */}
          {thumbnails && thumbnails.length > 0 && selectedThumbnailIndex !== undefined && (
              <div className="space-y-2">
                <Label>Selected Thumbnail</Label>
                <div className="border rounded-lg overflow-hidden">
                  <img
                    src={thumbnails![selectedThumbnailIndex!]}
                    alt="Selected thumbnail"
                    className="w-full h-auto"
                  />
                </div>
              </div>
          )}

          {/* Upload Progress */}
          {isUploading && (
            <div className="space-y-2 p-4 bg-muted/50 rounded-lg">
              <div className="flex justify-between text-sm">
                <span>{uploadMessage}</span>
                <span className="font-medium">{uploadProgress}%</span>
              </div>
              <Progress value={uploadProgress} className="h-2" />
            </div>
          )}

          {/* Upload Complete */}
          {uploadedVideoId && youtubeUrl && (
            <div className="p-4 bg-green-50 dark:bg-green-900/20 rounded-lg space-y-2">
              <div className="flex items-center gap-2 text-green-700 dark:text-green-400">
                <Check className="w-5 h-5" />
                <span className="font-medium">Upload Complete!</span>
              </div>
              <a
                href={youtubeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-blue-600 hover:underline"
              >
                View on YouTube Studio →
              </a>
            </div>
          )}
        </div>

        <DialogFooter className="flex-shrink-0 gap-2 sm:gap-2">
          {/* Left side: Navigation */}
          <div className="flex gap-2 mr-auto">
            {onBack && !isUploading && (
              <Button variant="outline" size="icon" onClick={onBack} title="Back to previous step">
                <ChevronLeft className="w-5 h-5" />
              </Button>
            )}
            {onSkip && !isUploading && (
              <Button variant="outline" size="icon" onClick={onSkip} title="Skip to next step">
                <ChevronRight className="w-5 h-5" />
              </Button>
            )}
          </div>

          {/* Right side: Exit + Upload/Confirm */}
          {!uploadedVideoId ? (
            <>
              <Button variant="outline" onClick={onClose} disabled={isUploading}>
                <X className="w-4 h-4 mr-2" />
                Exit
              </Button>

              {hasVideo ? (
                <Button onClick={handleUpload} disabled={!canUpload || isUploading}>
                  {isUploading ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Uploading...
                    </>
                  ) : (
                    <>
                      <Youtube className="w-4 h-4 mr-2" />
                      Upload to YouTube
                    </>
                  )}
                </Button>
              ) : (
                <Button onClick={handleConfirm}>
                  <Check className="w-4 h-4 mr-2" />
                  Confirm
                </Button>
              )}
            </>
          ) : (
            <Button onClick={onClose}>
              <Check className="w-4 h-4 mr-2" />
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
