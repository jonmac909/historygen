import { useState, useRef, useEffect } from "react";
import { Play, Pause, RefreshCw, Check, X, Loader2, ChevronDown, ChevronUp } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { regenerateAudioSegment } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

interface SegmentRegenerateModalProps {
  isOpen: boolean;
  onClose: () => void;
  segmentNumber: number;  // Audio segment index (1-based)
  originalText: string;   // Script text for this segment
  combinedAudioUrl?: string;  // Full combined audio for playing original
  segmentStartTime?: number;  // Start time in seconds for this segment
  segmentEndTime?: number;    // End time in seconds for this segment
  projectId: string;
  voiceSampleUrl?: string;
  ttsSettings?: { temperature?: number; topP?: number; repetitionPenalty?: number };
  onAccept: (segmentNumber: number, newAudioUrl: string, newText: string, duration: number) => void;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function SegmentRegenerateModal({
  isOpen,
  onClose,
  segmentNumber,
  originalText,
  combinedAudioUrl,
  segmentStartTime,
  segmentEndTime,
  projectId,
  voiceSampleUrl,
  ttsSettings,
  onAccept,
}: SegmentRegenerateModalProps) {
  const { toast } = useToast();
  const [editedText, setEditedText] = useState(originalText);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [newAudioUrl, setNewAudioUrl] = useState<string | null>(null);
  const [newDuration, setNewDuration] = useState<number>(0);

  // Original audio playback
  const [isPlayingOriginal, setIsPlayingOriginal] = useState(false);
  const [originalCurrentTime, setOriginalCurrentTime] = useState(0);
  const [originalLoading, setOriginalLoading] = useState(true);
  const originalAudioRef = useRef<HTMLAudioElement | null>(null);
  const playbackEndTimeRef = useRef<number | null>(null);

  // New audio playback
  const [isPlayingNew, setIsPlayingNew] = useState(false);
  const [newCurrentTime, setNewCurrentTime] = useState(0);
  const [newLoading, setNewLoading] = useState(true);
  const newAudioRef = useRef<HTMLAudioElement | null>(null);

  // Text expansion
  const [isTextExpanded, setIsTextExpanded] = useState(true);

  const segmentDuration = (segmentEndTime || 0) - (segmentStartTime || 0);
  const hasTextChanged = editedText !== originalText;

  // Reset state when modal opens with new segment
  useEffect(() => {
    if (isOpen) {
      setEditedText(originalText);
      setNewAudioUrl(null);
      setNewDuration(0);
      setIsRegenerating(false);
      setIsPlayingOriginal(false);
      setIsPlayingNew(false);
      setOriginalCurrentTime(0);
      setNewCurrentTime(0);
      setOriginalLoading(true);
      setNewLoading(true);
    }
  }, [isOpen, originalText, segmentNumber]);

  // Cleanup audio on close
  useEffect(() => {
    return () => {
      if (originalAudioRef.current) {
        originalAudioRef.current.pause();
      }
      if (newAudioRef.current) {
        newAudioRef.current.pause();
      }
    };
  }, []);

  // Original audio player handlers
  const handleOriginalCanPlay = () => setOriginalLoading(false);
  const handleOriginalTimeUpdate = () => {
    if (originalAudioRef.current) {
      const relativeTime = originalAudioRef.current.currentTime - (segmentStartTime || 0);
      setOriginalCurrentTime(Math.max(0, relativeTime));

      // Stop at end time
      if (playbackEndTimeRef.current && originalAudioRef.current.currentTime >= playbackEndTimeRef.current) {
        originalAudioRef.current.pause();
        setIsPlayingOriginal(false);
      }
    }
  };
  const handleOriginalEnded = () => {
    setIsPlayingOriginal(false);
    setOriginalCurrentTime(0);
  };

  const toggleOriginalPlay = () => {
    if (!originalAudioRef.current || !combinedAudioUrl) return;

    if (isPlayingOriginal) {
      originalAudioRef.current.pause();
      setIsPlayingOriginal(false);
    } else {
      // Stop new audio if playing
      if (newAudioRef.current && isPlayingNew) {
        newAudioRef.current.pause();
        setIsPlayingNew(false);
      }

      originalAudioRef.current.currentTime = segmentStartTime || 0;
      playbackEndTimeRef.current = segmentEndTime || null;
      originalAudioRef.current.play()
        .then(() => setIsPlayingOriginal(true))
        .catch(err => console.error('Failed to play:', err));
    }
  };

  // New audio player handlers
  const handleNewCanPlay = () => setNewLoading(false);
  const handleNewTimeUpdate = () => {
    if (newAudioRef.current) {
      setNewCurrentTime(newAudioRef.current.currentTime);
    }
  };
  const handleNewEnded = () => {
    setIsPlayingNew(false);
    setNewCurrentTime(0);
  };

  const toggleNewPlay = () => {
    if (!newAudioRef.current || !newAudioUrl) return;

    if (isPlayingNew) {
      newAudioRef.current.pause();
      setIsPlayingNew(false);
    } else {
      // Stop original audio if playing
      if (originalAudioRef.current && isPlayingOriginal) {
        originalAudioRef.current.pause();
        setIsPlayingOriginal(false);
      }

      newAudioRef.current.play()
        .then(() => setIsPlayingNew(true))
        .catch(err => console.error('Failed to play:', err));
    }
  };

  // Regenerate the segment audio
  const handleRegenerate = async () => {
    if (!voiceSampleUrl) {
      toast({ title: "No voice sample available", description: "Cannot regenerate without voice sample", variant: "destructive" });
      return;
    }

    setIsRegenerating(true);
    setNewAudioUrl(null);
    setNewLoading(true);

    try {
      const result = await regenerateAudioSegment(
        editedText,
        segmentNumber,
        voiceSampleUrl,
        projectId,
        undefined,
        ttsSettings
      );

      if (result.success && result.segment) {
        setNewAudioUrl(result.segment.audioUrl);
        setNewDuration(result.segment.duration);
        toast({ title: "Segment regenerated", description: "Listen to the new audio before accepting" });
      } else {
        toast({ title: "Regeneration failed", description: result.error || "Unknown error", variant: "destructive" });
      }
    } catch (error) {
      console.error('Regeneration failed:', error);
      toast({ title: "Regeneration failed", description: error instanceof Error ? error.message : "Network error", variant: "destructive" });
    } finally {
      setIsRegenerating(false);
    }
  };

  const handleAccept = () => {
    if (newAudioUrl) {
      onAccept(segmentNumber, newAudioUrl, editedText, newDuration);
    }
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg font-medium">
            Regenerate Segment {segmentNumber}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Original Audio Player */}
          {combinedAudioUrl && segmentStartTime !== undefined && (
            <div className="border rounded-lg p-3 bg-muted/30">
              <audio
                ref={originalAudioRef}
                src={combinedAudioUrl}
                preload="auto"
                onCanPlay={handleOriginalCanPlay}
                onTimeUpdate={handleOriginalTimeUpdate}
                onEnded={handleOriginalEnded}
              />

              <div className="flex items-center gap-2 mb-2">
                <span className="text-sm font-medium text-muted-foreground">Original Audio</span>
              </div>

              <div className="flex items-center gap-3">
                <Button
                  size="sm"
                  variant="outline"
                  className="w-9 h-9 rounded-full p-0 flex-shrink-0"
                  onClick={toggleOriginalPlay}
                  disabled={originalLoading}
                >
                  {originalLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : isPlayingOriginal ? (
                    <Pause className="w-4 h-4" />
                  ) : (
                    <Play className="w-4 h-4 ml-0.5" />
                  )}
                </Button>

                <div className="flex-1 space-y-1">
                  <div className="relative h-1.5 w-full rounded-full bg-secondary overflow-hidden">
                    <div
                      className="absolute h-full bg-muted-foreground rounded-full transition-all"
                      style={{ width: `${segmentDuration ? (originalCurrentTime / segmentDuration) * 100 : 0}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{formatTime(originalCurrentTime)}</span>
                    <span>{formatTime(segmentDuration)}</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Expandable Script Text */}
          <div className="border rounded-lg bg-card">
            <button
              onClick={() => setIsTextExpanded(!isTextExpanded)}
              className="w-full flex items-center justify-between p-3 text-sm hover:bg-muted/50 transition-colors"
            >
              <span className="font-medium">
                Script Text {hasTextChanged && <span className="text-amber-500">(edited)</span>}
              </span>
              {isTextExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>

            {isTextExpanded ? (
              <div className="px-3 pb-3">
                <textarea
                  value={editedText}
                  onChange={(e) => setEditedText(e.target.value)}
                  className="w-full min-h-[100px] p-2 text-sm bg-background border rounded resize-y"
                  placeholder="Edit the script text for this segment..."
                />
                {hasTextChanged && (
                  <p className="text-xs text-amber-500 mt-1">
                    Text has been modified. Click Regenerate to create new audio.
                  </p>
                )}
              </div>
            ) : (
              <p className="px-3 pb-3 text-sm text-muted-foreground line-clamp-2 italic">
                "{editedText.substring(0, 100)}{editedText.length > 100 ? '...' : ''}"
              </p>
            )}
          </div>

          {/* Regenerate Button */}
          <Button
            className="w-full"
            onClick={handleRegenerate}
            disabled={isRegenerating || !editedText.trim()}
          >
            {isRegenerating ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Regenerating...
              </>
            ) : (
              <>
                <RefreshCw className="w-4 h-4 mr-2" />
                {newAudioUrl ? 'Try Again' : 'Regenerate'}
              </>
            )}
          </Button>

          {/* New Audio Player */}
          {newAudioUrl && (
            <div className="border rounded-lg p-3 bg-green-50 border-green-200">
              <audio
                ref={newAudioRef}
                src={newAudioUrl}
                preload="auto"
                onCanPlay={handleNewCanPlay}
                onTimeUpdate={handleNewTimeUpdate}
                onEnded={handleNewEnded}
              />

              <div className="flex items-center gap-2 mb-2">
                <span className="text-sm font-medium text-green-700">New Audio</span>
                <span className="text-xs text-green-600">Ready to preview</span>
              </div>

              <div className="flex items-center gap-3">
                <Button
                  size="sm"
                  variant="outline"
                  className="w-9 h-9 rounded-full p-0 flex-shrink-0 border-green-300 hover:bg-green-100"
                  onClick={toggleNewPlay}
                  disabled={newLoading}
                >
                  {newLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : isPlayingNew ? (
                    <Pause className="w-4 h-4 text-green-700" />
                  ) : (
                    <Play className="w-4 h-4 ml-0.5 text-green-700" />
                  )}
                </Button>

                <div className="flex-1 space-y-1">
                  <div className="relative h-1.5 w-full rounded-full bg-green-100 overflow-hidden">
                    <div
                      className="absolute h-full bg-green-500 rounded-full transition-all"
                      style={{ width: `${newDuration ? (newCurrentTime / newDuration) * 100 : 0}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-xs text-green-700">
                    <span>{formatTime(newCurrentTime)}</span>
                    <span>{formatTime(newDuration)}</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 mt-4">
          <Button variant="outline" onClick={onClose}>
            <X className="w-4 h-4 mr-1" />
            Cancel
          </Button>
          <Button
            onClick={handleAccept}
            disabled={!newAudioUrl}
            className="bg-green-600 hover:bg-green-700"
          >
            <Check className="w-4 h-4 mr-1" />
            Accept
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
