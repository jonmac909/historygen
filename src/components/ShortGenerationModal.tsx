import { useState, useEffect, useRef } from "react";
import {
  Loader2,
  ChevronLeft,
  X,
  Check,
  Mic,
  FileText,
  Image,
  Video,
  Sparkles,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/hooks/use-toast";
import { generateShortStreaming, type ShortGenerationProgress } from "@/lib/api";

interface ShortGenerationModalProps {
  isOpen: boolean;
  projectId: string;
  hookStyle: string;
  shortScript: string;
  voiceSampleUrl: string;
  settings?: {
    ttsEmotionMarker?: string;
    ttsTemperature?: number;
    ttsTopP?: number;
    ttsRepetitionPenalty?: number;
  };
  onComplete: (result: {
    shortUrl: string;
    audioUrl: string;
    srtContent: string;
    imageUrls: string[];
    duration: number;
  }) => void;
  onCancel: () => void;
  onBack?: () => void;
}

interface GenerationStep {
  id: string;
  label: string;
  icon: React.ElementType;
  status: "pending" | "in_progress" | "complete" | "error";
}

export function ShortGenerationModal({
  isOpen,
  projectId,
  hookStyle,
  shortScript,
  voiceSampleUrl,
  settings,
  onComplete,
  onCancel,
  onBack,
}: ShortGenerationModalProps) {
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("Starting generation...");
  const [currentStep, setCurrentStep] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const hasStartedRef = useRef(false);

  const [steps, setSteps] = useState<GenerationStep[]>([
    { id: "tts", label: "Generating voiceover", icon: Mic, status: "pending" },
    { id: "captions", label: "Generating captions", icon: FileText, status: "pending" },
    { id: "prompts", label: "Planning images", icon: Sparkles, status: "pending" },
    { id: "images", label: "Sourcing images", icon: Image, status: "pending" },
    { id: "render", label: "Rendering video", icon: Video, status: "pending" },
    { id: "save", label: "Saving to project", icon: Check, status: "pending" },
  ]);

  // Update step status
  const updateStepStatus = (stepId: string, status: GenerationStep["status"]) => {
    setSteps((prev) =>
      prev.map((step) => {
        if (step.id === stepId) {
          return { ...step, status };
        }
        // Mark previous steps as complete if current step is in_progress
        if (status === "in_progress") {
          const currentIndex = prev.findIndex((s) => s.id === stepId);
          const thisIndex = prev.findIndex((s) => s.id === step.id);
          if (thisIndex < currentIndex && step.status !== "complete") {
            return { ...step, status: "complete" };
          }
        }
        return step;
      })
    );
  };

  // Start generation when modal opens
  useEffect(() => {
    if (isOpen && !hasStartedRef.current && shortScript && projectId) {
      hasStartedRef.current = true;
      startGeneration();
    }
  }, [isOpen, shortScript, projectId]);

  // Reset when modal closes
  useEffect(() => {
    if (!isOpen) {
      hasStartedRef.current = false;
      setProgress(0);
      setMessage("Starting generation...");
      setCurrentStep("");
      setError(null);
      setIsGenerating(false);
      setSteps((prev) =>
        prev.map((step) => ({ ...step, status: "pending" }))
      );
    }
  }, [isOpen]);

  const startGeneration = async () => {
    setIsGenerating(true);
    setError(null);

    try {
      const result = await generateShortStreaming(
        projectId,
        hookStyle,
        shortScript,
        voiceSampleUrl,
        settings,
        (progressData: ShortGenerationProgress) => {
          setProgress(progressData.progress);
          setMessage(progressData.message);
          setCurrentStep(progressData.step);
          updateStepStatus(progressData.step, "in_progress");
        }
      );

      if (result.success) {
        // Mark all steps complete
        setSteps((prev) =>
          prev.map((step) => ({ ...step, status: "complete" }))
        );
        setProgress(100);
        setMessage("Short ready!");

        toast({
          title: "Short Generated",
          description: "Your YouTube Short is ready for preview!",
        });

        // Small delay before completing
        setTimeout(() => {
          onComplete({
            shortUrl: result.shortUrl!,
            audioUrl: result.audioUrl!,
            srtContent: result.srtContent!,
            imageUrls: result.imageUrls!,
            duration: result.duration!,
          });
        }, 500);
      } else {
        throw new Error(result.error || "Generation failed");
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      setError(errorMessage);
      setMessage(`Error: ${errorMessage}`);
      updateStepStatus(currentStep || "tts", "error");

      toast({
        title: "Generation Failed",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleRetry = () => {
    hasStartedRef.current = false;
    setSteps((prev) =>
      prev.map((step) => ({ ...step, status: "pending" }))
    );
    startGeneration();
  };

  return (
    <Dialog open={isOpen}>
      <DialogContent
        className="sm:max-w-xl"
        hideCloseButton
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Video className="w-5 h-5 text-primary" />
            Generating Short
          </DialogTitle>
          <DialogDescription>
            Creating your ~26 second YouTube Short with Ken Burns effect
          </DialogDescription>
        </DialogHeader>

        <div className="py-6 space-y-6">
          {/* Progress bar */}
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">{message}</span>
              <span className="font-medium">{progress}%</span>
            </div>
            <Progress value={progress} className="h-2" />
          </div>

          {/* Step list */}
          <div className="space-y-3">
            {steps.map((step) => {
              const Icon = step.icon;
              const isActive = step.status === "in_progress";
              const isComplete = step.status === "complete";
              const isError = step.status === "error";

              return (
                <div
                  key={step.id}
                  className={`flex items-center gap-3 p-3 rounded-lg border transition-all ${
                    isActive
                      ? "border-primary bg-primary/5"
                      : isComplete
                      ? "border-green-500/50 bg-green-500/5"
                      : isError
                      ? "border-destructive/50 bg-destructive/5"
                      : "border-border bg-muted/20"
                  }`}
                >
                  <div
                    className={`p-2 rounded-full ${
                      isActive
                        ? "bg-primary/20 text-primary"
                        : isComplete
                        ? "bg-green-500/20 text-green-500"
                        : isError
                        ? "bg-destructive/20 text-destructive"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {isActive ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : isComplete ? (
                      <Check className="w-4 h-4" />
                    ) : isError ? (
                      <X className="w-4 h-4" />
                    ) : (
                      <Icon className="w-4 h-4" />
                    )}
                  </div>
                  <span
                    className={`text-sm ${
                      isActive
                        ? "text-foreground font-medium"
                        : isComplete
                        ? "text-green-600"
                        : isError
                        ? "text-destructive"
                        : "text-muted-foreground"
                    }`}
                  >
                    {step.label}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Error state with retry */}
          {error && (
            <div className="flex justify-center pt-2">
              <Button variant="outline" onClick={handleRetry}>
                <Loader2 className="w-4 h-4 mr-2" />
                Retry Generation
              </Button>
            </div>
          )}
        </div>

        {/* Footer with cancel/back */}
        <div className="flex gap-2 pt-4 border-t">
          {onBack && !isGenerating && (
            <Button variant="outline" size="icon" onClick={onBack}>
              <ChevronLeft className="w-5 h-5" />
            </Button>
          )}
          <div className="flex-1" />
          <Button
            variant="outline"
            onClick={onCancel}
            disabled={isGenerating && progress > 50}
          >
            <X className="w-4 h-4 mr-2" />
            {isGenerating ? "Cancel" : "Close"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
