import { useState, useEffect, useRef } from "react";
import { Video, Download, Loader2, ChevronLeft, ChevronRight, X, Check, Sparkles, RotateCcw, Maximize } from "lucide-react";

type EffectChoice = 'smoke_embers' | 'ken_burns' | 'none';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/hooks/use-toast";
import { renderVideoStreaming, type RenderVideoProgress } from "@/lib/api";

interface IntroClip {
  index: number;
  url: string;
  startSeconds: number;
  endSeconds: number;
}

interface VideoRenderModalProps {
  isOpen: boolean;
  projectId: string;
  projectTitle?: string;
  audioUrl: string;
  imageUrls: string[];
  imageTimings: { startSeconds: number; endSeconds: number }[];
  srtContent: string;
  introClips?: IntroClip[];  // Optional intro video clips (60s intro)
  existingBasicVideoUrl?: string;  // Pre-rendered basic video URL
  existingEffectsVideoUrl?: string;  // Pre-rendered effects video URL (smoke+embers)
  existingKenBurnsVideoUrl?: string;  // Pre-rendered Ken Burns video URL
  autoRender?: boolean;  // Auto-start rendering when modal opens (for full automation mode)
  segmentsNeedRecombine?: boolean;  // Whether audio segments need to be recombined
  onRecombineAudio?: () => Promise<string>;  // Callback to recombine audio, returns new URL
  onRefreshData?: () => Promise<{ clips: IntroClip[]; images: string[] }>;  // Fetch latest clips/images from DB before render
  onConfirm: (basicVideoUrl: string, effectsVideoUrl: string, kenBurnsVideoUrl?: string) => void;
  onCancel: () => void;
  onBack?: () => void;
  onSkip?: () => void;
  onForward?: () => void;  // Navigate to next step (Thumbnails)
}

type RenderPass = 'idle' | 'pass1' | 'pass2' | 'complete';

// Download file from URL
const downloadFromUrl = async (url: string, filename: string) => {
  let downloadUrl = url;
  if (url.includes('supabase.co/storage')) {
    const separator = url.includes('?') ? '&' : '?';
    downloadUrl = `${url}${separator}download=${encodeURIComponent(filename)}`;
  }

  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = filename;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

export function VideoRenderModal({
  isOpen,
  projectId,
  projectTitle,
  audioUrl,
  imageUrls,
  imageTimings,
  srtContent,
  introClips,
  existingBasicVideoUrl,
  existingEffectsVideoUrl,
  existingKenBurnsVideoUrl,
  autoRender = false,
  segmentsNeedRecombine = false,
  onRecombineAudio,
  onRefreshData,
  onConfirm,
  onCancel,
  onBack,
  onSkip,
  onForward,
}: VideoRenderModalProps) {
  // State for render progress
  const [currentPass, setCurrentPass] = useState<RenderPass>('idle');
  const [renderProgress, setRenderProgress] = useState<RenderVideoProgress | null>(null);
  const [basicVideoUrl, setBasicVideoUrl] = useState<string | null>(null);
  const [effectsVideoUrl, setEffectsVideoUrl] = useState<string | null>(null);
  const [kenBurnsVideoUrl, setKenBurnsVideoUrl] = useState<string | null>(null);
  const [selectedEffect, setSelectedEffect] = useState<EffectChoice>('smoke_embers'); // Effect selector
  const [actualAudioUrl, setActualAudioUrl] = useState<string>(audioUrl); // Track actual audio URL (may be updated after recombine)
  const autoRenderTriggered = useRef(false);
  const hasInitializedRef = useRef(false);
  const lastPropsRef = useRef({ basic: '', effects: '', kenBurns: '' });

  // Update actual audio URL when prop changes
  useEffect(() => {
    setActualAudioUrl(audioUrl);
  }, [audioUrl]);

  // Single consolidated effect for syncing props to state - runs only when modal opens or props change
  useEffect(() => {
    // Only sync when modal opens AND props actually changed
    if (!isOpen) {
      hasInitializedRef.current = false;
      return;
    }

    const propsChanged =
      lastPropsRef.current.basic !== (existingBasicVideoUrl || '') ||
      lastPropsRef.current.effects !== (existingEffectsVideoUrl || '') ||
      lastPropsRef.current.kenBurns !== (existingKenBurnsVideoUrl || '');

    if (!hasInitializedRef.current || propsChanged) {
      hasInitializedRef.current = true;
      lastPropsRef.current = {
        basic: existingBasicVideoUrl || '',
        effects: existingEffectsVideoUrl || '',
        kenBurns: existingKenBurnsVideoUrl || ''
      };

      // CRITICAL: Always sync internal state with props, including clearing when undefined
      // This ensures switching projects properly resets the video URLs
      setBasicVideoUrl(existingBasicVideoUrl || null);
      setEffectsVideoUrl(existingEffectsVideoUrl || null);
      setKenBurnsVideoUrl(existingKenBurnsVideoUrl || null);

      if (existingEffectsVideoUrl || existingKenBurnsVideoUrl || existingBasicVideoUrl) {
        autoRenderTriggered.current = true;
        setCurrentPass('complete');
      } else {
        // No videos exist - reset to idle state for fresh render
        autoRenderTriggered.current = false;
        setCurrentPass('idle');
      }
    }
  }, [isOpen, existingBasicVideoUrl, existingEffectsVideoUrl, existingKenBurnsVideoUrl]);

  // Auto-start rendering when modal opens (if autoRender=true AND no existing videos)
  useEffect(() => {
    if (isOpen && autoRender && !autoRenderTriggered.current && !effectsVideoUrl && currentPass === 'idle') {
      autoRenderTriggered.current = true;
      handleRenderBothPasses();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, autoRender]);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      if (!existingBasicVideoUrl && !existingEffectsVideoUrl) {
        autoRenderTriggered.current = false;
      }
      setRenderProgress(null);
      // Keep current video URLs and pass state - don't reset them
    }
  }, [isOpen, existingBasicVideoUrl, existingEffectsVideoUrl]);

  // Auto-confirm when rendering completes in full automation mode
  const autoConfirmTriggered = useRef(false);
  useEffect(() => {
    const hasVideo = effectsVideoUrl || kenBurnsVideoUrl || basicVideoUrl;
    if (autoRender && hasVideo && currentPass === 'complete' && !autoConfirmTriggered.current) {
      autoConfirmTriggered.current = true;
      console.log('[VideoRenderModal] Auto-confirming after render complete');
      const timer = setTimeout(() => {
        onConfirm(basicVideoUrl || '', effectsVideoUrl || '', kenBurnsVideoUrl || undefined);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [autoRender, basicVideoUrl, effectsVideoUrl, kenBurnsVideoUrl, currentPass, onConfirm]);

  // Reset auto-confirm flag when modal closes
  useEffect(() => {
    if (!isOpen) {
      autoConfirmTriggered.current = false;
    }
  }, [isOpen]);

  // Render video with selected effect (single pass)
  const handleRender = async () => {
    // CRITICAL: Refresh data from database before rendering to get latest clips/images
    let clipsToRender = introClips;
    let imagesToRender = imageUrls;

    if (onRefreshData) {
      try {
        console.log('[Render] Refreshing clips and images from database...');
        const freshData = await onRefreshData();
        clipsToRender = freshData.clips;
        imagesToRender = freshData.images;
        console.log('[Render] Got fresh data:', {
          clips: clipsToRender?.length || 0,
          images: imagesToRender?.length || 0
        });
      } catch (err) {
        console.error('[Render] Failed to refresh data, using props:', err);
      }
    }

    // Map selected effect to API effects object
    const effectsConfig = {
      embers: false,
      smoke_embers: selectedEffect === 'smoke_embers',
      ken_burns: selectedEffect === 'ken_burns'
    };

    const effectLabel = selectedEffect === 'smoke_embers' ? 'Smoke + Embers'
      : selectedEffect === 'ken_burns' ? 'Ken Burns'
      : 'Basic';

    // Log all render inputs for debugging
    console.log('[Render] Starting render with:', {
      effect: selectedEffect,
      introClips: clipsToRender?.length || 0,
      images: imagesToRender?.length || 0,
      audioUrl: actualAudioUrl?.substring(0, 50) + '...',
      hasRecombineCallback: !!onRecombineAudio
    });

    // Warn about missing data
    if (!actualAudioUrl) {
      toast({
        title: "Missing Audio",
        description: "No audio URL found. Please go back and regenerate audio.",
        variant: "destructive",
      });
      return;
    }

    if (!imagesToRender || imagesToRender.length === 0) {
      toast({
        title: "Missing Images",
        description: "No images found. Please go back and generate images.",
        variant: "destructive",
      });
      return;
    }

    // Info toast about what will be rendered
    const clipInfo = clipsToRender && clipsToRender.length > 0
      ? `${clipsToRender.length} intro clips + `
      : '';
    toast({
      title: "Starting Render",
      description: `${clipInfo}${imagesToRender.length} images (${effectLabel})`,
    });

    // CRITICAL: Log clip URLs so we can verify correct clips are being rendered
    if (clipsToRender && clipsToRender.length > 0) {
      console.log('[VideoRenderModal] ===== CLIPS BEING RENDERED =====');
      clipsToRender.forEach((clip, i) => {
        console.log(`[VideoRenderModal] Clip ${i}: ${clip.url.substring(0, 80)}...`);
      });
      console.log('[VideoRenderModal] =====================================');
    }

    let audioUrlToUse = actualAudioUrl;

    // Only recombine if explicitly needed (segmentsNeedRecombine flag)
    if (onRecombineAudio && segmentsNeedRecombine) {
      setCurrentPass('pass1');
      setRenderProgress({ stage: 'downloading', percent: 0, message: 'Recombining audio segments...' });

      try {
        audioUrlToUse = await onRecombineAudio();
        setActualAudioUrl(audioUrlToUse);
        console.log('Audio recombined before render:', audioUrlToUse);
      } catch (error) {
        console.error('Failed to recombine audio:', error);
        if (actualAudioUrl) {
          console.log('Using existing audio URL after recombine failed:', actualAudioUrl);
          audioUrlToUse = actualAudioUrl;
          toast({
            title: "Using Existing Audio",
            description: "Recombine failed, using previously saved audio.",
          });
        } else {
          toast({
            title: "Audio Recombine Failed",
            description: error instanceof Error ? error.message : "Failed to recombine audio",
            variant: "destructive",
          });
          setCurrentPass('idle');
          setRenderProgress(null);
          return;
        }
      }
    } else {
      console.log('Skipping recombine, using existing audio URL:', actualAudioUrl?.substring(0, 60));
    }

    setCurrentPass('pass1');
    setRenderProgress({ stage: 'downloading', percent: 0, message: `Rendering ${effectLabel} video...` });

    try {
      const result = await renderVideoStreaming(
        projectId,
        audioUrlToUse,
        imagesToRender,
        imageTimings,
        srtContent,
        projectTitle || 'HistoryGenAI Export',
        {
          onProgress: (progress) => setRenderProgress({
            ...progress,
            message: progress.message
          }),
          onVideoReady: (url) => {
            toast({
              title: "Render Complete",
              description: `${effectLabel} video is ready!`,
            });
          },
          onCaptionError: (error) => {
            console.warn('Caption error (ignored):', error);
          }
        },
        effectsConfig,
        true,  // Use CPU rendering
        clipsToRender  // Include intro video clips (fresh from DB)
      );

      if (!result.success || !result.videoUrl) {
        throw new Error(result.error || 'Render failed');
      }

      // Store the video URL in the appropriate state based on effect type
      if (selectedEffect === 'smoke_embers') {
        setEffectsVideoUrl(result.videoUrl);
      } else if (selectedEffect === 'ken_burns') {
        setKenBurnsVideoUrl(result.videoUrl);
      } else {
        setBasicVideoUrl(result.videoUrl);
      }

      setCurrentPass('complete');

    } catch (error) {
      console.error('Render error:', error);
      toast({
        title: "Render Failed",
        description: error instanceof Error ? error.message : "Failed to render video. Please try again.",
        variant: "destructive",
      });
      setCurrentPass('idle');
      setRenderProgress(null);
    }
  };

  // Keep old function name for auto-render compatibility
  const handleRenderBothPasses = handleRender;


  const handleConfirm = () => {
    if (effectsVideoUrl || basicVideoUrl || kenBurnsVideoUrl) {
      onConfirm(basicVideoUrl || '', effectsVideoUrl || '', kenBurnsVideoUrl || undefined);
    }
  };

  // Get the current video URL based on selected effect
  const getCurrentVideoUrl = (): string | null => {
    if (selectedEffect === 'smoke_embers') return effectsVideoUrl;
    if (selectedEffect === 'ken_burns') return kenBurnsVideoUrl;
    return basicVideoUrl;
  };

  // Exit handler - save videos if they exist before closing
  const handleExit = () => {
    // Warn user if render is in progress
    if (isRendering) {
      const confirmed = window.confirm(
        'A render is still in progress. If you exit now, you may lose the current render.\n\nAre you sure you want to exit?'
      );
      if (!confirmed) return;
    }

    // If videos were rendered, save them before exiting
    if (currentPass === 'complete' && (effectsVideoUrl || basicVideoUrl || kenBurnsVideoUrl)) {
      console.log('[VideoRenderModal] Saving videos on exit');
      onConfirm(basicVideoUrl || '', effectsVideoUrl || '', kenBurnsVideoUrl || undefined);
    }
    onCancel();
  };

  const getStageLabel = (stage: string): string => {
    switch (stage) {
      case 'downloading': return 'Downloading assets';
      case 'preparing': return 'Preparing timeline';
      case 'rendering': return 'Rendering video';
      case 'uploading': return 'Uploading video';
      default: return stage;
    }
  };

  const isRendering = currentPass === 'pass1' || currentPass === 'pass2';
  const hasAnyVideo = basicVideoUrl || effectsVideoUrl || kenBurnsVideoUrl;
  const currentVideoUrl = getCurrentVideoUrl();

  // Handle escape key - allow closing when not actively rendering
  const handleEscapeKey = (e: KeyboardEvent) => {
    if (isRendering) {
      e.preventDefault();
    } else {
      onCancel();
    }
  };

  return (
    <Dialog open={isOpen}>
      <DialogContent
        className="sm:max-w-5xl"
        hideCloseButton
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={handleEscapeKey}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Video className="w-5 h-5 text-primary" />
            {currentPass === 'complete' ? 'Video Ready' : isRendering ? 'Rendering Video' : 'Render Video'}
          </DialogTitle>
          <DialogDescription>
            {currentPass === 'complete'
              ? 'Your video is ready! Download or continue to thumbnails.'
              : isRendering
                ? 'Rendering your video...'
                : 'Choose an effect style and render your video.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Video Player - Show rendered video */}
          {currentVideoUrl && currentPass === 'complete' && (
            <div className="space-y-3">
              <video
                key={currentVideoUrl}
                src={currentVideoUrl}
                controls
                preload="auto"
                crossOrigin="anonymous"
                className="w-full rounded-lg border"
                style={{ maxHeight: '400px' }}
              />
            </div>
          )}

          {/* Rendering Progress */}
          {isRendering && renderProgress && (
            <>
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">
                    Rendering {selectedEffect === 'smoke_embers' ? 'Smoke + Embers' : selectedEffect === 'ken_burns' ? 'Ken Burns' : 'Basic'} video...
                  </span>
                  <span className="font-medium">{renderProgress.percent}%</span>
                </div>
                <Progress value={renderProgress.percent} className="h-2" />
              </div>
              <p className="text-sm text-muted-foreground">
                {getStageLabel(renderProgress.stage)}: {renderProgress.message}
              </p>
              <p className="text-xs text-muted-foreground">
                This may take several minutes for large videos (200 images ~30-45 min)...
              </p>
            </>
          )}

          {/* Loading state before progress starts */}
          {isRendering && !renderProgress && (
            <div className="flex flex-col items-center gap-3 py-8">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">Starting render...</p>
            </div>
          )}

          {/* Effect Selector + Render button when not rendering */}
          {!isRendering && currentPass !== 'complete' && (
            <div className="space-y-4 py-4">
              <div className="bg-muted/50 rounded-lg p-4 space-y-3">
                <h4 className="font-medium text-sm">Choose Video Effect</h4>
                <div className="space-y-2">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="radio"
                      name="effect"
                      value="smoke_embers"
                      checked={selectedEffect === 'smoke_embers'}
                      onChange={() => setSelectedEffect('smoke_embers')}
                      className="w-4 h-4"
                    />
                    <Sparkles className="w-4 h-4 text-orange-500" />
                    <span className="text-sm">Smoke + Embers <span className="text-muted-foreground">(Atmospheric overlay)</span></span>
                  </label>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="radio"
                      name="effect"
                      value="ken_burns"
                      checked={selectedEffect === 'ken_burns'}
                      onChange={() => setSelectedEffect('ken_burns')}
                      className="w-4 h-4"
                    />
                    <Maximize className="w-4 h-4 text-blue-500" />
                    <span className="text-sm">Ken Burns <span className="text-muted-foreground">(Slow zoom + pan, clean)</span></span>
                  </label>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="radio"
                      name="effect"
                      value="none"
                      checked={selectedEffect === 'none'}
                      onChange={() => setSelectedEffect('none')}
                      className="w-4 h-4"
                    />
                    <Video className="w-4 h-4 text-gray-500" />
                    <span className="text-sm">None <span className="text-muted-foreground">(Basic video)</span></span>
                  </label>
                </div>
              </div>
              <Button onClick={handleRender} className="w-full gap-2">
                <Video className="w-4 h-4" />
                Render Video
              </Button>
            </div>
          )}

          {/* Re-render button when video is complete */}
          {!isRendering && currentPass === 'complete' && (
            <div className="mt-2">
              <Button
                variant="outline"
                onClick={() => setCurrentPass('idle')}
                className="w-full gap-2"
              >
                <RotateCcw className="w-4 h-4" />
                Render Different Effect
              </Button>
            </div>
          )}
        </div>

        <DialogFooter className="flex-shrink-0 gap-2 sm:gap-2">
          {/* Left side: Navigation + Download */}
          <div className="flex gap-2 mr-auto">
            {onBack && (
              <Button variant="outline" size="icon" onClick={onBack} disabled={isRendering} title="Back to previous step">
                <ChevronLeft className="w-5 h-5" />
              </Button>
            )}
            {onSkip && (
              <Button variant="outline" size="icon" onClick={onSkip} disabled={isRendering} title="Skip to next step">
                <ChevronRight className="w-5 h-5" />
              </Button>
            )}
            {/* Download button - downloads current video */}
            {currentVideoUrl && currentPass === 'complete' && (
              <Button
                variant="outline"
                onClick={async () => {
                  const effectSuffix = selectedEffect === 'smoke_embers' ? '_effects'
                    : selectedEffect === 'ken_burns' ? '_kenburns'
                    : '';
                  const filename = (projectTitle || 'video').replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '_').substring(0, 50) + effectSuffix + '.mp4';
                  toast({ title: "Downloading...", description: `Downloading ${filename}...` });
                  try {
                    await downloadFromUrl(currentVideoUrl, filename);
                    toast({ title: "Download Complete", description: `${filename} downloaded successfully.` });
                  } catch (error) {
                    toast({ title: "Download Failed", description: "Failed to download video.", variant: "destructive" });
                  }
                }}
              >
                <Download className="w-4 h-4 mr-2" />
                Download
              </Button>
            )}
          </div>

          {/* Right side: Exit + Continue */}
          <Button variant="outline" onClick={handleExit}>
            <X className="w-4 h-4 mr-2" />
            Exit
          </Button>

          {onForward ? (
            <Button
              onClick={onForward}
              disabled={isRendering || (!effectsVideoUrl && !basicVideoUrl)}
            >
              Thumbnails
              <ChevronRight className="w-4 h-4 ml-2" />
            </Button>
          ) : (
            <Button
              onClick={handleConfirm}
              disabled={!effectsVideoUrl && !basicVideoUrl}
            >
              <Check className="w-4 h-4 mr-2" />
              Continue
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
