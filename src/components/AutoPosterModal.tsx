/**
 * Auto Poster Modal - Auto-selects best outlier and triggers frontend Full Auto pipeline
 *
 * Flow:
 * 1. Modal opens -> Auto-scans whitelist channels
 * 2. Shows best outlier (highest score, 2hr+, last 7 days)
 * 3. User clicks Generate -> Closes modal, triggers Full Auto Generate on main page
 */

import { useState, useEffect } from "react";
import { Loader2, Search, Play, XCircle, Clock, TrendingUp, AlertCircle, FileText } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const API_BASE_URL = import.meta.env.VITE_RENDER_API_URL || "";
const renderApiKey = import.meta.env.VITE_INTERNAL_API_KEY;
const renderAuthHeader = renderApiKey ? { 'X-Internal-Api-Key': renderApiKey } : {};

interface OutlierVideo {
  videoId: string;
  title: string;
  thumbnailUrl: string;
  channelId: string;
  channelName: string;
  subscriberCountFormatted: string;
  viewCount: number;
  durationSeconds: number;
  publishedAt: string;
  outlierMultiplier: number;
}

interface AutoPosterModalProps {
  open: boolean;
  onClose: () => void;
  onSelectVideo: (videoUrl: string, wordCount: number, thumbnailUrl: string, videoTitle: string) => void;
}

type ModalState = "scanning" | "found" | "not_found" | "error";

// Format duration from seconds to "Xh Ym"
function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

// Format views with K/M suffix
function formatViews(views: number): string {
  if (views >= 1000000) {
    return `${(views / 1000000).toFixed(1)}M`;
  }
  if (views >= 1000) {
    return `${(views / 1000).toFixed(1)}K`;
  }
  return views.toString();
}

// Format publish time for display
function formatPublishTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });
}

export function AutoPosterModal({ open, onClose, onSelectVideo }: AutoPosterModalProps) {
  const [state, setState] = useState<ModalState>("scanning");
  const [outlier, setOutlier] = useState<OutlierVideo | null>(null);
  const [channelsScanned, setChannelsScanned] = useState(0);
  const [publishAt, setPublishAt] = useState<string>("");
  const [reason, setReason] = useState<string>("");
  const [scanningMessage, setScanningMessage] = useState<string>("Loading channels...");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [wordCount, setWordCount] = useState<number>(0);

  // Fetch best outlier when modal opens
  useEffect(() => {
    if (open) {
      fetchBestOutlier();
    } else {
      // Reset state when modal closes
      setState("scanning");
      setOutlier(null);
      setChannelsScanned(0);
      setPublishAt("");
      setReason("");
      setErrorMessage("");
      setWordCount(0);
    }
  }, [open]);

  const fetchBestOutlier = async () => {
    setState("scanning");
    setReason("");
    setScanningMessage("Loading channels...");

    try {
      const response = await fetch(`${API_BASE_URL}/auto-clone/best-outlier`, {
        headers: renderAuthHeader,
      });
      const reader = response.body?.getReader();

      if (!reader) {
        setState("error");
        setErrorMessage("Failed to connect to server");
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE events
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";

        for (const event of events) {
          if (!event.trim()) continue;

          const dataMatch = event.match(/^data: (.+)$/m);
          if (dataMatch) {
            try {
              const data = JSON.parse(dataMatch[1]);

              if (data.type === "progress") {
                setScanningMessage(data.message || "Scanning...");
                if (data.totalChannels) {
                  setChannelsScanned(data.channelIndex || 0);
                }
              } else if (data.type === "complete") {
                setChannelsScanned(data.channelsScanned || 0);

                if (data.outlier) {
                  setOutlier(data.outlier);
                  setPublishAt(data.publishAt || "");
                  // Calculate default word count: 150 words per minute
                  const durationMinutes = Math.round(data.outlier.durationSeconds / 60);
                  setWordCount(durationMinutes * 150);
                  setState("found");
                } else {
                  setReason(data.reason || "No qualifying outliers found");
                  setState("not_found");
                }
              } else if (data.type === "error") {
                setState("error");
                setErrorMessage(data.error || "Failed to scan channels");
              }
            } catch (e) {
              console.error("Failed to parse SSE event:", e);
            }
          }
        }
      }
    } catch (err: any) {
      setState("error");
      setErrorMessage(err.message || "Failed to connect to server");
    }
  };

  const handleGenerateClick = () => {
    if (!outlier) return;

    // Build YouTube URL from video ID
    const videoUrl = `https://www.youtube.com/watch?v=${outlier.videoId}`;

    // Close modal and trigger frontend pipeline
    onClose();
    onSelectVideo(videoUrl, wordCount, outlier.thumbnailUrl, outlier.title);
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-lg overflow-hidden">
        <DialogHeader>
          <DialogTitle className="text-xl font-bold flex items-center gap-2">
            {state === "scanning" && <Search className="w-5 h-5 animate-pulse" />}
            {state === "found" && <TrendingUp className="w-5 h-5 text-green-500" />}
            {state === "not_found" && <AlertCircle className="w-5 h-5 text-yellow-500" />}
            {state === "error" && <XCircle className="w-5 h-5 text-red-500" />}
            Auto Poster
          </DialogTitle>
        </DialogHeader>

        <div className="py-4 overflow-hidden">
          {/* Scanning State */}
          {state === "scanning" && (
            <div className="flex flex-col items-center justify-center py-8 gap-4">
              <Loader2 className="w-12 h-12 text-primary animate-spin" />
              <div className="text-center space-y-1">
                <p className="font-medium">{scanningMessage}</p>
                <p className="text-sm text-muted-foreground">
                  Looking for 1hr+ videos with 2x+ average views from last 30 days
                </p>
              </div>
            </div>
          )}

          {/* Found State - Show Outlier Card */}
          {state === "found" && outlier && (
            <div className="space-y-4 overflow-hidden">
              <div className="border rounded-lg overflow-hidden">
                <img
                  src={outlier.thumbnailUrl}
                  alt={outlier.title}
                  className="w-full aspect-video object-cover"
                />
                <div className="p-4 space-y-2 overflow-hidden">
                  <h3 className="font-semibold line-clamp-2 break-words overflow-hidden">{outlier.title}</h3>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
                    <span>{outlier.channelName}</span>
                    {outlier.subscriberCountFormatted && (
                      <>
                        <span>•</span>
                        <span>{outlier.subscriberCountFormatted} subs</span>
                      </>
                    )}
                    <span>•</span>
                    <span>{formatDuration(outlier.durationSeconds)}</span>
                    <span>•</span>
                    <span>{formatViews(outlier.viewCount)} views</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="bg-green-500/10 text-green-600">
                      <TrendingUp className="w-3 h-3 mr-1" />
                      {outlier.outlierMultiplier.toFixed(1)}x average
                    </Badge>
                    <Badge variant="outline">
                      {outlier.publishedAt}
                    </Badge>
                  </div>
                </div>
              </div>

              {/* Word Count Input */}
              <div className="space-y-2">
                <Label htmlFor="wordCount" className="text-sm flex items-center gap-2">
                  <FileText className="w-4 h-4" />
                  Target Word Count
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="wordCount"
                    type="number"
                    value={wordCount}
                    onChange={(e) => setWordCount(parseInt(e.target.value) || 0)}
                    min={1000}
                    max={50000}
                    step={500}
                    className="w-32"
                  />
                  <span className="text-sm text-muted-foreground">
                    (~{Math.round(wordCount / 150)} min @ 150 wpm)
                  </span>
                </div>
              </div>

              {publishAt && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 rounded-lg p-3">
                  <Clock className="w-4 h-4" />
                  <span>Will publish at {formatPublishTime(publishAt)}</span>
                </div>
              )}
            </div>
          )}

          {/* Not Found State */}
          {state === "not_found" && (
            <div className="flex flex-col items-center justify-center py-8 gap-4 text-center">
              <AlertCircle className="w-12 h-12 text-yellow-500" />
              <div>
                <p className="font-medium">No Outliers Found</p>
                <p className="text-sm text-muted-foreground mt-1">{reason}</p>
                <p className="text-xs text-muted-foreground mt-2">
                  Scanned {channelsScanned} channels
                </p>
              </div>
            </div>
          )}

          {/* Error State */}
          {state === "error" && (
            <div className="flex flex-col items-center justify-center py-8 gap-4 text-center">
              <XCircle className="w-12 h-12 text-red-500" />
              <div>
                <p className="font-medium">Something went wrong</p>
                <p className="text-sm text-muted-foreground mt-1">{errorMessage}</p>
              </div>
              <Button variant="outline" onClick={fetchBestOutlier}>
                Try Again
              </Button>
            </div>
          )}
        </div>

        <DialogFooter>
          {state === "found" && (
            <Button onClick={handleGenerateClick} className="w-full">
              <Play className="w-4 h-4 mr-2" />
              Generate Video
            </Button>
          )}
          {(state === "not_found" || state === "error") && (
            <Button variant="outline" onClick={onClose} className="w-full">
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
