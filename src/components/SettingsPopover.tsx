import React, { useState } from "react";
import { Settings, X } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { VoiceSampleUpload } from "@/components/VoiceSampleUpload";
import type { ScriptTemplate, ImageTemplate } from "@/components/ConfigModal";

export interface GenerationSettings {
  projectTitle: string;
  topic: string;  // Specific topic focus (e.g., "Viking Winters", "History of Bread", "Cleopatra")
  fullAutomation: boolean;
  modernKeywordFilter: boolean;  // Filter anachronistic/modern keywords from image prompts
  scriptTemplate: string;
  imageTemplate: string;
  customStylePrompt?: string;  // Custom image style prompt (overrides template)
  aiModel: string;
  voiceSampleUrl: string | null;
  speed: number;
  imageCount: number;
  wordCount: number;
  quality: string;
  customScript?: string;
  // TTS settings
  ttsEmotionMarker: string;
  ttsTemperature: number;
  ttsTopP: number;
  ttsRepetitionPenalty: number;
}

// Available emotion/tone markers for Fish Speech
export const TTS_EMOTION_MARKERS = [
  { value: "(sincere) (soft tone)", label: "Sincere & Soft (Documentary)" },
  { value: "(engaging)", label: "Engaging" },
  { value: "(excited)", label: "Excited" },
  { value: "(confident)", label: "Confident" },
  { value: "(calm)", label: "Calm" },
  { value: "(serious)", label: "Serious" },
  { value: "(warm)", label: "Warm" },
  { value: "(dramatic)", label: "Dramatic" },
  { value: "(whispering)", label: "Whispering" },
  { value: "(storytelling)", label: "Storytelling" },
  { value: "none", label: "None (Default)" },
];


interface SettingsPopoverProps {
  settings: GenerationSettings;
  onSettingsChange: (settings: GenerationSettings) => void;
  scriptTemplates: ScriptTemplate[];
  imageTemplates: ImageTemplate[];
}

const defaultScriptLabels: Record<string, string> = {
  "template-a": "Complete Histories",
  "template-b": "Lost Epoch",
  "template-c": "Basic Documentary",
};

const defaultImageLabels: Record<string, string> = {
  "image-a": "Dutch Golden Age",
  "image-b": "Italian Renaissance",
  "image-c": "Medieval Style",
};

export function SettingsPopover({
  settings,
  onSettingsChange,
  scriptTemplates,
  imageTemplates,
}: SettingsPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [localSettings, setLocalSettings] = useState(settings);

  // Sync local settings when props change (but not when modal is open)
  React.useEffect(() => {
    if (!isOpen) {
      setLocalSettings(settings);
    }
  }, [settings, isOpen]);

  const scriptTemplateOptions = scriptTemplates.map((template) => ({
    value: template.id,
    label: template.name || defaultScriptLabels[template.id] || template.id,
  }));

  const imageTemplateOptions = imageTemplates.map((template) => ({
    value: template.id,
    label: template.name || defaultImageLabels[template.id] || template.id,
  }));

  const updateSetting = <K extends keyof GenerationSettings>(
    key: K,
    value: GenerationSettings[K]
  ) => {
    setLocalSettings(prev => ({ ...prev, [key]: value }));
  };

  const handleClose = () => {
    onSettingsChange(localSettings);
    setIsOpen(false);
  };

  return (
    <Dialog open={isOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setIsOpen(true)}
          className={`shrink-0 transition-colors ${
            isOpen
              ? "bg-primary text-primary-foreground hover:bg-primary/90"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Settings className="w-5 h-5" />
        </Button>
      </DialogTrigger>
      <DialogContent
        className="sm:max-w-md"
        hideCloseButton
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={() => handleClose()}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center justify-center gap-2 text-primary">
            <Settings className="w-4 h-4" />
            <span className="text-sm font-semibold tracking-wide uppercase">
              Generation Settings
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-4 px-1 max-h-[70vh] overflow-y-auto">
          {/* Custom Script Input */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-center block">
              Paste Your Own Script (Optional):
            </label>
            <p className="text-xs text-muted-foreground text-center">
              Skip YouTube fetch and AI rewriting - go straight to audio generation
            </p>
            <Textarea
              placeholder="Paste your pre-written script here to skip the transcript and rewriting steps..."
              value={localSettings.customScript || ""}
              onChange={(e) => updateSetting("customScript", e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              className="min-h-[120px] resize-y"
            />
            {localSettings.customScript && localSettings.customScript.trim().length > 0 && (
              <p className="text-xs text-primary text-center">
                ✓ Custom script ready ({localSettings.customScript.trim().split(/\s+/).length} words)
              </p>
            )}
          </div>

          {/* Script Template */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-center block">
              Script Template:
            </label>
            <p className="text-xs text-muted-foreground text-center">
              {localSettings.customScript && localSettings.customScript.trim().length > 0
                ? "(Ignored when using custom script)"
                : "Voice, structure, and style for the script"}
            </p>
            <Select
              value={localSettings.scriptTemplate}
              onValueChange={(value) => updateSetting("scriptTemplate", value)}
              disabled={!!(localSettings.customScript && localSettings.customScript.trim().length > 0)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a template" />
              </SelectTrigger>
              <SelectContent>
                {scriptTemplateOptions.map((template) => (
                  <SelectItem key={template.value} value={template.value}>
                    {template.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Image Template */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-center block">
              Image Style:
            </label>
            <p className="text-xs text-muted-foreground text-center">
              Visual style for generated images
            </p>
            <Select
              value={localSettings.imageTemplate}
              onValueChange={(value) => updateSetting("imageTemplate", value)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select an image style" />
              </SelectTrigger>
              <SelectContent>
                {imageTemplateOptions.map((template) => (
                  <SelectItem key={template.value} value={template.value}>
                    {template.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Voice Sample Upload */}
          <VoiceSampleUpload
            voiceSampleUrl={localSettings.voiceSampleUrl}
            onVoiceSampleChange={(url) => updateSetting("voiceSampleUrl", url)}
          />

          {/* Speed */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-center block">
              Select Your Speed:
            </label>
            <div className="px-3 py-3 bg-secondary/50 rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-muted-foreground">Speed</span>
                <span className="text-sm font-medium">{localSettings.speed.toFixed(2)}x</span>
              </div>
              <Slider
                value={[localSettings.speed]}
                onValueChange={(value) => updateSetting("speed", value[0])}
                min={0.6}
                max={1}
                step={0.05}
                className="w-full"
              />
              <div className="flex justify-between text-xs text-muted-foreground mt-1">
                <span>0.6x</span>
                <span>0.8x</span>
                <span>1x</span>
              </div>
            </div>
          </div>

          {/* TTS Voice Style */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-center block">
              Voice Style:
            </label>
            <p className="text-xs text-muted-foreground text-center">
              Emotion/tone marker for TTS narration
            </p>
            <Select
              value={localSettings.ttsEmotionMarker ?? "(sincere) (soft tone)"}
              onValueChange={(value) => updateSetting("ttsEmotionMarker", value)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select voice style" />
              </SelectTrigger>
              <SelectContent>
                {TTS_EMOTION_MARKERS.map((marker) => (
                  <SelectItem key={marker.value || "none"} value={marker.value}>
                    {marker.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* TTS Temperature */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-center block">
              Voice Expressiveness:
            </label>
            <div className="px-3 py-3 bg-secondary/50 rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-muted-foreground">Temperature</span>
                <span className="text-sm font-medium">{(localSettings.ttsTemperature ?? 0.9).toFixed(2)}</span>
              </div>
              <Slider
                value={[localSettings.ttsTemperature ?? 0.9]}
                onValueChange={(value) => updateSetting("ttsTemperature", value[0])}
                min={0.1}
                max={1.0}
                step={0.05}
                className="w-full"
              />
              <div className="flex justify-between text-xs text-muted-foreground mt-1">
                <span>Monotone</span>
                <span>Expressive</span>
              </div>
            </div>
          </div>

          {/* TTS Top-P */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-center block">
              Voice Variation:
            </label>
            <div className="px-3 py-3 bg-secondary/50 rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-muted-foreground">Top-P</span>
                <span className="text-sm font-medium">{(localSettings.ttsTopP ?? 0.85).toFixed(2)}</span>
              </div>
              <Slider
                value={[localSettings.ttsTopP ?? 0.85]}
                onValueChange={(value) => updateSetting("ttsTopP", value[0])}
                min={0.1}
                max={1.0}
                step={0.05}
                className="w-full"
              />
              <div className="flex justify-between text-xs text-muted-foreground mt-1">
                <span>Consistent</span>
                <span>Varied</span>
              </div>
            </div>
          </div>

          {/* TTS Repetition Penalty */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-center block">
              Repetition Prevention:
            </label>
            <div className="px-3 py-3 bg-secondary/50 rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-muted-foreground">Penalty</span>
                <span className="text-sm font-medium">{(localSettings.ttsRepetitionPenalty ?? 1.1).toFixed(2)}</span>
              </div>
              <Slider
                value={[localSettings.ttsRepetitionPenalty ?? 1.1]}
                onValueChange={(value) => updateSetting("ttsRepetitionPenalty", value[0])}
                min={0.9}
                max={2.0}
                step={0.1}
                className="w-full"
              />
              <div className="flex justify-between text-xs text-muted-foreground mt-1">
                <span>0.9 (Natural)</span>
                <span>2.0 (Strong)</span>
              </div>
            </div>
          </div>

        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} className="w-full">
            <X className="w-4 h-4 mr-2" />
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
