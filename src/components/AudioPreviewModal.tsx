import { useState, useRef, useEffect } from "react";
import { Check, X, Play, Pause, RotateCcw, Volume2, Loader2, ChevronLeft, ChevronRight } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface AudioPreviewModalProps {
  isOpen: boolean;
  audioUrl: string;
  duration?: number;
  onConfirm: () => void;
  onRegenerate: () => void;
  onCancel: () => void;
  onBack?: () => void;
  onForward?: () => void;
}

export function AudioPreviewModal({
  isOpen,
  audioUrl,
  duration,
  onConfirm,
  onRegenerate,
  onCancel,
  onBack,
  onForward,
}: AudioPreviewModalProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(duration || 0);
  const [isLoading, setIsLoading] = useState(true);
  const [playbackRate, setPlaybackRate] = useState(1);
  const audioRef = useRef<HTMLAudioElement>(null);

  // Reset state when modal opens with new audio
  useEffect(() => {
    if (isOpen && audioUrl) {
      setIsPlaying(false);
      setCurrentTime(0);
      setIsLoading(true);
      setAudioDuration(duration || 0);
      setPlaybackRate(1);

      // Fallback: if audio doesn't load within 3 seconds but we have duration, show controls
      const timeout = setTimeout(() => {
        if (duration && duration > 0) {
          setIsLoading(false);
        }
      }, 3000);

      return () => clearTimeout(timeout);
    }
  }, [isOpen, audioUrl, duration]);

  const togglePlay = () => {
    if (!audioRef.current) {
      console.error('Audio ref not available');
      return;
    }
    
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      console.log('Attempting to play audio from:', audioUrl);
      audioRef.current.play()
        .then(() => {
          console.log('Audio playback started');
          setIsPlaying(true);
        })
        .catch((err) => {
          console.error('Failed to play audio:', err);
          // Try loading and playing again
          audioRef.current?.load();
          audioRef.current?.play().catch(e => console.error('Retry failed:', e));
        });
    }
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    if (audioRef.current) {
      const realDuration = audioRef.current.duration;
      if (realDuration && isFinite(realDuration) && realDuration > 0) {
        setAudioDuration(realDuration);
      }
      setIsLoading(false);
    }
  };

  const handleCanPlay = () => {
    setIsLoading(false);
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
  };

  const togglePlaybackRate = () => {
    const newRate = playbackRate === 1 ? 2 : 1;
    setPlaybackRate(newRate);
    if (audioRef.current) {
      audioRef.current.playbackRate = newRate;
    }
  };

  const handleSeek = (value: number[]) => {
    if (audioRef.current) {
      audioRef.current.currentTime = value[0];
      setCurrentTime(value[0]);
    }
  };

  const handleEnded = () => {
    setIsPlaying(false);
    setCurrentTime(0);
  };

  const handleError = () => {
    // Even on error, allow user to try playing - some browsers report errors but still play
    console.error('Audio load error, but allowing playback attempt');
    setIsLoading(false);
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-2xl font-bold flex items-center gap-2">
            <Volume2 className="w-6 h-6 text-primary" />
            Preview Audio
          </DialogTitle>
          <DialogDescription>
            Listen to the generated voiceover and confirm before continuing.
          </DialogDescription>
        </DialogHeader>

        <div className="py-6 space-y-6">
          <audio
            ref={audioRef}
            src={audioUrl}
            preload="auto"
            onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={handleLoadedMetadata}
            onCanPlay={handleCanPlay}
            onEnded={handleEnded}
            onError={handleError}
          />

          {/* Play/Pause Button */}
          <div className="flex justify-center">
            <Button
              size="lg"
              variant="outline"
              className="w-20 h-20 rounded-full border-2 hover:bg-primary hover:text-primary-foreground transition-colors"
              onClick={togglePlay}
              disabled={isLoading}
            >
              {isLoading ? (
                <Loader2 className="w-8 h-8 animate-spin" />
              ) : isPlaying ? (
                <Pause className="w-8 h-8" />
              ) : (
                <Play className="w-8 h-8 ml-1" />
              )}
            </Button>
          </div>

          {/* Progress Bar */}
          <div className="space-y-1 px-2">
            <div className="relative h-2 w-full rounded-full bg-secondary overflow-hidden">
              <div
                className="absolute h-full bg-primary rounded-full transition-all"
                style={{ width: `${audioDuration ? (currentTime / audioDuration) * 100 : 0}%` }}
              />
              <input
                type="range"
                min={0}
                max={audioDuration || 100}
                step={0.1}
                value={currentTime}
                onChange={(e) => handleSeek([parseFloat(e.target.value)])}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              />
            </div>
            <div className="flex justify-between text-sm font-medium text-muted-foreground">
              <span>{formatTime(currentTime)}</span>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant={playbackRate === 2 ? "default" : "outline"}
                  className="h-6 px-2 text-xs"
                  onClick={togglePlaybackRate}
                >
                  {playbackRate}x
                </Button>
                <span>{formatTime(audioDuration)}</span>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          {onBack && (
            <Button variant="outline" size="icon" onClick={onBack} title="Back to previous step" className="sm:mr-auto">
              <ChevronLeft className="w-5 h-5" />
            </Button>
          )}

          <Button variant="outline" onClick={onRegenerate} className="w-full sm:w-auto">
            <RotateCcw className="w-4 h-4 mr-2" />
            Regenerate
          </Button>

          <Button variant="outline" onClick={onCancel} className="w-full sm:w-auto">
            <X className="w-4 h-4 mr-2" />
            Cancel
          </Button>

          {onForward ? (
            <Button onClick={onForward} className="w-full sm:w-auto">
              Captions
              <ChevronRight className="w-4 h-4 ml-2" />
            </Button>
          ) : (
            <Button onClick={onConfirm} className="w-full sm:w-auto">
              <Check className="w-4 h-4 mr-2" />
              Generate Captions
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
