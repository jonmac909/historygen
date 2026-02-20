import { useState, useEffect, useCallback } from "react";
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
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Edit2,
  Loader2,
  RefreshCw,
  Scan,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  scanImagesStreaming,
  rewritePrompt,
  ScanResult,
  ScanEvent,
  type ImagePromptWithTiming,
} from "@/lib/api";

interface ImageScannerModalProps {
  isOpen: boolean;
  images: string[];
  prompts: ImagePromptWithTiming[];
  srtContent?: string;
  eraTopic: string;
  projectId: string;
  onCancel: () => void;
  onBack?: () => void;
  onContinue: (updatedPrompts?: ImagePromptWithTiming[]) => void;
  onRegenerate: (indices: number[], editedPrompts: Map<number, string>) => Promise<void>;
}

type ScanPhase = "idle" | "scanning" | "results" | "regenerating" | "rescanning" | "complete";

// Parse SRT content and extract text for a given time range
function extractSrtTextForTimeRange(srtContent: string, startSeconds: number, endSeconds: number): string {
  const lines = srtContent.split('\n');
  const matchingTexts: string[] = [];

  let i = 0;
  while (i < lines.length) {
    if (!lines[i]?.trim()) {
      i++;
      continue;
    }

    if (/^\d+$/.test(lines[i].trim())) {
      i++;
    }

    const timestampMatch = lines[i]?.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
    if (timestampMatch) {
      const captionStart = parseInt(timestampMatch[1]) * 3600 + parseInt(timestampMatch[2]) * 60 + parseInt(timestampMatch[3]) + parseInt(timestampMatch[4]) / 1000;
      const captionEnd = parseInt(timestampMatch[5]) * 3600 + parseInt(timestampMatch[6]) * 60 + parseInt(timestampMatch[7]) + parseInt(timestampMatch[8]) / 1000;

      i++;

      const textLines: string[] = [];
      while (i < lines.length && lines[i]?.trim()) {
        textLines.push(lines[i].trim());
        i++;
      }

      if (captionEnd >= startSeconds && captionStart <= endSeconds) {
        matchingTexts.push(textLines.join(' '));
      }
    } else {
      i++;
    }
  }

  return matchingTexts.join(' ');
}

// Map violation type to user-friendly label
function getViolationLabel(violation: string): string {
  const labels: Record<string, string> = {
    nudity: "Nudity/Revealing Content",
    violence: "Violence",
    gore: "Gore/Medical",
    medical: "Medical Procedure",
    disturbing: "Disturbing Content",
    wrong_clothing: "Wrong Era Clothing",
    wrong_architecture: "Wrong Era Architecture",
    wrong_objects: "Anachronistic Objects",
    wrong_era: "Wrong Historical Era",
  };
  return labels[violation] || violation;
}

// Get violation severity color
function getViolationColor(violation: string): string {
  if (["nudity", "gore", "violence", "medical", "disturbing"].includes(violation)) {
    return "text-red-600 bg-red-50 border-red-200";
  }
  return "text-amber-600 bg-amber-50 border-amber-200";
}

export function ImageScannerModal({
  isOpen,
  images,
  prompts,
  srtContent,
  eraTopic,
  projectId,
  onCancel,
  onBack,
  onContinue,
  onRegenerate,
}: ImageScannerModalProps) {
  const [phase, setPhase] = useState<ScanPhase>("idle");
  const [scanProgress, setScanProgress] = useState({ current: 0, total: 0 });
  const [scanResults, setScanResults] = useState<ScanResult[]>([]);
  const [flaggedImages, setFlaggedImages] = useState<ScanResult[]>([]);

  // Prompt editing state
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editedPrompts, setEditedPrompts] = useState<Map<number, string>>(new Map());
  const [suggestedPrompts, setSuggestedPrompts] = useState<Map<number, string>>(new Map());
  const [loadingSuggestion, setLoadingSuggestion] = useState<Set<number>>(new Set());

  // Regeneration state
  const [regeneratingIndices, setRegeneratingIndices] = useState<Set<number>>(new Set());

  // Start scanning when modal opens
  useEffect(() => {
    if (isOpen && phase === "idle" && images.length > 0) {
      startScan();
    }
  }, [isOpen]);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setPhase("idle");
      setScanProgress({ current: 0, total: 0 });
      setScanResults([]);
      setFlaggedImages([]);
      setEditingIndex(null);
      setEditedPrompts(new Map());
      setSuggestedPrompts(new Map());
      setLoadingSuggestion(new Set());
      setRegeneratingIndices(new Set());
    }
  }, [isOpen]);

  const startScan = useCallback(async () => {
    setPhase("scanning");
    setScanProgress({ current: 0, total: images.length });
    setScanResults([]);
    setFlaggedImages([]);

    const imagesToScan = images.map((url, index) => ({ index, imageUrl: url }));

    try {
      await scanImagesStreaming(imagesToScan, eraTopic, projectId, (event: ScanEvent) => {
        if (event.type === "scanning") {
          setScanProgress({ current: event.index + 1, total: event.total });
        } else if (event.type === "result") {
          setScanResults(prev => [...prev, {
            index: event.index,
            imageUrl: event.imageUrl,
            safe: event.safe,
            violations: event.violations,
            confidence: event.confidence,
            details: event.details,
          }]);
        } else if (event.type === "complete") {
          const flagged = event.results.filter(r => !r.safe);
          setFlaggedImages(flagged);

          if (flagged.length === 0) {
            setPhase("complete");
          } else {
            setPhase("results");
            // Auto-generate suggested prompts for flagged images
            flagged.forEach(result => {
              generateSuggestion(result.index, result.violations);
            });
          }
        } else if (event.type === "error") {
          console.error("Scan error:", event.error);
          // On error, allow user to continue without scanning
          setPhase("complete");
        }
      });
    } catch (error) {
      console.error("Scan failed:", error);
      setPhase("complete");
    }
  }, [images, eraTopic, projectId]);

  const generateSuggestion = async (index: number, violations: string[]) => {
    const prompt = prompts.find(p => p.index === index);
    if (!prompt) return;

    setLoadingSuggestion(prev => new Set([...prev, index]));

    const scriptContext = srtContent && prompt.startSeconds !== undefined && prompt.endSeconds !== undefined
      ? extractSrtTextForTimeRange(srtContent, prompt.startSeconds, prompt.endSeconds)
      : "";

    try {
      const result = await rewritePrompt(
        prompt.sceneDescription || prompt.prompt,
        scriptContext,
        violations,
        eraTopic
      );

      if (result.success && result.newPrompt) {
        setSuggestedPrompts(prev => new Map(prev).set(index, result.newPrompt!));
        // Auto-apply suggestion to editedPrompts
        setEditedPrompts(prev => new Map(prev).set(index, result.newPrompt!));
      }
    } catch (error) {
      console.error("Failed to generate suggestion:", error);
    } finally {
      setLoadingSuggestion(prev => {
        const next = new Set(prev);
        next.delete(index);
        return next;
      });
    }
  };

  const handleEditPrompt = (index: number, value: string) => {
    setEditedPrompts(prev => new Map(prev).set(index, value));
  };

  const handleFixImages = async () => {
    if (flaggedImages.length === 0) return;

    setPhase("regenerating");
    const indices = flaggedImages.map(f => f.index);
    setRegeneratingIndices(new Set(indices));

    try {
      await onRegenerate(indices, editedPrompts);

      // After regeneration, rescan the fixed images
      setPhase("rescanning");
      setScanProgress({ current: 0, total: indices.length });

      const imagesToRescan = indices.map(index => ({
        index,
        imageUrl: images[index],
      }));

      const newResults: ScanResult[] = [];

      await scanImagesStreaming(imagesToRescan, eraTopic, projectId, (event: ScanEvent) => {
        if (event.type === "scanning") {
          setScanProgress({ current: event.index + 1, total: event.total });
        } else if (event.type === "result") {
          newResults.push({
            index: event.index,
            imageUrl: event.imageUrl,
            safe: event.safe,
            violations: event.violations,
            confidence: event.confidence,
            details: event.details,
          });
        } else if (event.type === "complete") {
          const stillFlagged = newResults.filter(r => !r.safe);
          setFlaggedImages(stillFlagged);

          if (stillFlagged.length === 0) {
            setPhase("complete");
          } else {
            setPhase("results");
            // Reset edited prompts for still-flagged images
            setEditedPrompts(new Map());
            setSuggestedPrompts(new Map());
            stillFlagged.forEach(result => {
              generateSuggestion(result.index, result.violations);
            });
          }
        }
      });
    } catch (error) {
      console.error("Fix images failed:", error);
      setPhase("results");
    } finally {
      setRegeneratingIndices(new Set());
    }
  };

  const handleSkip = () => {
    // Continue without fixing - user acknowledges the risk
    onContinue();
  };

  const handleContinue = () => {
    // Update prompts with edited versions and continue
    if (editedPrompts.size > 0) {
      const updatedPrompts = prompts.map(p => {
        const edited = editedPrompts.get(p.index);
        if (edited) {
          return { ...p, sceneDescription: edited, prompt: edited };
        }
        return p;
      });
      onContinue(updatedPrompts);
    } else {
      onContinue();
    }
  };

  const progressPercent = scanProgress.total > 0
    ? (scanProgress.current / scanProgress.total) * 100
    : 0;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-2xl font-bold flex items-center gap-2">
            <Scan className="w-6 h-6 text-primary" />
            Image Scanner
            {phase === "complete" && flaggedImages.length === 0 && (
              <span className="ml-2 text-sm font-normal text-green-600 flex items-center gap-1">
                <ShieldCheck className="w-4 h-4" /> All Clear
              </span>
            )}
            {phase === "results" && flaggedImages.length > 0 && (
              <span className="ml-2 text-sm font-normal text-amber-600 flex items-center gap-1">
                <AlertTriangle className="w-4 h-4" /> {flaggedImages.length} Issues Found
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            {phase === "scanning" && "Scanning images for content violations and historical accuracy..."}
            {phase === "results" && "Review flagged images and fix prompts before continuing."}
            {phase === "regenerating" && "Regenerating flagged images with updated prompts..."}
            {phase === "rescanning" && "Verifying regenerated images..."}
            {phase === "complete" && "All images passed content and accuracy checks."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto py-4">
          {/* Scanning Phase */}
          {(phase === "scanning" || phase === "rescanning") && (
            <div className="flex flex-col items-center justify-center py-12 space-y-6">
              <Loader2 className="w-12 h-12 text-primary animate-spin" />
              <div className="text-center space-y-2">
                <p className="text-lg font-medium">
                  {phase === "scanning" ? "Scanning" : "Rescanning"} {scanProgress.current} of {scanProgress.total} images...
                </p>
                <p className="text-sm text-muted-foreground">
                  Checking for content issues and historical accuracy
                </p>
              </div>
              <Progress value={progressPercent} className="w-64" />
            </div>
          )}

          {/* Regenerating Phase */}
          {phase === "regenerating" && (
            <div className="flex flex-col items-center justify-center py-12 space-y-6">
              <RefreshCw className="w-12 h-12 text-primary animate-spin" />
              <div className="text-center space-y-2">
                <p className="text-lg font-medium">
                  Regenerating {regeneratingIndices.size} images...
                </p>
                <p className="text-sm text-muted-foreground">
                  Using updated prompts to fix content issues
                </p>
              </div>
            </div>
          )}

          {/* Results Phase - Flagged Images */}
          {phase === "results" && flaggedImages.length > 0 && (
            <div className="space-y-6">
              {/* Summary */}
              <div className="flex items-center justify-between p-4 bg-muted/30 rounded-lg border">
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2 text-green-600">
                    <ShieldCheck className="w-5 h-5" />
                    <span className="font-medium">{images.length - flaggedImages.length} passed</span>
                  </div>
                  <div className="flex items-center gap-2 text-amber-600">
                    <ShieldAlert className="w-5 h-5" />
                    <span className="font-medium">{flaggedImages.length} flagged</span>
                  </div>
                </div>
              </div>

              {/* Flagged Images List */}
              <div className="space-y-4">
                {flaggedImages.map((result) => {
                  const prompt = prompts.find(p => p.index === result.index);
                  const isEditing = editingIndex === result.index;
                  const currentEditedPrompt = editedPrompts.get(result.index) || "";
                  const suggestion = suggestedPrompts.get(result.index);
                  const isLoadingSuggestion = loadingSuggestion.has(result.index);

                  return (
                    <div
                      key={result.index}
                      className="border rounded-lg overflow-hidden bg-white dark:bg-gray-900"
                    >
                      {/* Header */}
                      <div className="flex items-center justify-between p-3 bg-muted/30 border-b">
                        <div className="flex items-center gap-3">
                          <span className="font-medium">Image {result.index + 1}</span>
                          <div className="flex gap-1">
                            {result.violations.map((v) => (
                              <span
                                key={v}
                                className={`text-xs px-2 py-0.5 rounded border ${getViolationColor(v)}`}
                              >
                                {getViolationLabel(v)}
                              </span>
                            ))}
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {Math.round(result.confidence * 100)}% confidence
                          </span>
                        </div>
                      </div>

                      {/* Content */}
                      <div className="flex gap-4 p-4">
                        {/* Thumbnail */}
                        <div className="flex-shrink-0">
                          <img
                            src={result.imageUrl}
                            alt={`Image ${result.index + 1}`}
                            className="w-32 h-24 object-cover rounded border"
                          />
                        </div>

                        {/* Prompts */}
                        <div className="flex-1 space-y-3">
                          {/* Current Prompt */}
                          <div>
                            <div className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
                              Current Prompt
                            </div>
                            <p className="text-sm bg-muted/50 p-2 rounded border">
                              {prompt?.sceneDescription || prompt?.prompt || "No prompt available"}
                            </p>
                          </div>

                          {/* Suggested/Edited Prompt */}
                          <div>
                            <div className="flex items-center justify-between mb-1">
                              <div className="text-xs text-muted-foreground uppercase tracking-wide">
                                {isEditing ? "Your Edited Prompt" : "Suggested New Prompt"}
                              </div>
                              {!isEditing && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 text-xs"
                                  onClick={() => setEditingIndex(result.index)}
                                >
                                  <Edit2 className="w-3 h-3 mr-1" />
                                  Edit
                                </Button>
                              )}
                            </div>

                            {isEditing ? (
                              <div className="space-y-2">
                                {/* Script context */}
                                {srtContent && prompt?.startSeconds !== undefined && prompt?.endSeconds !== undefined && (
                                  <div className="bg-blue-50 dark:bg-blue-900/20 rounded p-2 border border-blue-200 dark:border-blue-800">
                                    <div className="text-xs text-blue-600 dark:text-blue-400 uppercase tracking-wide mb-1">
                                      Script for this scene ({Math.floor(prompt.startSeconds / 60)}:{String(Math.floor(prompt.startSeconds % 60)).padStart(2, '0')} - {Math.floor(prompt.endSeconds / 60)}:{String(Math.floor(prompt.endSeconds % 60)).padStart(2, '0')})
                                    </div>
                                    <p className="text-sm text-blue-700 dark:text-blue-300 italic">
                                      "{extractSrtTextForTimeRange(srtContent, prompt.startSeconds, prompt.endSeconds) || "No matching audio"}"
                                    </p>
                                  </div>
                                )}
                                <textarea
                                  value={currentEditedPrompt}
                                  onChange={(e) => handleEditPrompt(result.index, e.target.value)}
                                  className="w-full min-h-[80px] p-2 text-sm bg-background border rounded resize-y"
                                  placeholder="Describe the visual scene..."
                                />
                                <div className="flex gap-2 justify-end">
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => setEditingIndex(null)}
                                  >
                                    Done
                                  </Button>
                                </div>
                              </div>
                            ) : isLoadingSuggestion ? (
                              <div className="flex items-center gap-2 text-sm text-muted-foreground p-2 bg-muted/50 rounded border">
                                <Loader2 className="w-4 h-4 animate-spin" />
                                Generating suggestion...
                              </div>
                            ) : (
                              <p className="text-sm bg-green-50 dark:bg-green-900/20 p-2 rounded border border-green-200 dark:border-green-800 text-green-800 dark:text-green-200">
                                {currentEditedPrompt || suggestion || "Generating suggestion..."}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Complete Phase */}
          {phase === "complete" && (
            <div className="flex flex-col items-center justify-center py-12 space-y-4">
              <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                <ShieldCheck className="w-8 h-8 text-green-600" />
              </div>
              <div className="text-center">
                <p className="text-lg font-medium text-green-600">All Images Passed!</p>
                <p className="text-sm text-muted-foreground mt-1">
                  {images.length} images verified for content and historical accuracy.
                </p>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="flex-shrink-0 gap-2 sm:gap-2">
          {/* Left side: Back */}
          <div className="flex gap-2 mr-auto">
            {onBack && (
              <Button variant="outline" size="icon" onClick={onBack} title="Back to Images">
                <ChevronLeft className="w-5 h-5" />
              </Button>
            )}
          </div>

          {/* Right side: Actions based on phase */}
          {phase === "scanning" && (
            <Button variant="outline" onClick={onCancel}>
              <X className="w-4 h-4 mr-2" />
              Cancel
            </Button>
          )}

          {phase === "results" && flaggedImages.length > 0 && (
            <>
              <Button variant="outline" onClick={handleSkip} className="text-amber-600 border-amber-300 hover:bg-amber-50">
                <AlertTriangle className="w-4 h-4 mr-2" />
                Skip (Not Recommended)
              </Button>
              <Button
                onClick={handleFixImages}
                disabled={loadingSuggestion.size > 0}
              >
                <RefreshCw className="w-4 h-4 mr-2" />
                Fix {flaggedImages.length} Image{flaggedImages.length > 1 ? "s" : ""}
              </Button>
            </>
          )}

          {phase === "complete" && (
            <Button onClick={handleContinue}>
              Continue to Video Clips
              <ChevronRight className="w-4 h-4 ml-2" />
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
