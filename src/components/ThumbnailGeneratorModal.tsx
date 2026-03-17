import { useState, useRef, useEffect } from "react";
import { Image, Upload, X, Loader2, Download, Sparkles, ChevronLeft, ChevronRight, Check, ArrowUp, Expand, Heart } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/hooks/use-toast";
import { generateThumbnailsStreaming, suggestThumbnailPrompts, expandTopicToDescription, type ThumbnailGenerationProgress } from "@/lib/api";
import JSZip from "jszip";

interface ThumbnailGeneratorModalProps {
  isOpen: boolean;
  projectId: string;
  projectTitle?: string;
  script?: string;
  initialThumbnails?: string[];
  initialSelectedIndex?: number;
  favoriteThumbnails?: string[];
  onFavoriteToggle?: (url: string) => void;
  onConfirm: (thumbnails: string[], selectedIndex: number | undefined) => void;
  onSelectionChange?: (thumbnails: string[], selectedIndex: number | undefined) => void;  // Real-time updates
  onCancel: () => void;
  onBack?: () => void;
  onSkip?: () => void;
  onForward?: () => void;  // Navigate to next step (YouTube)
  // Full Auto mode props
  sourceThumbnailUrl?: string;  // Original YouTube thumbnail to use as reference
  autoGenerate?: boolean;       // Auto-generate thumbnails when modal opens
}

export function ThumbnailGeneratorModal({
  isOpen,
  projectId,
  initialThumbnails,
  initialSelectedIndex,
  favoriteThumbnails = [],
  onFavoriteToggle,
  onConfirm,
  onSelectionChange,
  onCancel,
  onBack,
  onSkip,
  onForward,
  sourceThumbnailUrl,
  autoGenerate = false,
}: ThumbnailGeneratorModalProps) {
  // Default reference thumbnail
  const DEFAULT_THUMBNAIL_URL = "/thumbs/boring.jpg";

  // Upload state
  const [exampleImage, setExampleImage] = useState<File | null>(null);
  const [examplePreview, setExamplePreview] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const openReferencePicker = () => {
    const input = fileInputRef.current as (HTMLInputElement & {
      showPicker?: () => void;
    }) | null;

    if (!input) return;

    // Allow re-selecting the same file and prefer the native picker API when available.
    input.value = "";

    if (typeof input.showPicker === "function") {
      try {
        input.showPicker();
        return;
      } catch (error) {
        console.warn("showPicker failed, falling back to click()", error);
      }
    }

    input.click();
  };

  // Load default thumbnail on mount or when project changes
  useEffect(() => {
    // Reset to default when project changes
    loadDefaultThumbnail();
  }, [projectId]);

  const loadDefaultThumbnail = async () => {
    setIsUploading(true);
    try {
      const response = await fetch(DEFAULT_THUMBNAIL_URL);
      const blob = await response.blob();
      const file = new File([blob], 'default-reference.jpg', { type: blob.type });
      setExampleImage(file);

      const reader = new FileReader();
      reader.onload = (e) => {
        setExamplePreview(e.target?.result as string);
        setIsUploading(false);
      };
      reader.onerror = () => setIsUploading(false);
      reader.readAsDataURL(blob);
    } catch (error) {
      console.error("Failed to load default thumbnail:", error);
      setIsUploading(false);
    }
  };

  // Generation state - single prompt for everything
  const [imagePrompt, setImagePrompt] = useState("");
  const [topicInput, setTopicInput] = useState("");
  const [suggestedPrompts, setSuggestedPrompts] = useState<string[]>([]);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [thumbnailCount, setThumbnailCount] = useState(3);
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState<ThumbnailGenerationProgress | null>(null);
  const [generatedThumbnails, setGeneratedThumbnails] = useState<string[]>(initialThumbnails || []);

  // Tab state for right column: generated | favorites | uploaded
  const [activeTab, setActiveTab] = useState<'generated' | 'favorites' | 'uploaded'>('generated');

  // Uploaded thumbnails (user can upload their own)
  const [uploadedThumbnails, setUploadedThumbnails] = useState<string[]>([]);
  const uploadThumbnailInputRef = useRef<HTMLInputElement>(null);

  // Selection state - which thumbnail is selected for YouTube upload
  const [selectedThumbnail, setSelectedThumbnail] = useState<string | null>(
    initialThumbnails && initialSelectedIndex !== undefined
      ? initialThumbnails[initialSelectedIndex] || null
      : null
  );

  // Track last notified state to prevent redundant callbacks
  const lastNotifiedRef = useRef<{ thumbnails: string; selectedIndex: number | undefined } | null>(null);

  // Reset state when modal opens with new initial values
  useEffect(() => {
    if (isOpen) {
      // Reset the notification ref so initial values trigger a save
      lastNotifiedRef.current = null;

      if (initialThumbnails && initialThumbnails.length > 0) {
        setGeneratedThumbnails(initialThumbnails);
        setSelectedThumbnail(
          initialSelectedIndex !== undefined
            ? initialThumbnails[initialSelectedIndex] || null
            : null
        );
      }
    }
  }, [isOpen, initialThumbnails, initialSelectedIndex]);

  // Track if auto-generation has been triggered for this session
  const autoGenTriggeredRef = useRef(false);

  // Full Auto mode: Load source thumbnail and auto-generate
  useEffect(() => {
    if (!isOpen || !autoGenerate || !sourceThumbnailUrl || autoGenTriggeredRef.current) {
      return;
    }

    // Mark as triggered to prevent re-running
    autoGenTriggeredRef.current = true;

    const loadAndGenerate = async () => {
      console.log("[Full Auto Thumbnails] Loading source thumbnail:", sourceThumbnailUrl);
      setIsUploading(true);

      try {
        // Download source thumbnail
        const response = await fetch(sourceThumbnailUrl);
        const blob = await response.blob();
        const file = new File([blob], 'source-thumbnail.jpg', { type: blob.type });
        setExampleImage(file);

        // Convert to data URL for preview
        const reader = new FileReader();
        reader.onload = async (e) => {
          const preview = e.target?.result as string;
          setExamplePreview(preview);
          setIsUploading(false);

          // Set the auto-generation prompt (same as pipeline-runner)
          const autoPrompt = "Create an original thumbnail inspired by this image. Use the same style, color palette, text placement, and mood - but make it a unique, original composition. Keep similar visual elements and aesthetic but don't copy directly.";
          setImagePrompt(autoPrompt);
          setThumbnailCount(1);  // Generate 1 thumbnail for efficiency

          // Wait a moment for state to settle, then trigger generation
          await new Promise(resolve => setTimeout(resolve, 500));

          console.log("[Full Auto Thumbnails] Starting auto-generation...");

          // Extract base64 from preview
          const base64Prefix = ';base64,';
          const prefixIndex = preview.indexOf(base64Prefix);
          if (prefixIndex === -1) {
            console.error("[Full Auto Thumbnails] Invalid image format");
            return;
          }
          const base64Data = preview.substring(prefixIndex + base64Prefix.length);

          setIsGenerating(true);

          try {
            const result = await generateThumbnailsStreaming(
              base64Data,
              autoPrompt,
              1,  // Generate 1 thumbnail
              projectId,
              (prog) => setProgress(prog)
            );

            if (result.success && result.thumbnails && result.thumbnails.length > 0) {
              // Deduplicate URLs in case the API returned duplicates
              const uniqueThumbnails = [...new Set(result.thumbnails)];
              console.log("[Full Auto Thumbnails] Generated thumbnail:", uniqueThumbnails[0]);
              setGeneratedThumbnails(uniqueThumbnails);
              setSelectedThumbnail(uniqueThumbnails[0]);

              // Auto-confirm after short delay
              setTimeout(() => {
                console.log("[Full Auto Thumbnails] Auto-confirming...");
                onConfirm(uniqueThumbnails, 0);
              }, 500);
            } else {
              console.error("[Full Auto Thumbnails] Generation failed:", result.error);
              // Fall back to manual mode
            }
          } catch (genError) {
            console.error("[Full Auto Thumbnails] Generation error:", genError);
          } finally {
            setIsGenerating(false);
            setProgress(null);
          }
        };
        reader.readAsDataURL(blob);
      } catch (error) {
        console.error("[Full Auto Thumbnails] Failed to load source thumbnail:", error);
        setIsUploading(false);
        // Fall back to default thumbnail
        loadDefaultThumbnail();
      }
    };

    loadAndGenerate();
  }, [isOpen, autoGenerate, sourceThumbnailUrl, projectId, onConfirm]);

  // Reset auto-gen trigger when modal closes
  useEffect(() => {
    if (!isOpen) {
      autoGenTriggeredRef.current = false;
    }
  }, [isOpen]);

  // Notify parent when selection changes (for real-time persistence)
  // Note: onSelectionChange excluded from deps to prevent infinite loops with inline callbacks
  useEffect(() => {
    if (isOpen && onSelectionChange) {
      const allThumbnails = [...generatedThumbnails, ...uploadedThumbnails];
      const selectedIndex = selectedThumbnail
        ? allThumbnails.indexOf(selectedThumbnail)
        : undefined;

      // Create a fingerprint to check if state actually changed
      const fingerprint = allThumbnails.join('|');
      const lastFingerprint = lastNotifiedRef.current?.thumbnails;
      const lastSelectedIndex = lastNotifiedRef.current?.selectedIndex;

      // Only notify if something actually changed
      if (fingerprint !== lastFingerprint || selectedIndex !== lastSelectedIndex) {
        lastNotifiedRef.current = { thumbnails: fingerprint, selectedIndex };
        onSelectionChange(allThumbnails, selectedIndex !== -1 ? selectedIndex : undefined);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedThumbnail, generatedThumbnails, uploadedThumbnails, isOpen]);

  // History stack for navigating back to previous thumbnail batches
  const [thumbnailHistory, setThumbnailHistory] = useState<{
    thumbnails: string[];
    referencePreview: string;
    prompt: string;
  }[]>([]);

  // Lightbox state - track index for arrow key navigation
  // lightboxIndex: -1 = reference, 0+ = generated thumbnails, null = closed
  // lightboxSource: which tab the lightbox is showing ('generated' | 'favorites' | 'uploaded' | 'reference')
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [lightboxSource, setLightboxSource] = useState<'generated' | 'favorites' | 'uploaded' | 'reference'>('generated');
  const lightboxOverlayRef = useRef<HTMLDivElement>(null);
  const lightboxImageRef = useRef<HTMLImageElement>(null);

  // Get current lightbox image URL based on source
  const getLightboxImage = (): string | null => {
    if (lightboxIndex === null) return null;
    if (lightboxSource === 'reference') return examplePreview;
    if (lightboxSource === 'favorites') return favoriteThumbnails[lightboxIndex] || null;
    if (lightboxSource === 'uploaded') return uploadedThumbnails[lightboxIndex] || null;
    // generated
    return generatedThumbnails[lightboxIndex] || null;
  };
  const lightboxImage = getLightboxImage();

  // Get the array for current lightbox source (for navigation)
  const getLightboxArray = (): string[] => {
    if (lightboxSource === 'favorites') return favoriteThumbnails;
    if (lightboxSource === 'uploaded') return uploadedThumbnails;
    return generatedThumbnails;
  };

  // Keyboard: ESC to close lightbox, Arrow keys to navigate (capture phase to intercept before Dialog)
  useEffect(() => {
    if (lightboxIndex === null) return;

    const currentArray = getLightboxArray();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setLightboxIndex(null);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        setLightboxIndex(prev =>
          prev !== null && prev < currentArray.length - 1 ? prev + 1 : prev
        );
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        setLightboxIndex(prev =>
          prev !== null && prev > 0 ? prev - 1 : prev
        );
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [lightboxIndex, lightboxSource, generatedThumbnails.length, favoriteThumbnails.length, uploadedThumbnails.length]);

  // Click handling: background click closes lightbox
  useEffect(() => {
    if (lightboxIndex === null) return;

    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;

      // If clicked on image, do nothing
      if (lightboxImageRef.current?.contains(target)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // If clicked on overlay background, close
      if (lightboxOverlayRef.current?.contains(target)) {
        e.preventDefault();
        e.stopPropagation();
        setLightboxIndex(null);
      }
    };

    window.addEventListener('click', handleClick, true);
    return () => window.removeEventListener('click', handleClick, true);
  }, [lightboxIndex]);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    const validTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
    if (!validTypes.includes(file.type)) {
      toast({
        title: "Invalid File Type",
        description: "Please upload a PNG, JPG, or WebP image.",
        variant: "destructive",
      });
      return;
    }

    // Validate file size (max 20MB)
    if (file.size > 20 * 1024 * 1024) {
      toast({
        title: "File Too Large",
        description: "Please upload an image under 20MB.",
        variant: "destructive",
      });
      return;
    }

    setIsUploading(true);
    setExampleImage(file);

    // Create preview
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      setExamplePreview(dataUrl);
      setIsUploading(false);
    };
    reader.onerror = () => {
      toast({
        title: "Upload Failed",
        description: "Failed to read image file.",
        variant: "destructive",
      });
      setIsUploading(false);
    };
    reader.readAsDataURL(file);

    // Clear previous results
    setGeneratedThumbnails([]);
  };

  const handleRemoveImage = () => {
    setExampleImage(null);
    setExamplePreview(null);
    setImagePrompt("");
    setGeneratedThumbnails([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const extractYouTubeVideoId = (url: string): string | null => {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    ];
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return match[1];
    }
    return null;
  };

  const handleYouTubeUrl = async (url: string) => {
    const videoId = extractYouTubeVideoId(url);
    if (!videoId) return;

    setIsUploading(true);
    try {
      // Try maxresdefault first, fall back to hqdefault
      const thumbnailUrls = [
        `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      ];

      let blob: Blob | null = null;
      for (const thumbUrl of thumbnailUrls) {
        const response = await fetch(thumbUrl);
        if (response.ok) {
          blob = await response.blob();
          // maxresdefault returns a tiny placeholder if unavailable
          if (blob.size > 5000) break;
        }
      }

      if (!blob || blob.size < 1000) {
        throw new Error('Could not fetch YouTube thumbnail');
      }

      const file = new File([blob], `youtube-${videoId}.jpg`, { type: 'image/jpeg' });
      setExampleImage(file);

      const reader = new FileReader();
      reader.onload = (e) => {
        setExamplePreview(e.target?.result as string);
        setIsUploading(false);
      };
      reader.onerror = () => {
        toast({ title: "Failed", description: "Could not load YouTube thumbnail.", variant: "destructive" });
        setIsUploading(false);
      };
      reader.readAsDataURL(file);
      setGeneratedThumbnails([]);
    } catch (error) {
      toast({ title: "Failed", description: "Could not fetch YouTube thumbnail.", variant: "destructive" });
      setIsUploading(false);
    }
  };

  const handleSuggestPrompts = async () => {
    const topic = topicInput.trim();
    if (!topic) return;
    setIsSuggesting(true);
    setSuggestedPrompts([]);
    try {
      const result = await suggestThumbnailPrompts(topic);
      if (result.success && result.prompts) {
        setSuggestedPrompts(result.prompts);
      } else {
        toast({ title: "Failed", description: result.error || "Could not generate suggestions.", variant: "destructive" });
      }
    } catch (error) {
      toast({ title: "Failed", description: "Could not generate suggestions.", variant: "destructive" });
    } finally {
      setIsSuggesting(false);
    }
  };

  const handleGenerate = async () => {
    if (!exampleImage || !examplePreview) {
      toast({
        title: "No Example Image",
        description: "Please upload an example thumbnail first.",
        variant: "destructive",
      });
      return;
    }

    if (!imagePrompt.trim()) {
      toast({
        title: "No Prompt",
        description: "Please wait for analysis or enter a prompt manually.",
        variant: "destructive",
      });
      return;
    }

    setIsGenerating(true);
    setProgress(null);
    setGeneratedThumbnails([]);
    setSelectedThumbnail(null);

    try {
      // Extract base64 from data URL - use indexOf instead of regex to avoid stack overflow on large strings
      const base64Prefix = ';base64,';
      const prefixIndex = examplePreview.indexOf(base64Prefix);
      if (prefixIndex === -1 || !examplePreview.startsWith('data:image/')) {
        throw new Error("Invalid image format");
      }
      const base64Data = examplePreview.substring(prefixIndex + base64Prefix.length);

      // If there's a topic, expand it into a detailed character/subject description
      let subjectDescription = '';
      if (topicInput.trim()) {
        setProgress({ stage: 'generating', percent: 5, message: 'Expanding topic description...' });
        const expandResult = await expandTopicToDescription(topicInput.trim());
        if (expandResult.success && expandResult.description) {
          subjectDescription = expandResult.description;
          console.log('[Thumbnails] Expanded topic:', subjectDescription);
        } else {
          // Fall back to using the topic as-is
          subjectDescription = topicInput.trim();
          console.warn('[Thumbnails] Topic expansion failed, using raw topic');
        }
      }

      // Combine expanded subject description with style prompt
      const fullPrompt = subjectDescription
        ? `${subjectDescription}, ${imagePrompt.trim()}`
        : imagePrompt.trim();

      console.log('[Thumbnails] Full prompt:', fullPrompt);

      // Call the thumbnail generation API with the combined prompt
      const result = await generateThumbnailsStreaming(
        base64Data,
        fullPrompt,
        thumbnailCount,
        projectId,
        (progress) => setProgress(progress)
      );

      if (result.success && result.thumbnails) {
        // Deduplicate URLs in case the API returned duplicates
        const uniqueThumbnails = [...new Set(result.thumbnails)];
        setGeneratedThumbnails(uniqueThumbnails);
        toast({
          title: "Thumbnails Generated",
          description: `${uniqueThumbnails.length} thumbnails created successfully.`,
        });
      } else {
        toast({
          title: "Generation Failed",
          description: result.error || "Failed to generate thumbnails.",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error("Thumbnail generation error:", error);
      toast({
        title: "Generation Failed",
        description: error instanceof Error ? error.message : "Failed to generate thumbnails.",
        variant: "destructive",
      });
    } finally {
      setIsGenerating(false);
      setProgress(null);
    }
  };

  // Compress image blob to JPEG under 2MB using canvas
  const compressImageBlob = async (blob: Blob): Promise<{ blob: Blob; wasCompressed: boolean }> => {
    const MAX_SIZE = 2 * 1024 * 1024; // 2MB

    if (blob.size <= MAX_SIZE) {
      return { blob, wasCompressed: false };
    }

    return new Promise((resolve) => {
      const img = new window.Image();
      img.crossOrigin = 'anonymous';

      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;

        // Start with original dimensions, max 1280 width
        if (width > 1280) {
          height = Math.round(height * (1280 / width));
          width = 1280;
        }

        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve({ blob, wasCompressed: false });
          return;
        }

        ctx.drawImage(img, 0, 0, width, height);

        // Try progressively lower quality until under 2MB
        const tryCompress = (quality: number) => {
          canvas.toBlob(
            (compressedBlob) => {
              if (!compressedBlob) {
                resolve({ blob, wasCompressed: false });
                return;
              }

              if (compressedBlob.size <= MAX_SIZE || quality <= 0.1) {
                console.log(`[Thumbnail] Compressed: ${(blob.size / 1024 / 1024).toFixed(2)}MB -> ${(compressedBlob.size / 1024 / 1024).toFixed(2)}MB at quality=${quality.toFixed(1)}`);
                resolve({ blob: compressedBlob, wasCompressed: true });
              } else {
                // Try lower quality
                tryCompress(quality - 0.1);
              }
            },
            'image/jpeg',
            quality
          );
        };

        tryCompress(0.9);
      };

      img.onerror = () => {
        resolve({ blob, wasCompressed: false });
      };

      img.src = URL.createObjectURL(blob);
    });
  };

  const handleDownloadThumbnail = async (url: string, index: number) => {
    toast({
      title: "Preparing download...",
      description: "Checking file size...",
    });

    try {
      // Fetch the image as blob to bypass cross-origin download restrictions
      const response = await fetch(url);
      let blob = await response.blob();

      // Check if compression is needed (over 2MB)
      const { blob: finalBlob, wasCompressed } = await compressImageBlob(blob);
      blob = finalBlob;

      // Use appropriate extension based on whether we compressed
      const extension = wasCompressed ? 'jpg' : (blob.type.includes('jpeg') ? 'jpg' : 'png');
      const filename = `thumbnail_${index + 1}.${extension}`;

      const blobUrl = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      // Clean up the blob URL
      URL.revokeObjectURL(blobUrl);

      toast({
        title: "Downloaded",
        description: wasCompressed
          ? `${filename} (compressed to ${(blob.size / 1024 / 1024).toFixed(1)}MB)`
          : filename,
      });
    } catch (error) {
      toast({
        title: "Download Failed",
        description: "Failed to download thumbnail.",
        variant: "destructive",
      });
    }
  };

  const handleDownloadAllAsZip = async () => {
    if (generatedThumbnails.length === 0) return;

    toast({
      title: "Preparing Download",
      description: `Creating zip with ${generatedThumbnails.length} thumbnails...`,
    });

    try {
      const zip = new JSZip();
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

      for (let i = 0; i < generatedThumbnails.length; i++) {
        const url = generatedThumbnails[i];
        const filename = `thumbnail_${i + 1}.png`;

        try {
          // Use edge function proxy to bypass CORS
          const response = await fetch(`${supabaseUrl}/functions/v1/download-images-zip`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${supabaseKey}`,
              'apikey': supabaseKey,
            },
            body: JSON.stringify({ imageUrl: url })
          });

          if (response.ok) {
            const blob = await response.blob();
            if (blob.size > 0) {
              zip.file(filename, blob);
            }
          }
        } catch (error) {
          console.error(`Error fetching thumbnail ${i + 1}:`, error);
        }
      }

      const fileCount = Object.keys(zip.files).length;
      if (fileCount === 0) {
        toast({
          title: "Download Failed",
          description: "Failed to fetch thumbnails.",
          variant: "destructive",
        });
        return;
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const url = window.URL.createObjectURL(zipBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'thumbnails.zip';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);

      toast({
        title: "Download Complete",
        description: `thumbnails.zip downloaded with ${fileCount} images.`,
      });
    } catch (error) {
      console.error('Zip creation failed:', error);
      toast({
        title: "Download Failed",
        description: "Failed to create zip file.",
        variant: "destructive",
      });
    }
  };

  // Use a generated thumbnail as the new reference image
  const handleUseAsReference = async (url: string) => {
    setIsUploading(true);
    try {
      // Save current state to history before switching (if we have thumbnails)
      // Limit history to 5 entries to prevent memory issues with large base64 strings
      if (generatedThumbnails.length > 0 && examplePreview) {
        setThumbnailHistory(prev => {
          const newHistory = [...prev, {
            thumbnails: generatedThumbnails,
            referencePreview: examplePreview,
            prompt: imagePrompt,
          }];
          // Keep only the last 5 entries
          return newHistory.slice(-5);
        });
      }

      // Fetch the image and convert to data URL
      const response = await fetch(url);
      const blob = await response.blob();

      // Create a File object from the blob
      const file = new File([blob], 'reference.png', { type: blob.type });
      setExampleImage(file);

      // Convert to data URL for preview
      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target?.result as string;
        setExamplePreview(dataUrl);
        setIsUploading(false);
        toast({
          title: "Reference Updated",
          description: "Now using this thumbnail as the reference. Modify your prompt and generate again.",
        });
      };
      reader.onerror = () => {
        toast({
          title: "Failed",
          description: "Could not use this image as reference.",
          variant: "destructive",
        });
        setIsUploading(false);
      };
      reader.readAsDataURL(blob);

      // Clear generated thumbnails and selection to start fresh iteration
      setGeneratedThumbnails([]);
      setSelectedThumbnail(null);
    } catch (error) {
      console.error("Failed to use as reference:", error);
      toast({
        title: "Failed",
        description: "Could not fetch the image.",
        variant: "destructive",
      });
      setIsUploading(false);
    }
  };

  // Go back to previous thumbnail batch
  const handleGoBackInHistory = () => {
    if (thumbnailHistory.length === 0) return;

    const previousState = thumbnailHistory[thumbnailHistory.length - 1];

    // Restore previous state
    setGeneratedThumbnails(previousState.thumbnails);
    setExamplePreview(previousState.referencePreview);
    setImagePrompt(previousState.prompt);
    setSelectedThumbnail(null);

    // Remove from history
    setThumbnailHistory(prev => prev.slice(0, -1));

    toast({
      title: "Returned to Previous Batch",
      description: `Showing ${previousState.thumbnails.length} thumbnails from previous generation.`,
    });
  };

  const handleComplete = () => {
    // Combine all thumbnails (generated + favorites + uploaded) and find selected index
    const allThumbnails = [...generatedThumbnails, ...uploadedThumbnails];
    const selectedIndex = selectedThumbnail
      ? allThumbnails.indexOf(selectedThumbnail)
      : undefined;
    onConfirm(allThumbnails, selectedIndex !== -1 ? selectedIndex : undefined);
  };

  // Handle uploading custom thumbnails
  const handleUploadThumbnail = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const validTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
    const newThumbnails: string[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!validTypes.includes(file.type)) {
        toast({
          title: "Invalid File Type",
          description: `${file.name} is not a valid image. Please upload PNG, JPG, or WebP.`,
          variant: "destructive",
        });
        continue;
      }
      if (file.size > 20 * 1024 * 1024) {
        toast({
          title: "File Too Large",
          description: `${file.name} is over 20MB.`,
          variant: "destructive",
        });
        continue;
      }

      // Convert to data URL
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target?.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      newThumbnails.push(dataUrl);
    }

    if (newThumbnails.length > 0) {
      setUploadedThumbnails(prev => [...prev, ...newThumbnails]);
      setActiveTab('uploaded');
      toast({
        title: "Thumbnails Uploaded",
        description: `${newThumbnails.length} thumbnail(s) added.`,
      });
    }

    // Clear input
    if (uploadThumbnailInputRef.current) {
      uploadThumbnailInputRef.current.value = '';
    }
  };

  // Remove an uploaded thumbnail
  const handleRemoveUploadedThumbnail = (index: number) => {
    const url = uploadedThumbnails[index];
    setUploadedThumbnails(prev => prev.filter((_, i) => i !== index));
    if (selectedThumbnail === url) {
      setSelectedThumbnail(null);
    }
  };

  // Handle escape key - allow closing when not actively generating
  const handleEscapeKey = (e: KeyboardEvent) => {
    // If lightbox is open, let the lightbox handler deal with it
    if (lightboxImage) return;

    if (isGenerating || isUploading) {
      e.preventDefault();
    } else {
      onCancel();
    }
  };

  return (
    <Dialog open={isOpen}>
      <DialogContent
        className="sm:max-w-6xl max-h-[90vh] overflow-y-auto"
        hideCloseButton
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={handleEscapeKey}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Image className="w-5 h-5 text-primary" />
            Generate Thumbnails
          </DialogTitle>
          <DialogDescription>
            Upload a reference thumbnail and describe what you want to generate
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          <div className="flex gap-6">
            {/* Left Column - Input Controls (narrower) */}
            <div className="w-64 shrink-0 space-y-4">
              {/* Upload Example Thumbnail */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Reference:</label>

                {examplePreview ? (
                  <div className="space-y-2">
                    <div className="relative">
                      <img
                        src={examplePreview}
                        alt="Example thumbnail"
                        className="w-full h-auto rounded-lg border cursor-pointer hover:opacity-90 transition-opacity"
                        style={{ aspectRatio: '16/9', objectFit: 'cover' }}
                        onClick={() => {
                          setLightboxSource('reference');
                          setLightboxIndex(0);
                        }}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="absolute top-1 right-1 h-6 w-6 bg-background/80 hover:bg-background"
                        onClick={handleRemoveImage}
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                    <button
                      type="button"
                      className="inline-flex items-center justify-center gap-1 w-full h-9 px-3 rounded-md text-sm font-medium border border-input bg-background hover:bg-accent hover:text-accent-foreground cursor-pointer transition-colors"
                      onClick={openReferencePicker}
                    >
                      <Upload className="w-3 h-3" />
                      Change Reference
                    </button>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <div className="flex-1 h-px bg-border" />
                      <span>or</span>
                      <div className="flex-1 h-px bg-border" />
                    </div>
                    <Input
                      placeholder="Paste YouTube URL..."
                      className="h-7 text-xs"
                      onKeyDown={(e) => e.stopPropagation()}
                      onPaste={(e) => {
                        const text = e.clipboardData.getData('text');
                        if (extractYouTubeVideoId(text)) {
                          e.preventDefault();
                          handleYouTubeUrl(text);
                          (e.target as HTMLInputElement).value = '';
                        }
                      }}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (extractYouTubeVideoId(val)) {
                          handleYouTubeUrl(val);
                          e.target.value = '';
                        }
                      }}
                    />
                  </div>
                ) : (<>
                  <label
                    htmlFor="thumbnail-ref-input"
                    className="border-2 border-dashed border-border rounded-lg p-4 text-center cursor-pointer hover:border-primary/50 hover:bg-secondary/30 transition-colors aspect-video flex items-center justify-center"
                  >
                    {isUploading ? (
                      <div className="flex flex-col items-center gap-2">
                        <Loader2 className="w-5 h-5 animate-spin text-primary" />
                        <span className="text-xs text-muted-foreground">Loading...</span>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-1">
                        <Upload className="w-5 h-5 text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">
                          Upload reference
                        </span>
                      </div>
                    )}
                  </label>
                  <Input
                    placeholder="Paste YouTube URL..."
                    className="h-7 text-xs"
                    onKeyDown={(e) => e.stopPropagation()}
                    onPaste={(e) => {
                      const text = e.clipboardData.getData('text');
                      if (extractYouTubeVideoId(text)) {
                        e.preventDefault();
                        handleYouTubeUrl(text);
                        (e.target as HTMLInputElement).value = '';
                      }
                    }}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (extractYouTubeVideoId(val)) {
                        handleYouTubeUrl(val);
                        e.target.value = '';
                      }
                    }}
                  />
                </>)}

                <input
                  id="thumbnail-ref-input"
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/jpg,image/webp"
                  className="sr-only"
                  onChange={handleFileSelect}
                />
              </div>

              {/* Topic → Prompt Suggestions */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Prompt Ideas:</label>
                <div className="flex gap-1">
                  <Input
                    placeholder="e.g. Queen Charlotte"
                    value={topicInput}
                    onChange={(e) => setTopicInput(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') handleSuggestPrompts();
                    }}
                    className="h-7 text-xs flex-1"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 gap-1"
                    onClick={handleSuggestPrompts}
                    disabled={!topicInput.trim() || isSuggesting}
                  >
                    {isSuggesting ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Sparkles className="w-3 h-3" />
                    )}
                  </Button>
                </div>
                {suggestedPrompts.length > 0 && (
                  <div className="space-y-1 max-h-[120px] overflow-y-auto">
                    {suggestedPrompts.map((prompt, i) => (
                      <button
                        key={i}
                        className="w-full text-left text-xs p-1.5 rounded border hover:bg-secondary/50 transition-colors leading-tight"
                        onClick={() => {
                          setImagePrompt(prompt);
                          setSuggestedPrompts([]);
                        }}
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Image Prompt */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Prompt:</label>
                <Textarea
                  placeholder="Describe style, colors, composition, mood, text..."
                  value={imagePrompt}
                  onChange={(e) => setImagePrompt(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                  className="min-h-[80px] resize-y font-mono text-xs"
                />
              </div>

              {/* Thumbnail Count + Generate */}
              <div className="flex items-center gap-2">
                <div className="flex gap-1">
                  {[1, 3, 6, 9].map((count) => (
                    <Button
                      key={count}
                      variant={thumbnailCount === count ? "default" : "outline"}
                      size="sm"
                      onClick={() => setThumbnailCount(count)}
                      disabled={isGenerating}
                      className="h-7 w-7 px-0 text-xs"
                    >
                      {count}
                    </Button>
                  ))}
                </div>
                <Button
                  onClick={handleGenerate}
                  disabled={!examplePreview || !imagePrompt.trim() || isGenerating}
                  size="sm"
                  className="flex-1 gap-1"
                >
                  {isGenerating ? (
                    <>
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Generating...
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-3 h-3" />
                      Generate
                    </>
                  )}
                </Button>
              </div>

              {/* Progress */}
              {progress && (
                <div className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">
                      {progress.message || (progress.stage === 'analyzing' ? 'Processing...' : 'Generating...')}
                    </span>
                    <span className="font-medium">{progress.percent}%</span>
                  </div>
                  <Progress value={progress.percent} className="h-1.5" />
                </div>
              )}
            </div>

            {/* Right Column - Tabbed Thumbnails (wider) */}
            <div className="flex-1 space-y-3">
              {/* Tabs */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setActiveTab('generated')}
                    className={`px-3 py-1 text-sm rounded-md transition-colors ${
                      activeTab === 'generated'
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    Generated ({generatedThumbnails.length})
                  </button>
                  <button
                    onClick={() => setActiveTab('favorites')}
                    className={`px-3 py-1 text-sm rounded-md transition-colors ${
                      activeTab === 'favorites'
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    <Heart className={`w-3 h-3 inline mr-1 ${favoriteThumbnails.length > 0 ? 'fill-red-500 text-red-500' : ''}`} />
                    ({favoriteThumbnails.length})
                  </button>
                  <button
                    onClick={() => setActiveTab('uploaded')}
                    className={`px-3 py-1 text-sm rounded-md transition-colors ${
                      activeTab === 'uploaded'
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    Uploaded ({uploadedThumbnails.length})
                  </button>
                </div>
                <div className="flex items-center gap-1">
                  {activeTab === 'generated' && thumbnailHistory.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleGoBackInHistory}
                      className="gap-1 h-6 text-xs text-muted-foreground hover:text-foreground px-2"
                    >
                      <ChevronLeft className="w-3 h-3" />
                      Previous
                    </Button>
                  )}
                  {activeTab === 'uploaded' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => uploadThumbnailInputRef.current?.click()}
                      className="gap-1 h-6 px-2"
                    >
                      <Upload className="w-3 h-3" />
                      Upload
                    </Button>
                  )}
                  {activeTab === 'generated' && generatedThumbnails.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleDownloadAllAsZip}
                      className="gap-1 h-6 px-2"
                    >
                      <Download className="w-3 h-3" />
                    </Button>
                  )}
                </div>
              </div>

              {/* Hidden input for uploading thumbnails */}
              <input
                ref={uploadThumbnailInputRef}
                type="file"
                accept="image/png,image/jpeg,image/jpg,image/webp"
                multiple
                className="hidden"
                onChange={handleUploadThumbnail}
              />

              {/* Generated Tab */}
              {activeTab === 'generated' && (
                <>
                  {generatedThumbnails.length === 0 ? (
                    <div className="border-2 border-dashed border-border rounded-lg p-8 text-center">
                      <p className="text-sm text-muted-foreground">
                        {thumbnailHistory.length > 0
                          ? 'No thumbnails. Click "Previous" to restore last batch.'
                          : 'Generated thumbnails will appear here'}
                      </p>
                    </div>
                  ) : (
                    <>
                      <p className="text-xs text-muted-foreground">
                        Click to expand. Use ← → keys to navigate. Hover for actions.
                      </p>
                      <div className="grid grid-cols-3 gap-3 max-h-[400px] overflow-y-auto pr-1">
                        {generatedThumbnails.map((url, index) => {
                          const isSelected = selectedThumbnail === url;
                          return (
                            <div key={index} className="relative group">
                              <img
                                src={url}
                                alt={`Thumbnail ${index + 1}`}
                                className={`w-full rounded-lg cursor-pointer transition-all ${
                                  isSelected
                                    ? 'ring-2 ring-primary ring-offset-1 opacity-100'
                                    : 'border hover:opacity-90'
                                }`}
                                style={{ aspectRatio: '16/9', objectFit: 'cover' }}
                                onClick={() => {
                                  setSelectedThumbnail(isSelected ? null : url);
                                }}
                              />
                              {isSelected && (
                                <div className="absolute top-1 left-1 bg-primary text-primary-foreground rounded-full p-0.5">
                                  <Check className="w-3 h-3" />
                                </div>
                              )}
                              <div className="absolute bottom-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 bg-background/80 hover:bg-background"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setLightboxSource('generated');
                                    setLightboxIndex(index);
                                  }}
                                  title="Expand"
                                >
                                  <Expand className="w-3 h-3" />
                                </Button>
                                {onFavoriteToggle && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 bg-background/80 hover:bg-background"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      onFavoriteToggle(url);
                                    }}
                                    title={favoriteThumbnails.includes(url) ? "Remove from favorites" : "Add to favorites"}
                                  >
                                    <Heart className={`w-3 h-3 ${favoriteThumbnails.includes(url) ? 'fill-red-500 text-red-500' : ''}`} />
                                  </Button>
                                )}
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 bg-background/80 hover:bg-background"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleUseAsReference(url);
                                  }}
                                  title="Use as reference"
                                >
                                  <ArrowUp className="w-3 h-3" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 bg-background/80 hover:bg-background"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDownloadThumbnail(url, index);
                                  }}
                                  title="Download"
                                >
                                  <Download className="w-3 h-3" />
                                </Button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                </>
              )}

              {/* Favorites Tab */}
              {activeTab === 'favorites' && (
                <>
                  {favoriteThumbnails.length === 0 ? (
                    <div className="border-2 border-dashed border-border rounded-lg p-8 text-center">
                      <Heart className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
                      <p className="text-sm text-muted-foreground">
                        No favorites yet. Click the heart icon on thumbnails to add them here.
                      </p>
                    </div>
                  ) : (
                    <>
                      <p className="text-xs text-muted-foreground">
                        Click to expand. Use ← → keys to navigate. Hover for actions.
                      </p>
                      <div className="grid grid-cols-3 gap-3 max-h-[400px] overflow-y-auto pr-1">
                        {favoriteThumbnails.map((url, index) => {
                          const isSelected = selectedThumbnail === url;
                          return (
                            <div key={index} className="relative group">
                              <img
                                src={url}
                                alt={`Favorite ${index + 1}`}
                                className={`w-full rounded-lg cursor-pointer transition-all ${
                                  isSelected
                                    ? 'ring-2 ring-primary ring-offset-1 opacity-100'
                                    : 'border hover:opacity-90'
                                }`}
                                style={{ aspectRatio: '16/9', objectFit: 'cover' }}
                                onClick={() => {
                                  setSelectedThumbnail(isSelected ? null : url);
                                }}
                              />
                              {isSelected && (
                                <div className="absolute top-1 left-1 bg-primary text-primary-foreground rounded-full p-0.5">
                                  <Check className="w-3 h-3" />
                                </div>
                              )}
                              <div className="absolute bottom-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 bg-background/80 hover:bg-background"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setLightboxSource('generated');
                                    setLightboxIndex(index);
                                  }}
                                  title="Expand"
                                >
                                  <Expand className="w-3 h-3" />
                                </Button>
                                {onFavoriteToggle && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 bg-red-500/80 hover:bg-red-500 text-white"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      onFavoriteToggle(url);
                                    }}
                                    title="Remove from favorites"
                                  >
                                    <Heart className="w-3 h-3 fill-white" />
                                  </Button>
                                )}
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 bg-background/80 hover:bg-background"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDownloadThumbnail(url, index);
                                  }}
                                  title="Download"
                                >
                                  <Download className="w-3 h-3" />
                                </Button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                </>
              )}

              {/* Uploaded Tab */}
              {activeTab === 'uploaded' && (
                <>
                  {uploadedThumbnails.length === 0 ? (
                    <div
                      className="border-2 border-dashed border-border rounded-lg p-8 text-center cursor-pointer hover:border-primary/50 hover:bg-secondary/30 transition-colors"
                      onClick={() => uploadThumbnailInputRef.current?.click()}
                    >
                      <Upload className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
                      <p className="text-sm text-muted-foreground">
                        Click to upload your own thumbnails
                      </p>
                    </div>
                  ) : (
                    <>
                      <p className="text-xs text-muted-foreground">
                        Click to expand. Use ← → keys to navigate. Hover for actions.
                      </p>
                      <div className="grid grid-cols-3 gap-3 max-h-[400px] overflow-y-auto pr-1">
                        {uploadedThumbnails.map((url, index) => {
                          const isSelected = selectedThumbnail === url;
                          return (
                            <div key={index} className="relative group">
                              <img
                                src={url}
                                alt={`Uploaded ${index + 1}`}
                                className={`w-full rounded-lg cursor-pointer transition-all ${
                                  isSelected
                                    ? 'ring-2 ring-primary ring-offset-1 opacity-100'
                                    : 'border hover:opacity-90'
                                }`}
                                style={{ aspectRatio: '16/9', objectFit: 'cover' }}
                                onClick={() => {
                                  setSelectedThumbnail(isSelected ? null : url);
                                }}
                              />
                              {isSelected && (
                                <div className="absolute top-1 left-1 bg-primary text-primary-foreground rounded-full p-0.5">
                                  <Check className="w-3 h-3" />
                                </div>
                              )}
                              <div className="absolute bottom-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 bg-background/80 hover:bg-background"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setLightboxSource('generated');
                                    setLightboxIndex(index);
                                  }}
                                  title="Expand"
                                >
                                  <Expand className="w-3 h-3" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 bg-background/80 hover:bg-background"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleRemoveUploadedThumbnail(index);
                                  }}
                                  title="Remove"
                                >
                                  <X className="w-3 h-3" />
                                </Button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
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
            {onSkip && (
              <Button variant="outline" size="icon" onClick={onSkip} title="Skip to next step">
                <ChevronRight className="w-5 h-5" />
              </Button>
            )}
            {selectedThumbnail && (
              <Button
                variant="outline"
                onClick={() => {
                  const index = generatedThumbnails.indexOf(selectedThumbnail);
                  if (index >= 0) {
                    handleDownloadThumbnail(selectedThumbnail, index);
                  } else {
                    // For uploaded thumbnails, use a generic name
                    handleDownloadThumbnail(selectedThumbnail, 0);
                  }
                }}
              >
                <Download className="w-4 h-4 mr-2" />
                Download
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
              YouTube
              <ChevronRight className="w-4 h-4 ml-2" />
            </Button>
          ) : (
            <Button
              onClick={handleComplete}
              disabled={generatedThumbnails.length > 0 && !selectedThumbnail}
            >
              <Check className="w-4 h-4 mr-2" />
              {generatedThumbnails.length > 0 && !selectedThumbnail
                ? 'Select a Thumbnail'
                : 'Continue'}
            </Button>
          )}
        </DialogFooter>

        {/* Lightbox with navigation */}
        {lightboxImage && lightboxIndex !== null && (() => {
          const currentArray = getLightboxArray();
          const showNavigation = lightboxSource !== 'reference' && currentArray.length > 1;
          return (
            <div
              ref={lightboxOverlayRef}
              className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center p-4"
            >
              {/* Left arrow */}
              {showNavigation && lightboxIndex > 0 && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute left-4 text-white hover:bg-white/20"
                  onClick={(e) => {
                    e.stopPropagation();
                    setLightboxIndex(lightboxIndex - 1);
                  }}
                >
                  <ChevronLeft className="w-8 h-8" />
                </Button>
              )}

              <img
                ref={lightboxImageRef}
                src={lightboxImage}
                alt="Full size preview"
                className="max-w-full max-h-full rounded-lg"
              />

              {/* Right arrow */}
              {showNavigation && lightboxIndex < currentArray.length - 1 && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-4 text-white hover:bg-white/20"
                  onClick={(e) => {
                    e.stopPropagation();
                    setLightboxIndex(lightboxIndex + 1);
                  }}
                >
                  <ChevronRight className="w-8 h-8" />
                </Button>
              )}

              {/* Image counter */}
              {showNavigation && (
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white/70 text-sm">
                  {lightboxIndex + 1} / {currentArray.length}
                </div>
              )}

              <Button
                variant="ghost"
                size="icon"
                className="absolute top-4 right-4 text-white hover:bg-white/20"
                onClick={() => setLightboxIndex(null)}
              >
                <X className="w-6 h-6" />
              </Button>
            </div>
          );
        })()}
      </DialogContent>
    </Dialog>
  );
}
