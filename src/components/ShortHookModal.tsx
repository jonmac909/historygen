import { useState, useEffect } from "react";
import {
  Loader2,
  ChevronLeft,
  ChevronRight,
  X,
  Sparkles,
  MessageSquare,
  HelpCircle,
  Lightbulb,
  Scale,
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
import { generateShortHooks, type HookOption } from "@/lib/api";

interface ShortHookModalProps {
  isOpen: boolean;
  projectId: string;
  script: string;
  onConfirm: (hookStyle: string, shortScript: string) => void;
  onCancel: () => void;
  onBack?: () => void;
  onSkip?: () => void;
}

const HOOK_ICONS = {
  story: MessageSquare,
  didyouknow: Lightbulb,
  question: HelpCircle,
  contrast: Scale,
};

const HOOK_COLORS = {
  story: "border-blue-500/50 bg-blue-500/5 hover:bg-blue-500/10",
  didyouknow: "border-yellow-500/50 bg-yellow-500/5 hover:bg-yellow-500/10",
  question: "border-purple-500/50 bg-purple-500/5 hover:bg-purple-500/10",
  contrast: "border-green-500/50 bg-green-500/5 hover:bg-green-500/10",
};

const HOOK_SELECTED_COLORS = {
  story: "ring-2 ring-blue-500 border-blue-500 bg-blue-500/20",
  didyouknow: "ring-2 ring-yellow-500 border-yellow-500 bg-yellow-500/20",
  question: "ring-2 ring-purple-500 border-purple-500 bg-purple-500/20",
  contrast: "ring-2 ring-green-500 border-green-500 bg-green-500/20",
};

export function ShortHookModal({
  isOpen,
  projectId,
  script,
  onConfirm,
  onCancel,
  onBack,
  onSkip,
}: ShortHookModalProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [hookOptions, setHookOptions] = useState<HookOption[]>([]);
  const [selectedHook, setSelectedHook] = useState<HookOption | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch hook options when modal opens
  useEffect(() => {
    if (isOpen && script && hookOptions.length === 0 && !isLoading) {
      fetchHookOptions();
    }
  }, [isOpen, script]);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setHookOptions([]);
      setSelectedHook(null);
      setError(null);
    }
  }, [isOpen]);

  const fetchHookOptions = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await generateShortHooks(projectId, script);

      if (result.success && result.hooks) {
        setHookOptions(result.hooks);
        // Auto-select the first hook
        if (result.hooks.length > 0) {
          setSelectedHook(result.hooks[0]);
        }
      } else {
        setError(result.error || "Failed to generate hook options");
        toast({
          title: "Failed to generate hooks",
          description: result.error || "Please try again",
          variant: "destructive",
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
      toast({
        title: "Error",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleConfirm = () => {
    if (!selectedHook) {
      toast({
        title: "Select a hook",
        description: "Please select a hook style to continue",
        variant: "destructive",
      });
      return;
    }

    onConfirm(selectedHook.style, selectedHook.fullScript);
  };

  return (
    <Dialog open={isOpen}>
      <DialogContent
        className="sm:max-w-4xl max-h-[90vh] overflow-y-auto"
        hideCloseButton
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-primary" />
            Choose Short Hook Style
          </DialogTitle>
          <DialogDescription>
            Select how your YouTube Short should begin. Each style has a different opening hook.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-12 gap-4">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
              <p className="text-muted-foreground">Generating hook options...</p>
              <p className="text-xs text-muted-foreground">
                AI is analyzing your script to create 4 engaging opening styles
              </p>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-12 gap-4">
              <p className="text-destructive">{error}</p>
              <Button variant="outline" onClick={fetchHookOptions}>
                Try Again
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              {hookOptions.map((hook) => {
                const Icon = HOOK_ICONS[hook.style as keyof typeof HOOK_ICONS] || MessageSquare;
                const isSelected = selectedHook?.style === hook.style;
                const baseColor = HOOK_COLORS[hook.style as keyof typeof HOOK_COLORS] || "border-border";
                const selectedColor = HOOK_SELECTED_COLORS[hook.style as keyof typeof HOOK_SELECTED_COLORS] || "ring-2 ring-primary";

                return (
                  <button
                    key={hook.style}
                    onClick={() => setSelectedHook(hook)}
                    className={`p-4 rounded-lg border-2 text-left transition-all ${
                      isSelected ? selectedColor : baseColor
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <Icon className="w-5 h-5" />
                      <span className="font-semibold">{hook.label}</span>
                    </div>
                    <p className="text-sm text-muted-foreground line-clamp-4">
                      "{hook.preview}..."
                    </p>
                  </button>
                );
              })}
            </div>
          )}

          {/* Selected hook preview */}
          {selectedHook && !isLoading && (
            <div className="mt-6 p-4 rounded-lg border bg-muted/30">
              <h4 className="font-medium mb-2 flex items-center gap-2">
                <Sparkles className="w-4 h-4" />
                Full Script Preview ({selectedHook.label})
              </h4>
              <p className="text-sm text-muted-foreground whitespace-pre-wrap max-h-[200px] overflow-y-auto">
                {selectedHook.fullScript}
              </p>
              <p className="text-xs text-muted-foreground mt-2">
                ~{selectedHook.fullScript.split(/\s+/).length} words | ~26 seconds
              </p>
            </div>
          )}
        </div>

        <DialogFooter className="flex-shrink-0 gap-2 sm:gap-2">
          {/* Left side: Navigation */}
          <div className="flex gap-2 mr-auto">
            {onBack && (
              <Button variant="outline" size="icon" onClick={onBack} title="Back to YouTube">
                <ChevronLeft className="w-5 h-5" />
              </Button>
            )}
            {onSkip && (
              <Button variant="outline" size="icon" onClick={onSkip} title="Skip to Results">
                <ChevronRight className="w-5 h-5" />
              </Button>
            )}
          </div>

          {/* Right side: Exit + Generate Short */}
          <Button variant="outline" onClick={onCancel}>
            <X className="w-4 h-4 mr-2" />
            Exit
          </Button>

          <Button
            onClick={handleConfirm}
            disabled={!selectedHook || isLoading}
          >
            Generate Short
            <ChevronRight className="w-4 h-4 ml-2" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
