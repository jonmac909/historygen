import { useState, useRef, useEffect } from "react";
import {
  Loader2,
  ChevronLeft,
  ChevronRight,
  X,
  Play,
  Pause,
  RefreshCw,
  Upload,
  Check,
  Youtube,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import { Progress } from "@/components/ui/progress";
import {
  getValidAccessToken,
  checkYouTubeConnection,
  authenticateYouTube,
} from "@/lib/youtubeAuth";
import { uploadShortToYouTube } from "@/lib/api";

interface ShortPreviewModalProps {
  isOpen: boolean;
  projectId: string;
  shortUrl: string;
  duration: number;
  hookStyle: string;
  onComplete: () => void;
  onCancel: () => void;
  onBack?: () => void;
  onSkip?: () => void;
  onRegenerate?: () => void;
}

export function ShortPreviewModal({
  isOpen,
  projectId,
  shortUrl,
  duration,
  hookStyle,
  onComplete,
  onCancel,
  onBack,
  onSkip,
  onRegenerate,
}: ShortPreviewModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadMessage, setUploadMessage] = useState("");
  const [isConnected, setIsConnected] = useState<boolean | null>(null);
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(null);

  // Check YouTube connection on open
  useEffect(() => {
    if (isOpen) {
      checkConnection();
      // Auto-play video when modal opens
      if (videoRef.current) {
        videoRef.current.play().catch(() => {});
      }
    }
  }, [isOpen]);

  // Reset when modal closes
  useEffect(() => {
    if (!isOpen) {
      setIsPlaying(false);
      setIsUploading(false);
      setUploadProgress(0);
      setUploadMessage("");
      setUploadedUrl(null);
    }
  }, [isOpen]);

  const checkConnection = async () => {
    const connected = await checkYouTubeConnection();
    setIsConnected(connected);
  };

  const handleConnect = async () => {
    const success = await authenticateYouTube();
    if (success) {
      setIsConnected(true);
      toast({
        title: "Connected to YouTube",
        description: "You can now upload your Short",
      });
    }
  };

  const handleTogglePlay = () => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        videoRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const handleUpload = async () => {
    if (!isConnected) {
      toast({
        title: "Not connected",
        description: "Please connect to YouTube first",
        variant: "destructive",
      });
      return;
    }

    setIsUploading(true);
    setUploadProgress(0);
    setUploadMessage("Preparing upload...");

    try {
      const accessToken = await getValidAccessToken();
      if (!accessToken) {
        throw new Error("Could not get YouTube access token");
      }

      setUploadMessage("Uploading to YouTube Shorts...");
      setUploadProgress(25);

      const result = await uploadShortToYouTube(
        projectId,
        accessToken,
        (progress) => {
          setUploadProgress(progress);
          if (progress < 50) {
            setUploadMessage("Uploading video...");
          } else if (progress < 90) {
            setUploadMessage("Processing...");
          } else {
            setUploadMessage("Finalizing...");
          }
        }
      );

      if (result.success && result.youtubeUrl) {
        setUploadedUrl(result.youtubeUrl);
        setUploadProgress(100);
        setUploadMessage("Upload complete!");

        toast({
          title: "Short Uploaded!",
          description: "Your YouTube Short has been published",
        });

        // Wait a moment before completing
        setTimeout(() => {
          onComplete();
        }, 1500);
      } else {
        throw new Error(result.error || "Upload failed");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setUploadMessage(`Error: ${message}`);

      toast({
        title: "Upload Failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      if (!uploadedUrl) {
        setIsUploading(false);
      }
    }
  };

  const hookLabels: Record<string, string> = {
    story: "Story Hook",
    didyouknow: "Did You Know",
    question: "Question Hook",
    contrast: "Contrast Hook",
  };

  return (
    <Dialog open={isOpen}>
      <DialogContent
        className="sm:max-w-lg"
        hideCloseButton
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Youtube className="w-5 h-5 text-red-500" />
            Short Preview
          </DialogTitle>
          <DialogDescription>
            Review your YouTube Short before uploading
          </DialogDescription>
        </DialogHeader>

        <div className="py-4 space-y-4">
          {/* Video player - 9:16 aspect ratio */}
          <div className="relative mx-auto" style={{ maxWidth: "280px" }}>
            <div
              className="relative rounded-lg overflow-hidden bg-black"
              style={{ aspectRatio: "9/16" }}
            >
              <video
                ref={videoRef}
                src={shortUrl}
                className="w-full h-full object-cover"
                playsInline
                loop
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
              />

              {/* Play/Pause overlay */}
              <button
                onClick={handleTogglePlay}
                className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 hover:opacity-100 transition-opacity"
              >
                {isPlaying ? (
                  <Pause className="w-12 h-12 text-white" />
                ) : (
                  <Play className="w-12 h-12 text-white" />
                )}
              </button>
            </div>

            {/* Video info */}
            <div className="mt-2 text-center text-sm text-muted-foreground">
              <p>{hookLabels[hookStyle] || hookStyle} | {duration.toFixed(1)}s</p>
              <p className="text-xs">1080 x 1920</p>
            </div>
          </div>

          {/* Upload progress */}
          {isUploading && (
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{uploadMessage}</span>
                <span className="font-medium">{uploadProgress}%</span>
              </div>
              <Progress value={uploadProgress} className="h-2" />
            </div>
          )}

          {/* Upload success */}
          {uploadedUrl && (
            <div className="flex items-center justify-center gap-2 p-3 rounded-lg bg-green-500/10 border border-green-500/50">
              <Check className="w-5 h-5 text-green-500" />
              <a
                href={uploadedUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-green-600 hover:underline"
              >
                View on YouTube
              </a>
            </div>
          )}

          {/* YouTube connection status */}
          {!isConnected && isConnected !== null && (
            <div className="flex items-center justify-center gap-2">
              <Button variant="outline" onClick={handleConnect}>
                <Youtube className="w-4 h-4 mr-2 text-red-500" />
                Connect YouTube to Upload
              </Button>
            </div>
          )}
        </div>

        <DialogFooter className="flex-shrink-0 gap-2 sm:gap-2">
          {/* Left side: Navigation */}
          <div className="flex gap-2 mr-auto">
            {onBack && !isUploading && (
              <Button variant="outline" size="icon" onClick={onBack} title="Back to Hook Selection">
                <ChevronLeft className="w-5 h-5" />
              </Button>
            )}
            {onSkip && !isUploading && (
              <Button variant="outline" size="icon" onClick={onSkip} title="Skip to Results">
                <ChevronRight className="w-5 h-5" />
              </Button>
            )}
            {onRegenerate && !isUploading && (
              <Button variant="outline" onClick={onRegenerate} title="Generate with different hook">
                <RefreshCw className="w-4 h-4 mr-2" />
                Regenerate
              </Button>
            )}
          </div>

          {/* Right side: Exit + Upload */}
          {!uploadedUrl && (
            <>
              <Button variant="outline" onClick={onCancel} disabled={isUploading}>
                <X className="w-4 h-4 mr-2" />
                Exit
              </Button>

              <Button
                onClick={handleUpload}
                disabled={!isConnected || isUploading}
              >
                {isUploading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Uploading...
                  </>
                ) : (
                  <>
                    <Upload className="w-4 h-4 mr-2" />
                    Upload Short
                  </>
                )}
              </Button>
            </>
          )}

          {uploadedUrl && (
            <Button onClick={onComplete}>
              <Check className="w-4 h-4 mr-2" />
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
