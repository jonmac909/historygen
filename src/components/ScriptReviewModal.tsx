import { useState, useEffect } from "react";
import { Check, X, Edit3, Loader2, Download, ChevronLeft, ChevronRight, RefreshCw, Star, AlertCircle, ChevronDown, ChevronUp, CircleAlert, HelpCircle, AlertTriangle, Expand } from "lucide-react";
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
import { rateScript, type ScriptRatingResult, type ScriptIssue } from "@/lib/api";
import { toast } from "@/hooks/use-toast";

interface ScriptReviewModalProps {
  isOpen: boolean;
  script: string;
  title?: string;
  topic?: string;  // Specific topic focus for drift detection
  template?: string;
  onConfirm: (script: string) => void;
  onCancel: () => void;
  onBack?: () => void;
  onForward?: () => void;
  onRegenerate?: (fixPrompt: string) => void;
  regenerationProgress?: number | null;  // 0-100 or null when not regenerating
}

export function ScriptReviewModal({
  isOpen,
  script,
  title,
  topic,
  template,
  onConfirm,
  onCancel,
  onBack,
  onForward,
  onRegenerate,
  regenerationProgress
}: ScriptReviewModalProps) {
  const [editedScript, setEditedScript] = useState(script);
  const [isEditing, setIsEditing] = useState(false);
  const [isRating, setIsRating] = useState(false);
  const [rating, setRating] = useState<ScriptRatingResult | null>(null);
  const [hasRatedAfterRegen, setHasRatedAfterRegen] = useState(false);
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);
  const [customPrompt, setCustomPrompt] = useState("");
  // Track previous issues to show which ones weren't fixed
  const [previousIssues, setPreviousIssues] = useState<ScriptIssue[]>([]);

  // Regeneration is now controlled by parent via regenerationProgress prop
  const isRegenerating = regenerationProgress !== null && regenerationProgress !== undefined;

  // Update editedScript when script prop changes
  useEffect(() => {
    if (script) {
      setEditedScript(script);
      // Reset rating when script changes (new script loaded)
      setRating(null);
      setHasRatedAfterRegen(false);
    }
  }, [script]);

  // Auto-rate when modal opens with a script, or when script changes (after regeneration)
  useEffect(() => {
    if (isOpen && script && !rating && !isRating) {
      handleRate();
    }
  }, [isOpen, script, rating]);

  const wordCount = editedScript.split(/\s+/).filter(Boolean).length;

  const handleRate = async () => {
    setIsRating(true);
    // Save current issues before re-rating (normalized)
    if (rating?.issues && rating.issues.length > 0) {
      setPreviousIssues(normalizeIssues(rating.issues as (string | ScriptIssue)[]));
    }
    try {
      const result = await rateScript(editedScript, template, title, topic);
      if (result.success) {
        setRating(result);
        // If new rating has no issues but we had previous issues, check which weren't fixed
        // by comparing text similarity
        if (previousIssues.length > 0 && (!result.issues || result.issues.length === 0)) {
          // All issues were fixed - clear previous issues
          setPreviousIssues([]);
        }
      } else {
        toast({
          title: "Rating Failed",
          description: result.error || "Could not rate the script.",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error('Rating error:', error);
      toast({
        title: "Rating Error",
        description: "An error occurred while rating the script.",
        variant: "destructive",
      });
    } finally {
      setIsRating(false);
    }
  };

  const handleRegenerate = async (prompt?: string) => {
    const fixPrompt = prompt || rating?.fixPrompt;
    if (!onRegenerate || !fixPrompt) return;

    setHasRatedAfterRegen(false);

    try {
      await onRegenerate(fixPrompt);
      // The parent component will update the script prop and regenerationProgress
      // Rating will happen automatically when the new script loads
      setHasRatedAfterRegen(true);
      setCustomPrompt(""); // Clear custom prompt after use
    } catch (error) {
      console.error('Regeneration error:', error);
      toast({
        title: "Regeneration Failed",
        description: "Could not regenerate the script.",
        variant: "destructive",
      });
    }
  };

  const handleCustomEdit = () => {
    if (customPrompt.trim()) {
      handleRegenerate(customPrompt.trim());
    }
  };

  const handleConfirm = () => {
    onConfirm(editedScript);
  };

  const handleDownload = () => {
    const blob = new Blob([editedScript], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'script.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const getGradeColor = (grade?: 'A' | 'B' | 'C') => {
    switch (grade) {
      case 'A': return 'text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-900/30';
      case 'B': return 'text-yellow-600 bg-yellow-100 dark:text-yellow-400 dark:bg-yellow-900/30';
      case 'C': return 'text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/30';
      default: return 'text-muted-foreground bg-muted';
    }
  };

  // Normalize issues - handle both old string format and new object format
  const normalizeIssues = (issues: (string | ScriptIssue)[] | undefined): ScriptIssue[] => {
    if (!issues) return [];
    return issues.map(issue => {
      if (typeof issue === 'string') {
        // Legacy format - assume major if it mentions formatting/headers, otherwise minor
        const isMajor = /header|title|markdown|format|hashtag|#/i.test(issue);
        return { text: issue, severity: isMajor ? 'major' : 'minor' } as ScriptIssue;
      }
      return issue;
    });
  };

  // Show loading if script is empty
  if (isOpen && !script) {
    return (
      <Dialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col items-center justify-center" aria-describedby="loading-description">
          <DialogHeader className="sr-only">
            <DialogTitle>Loading Script</DialogTitle>
            <DialogDescription id="loading-description">Please wait while the script loads.</DialogDescription>
          </DialogHeader>
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <p className="text-muted-foreground mt-4">Loading script...</p>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        className="max-w-4xl h-[85vh] flex flex-col overflow-hidden"
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle className="text-2xl font-bold flex items-center gap-2">
            Review Script
            <span className="text-sm font-normal text-muted-foreground ml-2">
              {wordCount.toLocaleString()} words
            </span>
            {/* Grade indicator - always visible, shows spinner while loading */}
            <span className="ml-2 px-2 py-0.5 text-sm font-bold rounded-full bg-muted flex items-center gap-1">
              {isRating ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span className="text-muted-foreground font-normal">Grade:</span>
                </>
              ) : rating?.grade ? (
                <button
                  onClick={() => setIsFeedbackOpen(!isFeedbackOpen)}
                  className={`flex items-center gap-1 ${getGradeColor(rating.grade)} px-2 py-0.5 -m-0.5 rounded-full hover:opacity-80 transition-opacity`}
                >
                  Grade: {rating.grade}
                  {isFeedbackOpen ? (
                    <ChevronUp className="w-3 h-3" />
                  ) : (
                    <ChevronDown className="w-3 h-3" />
                  )}
                </button>
              ) : (
                <span className="text-muted-foreground font-normal">Grade: —</span>
              )}
            </span>
            {/* YouTube Policy indicator */}
            {rating?.youtubePolicy && (
              <span className={`ml-1 px-2 py-0.5 text-xs font-medium rounded-full flex items-center gap-1 ${
                rating.youtubePolicy.safe
                  ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                  : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
              }`}>
                {rating.youtubePolicy.safe ? (
                  <>
                    <Check className="w-3 h-3" />
                    YouTube Safe
                  </>
                ) : (
                  <>
                    <AlertTriangle className="w-3 h-3" />
                    Policy Issues ({rating.youtubePolicy.issues.length})
                  </>
                )}
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            Review and edit the generated script before creating audio.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 py-4 flex flex-col gap-3 overflow-hidden">
          {/* Feedback Panel - only visible when user clicks Grade dropdown */}
          {rating && isFeedbackOpen && (
            <div className={`shrink-0 border rounded-lg p-3 ${
              rating.grade === 'A'
                ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800'
                : 'bg-muted/50'
            }`}>
              {/* Summary */}
              <div className="flex items-start gap-2">
                {rating.grade === 'A' ? (
                  <Star className="w-4 h-4 text-green-600 dark:text-green-400 mt-0.5 shrink-0" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-yellow-600 dark:text-yellow-400 mt-0.5 shrink-0" />
                )}
                <p className={`text-sm ${rating.grade === 'A' ? 'text-green-700 dark:text-green-300' : 'text-muted-foreground'}`}>
                  {rating.summary}
                </p>
              </div>

              {/* Current issues */}
              {rating.issues && rating.issues.length > 0 && (
                <ul className="text-sm text-muted-foreground space-y-1 ml-6 mt-2">
                  {normalizeIssues(rating.issues as (string | ScriptIssue)[]).map((issue, i) => (
                    <li key={i} className="flex items-start gap-2">
                      {issue.severity === 'major' ? (
                        <CircleAlert className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                      ) : (
                        <HelpCircle className="w-4 h-4 text-yellow-500 shrink-0 mt-0.5" />
                      )}
                      <span>{issue.text}</span>
                    </li>
                  ))}
                </ul>
              )}

              {/* Show previously fixed issues (strikethrough) if we went from issues to A */}
              {rating.grade === 'A' && previousIssues.length > 0 && (
                <div className="mt-2 pt-2 border-t border-green-200 dark:border-green-800">
                  <p className="text-xs text-green-600 dark:text-green-400 mb-1">Fixed issues:</p>
                  <ul className="text-sm text-muted-foreground/50 space-y-0.5 ml-6">
                    {previousIssues.map((issue, i) => (
                      <li key={i} className="flex items-start gap-2 line-through">
                        <Check className="w-4 h-4 text-green-500 shrink-0 mt-0.5" />
                        <span>{issue.text}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Topic Drift Alert - show when topics found don't match expected */}
              {rating.topicAnalysis?.hasDrift && (
                <div className="mt-2 pt-2 border-t border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 rounded p-2 -mx-1">
                  <div className="flex items-start gap-2">
                    <CircleAlert className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-red-700 dark:text-red-300">
                        Topic Drift Detected
                      </p>
                      <p className="text-xs text-red-600 dark:text-red-400 mt-1">
                        Expected: <strong>{rating.topicAnalysis.expectedTopic}</strong>
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Topics found: {rating.topicAnalysis.topicsFound.join(', ')}
                      </p>
                      {rating.topicAnalysis.offTopicSections.length > 0 && (
                        <ul className="text-xs text-muted-foreground mt-1 list-disc list-inside">
                          {rating.topicAnalysis.offTopicSections.map((section, i) => (
                            <li key={i}>{section}</li>
                          ))}
                        </ul>
                      )}
                      {onRegenerate && (
                        <div className="flex gap-2 mt-2">
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => handleRegenerate(`Remove all off-topic content. This script should ONLY be about "${rating.topicAnalysis?.expectedTopic}". Expand the on-topic content to fill the full word count with rich details, sensory descriptions, and historical depth about ${rating.topicAnalysis?.expectedTopic}.`)}
                            disabled={isRegenerating}
                            className="gap-1"
                          >
                            {isRegenerating ? (
                              <>
                                <Loader2 className="w-3 h-3 animate-spin" />
                                Regenerating...
                              </>
                            ) : (
                              <>
                                <RefreshCw className="w-3 h-3" />
                                Regenerate on Topic
                              </>
                            )}
                          </Button>
                          <span className="text-xs text-muted-foreground self-center">
                            Full rewrite focused on {rating.topicAnalysis.expectedTopic}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* YouTube Policy Issues - show when policy check found issues */}
              {rating.youtubePolicy && !rating.youtubePolicy.safe && (
                <div className="mt-2 pt-2 border-t border-orange-200 dark:border-orange-800 bg-orange-50 dark:bg-orange-900/20 rounded p-2 -mx-1">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-orange-600 dark:text-orange-400 shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-orange-700 dark:text-orange-300">
                        YouTube Policy Concerns
                      </p>
                      <p className="text-xs text-orange-600 dark:text-orange-400 mt-1">
                        {rating.youtubePolicy.summary}
                      </p>
                      {rating.youtubePolicy.issues.length > 0 && (
                        <ul className="text-xs text-muted-foreground mt-2 space-y-1">
                          {rating.youtubePolicy.issues.map((issue, i) => (
                            <li key={i} className="flex items-start gap-2">
                              <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                issue.severity === 'high'
                                  ? 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300'
                                  : issue.severity === 'medium'
                                  ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-300'
                                  : 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-300'
                              }`}>
                                {issue.severity}
                              </span>
                              <span className="flex-1">{issue.category}: "{issue.excerpt.substring(0, 50)}..."</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Quick Fix button - for minor issues (formatting, tone), not topic drift */}
              {rating.grade !== 'A' && onRegenerate && rating.fixPrompt && !rating.topicAnalysis?.hasDrift && (
                <div className="flex items-center gap-2 mt-2 pt-2 border-t">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleRegenerate()}
                    disabled={isRegenerating}
                    className="gap-1"
                  >
                    {isRegenerating ? (
                      <>
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Fixing...
                      </>
                    ) : (
                      <>
                        <Edit3 className="w-3 h-3" />
                        Quick Fix
                      </>
                    )}
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {rating.fixPrompt.substring(0, 80)}...
                  </span>
                </div>
              )}
              {/* Custom edit prompt - always visible when feedback panel is open */}
              {onRegenerate && (
                <div className="mt-3 pt-3 border-t space-y-2">
                  <label className="text-xs font-medium text-muted-foreground">Custom Edit Prompt:</label>
                  <div className="flex gap-2">
                    <Textarea
                      value={customPrompt}
                      onChange={(e) => setCustomPrompt(e.target.value)}
                      placeholder="e.g., Remove all content about Confederate America - this script should only be about Vikings winter"
                      className="text-sm min-h-[60px] flex-1"
                      disabled={isRegenerating}
                    />
                    <Button
                      variant="default"
                      size="sm"
                      onClick={handleCustomEdit}
                      disabled={isRegenerating || !customPrompt.trim()}
                      className="shrink-0 self-end"
                    >
                      {isRegenerating ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        "Apply"
                      )}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Script Content */}
          <div className="flex-1 min-h-0 relative overflow-hidden">
            {/* Regeneration overlay */}
            {isRegenerating && (
              <div className="absolute inset-0 bg-background/80 backdrop-blur-sm z-10 flex flex-col items-center justify-center rounded-lg">
                <Loader2 className="w-8 h-8 animate-spin text-primary mb-4" />
                <p className="text-sm font-medium mb-2">
                  {rating?.topicAnalysis?.hasDrift ? "Rewriting on topic..." : "Applying edits..."}
                </p>
                <p className="text-xs text-muted-foreground">
                  {rating?.topicAnalysis?.hasDrift
                    ? `Removing off-topic content and expanding ${rating.topicAnalysis.expectedTopic}`
                    : "This may take 10-30 seconds"}
                </p>
                <p className="text-xs text-muted-foreground mt-2">
                  {wordCount.toLocaleString()} words
                </p>
              </div>
            )}
            {isEditing ? (
              <Textarea
                value={editedScript}
                onChange={(e) => setEditedScript(e.target.value)}
                className="h-full font-mono text-sm resize-none"
                placeholder="Script content..."
                disabled={isRegenerating}
              />
            ) : (
              <ScrollArea className="h-full rounded-lg border border-border bg-muted/30 p-4">
                <pre className="whitespace-pre-wrap font-mono text-sm text-foreground leading-relaxed">
                  {editedScript}
                </pre>
              </ScrollArea>
            )}
          </div>
        </div>

        <DialogFooter className="shrink-0 gap-2 sm:gap-2 pt-2 border-t">
          {/* Left side: Back, Forward, Edit, Download, Re-rate */}
          <div className="flex gap-2 mr-auto">
            {onBack && (
              <Button variant="outline" size="icon" onClick={onBack} title="Back">
                <ChevronLeft className="w-5 h-5" />
              </Button>
            )}
            {onForward && (
              <Button variant="outline" size="icon" onClick={onForward} title="Forward">
                <ChevronRight className="w-5 h-5" />
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => setIsEditing(!isEditing)}
            >
              <Edit3 className="w-4 h-4 mr-2" />
              Edit
            </Button>
            <Button variant="outline" onClick={handleDownload}>
              <Download className="w-4 h-4 mr-2" />
              Download
            </Button>
            <Button
              variant="outline"
              onClick={handleRate}
              disabled={isRating}
            >
              {isRating ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Star className="w-4 h-4 mr-2" />
              )}
              Re-rate
            </Button>
          </div>

          {/* Right side: Exit + Generate Audio */}
          <Button variant="outline" onClick={onCancel}>
            <X className="w-4 h-4 mr-2" />
            Exit
          </Button>

          <Button onClick={handleConfirm}>
            <Check className="w-4 h-4 mr-2" />
            Generate Audio
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
