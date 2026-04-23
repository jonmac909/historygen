import { useState, useEffect } from "react";
import { Check, X, Video, Edit2, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Download, RefreshCw } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { ClipPrompt } from "@/lib/api";

interface VideoClipPromptsModalProps {
  isOpen: boolean;
  prompts: ClipPrompt[];
  stylePrompt: string;
  onConfirm: (editedPrompts: ClipPrompt[], editedStylePrompt: string) => void;
  onCancel: () => void;
  onBack?: () => void;
  onRegenerate?: () => void;
  isRegenerating?: boolean;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

interface ClipPromptCardProps {
  prompt: ClipPrompt;
  onUpdate: (updatedPrompt: ClipPrompt) => void;
}

function ClipPromptCard({ prompt, onUpdate }: ClipPromptCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [editedScene, setEditedScene] = useState(prompt.sceneDescription);

  useEffect(() => {
    setEditedScene(prompt.sceneDescription);
  }, [prompt.sceneDescription]);

  const hasChanges = editedScene !== prompt.sceneDescription;

  const handleSave = () => {
    onUpdate({
      ...prompt,
      sceneDescription: editedScene,
      prompt: prompt.prompt.replace(prompt.sceneDescription, editedScene)
    });
  };

  const handleReset = () => {
    setEditedScene(prompt.sceneDescription);
  };

  return (
    <div className="border rounded-lg p-4 space-y-3 bg-card">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Video className="w-4 h-4 text-primary" />
            <span className="font-medium text-lg">Clip {prompt.index}</span>
          </div>
          <span className="text-sm text-muted-foreground">
            {formatTime(prompt.startSeconds)} - {formatTime(prompt.endSeconds)}
          </span>
          <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded">
            {prompt.endSeconds - prompt.startSeconds}s
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
              className="w-full min-h-[120px] p-3 text-sm bg-background border rounded resize-y"
              placeholder="Describe the cinematic video scene with camera movements and motion..."
            />
            <p className="text-xs text-muted-foreground mt-1">
              Include camera movements (dolly, pan, tracking) and motion descriptions for best results.
            </p>
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

export function VideoClipPromptsModal({
  isOpen,
  prompts,
  stylePrompt,
  onConfirm,
  onCancel,
  onBack,
  onRegenerate,
  isRegenerating = false
}: VideoClipPromptsModalProps) {
  const [editedPrompts, setEditedPrompts] = useState<ClipPrompt[]>(prompts);
  const [editedStylePrompt, setEditedStylePrompt] = useState(stylePrompt);
  const [isStyleExpanded, setIsStyleExpanded] = useState(false);

  useEffect(() => {
    setEditedPrompts(prompts);
    setEditedStylePrompt(stylePrompt);
  }, [prompts, stylePrompt]);

  const handleUpdatePrompt = (updatedPrompt: ClipPrompt) => {
    setEditedPrompts(prev =>
      prev.map(p => p.index === updatedPrompt.index ? updatedPrompt : p)
    );
  };

  const handleConfirm = () => {
    // Apply style prompt to all edited prompts
    const finalPrompts = editedPrompts.map(p => ({
      ...p,
      prompt: editedStylePrompt ? `${editedStylePrompt}. ${p.sceneDescription}` : p.sceneDescription
    }));
    onConfirm(finalPrompts, editedStylePrompt);
  };

  const handleDownload = () => {
    const content = editedPrompts.map(p =>
      `Clip ${p.index} (${formatTime(p.startSeconds)} - ${formatTime(p.endSeconds)}):\n${p.sceneDescription}\n`
    ).join('\n---\n\n');

    const blob = new Blob([`Style: ${editedStylePrompt}\n\n${content}`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'video-clip-prompts.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  // Calculate actual duration from clip data
  const clipDuration = editedPrompts.length > 0 ? (editedPrompts[0].endSeconds - editedPrompts[0].startSeconds) : 5;
  const totalDuration = editedPrompts.length * clipDuration;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Video className="w-5 h-5" />
            Video Clip Prompts
          </DialogTitle>
          <DialogDescription>
            Review and edit the {editedPrompts.length} video clip descriptions for your intro sequence ({totalDuration} seconds total).
            Each clip is {clipDuration} seconds long with cinematic camera movements.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 pr-2">
          {/* Master Style Prompt */}
          <div className="border rounded-lg p-4 bg-primary/5">
            <div
              className="flex items-center justify-between cursor-pointer"
              onClick={() => setIsStyleExpanded(!isStyleExpanded)}
            >
              <div className="flex items-center gap-2">
                <span className="font-medium">Master Style Prompt</span>
                <span className="text-xs text-muted-foreground">(applies to all clips)</span>
              </div>
              {isStyleExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </div>

            {isStyleExpanded && (
              <div className="mt-3">
                <textarea
                  value={editedStylePrompt}
                  onChange={(e) => setEditedStylePrompt(e.target.value)}
                  className="w-full min-h-[80px] p-3 text-sm bg-background border rounded resize-y"
                  placeholder="e.g., Historically accurate, immersive first-person perspective, cinematic quality..."
                />
              </div>
            )}
          </div>

          {/* Clip Prompts */}
          <div className="space-y-3">
            {editedPrompts.map(prompt => (
              <ClipPromptCard
                key={prompt.index}
                prompt={prompt}
                onUpdate={handleUpdatePrompt}
              />
            ))}
          </div>
        </div>

        <DialogFooter className="flex-shrink-0 border-t pt-4 mt-4">
          <div className="flex justify-between w-full">
            <div className="flex gap-2">
              {onBack && (
                <Button variant="outline" onClick={onBack}>
                  <ChevronLeft className="w-4 h-4 mr-1" />
                  Back
                </Button>
              )}
              <Button variant="outline" onClick={handleDownload}>
                <Download className="w-4 h-4 mr-1" />
                Download
              </Button>
              {onRegenerate && (
                <Button
                  variant="outline"
                  onClick={onRegenerate}
                  disabled={isRegenerating}
                >
                  <RefreshCw className={`w-4 h-4 mr-1 ${isRegenerating ? 'animate-spin' : ''}`} />
                  Regenerate
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={onCancel}>
                <X className="w-4 h-4 mr-1" />
                Cancel
              </Button>
              <Button onClick={handleConfirm}>
                <Check className="w-4 h-4 mr-1" />
                Generate Clips
                <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
