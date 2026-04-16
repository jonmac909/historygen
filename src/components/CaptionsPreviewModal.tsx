import { useState, useEffect, useRef } from "react";
import { Check, X, Edit3, FileText, ChevronLeft, ChevronRight, Download, Minus, Plus, Image as ImageIcon, AlertTriangle, ChevronDown, CheckCircle2, RefreshCw, Play, Square, Wand2, Scissors, Search } from "lucide-react";
import { runCaptionQualityCheck, AudioSegment, scanAudioLoops, healAudioLoops, DetectedLoop } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
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
import { SegmentRegenerateModal } from "./SegmentRegenerateModal";

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
  issue: 'silence' | 'low_confidence' | 'garbled' | 'repetitive';
  value: number;
}

interface ScriptQAResult {
  score: number;
  totalScriptSentences: number;
  matchedSentences: number;
  issues: { type: string; originalText: string; transcribedText: string; severity: string; similarity?: number; segmentNumber?: number }[];
  wordIssues?: { type: string; scriptWord: string; transcribedWord: string; context: string; severity: string }[];
  needsReview: boolean;
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
  scriptQa?: ScriptQAResult;  // Script vs transcription QA results
  projectId?: string;  // For running quality checks
  onScriptQaUpdate?: (qa: ScriptQAResult) => void;  // Callback when QA check completes
  audioUrl?: string;  // Audio URL for playing segments
  // For audio regeneration
  voiceSampleUrl?: string;  // Voice sample URL for TTS regeneration
  ttsSettings?: { temperature?: number; topP?: number; repetitionPenalty?: number };
  audioSegments?: AudioSegment[];  // Audio segments with durations for time range calculation
  onSegmentRegenerated?: (segmentNumber: number, newAudioUrl: string, newText: string, duration: number) => void;
  // Called after audio is healed so the parent can update audioUrl/duration
  onAudioHealed?: (newAudioUrl: string, newDuration: number) => void;
  // Called after Scan Script Match so the parent can persist needsReview
  // flags on the affected audio_segments rows. Map is keyed by segment index.
  onSegmentsNeedReview?: (updates: Record<number, { issues: { type: string; severity: string; originalText?: string; transcribedText?: string; similarity?: number }[] } | null>) => void;
}

// Format seconds to MM:SS
function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Convert SRT timestamp (00:00:05,123) to seconds
function srtTimeToSeconds(srtTime: string): number {
  const match = srtTime.match(/(\d{2}):(\d{2}):(\d{2})[,.]?(\d{0,3})/);
  if (!match) return 0;
  const [, hours, minutes, seconds, ms] = match;
  return parseInt(hours) * 3600 + parseInt(minutes) * 60 + parseInt(seconds) + (parseInt(ms || '0') / 1000);
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
  scriptQa,
  projectId,
  onScriptQaUpdate,
  audioUrl,
  voiceSampleUrl,
  ttsSettings,
  audioSegments,
  onSegmentRegenerated,
  onAudioHealed,
  onSegmentsNeedReview,
}: CaptionsPreviewModalProps) {
  const { toast } = useToast();
  const [editedSrt, setEditedSrt] = useState(srtContent);
  const [isEditing, setIsEditing] = useState(false);
  const [expandedIssueIdx, setExpandedIssueIdx] = useState<number | null>(null);
  const [playingSegment, setPlayingSegment] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [segments, setSegments] = useState<ParsedSegment[]>([]);
  const [isQualityExpanded, setIsQualityExpanded] = useState(false);
  const [isScriptQaExpanded, setIsScriptQaExpanded] = useState(false);
  const [isCheckingQuality, setIsCheckingQuality] = useState(false);

  // Loop scan + heal state (replaces the old script-vs-transcription QA flow
  // that used to run on this button). `detectedLoops=null` means no scan has
  // run yet; `[]` means scan ran and found nothing (show "no loops" message).
  const [detectedLoops, setDetectedLoops] = useState<DetectedLoop[] | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isHealing, setIsHealing] = useState(false);

  // Regeneration modal state
  const [regenModalOpen, setRegenModalOpen] = useState(false);
  const [regenSegmentData, setRegenSegmentData] = useState<{
    segmentNumber: number;
    text: string;
    startTime?: number;
    endTime?: number;
  } | null>(null);

  // Calculate time range for an audio segment based on cumulative durations
  const getAudioSegmentTimeRange = (segmentNumber: number): { startTime: number; endTime: number } | null => {
    if (!audioSegments || audioSegments.length === 0) return null;

    // Sort segments by index
    const sortedSegments = [...audioSegments].sort((a, b) => a.index - b.index);

    let cumulativeTime = 0;
    for (const seg of sortedSegments) {
      if (seg.index === segmentNumber) {
        return {
          startTime: cumulativeTime,
          endTime: cumulativeTime + seg.duration,
        };
      }
      cumulativeTime += seg.duration;
    }
    return null;
  };

  // Open regeneration modal for a specific issue
  const openRegenModal = (issue: { segmentNumber?: number; originalText: string }) => {
    if (!issue.segmentNumber) {
      toast({ title: "Cannot regenerate", description: "No segment number available", variant: "destructive" });
      return;
    }

    const timeRange = getAudioSegmentTimeRange(issue.segmentNumber);
    setRegenSegmentData({
      segmentNumber: issue.segmentNumber,
      text: issue.originalText,
      startTime: timeRange?.startTime,
      endTime: timeRange?.endTime,
    });
    setRegenModalOpen(true);
  };

  // Handle accepted regeneration
  const handleRegenAccept = (segmentNumber: number, newAudioUrl: string, newText: string, duration: number) => {
    // Notify parent that segment was regenerated
    onSegmentRegenerated?.(segmentNumber, newAudioUrl, newText, duration);

    // Remove this issue from the QA list (optimistic update)
    if (scriptQa && onScriptQaUpdate) {
      const updatedIssues = scriptQa.issues.filter(i => i.segmentNumber !== segmentNumber);
      onScriptQaUpdate({
        ...scriptQa,
        issues: updatedIssues,
        // Recalculate needsReview based on remaining issues
        needsReview: updatedIssues.length > 0 || (scriptQa.wordIssues && scriptQa.wordIssues.length > 3),
      });
    }

    toast({ title: "Segment regenerated", description: `Audio segment ${segmentNumber} has been updated` });
    setRegenModalOpen(false);
  };

  // Scan the SRT for back-to-back repeated sentences (TTS loop hallucinations).
  // No API calls to RunPod — just text processing on the server. Results shown
  // inline so the user can review before healing.
  const handleScanLoops = async () => {
    if (!projectId || !editedSrt) {
      toast({ title: "Cannot scan", description: "Missing project ID or captions", variant: "destructive" });
      return;
    }
    setIsScanning(true);
    setDetectedLoops(null);
    try {
      const result = await scanAudioLoops(projectId, editedSrt);
      if (!result.success) {
        toast({ title: "Scan failed", description: result.error, variant: "destructive" });
        return;
      }
      const loops = result.loops || [];
      setDetectedLoops(loops);
      if (loops.length === 0) {
        toast({ title: "No loops found", description: "Captions look clean — no repeated sentences detected." });
      } else {
        toast({
          title: `${loops.length} loop${loops.length > 1 ? 's' : ''} detected`,
          description: "Review below, then click Self-Heal to remove them.",
        });
      }
    } catch (error) {
      toast({
        title: "Scan failed",
        description: error instanceof Error ? error.message : "Network error",
        variant: "destructive",
      });
    } finally {
      setIsScanning(false);
    }
  };

  // Cut the detected loop ranges out of the full audio via FFmpeg. Uploads
  // the healed voiceover.wav and updates the parent's audio URL + duration.
  const handleSelfHeal = async () => {
    if (!projectId || !detectedLoops || detectedLoops.length === 0) return;
    setIsHealing(true);
    try {
      const result = await healAudioLoops(
        projectId,
        detectedLoops.map(l => ({ start: l.start, end: l.end, text: l.text })),
      );
      if (!result.success) {
        toast({ title: "Heal failed", description: result.error, variant: "destructive" });
        return;
      }
      toast({
        title: `Healed ${result.cutsMade} loop${(result.cutsMade ?? 0) > 1 ? 's' : ''}`,
        description: `Removed ${result.totalRemovedSec?.toFixed(1)}s of repeated audio`,
      });
      if (result.audioUrl && result.duration !== undefined) {
        onAudioHealed?.(result.audioUrl, result.duration);
      }
      // Clear the loop list — audio no longer contains them.
      setDetectedLoops([]);
    } catch (error) {
      toast({
        title: "Heal failed",
        description: error instanceof Error ? error.message : "Network error",
        variant: "destructive",
      });
    } finally {
      setIsHealing(false);
    }
  };

  // Run quality check
  const handleQualityCheck = async () => {
    if (!projectId || !editedSrt) {
      toast({
        title: "Cannot check quality",
        description: "Missing project ID or captions",
        variant: "destructive",
      });
      return;
    }

    setIsCheckingQuality(true);
    try {
      const result = await runCaptionQualityCheck(projectId, editedSrt);
      if (result.success && result.scriptQa) {
        onScriptQaUpdate?.(result.scriptQa);
        const qa = result.scriptQa;

        // Mark each flagged segment with a needsReview tag so the Audio
        // Segments list can show an orange "Needs Review" pill. Segments
        // without issues get null so any prior flag clears on re-scan.
        if (onSegmentsNeedReview && audioSegments && audioSegments.length > 0) {
          const updates: Record<number, { issues: { type: string; severity: string; originalText?: string; transcribedText?: string; similarity?: number }[] } | null> = {};
          for (const seg of audioSegments) updates[seg.index] = null;
          for (const issue of qa.issues) {
            if (!issue.segmentNumber) continue;
            if (!updates[issue.segmentNumber] || updates[issue.segmentNumber] === null) {
              updates[issue.segmentNumber] = { issues: [] };
            }
            updates[issue.segmentNumber]!.issues.push({
              type: issue.type,
              severity: issue.severity,
              originalText: issue.originalText,
              transcribedText: issue.transcribedText,
              similarity: issue.similarity,
            });
          }
          onSegmentsNeedReview(updates);
        }

        if (qa.needsReview) {
          toast({
            title: `Script match: ${qa.score}%`,
            description: `${qa.issues.length} issues found - flagged segments show an orange "Needs Review" pill`,
            variant: "destructive",
          });
        } else {
          toast({
            title: `Script match: ${qa.score}%`,
            description: "Audio matches script well!",
          });
        }
      } else {
        toast({
          title: "Quality check failed",
          description: result.error || "Unknown error",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error('Quality check failed:', error);
      toast({
        title: "Quality check failed",
        description: error instanceof Error ? error.message : "Network error",
        variant: "destructive",
      });
    } finally {
      setIsCheckingQuality(false);
    }
  };

  // Play audio for a specific segment
  const playSegment = (segmentNumber: number) => {
    if (!audioUrl) {
      toast({ title: "No audio available", variant: "destructive" });
      return;
    }

    // Find the segment in parsed SRT
    const segment = segments.find(s => s.index === segmentNumber);
    if (!segment) {
      toast({ title: "Segment not found", variant: "destructive" });
      return;
    }

    const startTime = srtTimeToSeconds(segment.startTime);
    const endTime = srtTimeToSeconds(segment.endTime);

    // Stop current playback if any
    if (audioRef.current) {
      audioRef.current.pause();
    }

    // Create or reuse audio element
    if (!audioRef.current) {
      audioRef.current = new Audio(audioUrl);
    } else if (audioRef.current.src !== audioUrl) {
      audioRef.current.src = audioUrl;
    }

    const audio = audioRef.current;
    audio.currentTime = startTime;
    setPlayingSegment(segmentNumber);

    // Stop at end time
    const handleTimeUpdate = () => {
      if (audio.currentTime >= endTime) {
        audio.pause();
        setPlayingSegment(null);
        audio.removeEventListener('timeupdate', handleTimeUpdate);
      }
    };

    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('ended', () => setPlayingSegment(null), { once: true });
    audio.play().catch(err => {
      console.error('Audio play failed:', err);
      setPlayingSegment(null);
    });
  };

  // Stop audio playback
  const stopPlayback = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      setPlayingSegment(null);
    }
  };

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
  <>
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

        {/* Audio Quality Status - Only show if issues found */}
        {qualityIssues && qualityIssues.length > 0 && (
          <div className="border border-amber-500/30 rounded-lg bg-amber-500/10">
            <div className="flex items-center justify-between p-3">
              <button
                onClick={() => setIsQualityExpanded(!isQualityExpanded)}
                className="flex-1 flex items-center justify-between text-left hover:bg-amber-500/5 transition-colors"
              >
                <div className="flex items-center gap-2 text-amber-600">
                  <AlertTriangle className="w-4 h-4" />
                  <span className="text-sm font-medium">
                    {qualityWarning || `${qualityIssues.length} potential audio quality issue${qualityIssues.length > 1 ? 's' : ''}`}
                  </span>
                </div>
                <ChevronDown className={`w-4 h-4 text-amber-600 transition-transform ${isQualityExpanded ? 'rotate-180' : ''}`} />
              </button>
              {projectId && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleQualityCheck}
                  disabled={isCheckingQuality}
                  className="h-7 text-xs ml-2"
                >
                  <RefreshCw className={`w-3 h-3 mr-1 ${isCheckingQuality ? 'animate-spin' : ''}`} />
                  {isCheckingQuality ? 'Checking...' : 'Re-check'}
                </Button>
              )}
            </div>
            {isQualityExpanded && (
              <div className="px-3 pb-3 space-y-2 max-h-40 overflow-y-auto">
                {qualityIssues.map((issue, idx) => (
                  <div key={idx} className="text-xs bg-background/50 rounded p-2 flex justify-between">
                    <span className="text-muted-foreground">
                      {formatTime(issue.start)} - {issue.issue === 'silence' ? 'Possible silence/noise' :
                       issue.issue === 'garbled' || issue.issue === 'low_confidence' ? 'Garbled audio detected' :
                       'Possible repetitive content'}
                    </span>
                    <span className="text-amber-600 font-mono">
                      {issue.issue === 'silence' ? `${(issue.value * 100).toFixed(0)}% noise` :
                       issue.issue === 'garbled' || issue.issue === 'low_confidence' ? `quality: ${Math.abs(issue.value).toFixed(1)}` :
                       `ratio: ${issue.value.toFixed(1)}`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Loop scan + self-heal controls (replaces old Quality Check).
            Scan runs text-only detection on the SRT for repeated sentences;
            Self-Heal appears after scan if loops were found and cuts them
            from the audio via FFmpeg. Scan Script Match is a separate,
            manual-only check for garbled content / regen mess-ups — compares
            the SRT (Whisper output) against the original script text. */}
        {captionCount > 0 && projectId && (
          <div className="space-y-2">
            <div className="flex justify-end gap-2 flex-wrap">
              <Button
                size="sm"
                variant="outline"
                onClick={handleScanLoops}
                disabled={isScanning || isHealing || isCheckingQuality}
                className="h-7 text-xs"
              >
                <Search className={`w-3 h-3 mr-1 ${isScanning ? 'animate-pulse' : ''}`} />
                {isScanning ? 'Scanning...' : 'Scan for Loops'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={handleQualityCheck}
                disabled={isScanning || isHealing || isCheckingQuality}
                className="h-7 text-xs"
                title="Compare Whisper transcription against the original script — catches garbled audio, missing sentences, or regen mess-ups"
              >
                <FileText className={`w-3 h-3 mr-1 ${isCheckingQuality ? 'animate-pulse' : ''}`} />
                {isCheckingQuality ? 'Checking...' : 'Scan Script Match'}
              </Button>
              {detectedLoops && detectedLoops.length > 0 && (
                <Button
                  size="sm"
                  onClick={handleSelfHeal}
                  disabled={isScanning || isHealing}
                  className="h-7 text-xs bg-blue-600 hover:bg-blue-700 text-white"
                >
                  <Scissors className={`w-3 h-3 mr-1 ${isHealing ? 'animate-pulse' : ''}`} />
                  {isHealing ? 'Healing...' : `Self-Heal (${detectedLoops.length})`}
                </Button>
              )}
            </div>

            {/* Scan results list */}
            {detectedLoops && detectedLoops.length > 0 && (
              <div className="border border-blue-200 bg-blue-50 rounded-lg p-3 space-y-2">
                <div className="flex items-center gap-2 text-blue-700 text-sm font-medium">
                  <AlertTriangle className="w-4 h-4" />
                  {detectedLoops.length} repeated sentence{detectedLoops.length > 1 ? 's' : ''} detected
                  <span className="text-xs text-blue-500 font-normal">
                    ({detectedLoops.reduce((s, l) => s + l.durationSec, 0).toFixed(1)}s total)
                  </span>
                </div>
                <div className="max-h-48 overflow-y-auto space-y-1">
                  {detectedLoops.map((loop, i) => (
                    <div key={i} className="text-xs bg-white rounded px-2 py-1.5 flex gap-2">
                      <span className="font-mono text-blue-500 flex-shrink-0">
                        {formatTime(loop.start)}–{formatTime(loop.end)}
                      </span>
                      <span className="text-blue-800 italic truncate">"{loop.text}"</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Clean-scan message */}
            {detectedLoops && detectedLoops.length === 0 && !isScanning && (
              <div className="border border-green-200 bg-green-50 rounded-lg p-2 flex items-center gap-2 text-sm text-green-700">
                <CheckCircle2 className="w-4 h-4" />
                No repeated sentences detected.
              </div>
            )}
          </div>
        )}

        {/* Script QA: Compare TTS audio to original script - Compact Accordion */}
        {scriptQa && (
          scriptQa.needsReview ? (
            // Warning when score is low - compact accordion format
            <div className={`border rounded-lg ${scriptQa.score < 85 ? 'border-red-500/30 bg-red-500/10' : 'border-amber-500/30 bg-amber-500/10'}`}>
              <button
                onClick={() => setIsScriptQaExpanded(!isScriptQaExpanded)}
                className="w-full flex items-center justify-between p-3 text-left hover:bg-black/5 transition-colors"
              >
                <div className={`flex items-center gap-2 ${scriptQa.score < 85 ? 'text-red-600' : 'text-amber-600'}`}>
                  <AlertTriangle className="w-4 h-4" />
                  <span className="text-sm font-medium">
                    Script match: {scriptQa.score}% - {scriptQa.issues.length} issue{scriptQa.issues.length !== 1 ? 's' : ''}
                  </span>
                </div>
                <ChevronDown className={`w-4 h-4 transition-transform ${isScriptQaExpanded ? 'rotate-180' : ''}`} />
              </button>
              {isScriptQaExpanded && scriptQa.issues.length > 0 && (
                <div className="px-3 pb-3 space-y-1 max-h-64 overflow-y-auto">
                  {scriptQa.issues.map((issue, idx) => {
                    const isExpanded = expandedIssueIdx === idx;
                    const segNum = issue.segmentNumber;
                    const isPlaying = playingSegment === segNum;

                    return (
                      <div key={idx} className="border-b border-amber-500/20 last:border-0">
                        {/* Collapsed row - clickable to expand */}
                        <button
                          onClick={() => setExpandedIssueIdx(isExpanded ? null : idx)}
                          className="w-full text-left text-xs py-1.5 hover:bg-black/5 flex items-center gap-1"
                        >
                          <ChevronDown className={`w-3 h-3 flex-shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                          <span className={`font-medium ${issue.severity === 'error' ? 'text-red-600' : 'text-amber-600'}`}>
                            {segNum ? `Seg ${segNum}` : `#${idx + 1}`}:
                          </span>
                          {' '}
                          {!isExpanded && (
                            <>
                              {issue.originalText && (
                                <span className="text-green-600 truncate">"{issue.originalText.slice(0, 60)}{issue.originalText.length > 60 ? '...' : ''}"</span>
                              )}
                              {issue.originalText && issue.transcribedText && <span className="flex-shrink-0"> vs </span>}
                              {issue.transcribedText && (
                                <span className="text-red-500 truncate">"{issue.transcribedText.slice(0, 60)}{issue.transcribedText.length > 60 ? '...' : ''}"</span>
                              )}
                              {!issue.transcribedText && issue.type === 'missing' && (
                                <span className="text-red-500 italic">(missing)</span>
                              )}
                            </>
                          )}
                        </button>

                        {/* Expanded content */}
                        {isExpanded && (
                          <div className="pl-5 pb-2 space-y-2">
                            {/* Full script text */}
                            {issue.originalText && (
                              <div>
                                <span className="text-[10px] text-muted-foreground uppercase">Script:</span>
                                <p className="text-xs text-green-600 bg-green-50 p-1.5 rounded mt-0.5">"{issue.originalText}"</p>
                              </div>
                            )}
                            {/* Full transcribed text */}
                            {issue.transcribedText && (
                              <div>
                                <span className="text-[10px] text-muted-foreground uppercase">Heard:</span>
                                <p className="text-xs text-red-500 bg-red-50 p-1.5 rounded mt-0.5">"{issue.transcribedText}"</p>
                              </div>
                            )}
                            {!issue.transcribedText && issue.type === 'missing' && (
                              <p className="text-xs text-red-500 italic">(This text was not found in the audio)</p>
                            )}
                            {/* Action buttons */}
                            <div className="flex flex-wrap gap-2 mt-1">
                              {/* Play button */}
                              {audioUrl && segNum && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (isPlaying) {
                                      stopPlayback();
                                    } else {
                                      playSegment(segNum);
                                    }
                                  }}
                                  className={`flex items-center gap-1 text-xs px-2 py-1 rounded ${
                                    isPlaying
                                      ? 'bg-blue-500 text-white'
                                      : 'bg-blue-100 text-blue-700 hover:bg-blue-200'
                                  }`}
                                >
                                  {isPlaying ? <Square className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                                  {isPlaying ? 'Stop' : 'Play'}
                                </button>
                              )}

                              {/* Regenerate button - only show if we have voiceSampleUrl and segmentNumber */}
                              {voiceSampleUrl && issue.segmentNumber && projectId && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openRegenModal(issue);
                                  }}
                                  className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-amber-100 text-amber-700 hover:bg-amber-200"
                                >
                                  <Wand2 className="w-3 h-3" />
                                  Regenerate
                                </button>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* Word-level issues - compact badges */}
                  {scriptQa.wordIssues && scriptQa.wordIssues.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-2 mt-2 border-t border-amber-500/20">
                      {scriptQa.wordIssues.slice(0, 15).map((wi, idx) => (
                        <span key={idx} className={`text-xs px-1.5 py-0.5 rounded ${
                          wi.type === 'wrong_word' ? 'bg-red-100 text-red-700' :
                          wi.type === 'missing_word' ? 'bg-amber-100 text-amber-700' :
                          wi.type === 'clipped_word' ? 'bg-orange-100 text-orange-700' :
                          'bg-blue-100 text-blue-700'
                        }`}>
                          {wi.type === 'wrong_word' && `"${wi.scriptWord}"→"${wi.transcribedWord}"`}
                          {wi.type === 'missing_word' && `missing:"${wi.scriptWord}"`}
                          {wi.type === 'clipped_word' && `clipped:"${wi.transcribedWord}"`}
                          {wi.type === 'extra_word' && `extra:"${wi.transcribedWord}"`}
                        </span>
                      ))}
                      {scriptQa.wordIssues.length > 15 && (
                        <span className="text-xs text-muted-foreground">+{scriptQa.wordIssues.length - 15} more</span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            // Success when script matches well
            <div className="border border-green-500/30 rounded-lg bg-green-500/10 p-3">
              <div className="flex items-center gap-2 text-green-600">
                <CheckCircle2 className="w-4 h-4" />
                <span className="text-sm font-medium">
                  Script match: {scriptQa.score}% ({scriptQa.matchedSentences}/{scriptQa.totalScriptSentences} sentences)
                </span>
              </div>
            </div>
          )
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

    {/* Segment Regeneration Modal */}
    {regenSegmentData && projectId && (
      <SegmentRegenerateModal
        isOpen={regenModalOpen}
        onClose={() => {
          setRegenModalOpen(false);
          setRegenSegmentData(null);
        }}
        segmentNumber={regenSegmentData.segmentNumber}
        originalText={regenSegmentData.text}
        combinedAudioUrl={audioUrl}
        segmentStartTime={regenSegmentData.startTime}
        segmentEndTime={regenSegmentData.endTime}
        projectId={projectId}
        voiceSampleUrl={voiceSampleUrl}
        ttsSettings={ttsSettings}
        onAccept={handleRegenAccept}
      />
    )}
  </>
  );
}
