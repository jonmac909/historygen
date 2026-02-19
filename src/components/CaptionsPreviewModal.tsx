import { useState, useEffect, useRef } from "react";
import { Check, X, Edit3, FileText, ChevronLeft, ChevronRight, Download, Minus, Plus, Image as ImageIcon, Volume2, Loader2, RefreshCw, Play, Pause } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { toast } from "@/hooks/use-toast";
import { regenerateAudioSegment, recombineAudioSegments } from "@/lib/api";

interface ParsedSegment {
  index: number;
  startTime: string;
  endTime: string;
  text: string;
}

interface CaptionsPreviewModalProps {
  isOpen: boolean;
  srtContent: string;
  onConfirm: (srtContent: string) => void;
  onCancel: () => void;
  onBack?: () => void;
  onForward?: () => void;
  forwardLabel?: string;  // Label for forward button (e.g., "Video Prompts" or "Image Prompts")
  imageCount?: number;
  onImageCountChange?: (count: number) => void;
  // Pronunciation fix props
  audioUrl?: string;
  projectId?: string;
  voiceSampleUrl?: string;
  onAudioUpdated?: (newAudioUrl: string) => void;
}

// Parse SRT content into individual segments
function parseSRT(srtContent: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  const blocks = srtContent.trim().split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length >= 3) {
      const indexLine = lines[0];
      const timeLine = lines[1];
      const textLines = lines.slice(2);

      const index = parseInt(indexLine, 10);
      const timeMatch = timeLine.match(/(\d{2}:\d{2}:\d{2}[,.]?\d{0,3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]?\d{0,3})/);

      if (!isNaN(index) && timeMatch) {
        segments.push({
          index,
          startTime: timeMatch[1],
          endTime: timeMatch[2],
          text: textLines.join('\n'),
        });
      }
    }
  }

  return segments;
}

export function CaptionsPreviewModal({
  isOpen,
  srtContent,
  onConfirm,
  onCancel,
  onBack,
  onForward,
  forwardLabel = "Video Prompts",
  imageCount,
  onImageCountChange,
  audioUrl,
  projectId,
  voiceSampleUrl,
  onAudioUpdated,
}: CaptionsPreviewModalProps) {
  const [editedSrt, setEditedSrt] = useState(srtContent);
  const [isEditing, setIsEditing] = useState(false);
  const [segments, setSegments] = useState<ParsedSegment[]>([]);

  // Pronunciation fix state
  const [fixInputs, setFixInputs] = useState<Record<number, string>>({});
  const [regeneratingSegment, setRegeneratingSegment] = useState<number | null>(null);
  const [previewAudioUrls, setPreviewAudioUrls] = useState<Record<number, string>>({});
  const [playingSegment, setPlayingSegment] = useState<number | null>(null);
  const [applyingFix, setApplyingFix] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Sync state when srtContent prop changes
  useEffect(() => {
    if (srtContent) {
      setEditedSrt(srtContent);
      setSegments(parseSRT(srtContent));
    }
  }, [srtContent]);

  // Count caption entries
  const captionCount = segments.length;

  // Check if pronunciation fix feature is available
  const canFixPronunciation = !!(projectId && voiceSampleUrl);

  const handleConfirm = () => {
    onConfirm(editedSrt);
  };

  const handleDownload = () => {
    const blob = new Blob([editedSrt], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'captions.srt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Handle pronunciation fix input change
  const handleFixInputChange = (segmentIndex: number, value: string) => {
    setFixInputs(prev => ({ ...prev, [segmentIndex]: value }));
  };

  // Preview the regenerated segment with pronunciation fix
  // Format: "word → phonetic" or "word:phonetic" or just "word" (re-attempts same spelling)
  const handlePreviewFix = async (segment: ParsedSegment) => {
    const fixInput = fixInputs[segment.index]?.trim();
    if (!fixInput || !projectId || !voiceSampleUrl) return;

    // Parse input: "word → phonetic" or "word:phonetic" or just "word"
    let word: string;
    let phonetic: string;

    if (fixInput.includes('→')) {
      const parts = fixInput.split('→').map(s => s.trim());
      word = parts[0];
      phonetic = parts[1] || parts[0];
    } else if (fixInput.includes(':')) {
      const parts = fixInput.split(':').map(s => s.trim());
      word = parts[0];
      phonetic = parts[1] || parts[0];
    } else {
      // Just the word - re-attempt with same spelling
      word = fixInput;
      phonetic = fixInput;
    }

    setRegeneratingSegment(segment.index);

    try {
      const result = await regenerateAudioSegment(
        segment.text,
        segment.index,
        voiceSampleUrl,
        projectId,
        { word, phonetic }
      );

      if (result.success && result.segment?.audioUrl) {
        setPreviewAudioUrls(prev => ({
          ...prev,
          [segment.index]: result.segment!.audioUrl
        }));

        // Auto-play the preview
        if (audioRef.current) {
          audioRef.current.src = result.segment.audioUrl;
          audioRef.current.play();
          setPlayingSegment(segment.index);
        }

        toast({
          title: "Preview ready",
          description: "Listen to the regenerated segment. Click Apply to use it.",
        });
      } else {
        toast({
          title: "Regeneration failed",
          description: result.error || "Could not regenerate segment",
          variant: "destructive",
        });
      }
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to regenerate",
        variant: "destructive",
      });
    } finally {
      setRegeneratingSegment(null);
    }
  };

  // Apply the fix (recombine audio with the new segment)
  const handleApplyFix = async (segment: ParsedSegment) => {
    if (!projectId || !previewAudioUrls[segment.index]) return;

    setApplyingFix(segment.index);

    try {
      // Recombine all segments (the regenerated segment is already uploaded)
      const result = await recombineAudioSegments(projectId, captionCount);

      if (result.success && result.audioUrl) {
        // Clear the preview for this segment
        setPreviewAudioUrls(prev => {
          const newState = { ...prev };
          delete newState[segment.index];
          return newState;
        });
        setFixInputs(prev => {
          const newState = { ...prev };
          delete newState[segment.index];
          return newState;
        });

        // Notify parent of updated audio
        if (onAudioUpdated) {
          onAudioUpdated(result.audioUrl);
        }

        toast({
          title: "Fix applied",
          description: "Audio has been updated with the corrected pronunciation.",
        });
      } else {
        toast({
          title: "Apply failed",
          description: result.error || "Could not recombine audio",
          variant: "destructive",
        });
      }
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to apply fix",
        variant: "destructive",
      });
    } finally {
      setApplyingFix(null);
    }
  };

  // Play/pause preview audio
  const handlePlayPreview = (segmentIndex: number) => {
    const url = previewAudioUrls[segmentIndex];
    if (!url) return;

    if (playingSegment === segmentIndex && audioRef.current && !audioRef.current.paused) {
      audioRef.current.pause();
      setPlayingSegment(null);
    } else {
      if (audioRef.current) {
        audioRef.current.src = url;
        audioRef.current.play();
        setPlayingSegment(segmentIndex);
      }
    }
  };

  // Handle audio ended
  const handleAudioEnded = () => {
    setPlayingSegment(null);
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-2xl font-bold flex items-center gap-2">
            <FileText className="w-6 h-6 text-primary" />
            Preview Captions
            <span className="text-sm font-normal text-muted-foreground ml-2">
              {captionCount} segments
            </span>
          </DialogTitle>
          <DialogDescription>
            Review the generated SRT captions. {canFixPronunciation && "Type any mispronounced word to regenerate that segment."}
          </DialogDescription>
        </DialogHeader>

        {/* Hidden audio element for playback */}
        <audio ref={audioRef} onEnded={handleAudioEnded} className="hidden" />

        {/* Image Generation Settings */}
        {imageCount !== undefined && onImageCountChange && (
          <div className="border rounded-lg p-4 bg-muted/30">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ImageIcon className="w-4 h-4 text-primary" />
                <span className="text-sm font-medium">Number of images to generate</span>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => onImageCountChange(Math.max(1, imageCount - 1))}
                  disabled={imageCount <= 1}
                >
                  <Minus className="h-4 w-4" />
                </Button>
                <Input
                  type="number"
                  min={1}
                  max={500}
                  value={imageCount}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    if (!isNaN(val) && val >= 1 && val <= 500) {
                      onImageCountChange(val);
                    }
                  }}
                  className="w-16 h-8 text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                />
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => onImageCountChange(Math.min(500, imageCount + 1))}
                  disabled={imageCount >= 500}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        )}

        <div className="flex-1 min-h-0 py-4">
          {isEditing ? (
            <Textarea
              value={editedSrt}
              onChange={(e) => setEditedSrt(e.target.value)}
              className="h-[55vh] font-mono text-sm resize-none"
              placeholder="SRT content..."
            />
          ) : (
            <ScrollArea className="h-[55vh] rounded-lg border border-border bg-muted/30">
              <div className="p-4 space-y-4">
                {segments.map((segment) => (
                  <div
                    key={segment.index}
                    className="border rounded-lg p-3 bg-background hover:border-primary/50 transition-colors"
                  >
                    {/* Segment header */}
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-mono text-muted-foreground">
                        #{segment.index} | {segment.startTime} → {segment.endTime}
                      </span>
                    </div>

                    {/* Segment text */}
                    <p className="text-sm text-foreground mb-2 leading-relaxed">
                      {segment.text}
                    </p>

                    {/* Pronunciation fix section */}
                    {canFixPronunciation && (
                      <div className="flex items-center gap-2 pt-2 border-t border-border/50">
                        <Volume2 className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                        <Input
                          placeholder="word → phonetic (e.g. bond → bahnd)"
                          value={fixInputs[segment.index] || ''}
                          onChange={(e) => handleFixInputChange(segment.index, e.target.value)}
                          className="h-8 text-sm flex-1 max-w-[280px]"
                          disabled={regeneratingSegment === segment.index || applyingFix === segment.index}
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handlePreviewFix(segment)}
                          disabled={
                            !fixInputs[segment.index]?.trim() ||
                            regeneratingSegment === segment.index ||
                            applyingFix === segment.index
                          }
                          className="h-8"
                        >
                          {regeneratingSegment === segment.index ? (
                            <>
                              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                              Generating...
                            </>
                          ) : (
                            <>
                              <RefreshCw className="w-3 h-3 mr-1" />
                              Preview
                            </>
                          )}
                        </Button>

                        {/* Preview playback and apply buttons */}
                        {previewAudioUrls[segment.index] && (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handlePlayPreview(segment.index)}
                              className="h-8"
                            >
                              {playingSegment === segment.index ? (
                                <Pause className="w-3 h-3" />
                              ) : (
                                <Play className="w-3 h-3" />
                              )}
                            </Button>
                            <Button
                              size="sm"
                              variant="default"
                              onClick={() => handleApplyFix(segment)}
                              disabled={applyingFix === segment.index}
                              className="h-8"
                            >
                              {applyingFix === segment.index ? (
                                <>
                                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                                  Applying...
                                </>
                              ) : (
                                <>
                                  <Check className="w-3 h-3 mr-1" />
                                  Apply
                                </>
                              )}
                            </Button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </div>

        <DialogFooter className="flex-shrink-0 gap-2 sm:gap-2">
          {/* Left side: Navigation + Edit/Download */}
          <div className="flex gap-2 mr-auto">
            {onBack && (
              <Button variant="outline" size="icon" onClick={onBack} title="Back to previous step">
                <ChevronLeft className="w-5 h-5" />
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => setIsEditing(!isEditing)}
            >
              <Edit3 className="w-4 h-4 mr-2" />
              {isEditing ? "Preview" : "Edit"}
            </Button>
            <Button variant="outline" onClick={handleDownload}>
              <Download className="w-4 h-4 mr-2" />
              Download
            </Button>
          </div>

          {/* Right side: Exit + Forward/Continue */}
          <Button variant="outline" onClick={onCancel}>
            <X className="w-4 h-4 mr-2" />
            Exit
          </Button>

          {onForward ? (
            <Button onClick={onForward}>
              {forwardLabel}
              <ChevronRight className="w-4 h-4 ml-2" />
            </Button>
          ) : (
            <Button onClick={handleConfirm}>
              <Check className="w-4 h-4 mr-2" />
              Create {forwardLabel}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
