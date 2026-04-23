import { useState, useRef } from "react";
import { Upload, X, Play, Pause, Loader2, Mic } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";

interface VoiceSampleUploadProps {
  voiceSampleUrl: string | null;
  onVoiceSampleChange: (url: string | null) => void;
}

export function VoiceSampleUpload({ voiceSampleUrl, onVoiceSampleChange }: VoiceSampleUploadProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    const validTypes = ['audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/x-wav', 'audio/wave'];
    if (!validTypes.includes(file.type) && !file.name.endsWith('.wav') && !file.name.endsWith('.mp3')) {
      toast({
        title: "Invalid File Type",
        description: "Please upload a WAV or MP3 audio file.",
        variant: "destructive",
      });
      return;
    }

    // Validate file size (max 10MB)
    if (file.size > 10 * 1024 * 1024) {
      toast({
        title: "File Too Large",
        description: "Please upload an audio file under 10MB.",
        variant: "destructive",
      });
      return;
    }

    setIsUploading(true);
    try {
      const fileName = `voice-sample-${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
      
      const { error: uploadError } = await supabase.storage
        .from('voice-samples')
        .upload(fileName, file, {
          contentType: file.type,
          upsert: true,
        });

      if (uploadError) {
        throw uploadError;
      }

      const { data: urlData } = supabase.storage
        .from('voice-samples')
        .getPublicUrl(fileName);

      onVoiceSampleChange(urlData.publicUrl);
      toast({
        title: "Voice Sample Uploaded",
        description: "Your voice sample is ready for cloning.",
      });
    } catch (error) {
      console.error('Upload error:', error);
      toast({
        title: "Upload Failed",
        description: error instanceof Error ? error.message : "Failed to upload voice sample.",
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleRemove = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      setIsPlaying(false);
    }
    onVoiceSampleChange(null);
  };

  const togglePlayback = () => {
    if (!voiceSampleUrl) return;

    // Create new audio element if none exists or URL changed
    if (!audioRef.current || audioRef.current.src !== voiceSampleUrl) {
      if (audioRef.current) {
        audioRef.current.pause();
      }
      audioRef.current = new Audio(voiceSampleUrl);
      audioRef.current.onended = () => setIsPlaying(false);
      audioRef.current.onerror = (e) => {
        console.error('[VoiceSampleUpload] Audio error:', e);
        setIsPlaying(false);
        toast({
          title: "Playback Error",
          description: "Failed to play voice sample. The file may be unavailable.",
          variant: "destructive",
        });
      };
    }

    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play().catch((error) => {
        console.error('[VoiceSampleUpload] Play error:', error);
        setIsPlaying(false);
      });
      setIsPlaying(true);
    }
  };

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium text-center block">
        Voice Sample for Cloning:
      </label>
      
      {voiceSampleUrl ? (
        <div className="flex items-center gap-2 bg-secondary/50 rounded-lg px-3 py-2">
          <Mic className="w-4 h-4 text-primary shrink-0" />
          <span className="text-sm truncate flex-1">Voice sample uploaded</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={togglePlayback}
          >
            {isPlaying ? (
              <Pause className="w-4 h-4" />
            ) : (
              <Play className="w-4 h-4" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-destructive hover:text-destructive"
            onClick={handleRemove}
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      ) : (
        <div
          className="border-2 border-dashed border-border rounded-lg p-4 text-center cursor-pointer hover:border-primary/50 hover:bg-secondary/30 transition-colors"
          onClick={() => fileInputRef.current?.click()}
        >
          {isUploading ? (
            <div className="flex flex-col items-center gap-2">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
              <span className="text-sm text-muted-foreground">Uploading...</span>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <Upload className="w-6 h-6 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                Upload a 5-10 second voice sample
              </span>
              <span className="text-xs text-muted-foreground">
                WAV or MP3 (max 10MB)
              </span>
            </div>
          )}
        </div>
      )}
      
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/wav,audio/mp3,audio/mpeg,.wav,.mp3"
        className="hidden"
        onChange={handleFileSelect}
      />
      
      <p className="text-xs text-muted-foreground text-center">
        AI will clone this voice for narration
      </p>
    </div>
  );
}
