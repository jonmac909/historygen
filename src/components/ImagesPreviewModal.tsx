import { Check, X, Image as ImageIcon, RefreshCw, ZoomIn, Edit2, ChevronLeft, ChevronRight, Download, CheckSquare, Square, Loader2, Bug } from "lucide-react";
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
import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

interface ImagePrompt {
  index: number;
  prompt: string;
  sceneDescription: string;
  startSeconds?: number;
  endSeconds?: number;
}

interface ImagesPreviewModalProps {
  isOpen: boolean;
  images: string[];
  prompts?: ImagePrompt[];
  srtContent?: string;
  projectId?: string;  // For debugging and reconnecting orphaned images
  onConfirm: () => void;
  onCancel: () => void;
  onBack?: () => void;
  onForward?: () => void;
  onRegenerate?: (index: number, editedPrompt?: string) => void;
  onRegenerateMultiple?: (indices: number[], editedPrompts?: Map<number, string>) => Promise<void>;
  onReconnectImages?: () => Promise<void>;  // Callback to reconnect images
  regeneratingIndices?: Set<number>;
}

// Parse SRT content and extract text for a given time range
function extractSrtTextForTimeRange(srtContent: string, startSeconds: number, endSeconds: number): string {
  const lines = srtContent.split('\n');
  const matchingTexts: string[] = [];

  let i = 0;
  while (i < lines.length) {
    // Skip empty lines
    if (!lines[i]?.trim()) {
      i++;
      continue;
    }

    // Skip index line (just a number)
    if (/^\d+$/.test(lines[i].trim())) {
      i++;
    }

    // Parse timestamp line: 00:00:00,000 --> 00:00:02,500
    const timestampMatch = lines[i]?.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
    if (timestampMatch) {
      const captionStart = parseInt(timestampMatch[1]) * 3600 + parseInt(timestampMatch[2]) * 60 + parseInt(timestampMatch[3]) + parseInt(timestampMatch[4]) / 1000;
      const captionEnd = parseInt(timestampMatch[5]) * 3600 + parseInt(timestampMatch[6]) * 60 + parseInt(timestampMatch[7]) + parseInt(timestampMatch[8]) / 1000;

      i++;

      // Collect text lines until empty line
      const textLines: string[] = [];
      while (i < lines.length && lines[i]?.trim()) {
        textLines.push(lines[i].trim());
        i++;
      }

      // Check if this caption overlaps with our time range
      if (captionEnd >= startSeconds && captionStart <= endSeconds) {
        matchingTexts.push(textLines.join(' '));
      }
    } else {
      i++;
    }
  }

  return matchingTexts.join(' ');
}

export function ImagesPreviewModal({
  isOpen,
  images,
  prompts,
  srtContent,
  projectId,
  onConfirm,
  onCancel,
  onBack,
  onForward,
  onRegenerate,
  onRegenerateMultiple,
  onReconnectImages,
  regeneratingIndices = new Set()
}: ImagesPreviewModalProps) {
  // Debug: log prompts array on render
  console.log('[ImagesPreviewModal] prompts:', prompts?.length, 'images:', images?.length);
  console.log('[ImagesPreviewModal] prompts array:', prompts?.map((p, i) => ({ arrayIndex: i, promptIndex: p?.index, hasPrompt: !!p?.sceneDescription })));

  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [imageKeys, setImageKeys] = useState<Record<number, number>>({});
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editedPrompt, setEditedPrompt] = useState("");
  const prevImagesRef = useRef<string[]>([]);

  // Multi-select state
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [appendText, setAppendText] = useState("");

  // Track recently regenerated images for highlighting
  const [recentlyRegenerated, setRecentlyRegenerated] = useState<Set<number>>(new Set());
  const [pendingRegeneration, setPendingRegeneration] = useState<Set<number>>(new Set());

  // Refs for lightbox elements (needed for capture-phase click handling)
  const overlayRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  const openLightbox = (index: number) => {
    if (!isMultiSelectMode) {
      setLightboxIndex(index);
    }
  };
  const closeLightbox = () => setLightboxIndex(null);

  // Check if an image is regenerating
  const isRegenerating = (index: number) => {
    return regeneratingIndices.has(index);
  };

  // Track image URL changes to bust cache - compare with previous URLs
  useEffect(() => {
    const newKeys = { ...imageKeys };
    let hasChanges = false;

    images.forEach((url, idx) => {
      // If URL changed from previous render, increment the key
      if (prevImagesRef.current[idx] !== url) {
        newKeys[idx] = Date.now();
        hasChanges = true;
      } else if (!(idx in newKeys)) {
        // Initialize key for new indices
        newKeys[idx] = Date.now();
        hasChanges = true;
      }
    });

    if (hasChanges) {
      setImageKeys(newKeys);
    }

    // Store current images for next comparison
    prevImagesRef.current = [...images];
  }, [images]);

  // Force refresh image key when regeneration completes (even if URL is the same)
  // Track which indices were regenerating in previous render
  const prevRegeneratingIndicesRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    // Find indices that were regenerating but now aren't (regeneration completed)
    const completedIndices: number[] = [];
    prevRegeneratingIndicesRef.current.forEach(index => {
      if (!regeneratingIndices.has(index)) {
        completedIndices.push(index);
      }
    });

    // Update image keys for completed indices
    if (completedIndices.length > 0) {
      setImageKeys(prev => {
        const next = { ...prev };
        completedIndices.forEach(index => {
          next[index] = Date.now();
        });
        return next;
      });
    }

    // Store current set for next comparison
    prevRegeneratingIndicesRef.current = new Set(regeneratingIndices);
  }, [regeneratingIndices]);

  // Add cache buster to image URL
  const getImageUrl = (url: string, index: number) => {
    const key = imageKeys[index] || Date.now();
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}v=${key}`;
  };

  // Keyboard: ESC to close lightbox, Arrow keys to navigate
  useEffect(() => {
    if (lightboxIndex === null) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeLightbox();
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        // Go to next image (wrap around)
        const nextIndex = (lightboxIndex + 1) % images.length;
        setLightboxIndex(nextIndex);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        // Go to previous image (wrap around)
        const prevIndex = lightboxIndex === 0 ? images.length - 1 : lightboxIndex - 1;
        setLightboxIndex(prevIndex);
      }
    };

    // Use capture phase to intercept before Dialog
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [lightboxIndex, images.length]);

  // Click handling: background click closes, image click does nothing
  useEffect(() => {
    if (lightboxIndex === null) return;

    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;

      // If clicked on image, do nothing (don't close)
      if (imageRef.current?.contains(target)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // If clicked on overlay background, close
      if (overlayRef.current?.contains(target)) {
        e.preventDefault();
        e.stopPropagation();
        closeLightbox();
      }
    };

    // Use capture phase to intercept before Radix Dialog's event handlers
    window.addEventListener('click', handleClick, true);
    return () => window.removeEventListener('click', handleClick, true);
  }, [lightboxIndex]);

  const handleEditClick = (e: React.MouseEvent, index: number) => {
    e.stopPropagation();
    const prompt = prompts?.[index];
    if (prompt) {
      setEditedPrompt(prompt.sceneDescription);
      setEditingIndex(index);
    }
  };

  const handleSaveAndRegenerate = () => {
    if (editingIndex !== null && onRegenerate) {
      onRegenerate(editingIndex, editedPrompt);
      setEditingIndex(null);
      setEditedPrompt("");
    }
  };

  const handleCancelEdit = () => {
    setEditingIndex(null);
    setEditedPrompt("");
  };

  // Multi-select handlers
  const toggleSelection = (index: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedIndices(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const selectAll = () => {
    setSelectedIndices(new Set(images.map((_, i) => i)));
  };

  const clearSelection = () => {
    setSelectedIndices(new Set());
  };

  const exitMultiSelect = () => {
    setIsMultiSelectMode(false);
    setSelectedIndices(new Set());
    setFindText("");
    setReplaceText("");
    setAppendText("");
  };

  // Batch regenerate selected images
  const handleBatchRegenerate = async () => {
    if (selectedIndices.size === 0) return;

    // Mark selected images as pending regeneration
    setPendingRegeneration(new Set(selectedIndices));

    if (onRegenerateMultiple) {
      await onRegenerateMultiple(Array.from(selectedIndices));
    } else if (onRegenerate) {
      // Fallback: regenerate one by one (sequential)
      for (const index of selectedIndices) {
        onRegenerate(index);
      }
    }

    // After regeneration, mark them as recently regenerated
    setRecentlyRegenerated(prev => new Set([...prev, ...selectedIndices]));
    setPendingRegeneration(new Set());
  };

  // Apply batch edit and regenerate
  const handleApplyBatchEdit = async () => {
    if (selectedIndices.size === 0 || !prompts) return;

    const editedPrompts = new Map<number, string>();

    for (const index of selectedIndices) {
      const prompt = prompts[index];
      if (!prompt) continue;

      let newDescription = prompt.sceneDescription;

      // Apply find/replace
      if (findText && replaceText) {
        newDescription = newDescription.split(findText).join(replaceText);
      }

      // Apply append
      if (appendText) {
        newDescription = `${newDescription}. ${appendText}`;
      }

      editedPrompts.set(index, newDescription);
    }

    // Mark selected images as pending regeneration
    setPendingRegeneration(new Set(selectedIndices));

    if (onRegenerateMultiple) {
      await onRegenerateMultiple(Array.from(selectedIndices), editedPrompts);
    } else if (onRegenerate) {
      // Fallback: regenerate one by one with edits
      for (const [index, newPrompt] of editedPrompts) {
        onRegenerate(index, newPrompt);
      }
    }

    // After regeneration, mark them as recently regenerated
    setRecentlyRegenerated(prev => new Set([...prev, ...selectedIndices]));
    setPendingRegeneration(new Set());

    setFindText("");
    setReplaceText("");
    setAppendText("");
  };

  const handleDownloadAll = async () => {
    // Download each image sequentially
    for (let i = 0; i < images.length; i++) {
      const url = images[i];
      const a = document.createElement('a');
      a.href = url;
      a.download = `image-${String(i + 1).padStart(3, '0')}.png`;
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Small delay between downloads
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  };

  return (
    <>
    <Dialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        className="max-w-7xl max-h-[90vh] flex flex-col"
        onPointerDownOutside={(e) => {
          // Prevent Dialog from closing when clicking on the lightbox overlay
          if (lightboxIndex !== null) {
            e.preventDefault();
          }
        }}
        onInteractOutside={(e) => {
          // Prevent Dialog from closing when interacting with the lightbox
          if (lightboxIndex !== null) {
            e.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-2xl font-bold flex items-center gap-2">
            <ImageIcon className="w-6 h-6 text-primary" />
            Preview Images
            <span className="text-sm font-normal text-muted-foreground ml-2">
              {images.length} images generated
            </span>
          </DialogTitle>
          <DialogDescription>
            Review the generated images. Click edit to modify the prompt and regenerate.
          </DialogDescription>
        </DialogHeader>

        {/* Multi-select toggle and batch actions */}
        <div className="flex items-center justify-between gap-2 border-b pb-3">
          <div className="flex items-center gap-2">
            <Button
              variant={isMultiSelectMode ? "default" : "outline"}
              size="sm"
              onClick={() => isMultiSelectMode ? exitMultiSelect() : setIsMultiSelectMode(true)}
            >
              {isMultiSelectMode ? (
                <>
                  <X className="w-4 h-4 mr-1" />
                  Exit Multi-Select
                </>
              ) : (
                <>
                  <CheckSquare className="w-4 h-4 mr-1" />
                  Multi-Select
                </>
              )}
            </Button>

            {isMultiSelectMode && (
              <>
                <Button variant="outline" size="sm" onClick={selectAll}>
                  Select All
                </Button>
                {selectedIndices.size > 0 && (
                  <Button variant="ghost" size="sm" onClick={clearSelection}>
                    Clear ({selectedIndices.size})
                  </Button>
                )}
              </>
            )}
          </div>

          {/* Batch actions when images are selected */}
          {isMultiSelectMode && selectedIndices.size > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-muted-foreground">
                {selectedIndices.size} selected
              </span>
              <Button
                size="sm"
                onClick={handleBatchRegenerate}
                disabled={regeneratingIndices.size > 0 || pendingRegeneration.size > 0}
              >
                <RefreshCw className={`w-4 h-4 mr-1 ${pendingRegeneration.size > 0 ? 'animate-spin' : ''}`} />
                Regenerate
              </Button>
            </div>
          )}
        </div>

        {/* Inline batch edit panel - always visible when in multi-select mode */}
        {isMultiSelectMode && selectedIndices.size > 0 && (
          <div className="border rounded-lg p-4 bg-muted/30 space-y-3">
            <div className="flex items-center gap-2">
              <Edit2 className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-medium">Batch Edit Prompts</span>
              <span className="text-xs text-muted-foreground">
                (Changes apply to {selectedIndices.size} selected image{selectedIndices.size > 1 ? 's' : ''})
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground block mb-1">
                  Find text in prompts:
                </label>
                <Input
                  placeholder="e.g., beer, tankard, mug..."
                  value={findText}
                  onChange={(e) => setFindText(e.target.value)}
                  className="h-9"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">
                  Replace with:
                </label>
                <Input
                  placeholder="e.g., clay mug"
                  value={replaceText}
                  onChange={(e) => setReplaceText(e.target.value)}
                  className="h-9"
                />
              </div>
            </div>

            <div>
              <label className="text-xs text-muted-foreground block mb-1">
                Or append to all selected prompts:
              </label>
              <Input
                placeholder="e.g., wearing historically accurate medieval clothing"
                value={appendText}
                onChange={(e) => setAppendText(e.target.value)}
                className="h-9"
              />
            </div>

            <div className="flex gap-2 justify-end pt-1">
              <Button
                size="sm"
                onClick={handleApplyBatchEdit}
                disabled={(!findText && !appendText) || regeneratingIndices.size > 0 || pendingRegeneration.size > 0}
              >
                <RefreshCw className={`w-4 h-4 mr-1 ${pendingRegeneration.size > 0 ? 'animate-spin' : ''}`} />
                Apply & Regenerate
              </Button>
            </div>
          </div>
        )}

        {/* Recently regenerated indicator */}
        {recentlyRegenerated.size > 0 && (
          <div className="flex items-center justify-between p-2 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
            <span className="text-sm text-green-700 dark:text-green-400">
              ✓ {recentlyRegenerated.size} image{recentlyRegenerated.size > 1 ? 's' : ''} regenerated
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setRecentlyRegenerated(new Set())}
              className="h-7 text-green-700 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-900/40"
            >
              Clear
            </Button>
          </div>
        )}

        {/* Prompt editing panel (single image) */}
        {editingIndex !== null && prompts && prompts[editingIndex] && (
          <div className="border rounded-lg p-4 bg-muted/30 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="font-medium">Edit Prompt for Image {editingIndex + 1}</span>
                {/* Time range display */}
                {prompts[editingIndex].startSeconds !== undefined && prompts[editingIndex].endSeconds !== undefined && (
                  <span className="text-xs text-muted-foreground font-mono bg-muted px-2 py-0.5 rounded">
                    {Math.floor(prompts[editingIndex].startSeconds! / 60)}:{String(Math.floor(prompts[editingIndex].startSeconds! % 60)).padStart(2, '0')}
                    {' → '}
                    {Math.floor(prompts[editingIndex].endSeconds! / 60)}:{String(Math.floor(prompts[editingIndex].endSeconds! % 60)).padStart(2, '0')}
                  </span>
                )}
              </div>
              <Button size="sm" variant="ghost" onClick={handleCancelEdit}>
                <X className="w-4 h-4" />
              </Button>
            </div>

            {/* Script context from SRT */}
            {srtContent && prompts[editingIndex].startSeconds !== undefined && prompts[editingIndex].endSeconds !== undefined && (
              <div className="bg-muted/50 rounded p-3 border border-border/50">
                <div className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Script for this scene</div>
                <p className="text-sm text-foreground/80 leading-relaxed italic">
                  "{extractSrtTextForTimeRange(
                    srtContent,
                    prompts[editingIndex].startSeconds!,
                    prompts[editingIndex].endSeconds!
                  ) || 'No matching audio for this time range'}"
                </p>
              </div>
            )}

            <textarea
              value={editedPrompt}
              onChange={(e) => setEditedPrompt(e.target.value)}
              className="w-full min-h-[100px] p-3 text-sm bg-background border rounded resize-y"
              placeholder="Describe the visual scene..."
            />
            <div className="flex gap-2 justify-end">
              <Button size="sm" variant="outline" onClick={handleCancelEdit}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleSaveAndRegenerate}
                disabled={isRegenerating(editingIndex)}
              >
                {isRegenerating(editingIndex) ? (
                  <>
                    <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                    Regenerating...
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Save & Regenerate
                  </>
                )}
              </Button>
            </div>
          </div>
        )}

        <div className="overflow-y-auto flex-1 py-4 pr-2">
          <div className="grid grid-cols-3 gap-4">
            {images.map((imageUrl, index) => (
              <div
                key={`${index}-${imageKeys[index] || 0}`}
                className={`relative aspect-video rounded-lg overflow-hidden border bg-muted/30 group cursor-pointer ${
                  selectedIndices.has(index) ? 'ring-2 ring-primary border-primary' : 'border-border'
                }`}
                onClick={(e) => isMultiSelectMode ? toggleSelection(index, e) : openLightbox(index)}
              >
                <img
                  src={getImageUrl(imageUrl, index)}
                  alt={`Generated image ${index + 1}`}
                  className={`w-full h-full object-cover transition-all group-hover:scale-105 ${
                    // Desaturate non-regenerated images when there's a pending batch regeneration
                    pendingRegeneration.size > 0 && !pendingRegeneration.has(index) && !regeneratingIndices.has(index)
                      ? 'grayscale opacity-50'
                      : ''
                  } ${
                    // Highlight recently regenerated images with a subtle glow
                    recentlyRegenerated.has(index) && !isRegenerating(index)
                      ? 'ring-2 ring-green-500 ring-offset-2'
                      : ''
                  }`}
                />

                {/* Image number badge */}
                <div className="absolute bottom-2 left-2 px-2 py-1 bg-background/80 rounded text-xs font-medium">
                  {index + 1}
                </div>

                {/* Multi-select checkbox */}
                {isMultiSelectMode && (
                  <div
                    className="absolute top-2 left-2 z-20"
                    onClick={(e) => toggleSelection(index, e)}
                  >
                    {selectedIndices.has(index) ? (
                      <CheckSquare className="w-6 h-6 text-primary bg-background rounded" />
                    ) : (
                      <Square className="w-6 h-6 text-muted-foreground bg-background/80 rounded" />
                    )}
                  </div>
                )}

                {/* Regenerating overlay - ALWAYS visible when regenerating */}
                {isRegenerating(index) && (
                  <div className="absolute inset-0 bg-black/50 flex items-center justify-center z-30">
                    <div className="flex flex-col items-center gap-2">
                      <Loader2 className="w-8 h-8 text-white animate-spin" />
                      <span className="text-white text-xs">Regenerating...</span>
                    </div>
                  </div>
                )}

                {/* Zoom hint on hover (hidden when regenerating or multi-select) */}
                {!isRegenerating(index) && !isMultiSelectMode && (
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
                    <ZoomIn className="w-8 h-8 text-white opacity-0 group-hover:opacity-70 transition-opacity" />
                  </div>
                )}

                {/* Action buttons on hover (hidden when regenerating or multi-select) */}
                {!isRegenerating(index) && !isMultiSelectMode && (
                  <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity z-10 flex gap-1">
                    {prompts && (
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-8 w-8 p-0"
                        onClick={(e) => handleEditClick(e, index)}
                        disabled={isRegenerating(index)}
                        title="Edit prompt"
                      >
                        <Edit2 className="w-4 h-4" />
                      </Button>
                    )}
                    {onRegenerate && (
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-8 w-8 p-0"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRegenerate(index);
                        }}
                        disabled={isRegenerating(index)}
                        title="Regenerate this image"
                      >
                        <RefreshCw className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <DialogFooter className="flex-shrink-0 gap-2 sm:gap-2">
          {/* Left side: Navigation + Download */}
          <div className="flex gap-2 mr-auto">
            {onBack && (
              <Button variant="outline" size="icon" onClick={onBack} title="Back to previous step">
                <ChevronLeft className="w-5 h-5" />
              </Button>
            )}
            <Button variant="outline" onClick={handleDownloadAll}>
              <Download className="w-4 h-4 mr-2" />
              Images
            </Button>
            {/* Emergency reconnect - only shown when zero images (auto-recovery should handle most cases) */}
            {images.length === 0 && onReconnectImages && (
              <Button variant="outline" onClick={onReconnectImages} className="border-orange-500 text-orange-600 hover:bg-orange-50">
                <Bug className="w-4 h-4 mr-2" />
                Reconnect Images
              </Button>
            )}
          </div>

          {/* Right side: Exit + Forward/Continue */}
          <Button variant="outline" onClick={onCancel}>
            <X className="w-4 h-4 mr-2" />
            Exit
          </Button>

          {onForward ? (
            <Button onClick={onForward}>
              Generate Video Clips
              <ChevronRight className="w-4 h-4 ml-2" />
            </Button>
          ) : (
            <Button onClick={onConfirm}>
              <Check className="w-4 h-4 mr-2" />
              Generate Video Clips
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {/* Lightbox overlay - click background or press ESC to close */}
    {lightboxIndex !== null && createPortal(
      <div
        ref={overlayRef}
        className="fixed inset-0 z-[100] bg-black/90 flex cursor-pointer overflow-hidden"
      >
        {/* Image counter */}
        <div className="absolute top-4 left-4 text-white/70 text-lg font-medium pointer-events-none z-10">
          {lightboxIndex + 1} / {images.length}
        </div>

        {/* Hint text */}
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white/50 text-sm pointer-events-none z-10">
          Press ESC or click outside • Arrow keys to navigate
        </div>

        {/* Main content: Image on left, Script on right */}
        <div className="flex w-full h-full items-center justify-center gap-4 p-4">
          {/* Full-size image */}
          <div className="flex-shrink-0 flex items-center justify-center" style={{ maxWidth: srtContent || prompts ? '60%' : '90%' }}>
            <img
              ref={imageRef}
              src={getImageUrl(images[lightboxIndex], lightboxIndex)}
              alt={`Full size image ${lightboxIndex + 1}`}
              className="max-w-full max-h-[85vh] object-contain cursor-default"
            />
          </div>

          {/* Script/Audio text panel */}
          {console.log('[ImagesPreviewModal] lightbox:', { lightboxIndex, promptAtIndex: prompts?.[lightboxIndex!], hasPrompts: !!prompts, promptsLength: prompts?.length })}
          {(srtContent || prompts) && prompts?.[lightboxIndex] && (
            <div
              className="flex-shrink-0 w-[35%] max-h-[85vh] bg-black/60 rounded-lg p-4 overflow-y-auto cursor-default"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Time range */}
              {prompts[lightboxIndex].startSeconds !== undefined && prompts[lightboxIndex].endSeconds !== undefined && (
                <div className="text-white/50 text-xs mb-3 font-mono">
                  {Math.floor(prompts[lightboxIndex].startSeconds! / 60)}:{String(Math.floor(prompts[lightboxIndex].startSeconds! % 60)).padStart(2, '0')}
                  {' → '}
                  {Math.floor(prompts[lightboxIndex].endSeconds! / 60)}:{String(Math.floor(prompts[lightboxIndex].endSeconds! % 60)).padStart(2, '0')}
                </div>
              )}

              {/* Scene description / prompt */}
              <div className="mb-4">
                <div className="text-white/50 text-xs uppercase tracking-wide mb-1">Image Prompt</div>
                <p className="text-white/80 text-sm leading-relaxed">
                  {prompts[lightboxIndex].sceneDescription || prompts[lightboxIndex].prompt}
                </p>
              </div>

              {/* Matching audio/script text */}
              {srtContent && prompts[lightboxIndex].startSeconds !== undefined && prompts[lightboxIndex].endSeconds !== undefined && (
                <div>
                  <div className="text-white/50 text-xs uppercase tracking-wide mb-1">Audio Script</div>
                  <p className="text-white text-sm leading-relaxed">
                    {extractSrtTextForTimeRange(
                      srtContent,
                      prompts[lightboxIndex].startSeconds!,
                      prompts[lightboxIndex].endSeconds!
                    ) || 'No matching audio for this time range'}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>,
      document.body
    )}
  </>
  );
}
