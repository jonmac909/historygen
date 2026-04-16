import { useState, useRef, useEffect, useMemo } from "react";
import { Check, X, Play, Pause, RefreshCw, Volume2, Loader2, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Download, BookOpen, Square, AlertTriangle } from "lucide-react";
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
import { AudioSegment, regenerateAudioSegment, recombineAudioSegments, lookupPhonetic, previewWordPronunciation } from "@/lib/api";
import { PronunciationModal } from "./PronunciationModal";
import { toast } from "@/hooks/use-toast";

interface TTSSettings {
  temperature?: number;
  topP?: number;
  repetitionPenalty?: number;
}

// Issues from QA check that map to specific audio segments
export interface SegmentIssue {
  segmentIndex: number;  // 1-based segment number from SRT
  type: 'missing' | 'garbled' | 'extra' | 'mismatch';
  originalText: string;  // What the script says
  transcribedText: string;  // What was heard
  severity: 'warning' | 'error';
}

interface AudioSegmentsPreviewModalProps {
  isOpen: boolean;
  segments: AudioSegment[];
  combinedAudioUrl?: string;
  totalDuration?: number;
  onConfirmAll: () => void;
  onRegenerate: (segmentIndex: number, editedText?: string) => Promise<void>;
  onCancel: () => void;
  onBack?: () => void;
  onForward?: () => void;
  regeneratingIndex: number | null;
  // For pronunciation fixes
  projectId?: string;
  voiceSampleUrl?: string;
  ttsSettings?: TTSSettings;  // Same TTS settings used for original audio
  onAudioUpdated?: (newUrl: string) => void;
  // For stale audio detection
  segmentsNeedRecombine?: boolean;
  onRecombineAudio?: () => Promise<void>;
  // QA issues from captions quality check
  segmentIssues?: SegmentIssue[];
}

interface AudioSegmentCardProps {
  segment: AudioSegment;
  isRegenerating: boolean;
  onRegenerate: (editedText?: string) => void;
  editedText: string;
  onTextChange: (text: string) => void;
  // Pronunciation fix props
  projectId?: string;
  voiceSampleUrl?: string;
  ttsSettings?: TTSSettings;  // Same TTS settings used for original audio
  segmentCount: number;
  onAudioUpdated?: (newUrl: string) => void;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function AudioSegmentCard({ segment, isRegenerating, onRegenerate, editedText, onTextChange, projectId, voiceSampleUrl, ttsSettings, segmentCount, onAudioUpdated }: AudioSegmentCardProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isExpanded, setIsExpanded] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  // Pronunciation fix state
  const [wordInput, setWordInput] = useState('');
  const [phoneticInput, setPhoneticInput] = useState('');
  const [lookingUpPhonetic, setLookingUpPhonetic] = useState(false);
  // Word-only preview (just hear the word)
  const [wordPreviewUrl, setWordPreviewUrl] = useState<string | null>(null);
  const [generatingWordPreview, setGeneratingWordPreview] = useState(false);
  const [isWordPreviewPlaying, setIsWordPreviewPlaying] = useState(false);
  const wordPreviewAudioRef = useRef<HTMLAudioElement>(null);
  // Segment regeneration preview
  const [segmentPreviewUrl, setSegmentPreviewUrl] = useState<string | null>(null);
  const [regeneratingSegment, setRegeneratingSegment] = useState(false);
  const [isSegmentPreviewPlaying, setIsSegmentPreviewPlaying] = useState(false);
  const segmentPreviewAudioRef = useRef<HTMLAudioElement>(null);
  // Apply state
  const [applyingFix, setApplyingFix] = useState(false);
  const lookupTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const canFixPronunciation = !!projectId && !!voiceSampleUrl;
  const hasTextChanged = editedText !== segment.text;

  // Reset when segment URL changes (after regeneration)
  useEffect(() => {
    setIsPlaying(false);
    setCurrentTime(0);
    setIsLoading(true);
  }, [segment.audioUrl]);

  const togglePlay = () => {
    if (!audioRef.current) return;

    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play()
        .then(() => setIsPlaying(true))
        .catch((err) => console.error('Failed to play:', err));
    }
  };

  const togglePlaybackRate = () => {
    const newRate = playbackRate === 1 ? 2 : 1;
    setPlaybackRate(newRate);
    if (audioRef.current) {
      audioRef.current.playbackRate = newRate;
    }
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
    }
  };

  const handleCanPlay = () => {
    setIsLoading(false);
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
  };

  const handleEnded = () => {
    setIsPlaying(false);
    setCurrentTime(0);
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (audioRef.current) {
      const newTime = parseFloat(e.target.value);
      audioRef.current.currentTime = newTime;
      setCurrentTime(newTime);
    }
  };

  const handleRegenerate = () => {
    onRegenerate(hasTextChanged ? editedText : undefined);
  };

  // Pronunciation fix handlers
  const handleWordInputChange = async (value: string) => {
    setWordInput(value);

    // Clear any pending lookup timeout
    if (lookupTimeoutRef.current) {
      clearTimeout(lookupTimeoutRef.current);
    }

    // If empty, clear phonetic too
    if (!value.trim()) {
      setPhoneticInput('');
      return;
    }

    // Debounce the phonetic lookup (300ms)
    lookupTimeoutRef.current = setTimeout(async () => {
      setLookingUpPhonetic(true);
      try {
        const result = await lookupPhonetic(value.trim());
        setPhoneticInput(result.phonetic);
      } catch {
        setPhoneticInput(value.trim());
      } finally {
        setLookingUpPhonetic(false);
      }
    }, 300);
  };

  // 1. Hear Word - Generate the sentence with the word pronounced phonetically
  const handleHearWord = async () => {
    const word = wordInput.trim();
    const phonetic = phoneticInput.trim() || word;
    if (!word || !voiceSampleUrl) return;

    // Use the current segment text as context for natural voice cloning
    const sentenceContext = editedText || segment.text;

    setGeneratingWordPreview(true);
    try {
      const result = await previewWordPronunciation(word, phonetic, voiceSampleUrl, sentenceContext, ttsSettings);

      if (result.success && result.audioUrl) {
        setWordPreviewUrl(result.audioUrl);
        // Auto-play
        setTimeout(() => {
          if (wordPreviewAudioRef.current) {
            wordPreviewAudioRef.current.play()
              .then(() => setIsWordPreviewPlaying(true))
              .catch(console.error);
          }
        }, 100);
      } else {
        toast({
          title: "Preview failed",
          description: result.error || "Could not generate word preview",
          variant: "destructive",
        });
      }
    } catch (error) {
      toast({
        title: "Preview failed",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setGeneratingWordPreview(false);
    }
  };

  const toggleWordPreviewPlay = () => {
    if (!wordPreviewAudioRef.current || !wordPreviewUrl) return;

    if (isWordPreviewPlaying) {
      wordPreviewAudioRef.current.pause();
      setIsWordPreviewPlaying(false);
    } else {
      wordPreviewAudioRef.current.play()
        .then(() => setIsWordPreviewPlaying(true))
        .catch(console.error);
    }
  };

  // 2. Regen Segment - Regenerate the full segment with the fix
  const handleRegenSegmentWithFix = async () => {
    const word = wordInput.trim();
    const phonetic = phoneticInput.trim() || word;
    if (!word || !projectId || !voiceSampleUrl) return;

    setRegeneratingSegment(true);
    try {
      const result = await regenerateAudioSegment(
        editedText,
        segment.index,
        voiceSampleUrl,
        projectId,
        { word, phonetic },
        ttsSettings  // Pass same TTS settings as original audio
      );

      if (result.success && result.segment?.audioUrl) {
        setSegmentPreviewUrl(result.segment.audioUrl);
        toast({
          title: "Segment ready",
          description: "Listen to the regenerated segment, then Apply to use it",
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
        title: "Regeneration failed",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setRegeneratingSegment(false);
    }
  };

  const toggleSegmentPreviewPlay = () => {
    if (!segmentPreviewAudioRef.current || !segmentPreviewUrl) return;

    if (isSegmentPreviewPlaying) {
      segmentPreviewAudioRef.current.pause();
      setIsSegmentPreviewPlaying(false);
    } else {
      segmentPreviewAudioRef.current.play()
        .then(() => setIsSegmentPreviewPlaying(true))
        .catch(console.error);
    }
  };

  // 3. Apply - Splice the regenerated segment into the full audio
  const handleApplyFix = async () => {
    if (!projectId || !segmentPreviewUrl) return;

    setApplyingFix(true);
    try {
      const result = await recombineAudioSegments(projectId, segmentCount);

      if (result.success && result.audioUrl) {
        // Clear the fix state
        setWordInput('');
        setPhoneticInput('');
        setWordPreviewUrl(null);
        setSegmentPreviewUrl(null);

        // Notify parent of updated audio
        if (onAudioUpdated) {
          onAudioUpdated(result.audioUrl);
        }

        toast({
          title: "Fix applied",
          description: "Audio has been updated with the pronunciation fix",
        });
      } else {
        toast({
          title: "Apply failed",
          description: result.error || "Could not apply fix",
          variant: "destructive",
        });
      }
    } catch (error) {
      toast({
        title: "Apply failed",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setApplyingFix(false);
    }
  };

  return (
    <div className="border rounded-lg p-4 space-y-3 bg-card">
      <audio
        key={segment.audioUrl}
        ref={audioRef}
        src={segment.audioUrl}
        preload="auto"
        onTimeUpdate={handleTimeUpdate}
        onCanPlay={handleCanPlay}
        onEnded={handleEnded}
        onError={() => setIsLoading(false)}
      />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-lg">Segment {segment.index}</span>
          {segment.heal && segment.heal.ranges.length > 0 && (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-50 border border-blue-200 text-blue-700 text-xs font-medium"
              title={`Auto-healed ${segment.heal.ranges.length} loop${segment.heal.ranges.length > 1 ? 's' : ''} (${segment.heal.totalRemovedSec.toFixed(1)}s removed)`}
            >
              <RefreshCw className="w-3 h-3" />
              Healed × {segment.heal.ranges.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={handleRegenerate}
            disabled={isRegenerating}
            className="h-8 px-2"
          >
            <RefreshCw className={`w-4 h-4 ${isRegenerating ? 'animate-spin' : ''}`} />
            <span className="ml-1 text-sm">
              {isRegenerating ? 'Regenerating...' : hasTextChanged ? 'Regenerate (edited)' : 'Regenerate'}
            </span>
          </Button>
        </div>
      </div>

      {/* Heal details — show which sentences were cut so user can verify */}
      {segment.heal && segment.heal.ranges.length > 0 && (
        <div className="text-xs bg-blue-50 border border-blue-200 rounded-md p-2 space-y-1">
          <div className="font-medium text-blue-800">
            Auto-healed: removed {segment.heal.totalRemovedSec.toFixed(1)}s of repeated audio
          </div>
          {segment.heal.ranges.map((r, i) => (
            <div key={i} className="text-blue-700 pl-2">
              <span className="font-mono text-blue-500">
                {formatTime(r.startSec)}–{formatTime(r.endSec)}
              </span>
              {' → '}
              <span className="italic">"{r.text}"</span>
            </div>
          ))}
        </div>
      )}

      {/* Audio Player */}
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          className="w-10 h-10 rounded-full p-0 flex-shrink-0"
          onClick={togglePlay}
          disabled={isLoading || isRegenerating}
        >
          {isLoading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : isPlaying ? (
            <Pause className="w-4 h-4" />
          ) : (
            <Play className="w-4 h-4 ml-0.5" />
          )}
        </Button>

        {/* Progress Bar */}
        <div className="flex-1 space-y-1">
          <div className="relative h-2 w-full rounded-full bg-secondary overflow-hidden">
            <div
              className="absolute h-full bg-primary rounded-full transition-all"
              style={{ width: `${segment.duration ? (currentTime / segment.duration) * 100 : 0}%` }}
            />
            <input
              type="range"
              min={0}
              max={segment.duration || 100}
              step={0.1}
              value={currentTime}
              onChange={handleSeek}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
          </div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(segment.duration)}</span>
          </div>
        </div>

        {/* 2x Speed Button */}
        <Button
          size="sm"
          variant={playbackRate === 2 ? "default" : "outline"}
          className="h-8 px-2 text-xs flex-shrink-0"
          onClick={togglePlaybackRate}
        >
          {playbackRate}x
        </Button>
      </div>

      {/* Expandable Script Text */}
      <div className="border rounded-md bg-muted/30">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="w-full flex items-center justify-between p-2 text-sm text-muted-foreground hover:bg-muted/50 transition-colors"
        >
          <span className="font-medium">Script Text {hasTextChanged && <span className="text-yellow-500">(edited)</span>}</span>
          {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>

        {isExpanded ? (
          <div className="p-2 pt-0">
            <textarea
              value={editedText}
              onChange={(e) => onTextChange(e.target.value)}
              className="w-full min-h-[120px] p-2 text-sm bg-background border rounded resize-y"
              placeholder="Edit the script text for this segment..."
            />
            {hasTextChanged && (
              <p className="text-xs text-yellow-500 mt-1">
                Text has been modified. Click "Regenerate (edited)" to create new audio.
              </p>
            )}
          </div>
        ) : (
          <p className="px-2 pb-2 text-sm text-muted-foreground line-clamp-2 italic">
            "{editedText.substring(0, 150)}{editedText.length > 150 ? '...' : ''}"
          </p>
        )}
      </div>

      {/* Segment Info */}
      <div className="flex gap-4 text-xs text-muted-foreground">
        <span>Duration: {formatTime(segment.duration)}</span>
        <span>Size: {formatSize(segment.size)}</span>
      </div>

      {/* Pronunciation Fix Section */}
      {canFixPronunciation && (
        <div className="border-t pt-3 mt-3 space-y-2">
          {/* Hidden audio elements */}
          {wordPreviewUrl && (
            <audio
              ref={wordPreviewAudioRef}
              src={wordPreviewUrl}
              onEnded={() => setIsWordPreviewPlaying(false)}
            />
          )}
          {segmentPreviewUrl && (
            <audio
              ref={segmentPreviewAudioRef}
              src={segmentPreviewUrl}
              onEnded={() => setIsSegmentPreviewPlaying(false)}
            />
          )}

          {/* Row 1: Word/Phonetic inputs + Hear Word button */}
          <div className="flex items-center gap-2 flex-wrap">
            <Volume2 className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            <span className="text-xs text-muted-foreground flex-shrink-0">Fix:</span>
            <div className="flex items-center gap-1">
              <Input
                placeholder="word"
                value={wordInput}
                onChange={(e) => handleWordInputChange(e.target.value)}
                className="h-7 text-sm w-24"
                disabled={generatingWordPreview || regeneratingSegment || applyingFix}
              />
              <span className="text-muted-foreground">→</span>
              <div className="relative">
                <Input
                  placeholder="phonetic"
                  value={phoneticInput}
                  onChange={(e) => setPhoneticInput(e.target.value)}
                  className="h-7 text-sm w-28"
                  disabled={generatingWordPreview || regeneratingSegment || applyingFix}
                />
                {lookingUpPhonetic && (
                  <Loader2 className="w-3 h-3 animate-spin absolute right-2 top-2 text-muted-foreground" />
                )}
              </div>
            </div>

            {/* Hear Word button */}
            <Button
              size="sm"
              variant="outline"
              onClick={handleHearWord}
              disabled={!wordInput.trim() || generatingWordPreview || regeneratingSegment || applyingFix}
              className="h-7 text-xs"
            >
              {generatingWordPreview ? (
                <>
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <Volume2 className="w-3 h-3 mr-1" />
                  Hear Word
                </>
              )}
            </Button>

            {/* Play word preview again */}
            {wordPreviewUrl && (
              <Button
                size="sm"
                variant="ghost"
                onClick={toggleWordPreviewPlay}
                className="h-7 text-xs px-2"
              >
                {isWordPreviewPlaying ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
              </Button>
            )}

            {/* Regen Segment button */}
            <Button
              size="sm"
              variant="outline"
              onClick={handleRegenSegmentWithFix}
              disabled={!wordInput.trim() || generatingWordPreview || regeneratingSegment || applyingFix}
              className="h-7 text-xs"
            >
              {regeneratingSegment ? (
                <>
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                  Regenerating...
                </>
              ) : (
                <>
                  <RefreshCw className="w-3 h-3 mr-1" />
                  Regen Segment
                </>
              )}
            </Button>
          </div>

          {/* Row 2: Segment preview playback + Apply (only shows after segment is regenerated) */}
          {segmentPreviewUrl && (
            <div className="flex items-center gap-2 pl-6">
              <span className="text-xs text-muted-foreground">Segment preview:</span>
              <Button
                size="sm"
                variant="outline"
                onClick={toggleSegmentPreviewPlay}
                className="h-7 text-xs"
              >
                {isSegmentPreviewPlaying ? (
                  <>
                    <Pause className="w-3 h-3 mr-1" />
                    Stop
                  </>
                ) : (
                  <>
                    <Play className="w-3 h-3 mr-1" />
                    Play Segment
                  </>
                )}
              </Button>
              <Button
                size="sm"
                onClick={handleApplyFix}
                disabled={applyingFix}
                className="h-7 text-xs"
              >
                {applyingFix ? (
                  <>
                    <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                    Applying...
                  </>
                ) : (
                  <>
                    <Check className="w-3 h-3 mr-1" />
                    Apply Fix
                  </>
                )}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function AudioSegmentsPreviewModal({
  isOpen,
  segments,
  combinedAudioUrl,
  totalDuration: propTotalDuration,
  onConfirmAll,
  onRegenerate,
  onCancel,
  onBack,
  onForward,
  regeneratingIndex,
  projectId,
  voiceSampleUrl,
  ttsSettings,
  onAudioUpdated,
  segmentsNeedRecombine,
  onRecombineAudio,
  segmentIssues,
}: AudioSegmentsPreviewModalProps) {
  const [isPlayingAll, setIsPlayingAll] = useState(false);
  const [allCurrentTime, setAllCurrentTime] = useState(0);
  const [isLoadingAll, setIsLoadingAll] = useState(true);
  const [playbackRateAll, setPlaybackRateAll] = useState(1);
  const [editedTexts, setEditedTexts] = useState<Record<number, string>>({});
  const [isPronunciationModalOpen, setIsPronunciationModalOpen] = useState(false);
  const [expandedGroup, setExpandedGroup] = useState<number | null>(0); // First group expanded by default
  const [playingGroupIndex, setPlayingGroupIndex] = useState<number | null>(null);
  const [playingSegmentInGroup, setPlayingSegmentInGroup] = useState<number>(0);
  const groupAudioRef = useRef<HTMLAudioElement>(null);
  const combinedAudioRef = useRef<HTMLAudioElement>(null);

  // Sequential playback state (used when segmentsNeedRecombine is true)
  const [sequentialIndex, setSequentialIndex] = useState<number>(-1);
  const sequentialAudioRef = useRef<HTMLAudioElement>(null);

  const calculatedDuration = segments.reduce((sum, seg) => sum + seg.duration, 0);
  const totalDuration = propTotalDuration || calculatedDuration;

  // Group segments into chunks of 10 for easier navigation
  const SEGMENTS_PER_GROUP = 10;
  const segmentGroups = useMemo(() => {
    const groups: { groupIndex: number; segments: AudioSegment[]; startTime: number; duration: number }[] = [];
    let accumulatedTime = 0;

    for (let i = 0; i < segments.length; i += SEGMENTS_PER_GROUP) {
      const groupSegments = segments.slice(i, i + SEGMENTS_PER_GROUP);
      const groupDuration = groupSegments.reduce((sum, s) => sum + s.duration, 0);
      groups.push({
        groupIndex: Math.floor(i / SEGMENTS_PER_GROUP),
        segments: groupSegments,
        startTime: accumulatedTime,
        duration: groupDuration,
      });
      accumulatedTime += groupDuration;
    }
    return groups;
  }, [segments]);

  // Get QA issues for a specific segment (by 1-based index)
  const getIssuesForSegment = (segmentIndex: number): SegmentIssue[] => {
    if (!segmentIssues) return [];
    return segmentIssues.filter(issue => issue.segmentIndex === segmentIndex);
  };

  // Check if any segments have issues (for header warning)
  const hasAnyIssues = segmentIssues && segmentIssues.length > 0;

  // Play all segments in a group sequentially
  const playGroup = (groupIndex: number) => {
    const group = segmentGroups[groupIndex];
    if (!group || group.segments.length === 0) return;

    setPlayingGroupIndex(groupIndex);
    setPlayingSegmentInGroup(0);

    // Start playing first segment
    if (groupAudioRef.current) {
      groupAudioRef.current.src = group.segments[0].audioUrl;
      groupAudioRef.current.play().catch(console.error);
    }
  };

  const stopGroupPlayback = () => {
    setPlayingGroupIndex(null);
    setPlayingSegmentInGroup(0);
    if (groupAudioRef.current) {
      groupAudioRef.current.pause();
      groupAudioRef.current.src = '';
    }
  };

  const handleGroupAudioEnded = () => {
    if (playingGroupIndex === null) return;

    const group = segmentGroups[playingGroupIndex];
    const nextSegmentIndex = playingSegmentInGroup + 1;

    if (nextSegmentIndex < group.segments.length) {
      // Play next segment in group
      setPlayingSegmentInGroup(nextSegmentIndex);
      if (groupAudioRef.current) {
        groupAudioRef.current.src = group.segments[nextSegmentIndex].audioUrl;
        groupAudioRef.current.play().catch(console.error);
      }
    } else {
      // Group finished
      stopGroupPlayback();
    }
  };

  // Initialize edited texts when segments change
  useEffect(() => {
    const initialTexts: Record<number, string> = {};
    segments.forEach(seg => {
      initialTexts[seg.index] = seg.text;
    });
    setEditedTexts(initialTexts);
  }, [segments]);

  // Reset combined audio state when modal opens
  useEffect(() => {
    if (isOpen) {
      setIsPlayingAll(false);
      setAllCurrentTime(0);
      setSequentialIndex(-1);
      // If using sequential playback (stale combined audio), don't wait for combined to load
      setIsLoadingAll(!segmentsNeedRecombine);
      setPlaybackRateAll(1);
    }
  }, [isOpen, segmentsNeedRecombine]);

  const togglePlayAll = () => {
    // If segments need recombine, play sequentially instead of using stale combined audio
    if (segmentsNeedRecombine && segments.length > 0) {
      if (isPlayingAll) {
        // Stop sequential playback
        if (sequentialAudioRef.current) {
          sequentialAudioRef.current.pause();
        }
        setIsPlayingAll(false);
        setSequentialIndex(-1);
      } else {
        // Start sequential playback from beginning
        setSequentialIndex(0);
        setIsPlayingAll(true);
        setAllCurrentTime(0);
        if (sequentialAudioRef.current) {
          sequentialAudioRef.current.src = segments[0].audioUrl;
          sequentialAudioRef.current.playbackRate = playbackRateAll;
          sequentialAudioRef.current.play().catch((err) => console.error('Failed to play segment:', err));
        }
      }
      return;
    }

    // Normal combined audio playback
    if (!combinedAudioRef.current) return;

    if (isPlayingAll) {
      combinedAudioRef.current.pause();
      setIsPlayingAll(false);
    } else {
      combinedAudioRef.current.play()
        .then(() => setIsPlayingAll(true))
        .catch((err) => console.error('Failed to play combined audio:', err));
    }
  };

  // Handle sequential segment ending - play next segment
  const handleSequentialEnded = () => {
    const nextIndex = sequentialIndex + 1;
    if (nextIndex < segments.length) {
      // Calculate cumulative time up to this point
      const cumulativeTime = segments.slice(0, nextIndex).reduce((sum, s) => sum + s.duration, 0);
      setAllCurrentTime(cumulativeTime);
      setSequentialIndex(nextIndex);
      if (sequentialAudioRef.current) {
        sequentialAudioRef.current.src = segments[nextIndex].audioUrl;
        sequentialAudioRef.current.playbackRate = playbackRateAll;
        sequentialAudioRef.current.play().catch(console.error);
      }
    } else {
      // All segments finished
      setIsPlayingAll(false);
      setSequentialIndex(-1);
      setAllCurrentTime(0);
    }
  };

  // Update time during sequential playback
  const handleSequentialTimeUpdate = () => {
    if (sequentialAudioRef.current && sequentialIndex >= 0) {
      const previousTime = segments.slice(0, sequentialIndex).reduce((sum, s) => sum + s.duration, 0);
      setAllCurrentTime(previousTime + sequentialAudioRef.current.currentTime);
    }
  };

  const togglePlaybackRateAll = () => {
    const newRate = playbackRateAll === 1 ? 2 : 1;
    setPlaybackRateAll(newRate);
    if (combinedAudioRef.current) {
      combinedAudioRef.current.playbackRate = newRate;
    }
    if (sequentialAudioRef.current) {
      sequentialAudioRef.current.playbackRate = newRate;
    }
  };

  const handleAllTimeUpdate = () => {
    if (combinedAudioRef.current) {
      setAllCurrentTime(combinedAudioRef.current.currentTime);
    }
  };

  const handleAllSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (combinedAudioRef.current) {
      const newTime = parseFloat(e.target.value);
      combinedAudioRef.current.currentTime = newTime;
      setAllCurrentTime(newTime);
    }
  };

  const handleAllCanPlay = () => {
    setIsLoadingAll(false);
    if (combinedAudioRef.current) {
      combinedAudioRef.current.playbackRate = playbackRateAll;
    }
  };

  const handleTextChange = (segmentIndex: number, text: string) => {
    setEditedTexts(prev => ({
      ...prev,
      [segmentIndex]: text
    }));
  };

  const handleSegmentRegenerate = (segmentIndex: number, editedText?: string) => {
    onRegenerate(segmentIndex, editedText);
  };

  const handleDownloadAudio = () => {
    if (combinedAudioUrl) {
      const a = document.createElement('a');
      a.href = combinedAudioUrl;
      a.download = 'voiceover.wav';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-2xl font-bold flex items-center gap-2">
            <Volume2 className="w-6 h-6 text-primary" />
            Preview Audio Segments
          </DialogTitle>
          <DialogDescription>
            Listen to each segment and regenerate any that need improvement.
            Total duration: {formatTime(totalDuration)}
          </DialogDescription>
        </DialogHeader>

        {/* QA Issues Warning Banner */}
        {hasAnyIssues && (
          <div className="mt-2 p-3 bg-amber-50 border border-amber-300 rounded-lg">
            <div className="flex items-center gap-2 text-amber-700 font-medium">
              <AlertTriangle className="w-4 h-4" />
              {segmentIssues!.length} segment{segmentIssues!.length !== 1 ? 's need' : ' needs'} regeneration
            </div>
            <p className="text-xs text-amber-600 mt-1">
              Quality check found issues with the audio. Segments with problems are marked below.
            </p>
          </div>
        )}

        <div className="py-4 space-y-4">
          {/* Combined Audio Player - Play All */}
          {(combinedAudioUrl || segments.length > 0) && (
            <div className="border-2 border-primary/30 rounded-lg p-4 space-y-3 bg-primary/5">
              {/* Combined audio element (used when not stale) */}
              {combinedAudioUrl && (
                <audio
                  key={combinedAudioUrl}
                  ref={combinedAudioRef}
                  src={combinedAudioUrl}
                  preload="auto"
                  onTimeUpdate={handleAllTimeUpdate}
                  onCanPlay={handleAllCanPlay}
                  onEnded={() => { setIsPlayingAll(false); setAllCurrentTime(0); }}
                  onError={() => setIsLoadingAll(false)}
                />
              )}
              {/* Sequential playback audio element (used when segments are stale) */}
              <audio
                ref={sequentialAudioRef}
                preload="auto"
                onTimeUpdate={handleSequentialTimeUpdate}
                onEnded={handleSequentialEnded}
                onCanPlay={() => setIsLoadingAll(false)}
                style={{ display: 'none' }}
              />

              <div className="flex items-center justify-between">
                <span className="font-medium text-lg text-primary">Play All Segments</span>
                <span className="text-sm text-muted-foreground">{formatTime(totalDuration)}</span>
              </div>

              {/* Warning when combined audio is stale */}
              {segmentsNeedRecombine && (
                <div className="flex items-center gap-2 p-2 bg-yellow-500/10 border border-yellow-500/30 rounded-lg text-yellow-600 dark:text-yellow-400">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span className="text-sm">Combined audio is outdated. Individual segments have been updated.</span>
                  {onRecombineAudio && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="ml-auto h-7 text-xs border-yellow-500/50 hover:bg-yellow-500/10"
                      onClick={async () => {
                        try {
                          await onRecombineAudio();
                          toast({
                            title: "Audio Recombined",
                            description: "The combined audio has been updated with your changes.",
                          });
                        } catch (error) {
                          toast({
                            title: "Recombine Failed",
                            description: error instanceof Error ? error.message : "Failed to recombine audio",
                            variant: "destructive",
                          });
                        }
                      }}
                    >
                      <RefreshCw className="w-3 h-3 mr-1" />
                      Update Now
                    </Button>
                  )}
                </div>
              )}

              <div className="flex items-center gap-3">
                <Button
                  size="sm"
                  variant="default"
                  className="w-12 h-12 rounded-full p-0 flex-shrink-0"
                  onClick={togglePlayAll}
                  disabled={isLoadingAll}
                >
                  {isLoadingAll ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : isPlayingAll ? (
                    <Pause className="w-5 h-5" />
                  ) : (
                    <Play className="w-5 h-5 ml-0.5" />
                  )}
                </Button>

                <div className="flex-1 space-y-1">
                  <div className="relative h-2 w-full rounded-full bg-secondary overflow-hidden">
                    <div
                      className="absolute h-full bg-primary rounded-full transition-all"
                      style={{ width: `${totalDuration ? (allCurrentTime / totalDuration) * 100 : 0}%` }}
                    />
                    <input
                      type="range"
                      min={0}
                      max={totalDuration || 100}
                      step={0.1}
                      value={allCurrentTime}
                      onChange={handleAllSeek}
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    />
                  </div>
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{formatTime(allCurrentTime)}</span>
                    <span>{formatTime(totalDuration)}</span>
                  </div>
                </div>

                {/* 2x Speed Button */}
                <Button
                  size="sm"
                  variant={playbackRateAll === 2 ? "default" : "outline"}
                  className="h-10 px-3 text-sm flex-shrink-0"
                  onClick={togglePlaybackRateAll}
                >
                  {playbackRateAll}x
                </Button>
              </div>
            </div>
          )}

          {/* Hidden audio element for group playback */}
          <audio
            ref={groupAudioRef}
            onEnded={handleGroupAudioEnded}
            style={{ display: 'none' }}
          />

          {/* Segment Groups */}
          <div className="flex items-center justify-between mt-4 mb-2">
            <span className="text-sm font-medium text-muted-foreground">
              {segmentGroups.length} Groups ({segments.length} segments) - Click to expand
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsPronunciationModalOpen(true)}
              className="gap-1"
            >
              <BookOpen className="w-4 h-4" />
              Pronunciation
            </Button>
          </div>

          {segmentGroups.map((group) => {
            const isExpanded = expandedGroup === group.groupIndex;
            const isPlaying = playingGroupIndex === group.groupIndex;
            const startTimeFormatted = formatTime(group.startTime);
            const endTimeFormatted = formatTime(group.startTime + group.duration);

            return (
              <div key={group.groupIndex} className="border rounded-lg overflow-hidden">
                {/* Group Header */}
                <div
                  className={`flex items-center justify-between p-3 cursor-pointer transition-colors ${
                    isExpanded ? 'bg-primary/10 border-b' : 'hover:bg-muted/50'
                  }`}
                  onClick={() => setExpandedGroup(isExpanded ? null : group.groupIndex)}
                >
                  <div className="flex items-center gap-2">
                    {isExpanded ? (
                      <ChevronDown className="w-4 h-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-muted-foreground" />
                    )}
                    <span className="font-medium">
                      Group {group.groupIndex + 1} ({startTimeFormatted} - {endTimeFormatted})
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {group.segments.length} segments
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    {/* Play Group Button */}
                    <Button
                      size="sm"
                      variant={isPlaying ? "destructive" : "outline"}
                      className="h-8 px-3"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isPlaying) {
                          stopGroupPlayback();
                        } else {
                          playGroup(group.groupIndex);
                        }
                      }}
                    >
                      {isPlaying ? (
                        <>
                          <Square className="w-3 h-3 mr-1 fill-current" />
                          Stop
                        </>
                      ) : (
                        <>
                          <Play className="w-3 h-3 mr-1" />
                          Play
                        </>
                      )}
                    </Button>
                    <span className="text-sm text-muted-foreground w-14 text-right">
                      {formatTime(group.duration)}
                    </span>
                  </div>
                </div>

                {/* Expanded Segments */}
                {isExpanded && (
                  <div className="p-2 space-y-2 bg-muted/20">
                    {group.segments.map((segment, localIndex) => {
                      const segmentIssuesForThis = getIssuesForSegment(segment.index);
                      const hasIssues = segmentIssuesForThis.length > 0;

                      return (
                        <div key={segment.index} className="relative">
                          {/* Playing indicator */}
                          {isPlaying && playingSegmentInGroup === localIndex && (
                            <div className="absolute left-0 top-0 bottom-0 w-1 bg-primary rounded-l animate-pulse" />
                          )}
                          {/* QA Issue warning */}
                          {hasIssues && (
                            <div className="mb-1 p-2 bg-amber-50 border border-amber-200 rounded-t text-xs">
                              <div className="flex items-center gap-1 text-amber-700 font-medium mb-1">
                                <AlertTriangle className="w-3 h-3" />
                                QA Issue - Needs regeneration
                              </div>
                              {segmentIssuesForThis.map((issue, i) => (
                                <div key={i} className="pl-4 text-amber-600">
                                  <span className="text-green-600">"{issue.originalText.slice(0, 40)}{issue.originalText.length > 40 ? '...' : ''}"</span>
                                  {issue.transcribedText && (
                                    <>
                                      {' → heard: '}
                                      <span className="text-red-500">"{issue.transcribedText.slice(0, 40)}{issue.transcribedText.length > 40 ? '...' : ''}"</span>
                                    </>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                          <AudioSegmentCard
                            segment={segment}
                            isRegenerating={regeneratingIndex === segment.index}
                            onRegenerate={(editedText) => handleSegmentRegenerate(segment.index, editedText)}
                            editedText={editedTexts[segment.index] || segment.text}
                            onTextChange={(text) => handleTextChange(segment.index, text)}
                            projectId={projectId}
                            voiceSampleUrl={voiceSampleUrl}
                            ttsSettings={ttsSettings}
                            segmentCount={segments.length}
                            onAudioUpdated={onAudioUpdated}
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          {/* Left side: Navigation + Download */}
          <div className="flex gap-2 w-full sm:w-auto sm:mr-auto">
            {onBack && (
              <Button variant="outline" size="icon" onClick={onBack} title="Back to previous step">
                <ChevronLeft className="w-5 h-5" />
              </Button>
            )}
            {combinedAudioUrl && (
              <Button variant="outline" onClick={handleDownloadAudio} className="flex-1 sm:flex-none">
                <Download className="w-4 h-4 mr-2" />
                Download
              </Button>
            )}
          </div>

          {/* Right side: Exit + Forward/Continue */}
          <Button variant="outline" onClick={onCancel} className="w-full sm:w-auto">
            <X className="w-4 h-4 mr-2" />
            Exit
          </Button>

          {onForward ? (
            <Button
              onClick={onForward}
              className="w-full sm:w-auto"
              disabled={regeneratingIndex !== null}
            >
              Captions
              <ChevronRight className="w-4 h-4 ml-2" />
            </Button>
          ) : (
            <Button
              onClick={onConfirmAll}
              className="w-full sm:w-auto"
              disabled={regeneratingIndex !== null}
            >
              <Check className="w-4 h-4 mr-2" />
              Generate Captions
            </Button>
          )}
        </DialogFooter>
      </DialogContent>

      {/* Pronunciation Modal */}
      <PronunciationModal
        isOpen={isPronunciationModalOpen}
        onClose={() => setIsPronunciationModalOpen(false)}
      />
    </Dialog>
  );
}
