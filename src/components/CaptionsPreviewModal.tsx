import { useState, useEffect } from "react";
import { Check, X, Edit3, FileText, ChevronLeft, ChevronRight, Download, Minus, Plus, Image as ImageIcon, AlertTriangle, ChevronDown } from "lucide-react";
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

interface ParsedSegment {
  index: number;
  startTime: string;
  endTime: string;
  text: string;
}

interface QualityIssue {
  segmentIndex: number;
  chunkIndex: number;
  start: number;
  end: number;
  text: string;
  issue: 'silence' | 'low_confidence' | 'repetitive';
  value: number;
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
  topic?: string;  // Era/topic for image generation (e.g., "Regency England 1810s")
  onTopicChange?: (topic: string) => void;
  subjectFocus?: string;  // Story focus (e.g., "Charlotte and George's love story")
  onSubjectFocusChange?: (focus: string) => void;
  qualityIssues?: QualityIssue[];  // Audio quality issues from Whisper
  qualityWarning?: string;  // Summary warning message
}

// Format seconds to MM:SS
function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
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
  topic = "",
  onTopicChange,
  subjectFocus = "",
  onSubjectFocusChange,
  qualityIssues,
  qualityWarning,
}: CaptionsPreviewModalProps) {
  const [editedSrt, setEditedSrt] = useState(srtContent);
  const [isEditing, setIsEditing] = useState(false);
  const [segments, setSegments] = useState<ParsedSegment[]>([]);
  const [isQualityExpanded, setIsQualityExpanded] = useState(false);

  // Sync state when srtContent prop changes
  useEffect(() => {
    if (srtContent) {
      setEditedSrt(srtContent);
      setSegments(parseSRT(srtContent));
    }
  }, [srtContent]);

  // Count caption entries
  const captionCount = segments.length;

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
            Review the generated SRT captions.
          </DialogDescription>
        </DialogHeader>

        {/* Quality Issues Warning (collapsible) */}
        {qualityIssues && qualityIssues.length > 0 && (
          <div className="border border-amber-500/30 rounded-lg bg-amber-500/10">
            <button
              onClick={() => setIsQualityExpanded(!isQualityExpanded)}
              className="w-full flex items-center justify-between p-3 text-left hover:bg-amber-500/5 transition-colors"
            >
              <div className="flex items-center gap-2 text-amber-600">
                <AlertTriangle className="w-4 h-4" />
                <span className="text-sm font-medium">
                  {qualityWarning || `${qualityIssues.length} potential audio quality issue${qualityIssues.length > 1 ? 's' : ''}`}
                </span>
              </div>
              <ChevronDown className={`w-4 h-4 text-amber-600 transition-transform ${isQualityExpanded ? 'rotate-180' : ''}`} />
            </button>
            {isQualityExpanded && (
              <div className="px-3 pb-3 space-y-2 max-h-40 overflow-y-auto">
                {qualityIssues.map((issue, idx) => (
                  <div key={idx} className="text-xs bg-background/50 rounded p-2 flex justify-between">
                    <span className="text-muted-foreground">
                      {formatTime(issue.start)} - {issue.issue === 'silence' ? 'Possible silence/noise' :
                       issue.issue === 'low_confidence' ? 'Low confidence transcription' :
                       'Possible repetitive content'}
                    </span>
                    <span className="text-amber-600 font-mono">
                      {issue.issue === 'silence' ? `${(issue.value * 100).toFixed(0)}% noise` :
                       issue.issue === 'low_confidence' ? `conf: ${issue.value.toFixed(2)}` :
                       `ratio: ${issue.value.toFixed(1)}`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Image Generation Settings */}
        {imageCount !== undefined && onImageCountChange && (
          <div className="border rounded-lg p-4 bg-muted/30 space-y-4">
            {/* Section Header */}
            <div className="flex items-center gap-2 pb-2 border-b">
              <ImageIcon className="w-5 h-5 text-primary" />
              <span className="font-semibold">Set Image Prompt Guidelines</span>
            </div>

            {/* Image Count */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Number of images</span>
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

            {/* Era/Topic */}
            {onTopicChange && (
              <div className="space-y-1">
                <label className="text-sm font-medium">Era / Historical Period</label>
                <Input
                  value={topic}
                  onChange={(e) => onTopicChange(e.target.value)}
                  placeholder="e.g., Regency England 1810s, Georgian era, 18th century court life"
                  className="h-9"
                />
              </div>
            )}

            {/* Story Focus */}
            {onSubjectFocusChange && (
              <div className="space-y-1">
                <label className="text-sm font-medium">Story Focus</label>
                <Input
                  value={subjectFocus}
                  onChange={(e) => onSubjectFocusChange(e.target.value)}
                  placeholder="e.g., Charlotte and George's love story, royal courtship"
                  className="h-9"
                />
                <p className="text-xs text-muted-foreground">
                  Images will be topical to this story theme
                </p>
              </div>
            )}
          </div>
        )}

        <div className="flex-1 min-h-0 py-4 overflow-hidden">
          {isEditing ? (
            <Textarea
              value={editedSrt}
              onChange={(e) => setEditedSrt(e.target.value)}
              className="h-full font-mono text-sm resize-none"
              placeholder="SRT content..."
            />
          ) : (
            <ScrollArea className="h-full rounded-lg border border-border bg-muted/30">
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
                    <p className="text-sm text-foreground leading-relaxed">
                      {segment.text}
                    </p>
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
