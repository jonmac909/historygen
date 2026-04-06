import { useState } from "react";
import { Settings, FileText, Image, Mic } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { VoiceSampleUpload } from "@/components/VoiceSampleUpload";
import { TTS_EMOTION_MARKERS, type GenerationSettings } from "@/components/SettingsPopover";

export interface ScriptTemplate {
  id: string;
  template: string;
  name?: string;
}

export interface ImageTemplate {
  id: string;
  template: string;
  name?: string;
}

export interface CartesiaVoice {
  id: string;
  name: string;
  voiceId: string;
  referenceAudioUrl?: string;
  isCustom?: boolean;
  category?: string;
  previewUrl?: string;
}

interface ConfigModalProps {
  scriptTemplates: ScriptTemplate[];
  onSaveScriptTemplates: (templates: ScriptTemplate[]) => void;
  imageTemplates: ImageTemplate[];
  onSaveImageTemplates: (templates: ImageTemplate[]) => void;
  cartesiaVoices: CartesiaVoice[];
  onSaveVoices: (voices: CartesiaVoice[]) => void;
  // Voice settings (part of GenerationSettings)
  voiceSettings?: {
    voiceSampleUrl: string | null;
    ttsEmotionMarker: string;
    ttsTemperature: number;
    ttsTopP: number;
    ttsRepetitionPenalty: number;
    speed: number;
  };
  onVoiceSettingsChange?: (settings: Partial<GenerationSettings>) => void;
}

export function ConfigModal({
  scriptTemplates,
  onSaveScriptTemplates,
  imageTemplates,
  onSaveImageTemplates,
  cartesiaVoices,
  onSaveVoices,
  voiceSettings,
  onVoiceSettingsChange,
}: ConfigModalProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [scripts, setScripts] = useState<ScriptTemplate[]>(scriptTemplates);
  const [images, setImages] = useState<ImageTemplate[]>(imageTemplates);
  const [voices, setVoices] = useState<CartesiaVoice[]>(cartesiaVoices);

  // Local voice settings state
  const [localVoiceSettings, setLocalVoiceSettings] = useState(voiceSettings || {
    voiceSampleUrl: null,
    ttsEmotionMarker: "(sincere) (soft tone)",
    ttsTemperature: 0.9,
    ttsTopP: 0.85,
    ttsRepetitionPenalty: 1.1,
    speed: 1,
  });

  // Sync voice settings when modal opens
  const handleOpenChange = (open: boolean) => {
    if (open && voiceSettings) {
      setLocalVoiceSettings(voiceSettings);
    }
    setIsOpen(open);
  };

  const handleSave = () => {
    onSaveScriptTemplates(scripts);
    onSaveImageTemplates(images);
    onSaveVoices(voices);
    // Save voice settings
    if (onVoiceSettingsChange) {
      onVoiceSettingsChange(localVoiceSettings);
    }
    setIsOpen(false);
  };

  const updateVoiceSetting = <K extends keyof typeof localVoiceSettings>(
    key: K,
    value: typeof localVoiceSettings[K]
  ) => {
    setLocalVoiceSettings(prev => ({ ...prev, [key]: value }));
  };

  const updateScriptTemplate = (id: string, field: keyof ScriptTemplate, value: string) => {
    setScripts(prev => prev.map(t =>
      t.id === id ? { ...t, [field]: value } : t
    ));
  };

  const updateImageTemplate = (id: string, field: keyof ImageTemplate, value: string) => {
    setImages(prev => prev.map(t =>
      t.id === id ? { ...t, [field]: value } : t
    ));
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground hover:text-foreground">
          <Settings className="w-4 h-4" />
          <span className="hidden sm:inline">Templates</span>
        </Button>
      </DialogTrigger>
      <DialogContent
        className="sm:max-w-2xl max-h-[85vh] overflow-y-auto"
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="w-5 h-5 text-primary" />
            Configuration
          </DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="script" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="script">Script</TabsTrigger>
            <TabsTrigger value="image">Image</TabsTrigger>
            <TabsTrigger value="voice">Voice</TabsTrigger>
          </TabsList>

          {/* Script Templates Tab */}
          <TabsContent value="script" className="space-y-6 py-4">
            <p className="text-sm text-muted-foreground">
              Configure script templates to define the voice and structure for narration.
            </p>

            {scripts.map((script, index) => {
              const defaultName = `Template ${String.fromCharCode(65 + index)}`;
              return (
                <div key={script.id} className="space-y-3 p-4 border border-border rounded-lg">
                  <div className="flex items-center gap-2">
                    <FileText className="w-4 h-4 text-primary" />
                    <span className="font-medium">{script.name || defaultName}</span>
                  </div>

                  <div className="space-y-2">
                    <Label>Template Name</Label>
                    <Input
                      value={script.name || ""}
                      onChange={(e) => updateScriptTemplate(script.id, "name", e.target.value)}
                      placeholder={defaultName}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Template Instructions</Label>
                    <Textarea
                      value={script.template}
                      onChange={(e) => updateScriptTemplate(script.id, "template", e.target.value)}
                      placeholder="Describe the voice, approach, and techniques..."
                      className="min-h-[150px]"
                    />
                  </div>
                </div>
              );
            })}
          </TabsContent>

          {/* Image Templates Tab */}
          <TabsContent value="image" className="space-y-6 py-4">
            <p className="text-sm text-muted-foreground">
              Configure image templates to define the visual style for generated images.
            </p>

            {images.map((template, index) => {
              const defaultName = `Image Style ${String.fromCharCode(65 + index)}`;
              return (
                <div key={template.id} className="space-y-3 p-4 border border-border rounded-lg">
                  <div className="flex items-center gap-2">
                    <Image className="w-4 h-4 text-primary" />
                    <span className="font-medium">{template.name || defaultName}</span>
                  </div>

                  <div className="space-y-2">
                    <Label>Template Name</Label>
                    <Input
                      value={template.name || ""}
                      onChange={(e) => updateImageTemplate(template.id, "name", e.target.value)}
                      placeholder={defaultName}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Style Prompt</Label>
                    <Textarea
                      value={template.template}
                      onChange={(e) => updateImageTemplate(template.id, "template", e.target.value)}
                      placeholder="e.g., Cinematic, dramatic lighting, 4K quality, photorealistic..."
                      className="min-h-[150px]"
                    />
                  </div>
                </div>
              );
            })}
          </TabsContent>

          {/* Voice Settings Tab */}
          <TabsContent value="voice" className="space-y-6 py-4">
            <p className="text-sm text-muted-foreground">
              Configure voice settings for TTS narration.
            </p>

            <div className="space-y-6 p-4 border border-border rounded-lg">
              <div className="flex items-center gap-2 mb-4">
                <Mic className="w-4 h-4 text-primary" />
                <span className="font-medium">Voice Configuration</span>
              </div>

              {/* Voice Sample Upload */}
              <VoiceSampleUpload
                voiceSampleUrl={localVoiceSettings.voiceSampleUrl}
                onVoiceSampleChange={(url) => updateVoiceSetting("voiceSampleUrl", url)}
              />

              {/* Voice Style */}
              <div className="space-y-2">
                <Label>Voice Style</Label>
                <p className="text-xs text-muted-foreground">
                  Emotion/tone marker for TTS narration
                </p>
                <Select
                  value={localVoiceSettings.ttsEmotionMarker ?? "(sincere) (soft tone)"}
                  onValueChange={(value) => updateVoiceSetting("ttsEmotionMarker", value)}
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

              {/* Speed */}
              <div className="space-y-2">
                <Label>Speech Speed</Label>
                <div className="px-3 py-3 bg-secondary/50 rounded-lg">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-muted-foreground">Speed</span>
                    <span className="text-sm font-medium">{localVoiceSettings.speed.toFixed(2)}x</span>
                  </div>
                  <Slider
                    value={[localVoiceSettings.speed]}
                    onValueChange={(value) => updateVoiceSetting("speed", value[0])}
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

              {/* Voice Expressiveness (Temperature) */}
              <div className="space-y-2">
                <Label>Voice Expressiveness</Label>
                <div className="px-3 py-3 bg-secondary/50 rounded-lg">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-muted-foreground">Temperature</span>
                    <span className="text-sm font-medium">{(localVoiceSettings.ttsTemperature ?? 0.9).toFixed(2)}</span>
                  </div>
                  <Slider
                    value={[localVoiceSettings.ttsTemperature ?? 0.9]}
                    onValueChange={(value) => updateVoiceSetting("ttsTemperature", value[0])}
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

              {/* Voice Variation (Top-P) */}
              <div className="space-y-2">
                <Label>Voice Variation</Label>
                <div className="px-3 py-3 bg-secondary/50 rounded-lg">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-muted-foreground">Top-P</span>
                    <span className="text-sm font-medium">{(localVoiceSettings.ttsTopP ?? 0.85).toFixed(2)}</span>
                  </div>
                  <Slider
                    value={[localVoiceSettings.ttsTopP ?? 0.85]}
                    onValueChange={(value) => updateVoiceSetting("ttsTopP", value[0])}
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

              {/* Repetition Prevention */}
              <div className="space-y-2">
                <Label>Repetition Prevention</Label>
                <div className="px-3 py-3 bg-secondary/50 rounded-lg">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-muted-foreground">Penalty</span>
                    <span className="text-sm font-medium">{(localVoiceSettings.ttsRepetitionPenalty ?? 1.1).toFixed(2)}</span>
                  </div>
                  <Slider
                    value={[localVoiceSettings.ttsRepetitionPenalty ?? 1.1]}
                    onValueChange={(value) => updateVoiceSetting("ttsRepetitionPenalty", value[0])}
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
          </TabsContent>
        </Tabs>

        <div className="flex justify-end gap-2 pt-4 border-t">
          <Button variant="outline" onClick={() => setIsOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave}>
            Save Configuration
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
