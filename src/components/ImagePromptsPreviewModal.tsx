import { useState, useEffect, useMemo } from "react";
import { Check, X, Image as ImageIcon, Edit2, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Download, Palette, RefreshCw, AlertTriangle, Trash2, MapPin, Plus, Minus } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ImageTemplate } from "@/components/ConfigModal";

interface ImagePrompt {
  index: number;
  startTime: string;
  endTime: string;
  startSeconds: number;
  endSeconds: number;
  prompt: string;
  sceneDescription: string;
}

interface ImagePromptsPreviewModalProps {
  isOpen: boolean;
  prompts: ImagePrompt[];
  stylePrompt: string;
  imageTemplates: ImageTemplate[];  // Saved templates from settings
  onConfirm: (editedPrompts: ImagePrompt[], editedStylePrompt: string, topic?: string) => void;
  onCancel: () => void;
  onBack?: () => void;
  onForward?: () => void;
  onRegenerate?: (topic?: string) => void;  // Regenerate prompts with optional topic constraint
  isRegenerating?: boolean;
  topic?: string;  // Era/topic constraint (e.g., "Regency England 1810s")
  onTopicChange?: (topic: string) => void;
  onAddPrompts?: (count: number) => void;  // Add N more prompts to the end
  isAddingPrompts?: boolean;
  existingImageCount?: number;  // How many images already exist (to know which prompts need images)
}

function formatTimecode(time: string | undefined): string {
  // Convert HH-MM-SS to HH:MM:SS for display
  if (!time) return '00:00:00';
  return time.replace(/-/g, ':');
}

interface PromptCardProps {
  prompt: ImagePrompt;
  onUpdate: (updatedPrompt: ImagePrompt) => void;
}

function PromptCard({ prompt, onUpdate }: PromptCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [editedScene, setEditedScene] = useState(prompt.sceneDescription);

  // Sync with prompt changes
  useEffect(() => {
    setEditedScene(prompt.sceneDescription);
  }, [prompt.sceneDescription]);

  const hasChanges = editedScene !== prompt.sceneDescription;

  const handleSave = () => {
    onUpdate({
      ...prompt,
      sceneDescription: editedScene,
      prompt: prompt.prompt ? prompt.prompt.replace(prompt.sceneDescription, editedScene) : editedScene
    });
  };

  const handleReset = () => {
    setEditedScene(prompt.sceneDescription);
  };

  return (
    <div className="border rounded-lg p-4 space-y-3 bg-card">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="font-medium text-lg">Image {prompt.index}</span>
          <span className="text-sm text-muted-foreground">
            {formatTimecode(prompt.startTime)} - {formatTimecode(prompt.endTime)}
          </span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setIsExpanded(!isExpanded)}
          className="h-8 px-2"
        >
          <Edit2 className="w-4 h-4 mr-1" />
          {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </Button>
      </div>

      {isExpanded ? (
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium text-muted-foreground block mb-1">
              Scene Description {hasChanges && <span className="text-yellow-500">(edited)</span>}
            </label>
            <textarea
              value={editedScene}
              onChange={(e) => setEditedScene(e.target.value)}
              className="w-full min-h-[100px] p-3 text-sm bg-background border rounded resize-y"
              placeholder="Describe the visual scene..."
            />
          </div>

          {hasChanges && (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={handleReset}>
                Reset
              </Button>
              <Button size="sm" onClick={handleSave}>
                Apply Changes
              </Button>
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground line-clamp-3">
          {editedScene}
        </p>
      )}
    </div>
  );
}

export function ImagePromptsPreviewModal({
  isOpen,
  prompts,
  stylePrompt,
  imageTemplates,
  onConfirm,
  onCancel,
  onBack,
  onForward,
  onRegenerate,
  isRegenerating = false,
  topic = '',
  onTopicChange,
  onAddPrompts,
  isAddingPrompts = false,
  existingImageCount = 0
}: ImagePromptsPreviewModalProps) {
  const [editedPrompts, setEditedPrompts] = useState<ImagePrompt[]>(prompts);
  const [editedTopic, setEditedTopic] = useState(topic);
  const [promptsToAdd, setPromptsToAdd] = useState(12);  // Default to 12 (video clip count)

  // Pagination for large prompt lists (prevents stack overflow with 500+ items)
  const PROMPTS_PER_PAGE = 20;
  const [currentPage, setCurrentPage] = useState(0);
  const totalPages = Math.ceil(editedPrompts.length / PROMPTS_PER_PAGE);
  const visiblePrompts = editedPrompts.slice(
    currentPage * PROMPTS_PER_PAGE,
    (currentPage + 1) * PROMPTS_PER_PAGE
  );

  // Detect if incoming stylePrompt matches a saved template
  const detectStyleKey = (prompt: string): string => {
    const match = imageTemplates.find(t => t.template === prompt);
    if (match) return match.id;
    // If no match and prompt is empty or very short, default to first template
    if (!prompt || prompt.trim().length < 20) return imageTemplates[0]?.id || 'custom';
    return 'custom';
  };

  const [selectedStyleKey, setSelectedStyleKey] = useState<string>(() => detectStyleKey(stylePrompt));
  const [editedStyle, setEditedStyle] = useState(() => {
    // If stylePrompt is empty/short, use first template
    if (!stylePrompt || stylePrompt.trim().length < 20) {
      return imageTemplates[0]?.template || stylePrompt;
    }
    return stylePrompt;
  });

  // Sync with props when prompts change
  useEffect(() => {
    setEditedPrompts(prompts);
    setCurrentPage(0); // Reset to first page when prompts change
  }, [prompts]);

  // Sync style prompt when prop changes (but only if it's substantive)
  useEffect(() => {
    if (stylePrompt && stylePrompt.trim().length >= 20) {
      setEditedStyle(stylePrompt);
      setSelectedStyleKey(detectStyleKey(stylePrompt));
    }
  }, [stylePrompt]);

  // Sync topic when prop changes
  useEffect(() => {
    setEditedTopic(topic);
  }, [topic]);

  // Handle topic change (notify parent immediately)
  const handleTopicChange = (newTopic: string) => {
    setEditedTopic(newTopic);
    if (onTopicChange) {
      onTopicChange(newTopic);
    }
  };

  // Scan for modern/anachronistic terms in prompts
  const MODERN_TERMS = [
    'museum', 'laboratory', 'lab coat', 'scientist', 'researcher', 'display case',
    'microscope', 'magnifying glass', 'academic', 'university', 'professor',
    'modern', 'contemporary', 'facility', 'institution', 'exhibit', 'gallery',
    'archaeological', 'excavation', 'artifact', 'specimen', 'analysis',
    'sterile', 'clinical', 'research', 'study', 'documentation', 'tablet',
    'computer', 'screen', 'digital', 'photograph', 'camera'
  ];

  const promptsWithModernTerms = useMemo(() => {
    const results: { index: number; terms: string[] }[] = [];
    for (const prompt of editedPrompts) {
      const text = prompt.sceneDescription.toLowerCase();
      const foundTerms = MODERN_TERMS.filter(term => text.includes(term.toLowerCase()));
      if (foundTerms.length > 0) {
        results.push({ index: prompt.index, terms: foundTerms });
      }
    }
    return results;
  }, [editedPrompts]);

  // Remove sentences containing modern terms from a prompt
  const cleanModernTermsFromText = (text: string): string => {
    // Split into sentences, filter out those with modern terms
    const sentences = text.split(/(?<=[.!?])\s+/);
    const cleanedSentences = sentences.filter(sentence => {
      const lowerSentence = sentence.toLowerCase();
      return !MODERN_TERMS.some(term => lowerSentence.includes(term.toLowerCase()));
    });
    return cleanedSentences.join(' ').trim();
  };

  // Remove modern terms from a specific prompt
  const handleRemoveModernTerms = (promptIndex: number) => {
    setEditedPrompts(prev => prev.map(p => {
      if (p.index === promptIndex) {
        const newDesc = cleanModernTermsFromText(p.sceneDescription);
        return {
          ...p,
          sceneDescription: newDesc,
          prompt: `${editedStyle}. ${newDesc}`
        };
      }
      return p;
    }));
  };

  // Remove modern terms from all flagged prompts
  const handleRemoveAllModernTerms = () => {
    console.log('[ImagePromptsPreviewModal] Removing modern terms from', promptsWithModernTerms.length, 'prompts');
    setEditedPrompts(prev => prev.map(p => {
      const text = p.sceneDescription.toLowerCase();
      const hasModernTerms = MODERN_TERMS.some(term => text.includes(term));
      if (hasModernTerms) {
        const newDesc = cleanModernTermsFromText(p.sceneDescription);
        console.log(`[ImagePromptsPreviewModal] Cleaned prompt ${p.index}:`, p.sceneDescription.substring(0, 50), '->', newDesc.substring(0, 50));
        return {
          ...p,
          sceneDescription: newDesc,
          prompt: `${editedStyle}. ${newDesc}`
        };
      }
      return p;
    }));
  };

  const handleUpdatePrompt = (updatedPrompt: ImagePrompt) => {
    setEditedPrompts(prev =>
      prev.map(p => p.index === updatedPrompt.index ? updatedPrompt : p)
    );
  };

  const handleConfirm = () => {
    // Rebuild prompts with the current style
    const finalPrompts = editedPrompts.map(p => ({
      ...p,
      prompt: `${editedStyle}. ${p.sceneDescription}`
    }));
    onConfirm(finalPrompts, editedStyle);
  };

  // Handle style preset selection
  const handleStyleSelect = (styleKey: string) => {
    setSelectedStyleKey(styleKey);
    if (styleKey === 'custom') {
      // Keep current editedStyle for custom editing
    } else {
      const template = imageTemplates.find(t => t.id === styleKey);
      if (template) {
        setEditedStyle(template.template);
      }
    }
  };

  const handleDownload = () => {
    const data = editedPrompts.map(p => ({
      index: p.index,
      startTime: p.startTime,
      endTime: p.endTime,
      sceneDescription: p.sceneDescription,
      prompt: p.prompt
    }));
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'image-prompts.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const editedCount = editedPrompts.filter((p, i) =>
    p.sceneDescription !== prompts[i]?.sceneDescription
  ).length;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-2xl font-bold flex items-center gap-2">
            <ImageIcon className="w-6 h-6 text-primary" />
            Review Image Prompts
            <span className="text-sm font-normal text-muted-foreground ml-2">
              {prompts.length} images
            </span>
          </DialogTitle>
          <DialogDescription>
            Review and edit the scene descriptions before generating images.
            {editedCount > 0 && (
              <span className="text-yellow-500 ml-2">
                ({editedCount} edited)
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        {/* Modern Terms Warning Banner */}
        {promptsWithModernTerms.length > 0 && (
          <div className="border border-yellow-500/50 rounded-lg p-3 bg-yellow-500/10">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-5 h-5 text-yellow-500 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-yellow-600 dark:text-yellow-400">
                    {promptsWithModernTerms.length} prompt{promptsWithModernTerms.length > 1 ? 's' : ''} contain modern/anachronistic terms
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Found: {[...new Set(promptsWithModernTerms.flatMap(p => p.terms))].slice(0, 5).join(', ')}
                    {[...new Set(promptsWithModernTerms.flatMap(p => p.terms))].length > 5 && '...'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Images: {promptsWithModernTerms.map(p => `#${p.index}`).join(', ')}
                  </p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRemoveAllModernTerms}
                className="flex-shrink-0 border-yellow-500/50 hover:bg-yellow-500/20"
              >
                <Trash2 className="w-4 h-4 mr-1" />
                Remove All
              </Button>
            </div>
          </div>
        )}

        {/* Era/Topic Constraint */}
        <div className="border rounded-lg p-3 bg-muted/30">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <MapPin className="w-4 h-4 text-muted-foreground" />
              <div>
                <span className="text-sm font-medium">Era / Topic</span>
                <p className="text-xs text-muted-foreground">Constrains all images to this time period</p>
              </div>
            </div>
            <Input
              value={editedTopic}
              onChange={(e) => handleTopicChange(e.target.value)}
              placeholder="e.g., Regency England 1810s"
              className="w-[250px]"
            />
          </div>
        </div>

        {/* Image Style Selector */}
        <div className="border rounded-lg p-3 bg-muted/30">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <Palette className="w-4 h-4 text-muted-foreground" />
              <div>
                <span className="text-sm font-medium">Painting Style</span>
                <p className="text-xs text-muted-foreground">Visual aesthetic only - doesn't affect era/content</p>
              </div>
            </div>
            <Select value={selectedStyleKey} onValueChange={handleStyleSelect}>
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="Select a style..." />
              </SelectTrigger>
              <SelectContent>
                {imageTemplates.map((template) => (
                  <SelectItem key={template.id} value={template.id}>
                    {template.name}
                  </SelectItem>
                ))}
                <SelectItem value="custom">Custom Style</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Add Prompts Section */}
        {onAddPrompts && (
          <div className="border rounded-lg p-3 bg-muted/30">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <Plus className="w-4 h-4 text-muted-foreground" />
                <div>
                  <span className="text-sm font-medium">Add More Prompts</span>
                  <p className="text-xs text-muted-foreground">
                    {existingImageCount > 0
                      ? `${existingImageCount} images exist, ${editedPrompts.length} prompts total`
                      : 'Append additional image prompts to the end'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setPromptsToAdd(Math.max(1, promptsToAdd - 1))}
                  disabled={promptsToAdd <= 1 || isAddingPrompts}
                >
                  <Minus className="h-4 w-4" />
                </Button>
                <Input
                  type="number"
                  min={1}
                  max={50}
                  value={promptsToAdd}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    if (!isNaN(val) && val >= 1 && val <= 50) {
                      setPromptsToAdd(val);
                    }
                  }}
                  className="w-16 h-8 text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  disabled={isAddingPrompts}
                />
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setPromptsToAdd(Math.min(50, promptsToAdd + 1))}
                  disabled={promptsToAdd >= 50 || isAddingPrompts}
                >
                  <Plus className="h-4 w-4" />
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onAddPrompts(promptsToAdd)}
                  disabled={isAddingPrompts}
                  className="ml-2"
                >
                  {isAddingPrompts ? (
                    <>
                      <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                      Adding...
                    </>
                  ) : (
                    <>
                      <Plus className="w-4 h-4 mr-2" />
                      Add {promptsToAdd}
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Custom Style Prompt Editor - only shown when custom is selected */}
        {selectedStyleKey === 'custom' && (
          <div className="border rounded-lg p-3 bg-muted/30 space-y-2">
            <div className="flex items-center gap-2">
              <Edit2 className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-medium">Custom Style Prompt</span>
            </div>
            <p className="text-xs text-muted-foreground">
              This style is applied to all images. Describe the visual style you want.
            </p>
            <textarea
              value={editedStyle}
              onChange={(e) => setEditedStyle(e.target.value)}
              className="w-full min-h-[120px] p-3 text-sm bg-background border rounded resize-y"
              placeholder="Describe the visual style..."
            />
          </div>
        )}

        <div className="overflow-y-auto max-h-[50vh] py-4 pr-2">
          {/* Pagination controls for large lists */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between mb-3 pb-3 border-b">
              <span className="text-sm text-muted-foreground">
                Showing {currentPage * PROMPTS_PER_PAGE + 1}-{Math.min((currentPage + 1) * PROMPTS_PER_PAGE, editedPrompts.length)} of {editedPrompts.length}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(p => Math.max(0, p - 1))}
                  disabled={currentPage === 0}
                >
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <span className="text-sm">
                  Page {currentPage + 1} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={currentPage >= totalPages - 1}
                >
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            </div>
          )}
          <div className="space-y-3">
            {visiblePrompts.map((prompt) => (
              <PromptCard
                key={prompt.index}
                prompt={prompt}
                onUpdate={handleUpdatePrompt}
              />
            ))}
          </div>
        </div>

        <DialogFooter className="flex-shrink-0 gap-2 sm:gap-2">
          {/* Left side: Navigation + Download + Regenerate */}
          <div className="flex gap-2 mr-auto">
            {onBack && (
              <Button variant="outline" size="icon" onClick={onBack} title="Back to previous step">
                <ChevronLeft className="w-5 h-5" />
              </Button>
            )}
            <Button variant="outline" onClick={handleDownload}>
              <Download className="w-4 h-4 mr-2" />
              Download
            </Button>
            {onRegenerate && (
              <Button variant="outline" onClick={onRegenerate} disabled={isRegenerating}>
                <RefreshCw className={`w-4 h-4 mr-2 ${isRegenerating ? 'animate-spin' : ''}`} />
                {isRegenerating ? 'Regenerating...' : 'Redo Prompts'}
              </Button>
            )}
          </div>

          {/* Right side: Exit + Forward/Continue */}
          <Button variant="outline" onClick={onCancel}>
            <X className="w-4 h-4 mr-2" />
            Exit
          </Button>

          {onForward && (
            <Button variant="outline" onClick={onForward}>
              Images
              <ChevronRight className="w-4 h-4 ml-2" />
            </Button>
          )}
          <Button onClick={handleConfirm}>
            <Check className="w-4 h-4 mr-2" />
            {existingImageCount > 0 && existingImageCount < editedPrompts.length
              ? `Generate ${editedPrompts.length - existingImageCount} New Images`
              : onForward
                ? 'Regenerate All Images'
                : `Generate ${editedPrompts.length} Images`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
