import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { Check, X, Video, Play, Pause, ChevronLeft, ChevronRight, Download, RefreshCw, AlertTriangle, Maximize2 } from "lucide-react";
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
import type { GeneratedClip, ClipPrompt } from "@/lib/api";

interface VideoClipsPreviewModalProps {
  isOpen: boolean;
  clips: GeneratedClip[];
  clipPrompts: ClipPrompt[];
  onConfirm: () => void;
  onCancel: () => void;
  onBack?: () => void;
  onRegenerate?: (clipIndex: number, editedPrompt?: string) => void;
  onRegenerateMultiple?: (clipIndices: number[]) => void;
  regeneratingIndices?: Set<number>;
  selectedIndices?: Set<number>;
  onSelectionChange?: (indices: Set<number>) => void;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

interface ClipCardProps {
  clip: GeneratedClip;
  prompt?: ClipPrompt;
  onRegenerate?: (editedPrompt?: string) => void;
  isRegenerating?: boolean;
  onOpenFullscreen?: () => void;
  isSelected?: boolean;
  onToggleSelect?: () => void;
  showSelection?: boolean;
}

function ClipCard({ clip, prompt, onRegenerate, isRegenerating, onOpenFullscreen, isSelected, onToggleSelect, showSelection }: ClipCardProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editedPrompt, setEditedPrompt] = useState(prompt?.sceneDescription || '');

  // Reset error state when video URL changes (e.g., after regeneration)
  useEffect(() => {
    setHasError(false);
    setIsPlaying(false);
  }, [clip.videoUrl]);

  // Update edited prompt when prompt changes
  useEffect(() => {
    setEditedPrompt(prompt?.sceneDescription || '');
  }, [prompt?.sceneDescription]);

  const togglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        videoRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const handleEnded = () => {
    setIsPlaying(false);
  };

  const handleError = () => {
    setHasError(true);
  };

  const handleFullscreen = (e: React.MouseEvent) => {
    e.stopPropagation();
    onOpenFullscreen?.();
  };

  return (
    <div className={`border rounded-lg overflow-hidden bg-card ${isSelected ? 'ring-2 ring-primary' : ''}`}>
      <div className="relative aspect-video bg-black group">
        {/* Selection checkbox */}
        {showSelection && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleSelect?.();
            }}
            className={`absolute top-2 left-2 z-10 w-6 h-6 rounded border-2 flex items-center justify-center transition-colors ${
              isSelected
                ? 'bg-primary border-primary text-primary-foreground'
                : 'bg-black/50 border-white/70 hover:border-white'
            }`}
          >
            {isSelected && <Check className="w-4 h-4" />}
          </button>
        )}
        {hasError ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground">
            <AlertTriangle className="w-8 h-8 mb-2" />
            <span className="text-sm">Failed to load video</span>
          </div>
        ) : (
          <>
            <video
              key={clip.videoUrl}
              ref={videoRef}
              src={clip.videoUrl}
              poster={prompt?.imageUrl}
              className="w-full h-full object-contain cursor-pointer"
              onEnded={handleEnded}
              onError={handleError}
              preload="auto"
              onClick={handleFullscreen}
            />
            <div className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
              <Play className="w-12 h-12 text-white" />
            </div>
            <button
              onClick={togglePlay}
              className="absolute bottom-2 left-2 p-2 bg-black/50 rounded-full hover:bg-black/70 transition-colors"
            >
              {isPlaying ? (
                <Pause className="w-4 h-4 text-white" />
              ) : (
                <Play className="w-4 h-4 text-white" />
              )}
            </button>
            <button
              onClick={handleFullscreen}
              className="absolute bottom-2 right-2 p-2 bg-black/50 rounded-full hover:bg-black/70 transition-colors"
            >
              <Maximize2 className="w-4 h-4 text-white" />
            </button>
          </>
        )}
      </div>

      <div className="p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Video className="w-4 h-4 text-primary" />
            <span className="font-medium">Clip {clip.index}</span>
          </div>
          {prompt && (
            <span className="text-xs text-muted-foreground">
              {formatTime(prompt.startSeconds)} - {formatTime(prompt.endSeconds)}
            </span>
          )}
        </div>

        {prompt && (
          isEditing ? (
            <div className="space-y-2">
              <textarea
                value={editedPrompt}
                onChange={(e) => setEditedPrompt(e.target.value)}
                className="w-full min-h-[80px] p-2 text-sm bg-background border rounded resize-y"
                placeholder="Describe the scene..."
              />
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setIsEditing(false);
                    setEditedPrompt(prompt.sceneDescription);
                  }}
                  className="flex-1"
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    setIsEditing(false);
                    if (onRegenerate && editedPrompt !== prompt.sceneDescription) {
                      onRegenerate(editedPrompt);
                    }
                  }}
                  disabled={isRegenerating}
                  className="flex-1"
                >
                  <RefreshCw className={`w-3 h-3 mr-1 ${isRegenerating ? 'animate-spin' : ''}`} />
                  Regen
                </Button>
              </div>
            </div>
          ) : (
            <p
              className="text-sm text-muted-foreground line-clamp-2 cursor-pointer hover:text-foreground"
              onClick={() => setIsEditing(true)}
              title="Click to edit prompt"
            >
              {prompt.sceneDescription}
            </p>
          )
        )}

        {onRegenerate && !isEditing && (
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setIsEditing(true)}
              className="flex-1"
            >
              Edit
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onRegenerate()}
              disabled={isRegenerating}
              className="flex-1"
            >
              <RefreshCw className={`w-3 h-3 mr-1 ${isRegenerating ? 'animate-spin' : ''}`} />
              {isRegenerating ? '...' : 'Regen'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export function VideoClipsPreviewModal({
  isOpen,
  clips,
  clipPrompts,
  onConfirm,
  onCancel,
  onBack,
  onRegenerate,
  onRegenerateMultiple,
  regeneratingIndices = new Set(),
  selectedIndices = new Set(),
  onSelectionChange,
}: VideoClipsPreviewModalProps) {
  const isRegenerating = regeneratingIndices.size > 0;
  const [isPlayingAll, setIsPlayingAll] = useState(false);
  const [fullscreenClip, setFullscreenClip] = useState<GeneratedClip | null>(null);
  const fullscreenVideoRef = useRef<HTMLVideoElement>(null);
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([]);

  const totalDuration = clips.length * 5; // 5 seconds per clip (I2V)
  const successCount = clips.filter(c => c.videoUrl).length;
  const failedCount = clips.length - successCount;

  // Get current clip index and navigation helpers (must be declared before useEffect)
  const currentClipIndex = fullscreenClip ? clips.findIndex(c => c.index === fullscreenClip.index) : -1;
  const canGoNext = currentClipIndex < clips.length - 1;
  const canGoPrev = currentClipIndex > 0;

  // Update fullscreen clip when clips array changes (e.g., after regeneration)
  useEffect(() => {
    if (fullscreenClip) {
      const updatedClip = clips.find(c => c.index === fullscreenClip.index);
      if (updatedClip && updatedClip.videoUrl !== fullscreenClip.videoUrl) {
        setFullscreenClip(updatedClip);
      }
    }
  }, [clips, fullscreenClip]);

  // Keyboard navigation for fullscreen (capture phase to bypass Radix Dialog)
  useEffect(() => {
    if (!fullscreenClip) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setFullscreenClip(null);
      } else if (e.key === 'ArrowRight' && canGoNext) {
        e.preventDefault();
        e.stopPropagation();
        setFullscreenClip(clips[currentClipIndex + 1]);
      } else if (e.key === 'ArrowLeft' && canGoPrev) {
        e.preventDefault();
        e.stopPropagation();
        setFullscreenClip(clips[currentClipIndex - 1]);
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [fullscreenClip, currentClipIndex, canGoNext, canGoPrev, clips]);

  // Close fullscreen on background click (capture phase)
  useEffect(() => {
    if (!fullscreenClip) return;

    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('video-lightbox-backdrop')) {
        e.preventDefault();
        e.stopPropagation();
        setFullscreenClip(null);
      }
    };

    window.addEventListener('click', handleClick, { capture: true });
    return () => window.removeEventListener('click', handleClick, { capture: true });
  }, [fullscreenClip]);

  const goToNextClip = () => {
    if (canGoNext) {
      setFullscreenClip(clips[currentClipIndex + 1]);
    }
  };

  const goToPrevClip = () => {
    if (canGoPrev) {
      setFullscreenClip(clips[currentClipIndex - 1]);
    }
  };

  const handlePlayAll = async () => {
    if (isPlayingAll) {
      // Stop all videos
      videoRefs.current.forEach(video => video?.pause());
      setIsPlayingAll(false);
    } else {
      // Play all videos in sequence
      setIsPlayingAll(true);
      for (const video of videoRefs.current) {
        if (video && !video.error) {
          video.currentTime = 0;
          await video.play();
          await new Promise(resolve => {
            video.onended = resolve;
          });
        }
      }
      setIsPlayingAll(false);
    }
  };

  const [isDownloading, setIsDownloading] = useState(false);

  const handleDownloadAll = async () => {
    setIsDownloading(true);
    try {
      // Download clips sequentially to avoid overwhelming the browser
      for (let i = 0; i < clips.length; i++) {
        const clip = clips[i];
        if (clip.videoUrl) {
          try {
            // Fetch as blob to bypass cross-origin download restrictions
            const response = await fetch(clip.videoUrl);
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);

            const a = document.createElement('a');
            a.href = url;
            a.download = clip.filename || `clip_${String(i).padStart(3, '0')}.mp4`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            // Small delay between downloads
            if (i < clips.length - 1) {
              await new Promise(resolve => setTimeout(resolve, 500));
            }
          } catch (err) {
            console.error(`Failed to download clip ${i + 1}:`, err);
          }
        }
      }
    } finally {
      setIsDownloading(false);
    }
  };

  // Find the prompt for each clip
  const getPromptForClip = (clipIndex: number): ClipPrompt | undefined => {
    return clipPrompts.find(p => p.index === clipIndex);
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        className="max-w-6xl max-h-[90vh] overflow-hidden flex flex-col"
        onPointerDownOutside={(e) => fullscreenClip && e.preventDefault()}
        onInteractOutside={(e) => fullscreenClip && e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Video className="w-5 h-5" />
            Generate Video Clips
          </DialogTitle>
          <DialogDescription>
            Preview your {clips.length} intro video clips ({totalDuration} seconds total).
            {failedCount > 0 && (
              <span className="text-yellow-500 ml-2">
                {failedCount} clip{failedCount > 1 ? 's' : ''} failed to generate.
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        {/* Controls */}
        <div className="flex items-center gap-4 py-2 border-b">
          <Button
            variant="outline"
            onClick={handlePlayAll}
            disabled={successCount === 0}
          >
            {isPlayingAll ? (
              <>
                <Pause className="w-4 h-4 mr-1" />
                Stop
              </>
            ) : (
              <>
                <Play className="w-4 h-4 mr-1" />
                Play All
              </>
            )}
          </Button>

          <Button
            variant="outline"
            onClick={handleDownloadAll}
            disabled={successCount === 0 || isDownloading}
          >
            <Download className={`w-4 h-4 mr-1 ${isDownloading ? 'animate-pulse' : ''}`} />
            {isDownloading ? 'Downloading...' : 'Download All'}
          </Button>

          <div className="flex-1" />

          <span className="text-sm text-muted-foreground">
            {successCount}/{clips.length} clips ready
          </span>
        </div>

        {/* Clips Grid */}
        <div className="flex-1 overflow-y-auto">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 p-2">
            {clips.map((clip, index) => (
              <ClipCard
                key={clip.index}
                clip={clip}
                prompt={getPromptForClip(clip.index)}
                onRegenerate={onRegenerate ? (editedPrompt) => onRegenerate(clip.index, editedPrompt) : undefined}
                isRegenerating={regeneratingIndices.has(clip.index)}
                onOpenFullscreen={() => setFullscreenClip(clip)}
              />
            ))}
          </div>
        </div>

        <DialogFooter className="flex-shrink-0 border-t pt-4 mt-4">
          <div className="flex justify-between w-full">
            <div className="flex gap-2">
              {onBack && (
                <Button variant="outline" onClick={onBack}>
                  <ChevronLeft className="w-4 h-4 mr-1" />
                  Back to Prompts
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={onCancel}>
                <X className="w-4 h-4 mr-1" />
                Cancel
              </Button>
              <Button onClick={onConfirm} disabled={successCount === 0}>
                <Check className="w-4 h-4 mr-1" />
                Continue to Render
                <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>

      {/* Fullscreen Video Lightbox */}
      {fullscreenClip && createPortal(
        <div className="video-lightbox-backdrop fixed inset-0 z-[100] bg-black/90 flex items-center justify-center">
          <div className="relative max-w-[90vw] max-h-[90vh] flex flex-col items-center">
            {/* Close button */}
            <button
              onClick={() => setFullscreenClip(null)}
              className="absolute -top-12 right-0 p-2 text-white/70 hover:text-white transition-colors"
            >
              <X className="w-8 h-8" />
            </button>

            {/* Video player */}
            <video
              key={fullscreenClip.videoUrl}
              ref={fullscreenVideoRef}
              src={fullscreenClip.videoUrl}
              poster={getPromptForClip(fullscreenClip.index)?.imageUrl}
              className="max-w-full max-h-[80vh] rounded-lg"
              controls
              autoPlay
            />

            {/* Navigation arrows */}
            {canGoPrev && (
              <button
                onClick={goToPrevClip}
                className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-16 p-3 text-white/70 hover:text-white transition-colors"
              >
                <ChevronLeft className="w-10 h-10" />
              </button>
            )}
            {canGoNext && (
              <button
                onClick={goToNextClip}
                className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-16 p-3 text-white/70 hover:text-white transition-colors"
              >
                <ChevronRight className="w-10 h-10" />
              </button>
            )}

            {/* Clip info */}
            <div className="mt-4 text-white text-center">
              <p className="text-lg font-medium">Clip {fullscreenClip.index}</p>
              {getPromptForClip(fullscreenClip.index) && (
                <p className="text-sm text-white/70 mt-1 max-w-2xl">
                  {getPromptForClip(fullscreenClip.index)?.sceneDescription}
                </p>
              )}
              <p className="text-xs text-white/50 mt-2">
                {currentClipIndex + 1} of {clips.length} • Press ESC or click outside to close
              </p>
            </div>

            {/* Regenerate button in fullscreen */}
            {onRegenerate && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  onRegenerate(fullscreenClip.index);
                }}
                disabled={regeneratingIndices.has(fullscreenClip.index)}
                className="mt-4"
              >
                <RefreshCw className={`w-4 h-4 mr-1 ${regeneratingIndices.has(fullscreenClip.index) ? 'animate-spin' : ''}`} />
                {regeneratingIndices.has(fullscreenClip.index) ? 'Regenerating...' : 'Regenerate This Clip'}
              </Button>
            )}
          </div>
        </div>,
        document.body
      )}
    </Dialog>
  );
}
