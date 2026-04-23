import { useState, useEffect } from "react";
import { BookOpen, Plus, Trash2, X, Save, Loader2 } from "lucide-react";
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
import { toast } from "@/hooks/use-toast";

interface PronunciationFix {
  word: string;
  phonetic: string;
}

interface PronunciationModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function PronunciationModal({ isOpen, onClose }: PronunciationModalProps) {
  const [fixes, setFixes] = useState<PronunciationFix[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [newWord, setNewWord] = useState("");
  const [newPhonetic, setNewPhonetic] = useState("");

  const renderUrl = import.meta.env.VITE_RENDER_API_URL;
  const renderApiKey = import.meta.env.VITE_INTERNAL_API_KEY;
  const renderAuthHeader = renderApiKey ? { 'X-Internal-Api-Key': renderApiKey } : {};

  // Load pronunciation fixes when modal opens
  useEffect(() => {
    if (isOpen) {
      loadFixes();
    }
  }, [isOpen]);

  const loadFixes = async () => {
    setIsLoading(true);
    try {
      const response = await fetch(`${renderUrl}/pronunciation`, {
        headers: renderAuthHeader,
      });
      if (response.ok) {
        const data = await response.json();
        setFixes(data.fixes || []);
      } else {
        toast({
          title: "Failed to Load",
          description: "Could not load pronunciation fixes.",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error("Error loading pronunciation fixes:", error);
      toast({
        title: "Error",
        description: "Failed to connect to server.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddFix = () => {
    if (!newWord.trim() || !newPhonetic.trim()) {
      toast({
        title: "Missing Fields",
        description: "Please enter both word and phonetic spelling.",
        variant: "destructive",
      });
      return;
    }

    // Check if word already exists
    if (fixes.some(f => f.word.toLowerCase() === newWord.toLowerCase())) {
      toast({
        title: "Duplicate Word",
        description: "This word already has a pronunciation fix.",
        variant: "destructive",
      });
      return;
    }

    setFixes([...fixes, { word: newWord.trim(), phonetic: newPhonetic.trim() }]);
    setNewWord("");
    setNewPhonetic("");
  };

  const handleRemoveFix = (index: number) => {
    setFixes(fixes.filter((_, i) => i !== index));
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const response = await fetch(`${renderUrl}/pronunciation`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...renderAuthHeader },
        body: JSON.stringify({ fixes }),
      });

      if (response.ok) {
        toast({
          title: "Saved",
          description: "Pronunciation fixes saved. They will be used for future audio generation.",
        });
        onClose();
      } else {
        const data = await response.json();
        toast({
          title: "Save Failed",
          description: data.error || "Could not save pronunciation fixes.",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error("Error saving pronunciation fixes:", error);
      toast({
        title: "Error",
        description: "Failed to connect to server.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAddFix();
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookOpen className="w-5 h-5 text-primary" />
            Pronunciation Fixes
          </DialogTitle>
          <DialogDescription>
            Add phonetic spellings for words the TTS engine mispronounces.
            Changes apply to future audio regenerations.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto py-4 space-y-4">
          {/* Add New Fix */}
          <div className="flex gap-2">
            <Input
              placeholder="Word (e.g., dream)"
              value={newWord}
              onChange={(e) => setNewWord(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1"
            />
            <Input
              placeholder="Phonetic (e.g., dreem)"
              value={newPhonetic}
              onChange={(e) => setNewPhonetic(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1"
            />
            <Button size="icon" onClick={handleAddFix} disabled={isLoading}>
              <Plus className="w-4 h-4" />
            </Button>
          </div>

          {/* List of Fixes */}
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : fixes.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <p>No pronunciation fixes yet.</p>
              <p className="text-sm">Add words that need phonetic spelling.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {fixes.map((fix, index) => (
                <div
                  key={index}
                  className="flex items-center justify-between p-3 bg-muted/50 rounded-lg"
                >
                  <div className="flex items-center gap-4">
                    <span className="font-medium">{fix.word}</span>
                    <span className="text-muted-foreground">→</span>
                    <span className="text-primary italic">{fix.phonetic}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleRemoveFix(index)}
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            <X className="w-4 h-4 mr-2" />
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving || isLoading}>
            {isSaving ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="w-4 h-4 mr-2" />
                Save Changes
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
