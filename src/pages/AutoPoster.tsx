/**
 * Auto Poster - Live view of automated video cloning workflow
 *
 * Shows:
 * - Run history (auto_clone_runs table)
 * - Processed videos (processed_videos table)
 * - Manual trigger button
 * - Live progress when running
 */

import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, Play, RefreshCw, Clock, CheckCircle, XCircle, Loader2, Zap, RotateCcw, Trash2, Power } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';

const API_BASE_URL = import.meta.env.VITE_RENDER_API_URL || '';
const renderApiKey = import.meta.env.VITE_INTERNAL_API_KEY;
const renderAuthHeader = renderApiKey ? { 'X-Internal-Api-Key': renderApiKey } : {};

interface AutoCloneRun {
  id: string;
  run_date: string;
  status: 'running' | 'completed' | 'failed' | 'no_candidates';
  channels_scanned: number;
  outliers_found: number;
  video_selected_id: string | null;
  error_message: string | null;
  current_step: string | null;
  started_at: string;
  completed_at: string | null;
}

interface ProcessedVideo {
  id: string;
  video_id: string;
  channel_id: string;
  original_title: string;
  original_thumbnail_url: string | null;
  cloned_title: string | null;
  project_id: string | null;
  youtube_video_id: string | null;
  youtube_url: string | null;
  outlier_multiplier: number | null;
  duration_seconds: number | null;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  error_message: string | null;
  current_step: string | null;
  processed_at: string;
  completed_at: string | null;
}

export default function AutoPoster() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [runs, setRuns] = useState<AutoCloneRun[]>([]);
  const [processedVideos, setProcessedVideos] = useState<ProcessedVideo[]>([]);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [liveProgress, setLiveProgress] = useState<string | null>(null);
  const [cronEnabled, setCronEnabled] = useState<boolean | null>(null);
  const [togglingCron, setTogglingCron] = useState(false);
  const progressRef = useRef<HTMLDivElement>(null);

  // Fetch status data (showLoading=false for background polling)
  const fetchStatus = async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const [runsRes, videosRes] = await Promise.all([
        fetch(`${API_BASE_URL}/auto-clone/status`, { headers: renderAuthHeader }),
        fetch(`${API_BASE_URL}/auto-clone/processed`, { headers: renderAuthHeader }),
      ]);

      if (runsRes.ok) {
        const runsData = await runsRes.json();
        setRuns(runsData.runs || []);
      }

      if (videosRes.ok) {
        const videosData = await videosRes.json();
        setProcessedVideos(videosData.videos || []);
      }
    } catch (err) {
      console.error('Failed to fetch status:', err);
    } finally {
      setLoading(false);
    }
  };

  // Fetch cron enabled status
  const fetchCronStatus = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/auto-clone/cron-status`, { headers: renderAuthHeader });
      if (res.ok) {
        const data = await res.json();
        setCronEnabled(data.enabled);
      }
    } catch (err) {
      console.error('Failed to fetch cron status:', err);
    }
  };

  // Toggle cron enabled status
  const toggleCron = async (enabled: boolean) => {
    setTogglingCron(true);
    try {
      const res = await fetch(`${API_BASE_URL}/auto-clone/cron-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...renderAuthHeader },
        body: JSON.stringify({ enabled }),
      });
      if (res.ok) {
        setCronEnabled(enabled);
        toast({
          title: enabled ? 'Auto Poster enabled' : 'Auto Poster disabled',
          description: enabled
            ? 'Daily 6am PST cron job is now active'
            : 'Daily cron job is now paused',
        });
      }
    } catch (err) {
      toast({
        title: 'Failed to toggle cron',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setTogglingCron(false);
    }
  };

  // Initial fetch on mount only
  useEffect(() => {
    fetchStatus(true);
    fetchCronStatus();
  }, []);

  // Polling when something is in progress
  useEffect(() => {
    const hasRunning = runs.some(r => r.status === 'running');
    const hasProcessing = processedVideos.some(v => v.status === 'processing');

    if (!hasRunning && !hasProcessing && !triggering) {
      return; // No polling needed
    }

    const interval = setInterval(() => {
      fetchStatus(false); // No loading spinner for polling
    }, 5000);

    return () => clearInterval(interval);
  }, [runs, processedVideos, triggering]);

  // Check if there's already a run today
  const hasRunToday = runs.length > 0 && runs[0].run_date === new Date().toISOString().split('T')[0];
  const isRunning = runs.some(r => r.status === 'running');

  // Trigger manual run with SSE progress
  const triggerRun = async (force = false) => {
    setTriggering(true);
    setLiveProgress('Starting auto-clone...');

    try {
      const response = await fetch(`${API_BASE_URL}/auto-clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...renderAuthHeader },
        body: JSON.stringify({ force }),
      });

      if (!response.ok) {
        throw new Error(`Failed to trigger: ${response.status}`);
      }

      // Read SSE stream
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const text = decoder.decode(value);
          const lines = text.split('\n');

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.type === 'progress') {
                  setLiveProgress(`${data.step}: ${data.message} (${data.progress}%)`);
                } else if (data.type === 'complete') {
                  setLiveProgress(null);
                  toast({
                    title: 'Auto-clone complete',
                    description: data.success
                      ? `Video uploaded: ${data.youtubeUrl}`
                      : 'No suitable candidates found',
                  });
                  fetchStatus();
                } else if (data.type === 'error') {
                  setLiveProgress(null);
                  toast({
                    title: 'Auto-clone failed',
                    description: data.error,
                    variant: 'destructive',
                  });
                  fetchStatus();
                }
              } catch (e) {
                // Ignore parse errors
              }
            }
          }
        }
      }
    } catch (err) {
      toast({
        title: 'Failed to trigger',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
      setLiveProgress(null);
    } finally {
      setTriggering(false);
    }
  };

  // Retry a failed video
  const retryVideo = async (videoId: string) => {
    setRetrying(videoId);
    try {
      const response = await fetch(`${API_BASE_URL}/auto-clone/retry/${videoId}`, {
        method: 'POST',
        headers: renderAuthHeader,
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || `Failed: ${response.status}`);
      }
      toast({
        title: 'Retry started',
        description: 'Video processing has been restarted',
      });
      fetchStatus();
    } catch (err) {
      toast({
        title: 'Retry failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setRetrying(null);
    }
  };

  // Delete a processed video
  const deleteVideo = async (videoId: string) => {
    setDeleting(videoId);
    try {
      const response = await fetch(`${API_BASE_URL}/auto-clone/processed/${videoId}`, {
        method: 'DELETE',
        headers: renderAuthHeader,
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || `Failed: ${response.status}`);
      }
      toast({
        title: 'Video deleted',
        description: 'Video removed from processed list',
      });
      fetchStatus();
    } catch (err) {
      toast({
        title: 'Delete failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setDeleting(null);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'running':
      case 'processing':
        return <Badge variant="secondary" className="bg-blue-500/20 text-blue-400"><Loader2 className="w-3 h-3 mr-1 animate-spin" />Running</Badge>;
      case 'completed':
        return <Badge variant="secondary" className="bg-green-500/20 text-green-400"><CheckCircle className="w-3 h-3 mr-1" />Completed</Badge>;
      case 'failed':
        return <Badge variant="secondary" className="bg-red-500/20 text-red-400"><XCircle className="w-3 h-3 mr-1" />Failed</Badge>;
      case 'no_candidates':
        return <Badge variant="secondary" className="bg-yellow-500/20 text-yellow-400"><Clock className="w-3 h-3 mr-1" />No Candidates</Badge>;
      case 'pending':
        return <Badge variant="secondary" className="bg-gray-500/20 text-gray-400"><Clock className="w-3 h-3 mr-1" />Pending</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  };

  const formatDuration = (seconds: number | null) => {
    if (!seconds) return '-';
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${mins}m`;
  };

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <div>
              <h1 className="text-2xl font-bold">Auto Poster</h1>
              <p className="text-muted-foreground">Daily automated video cloning workflow</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            {/* Cron Toggle */}
            <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 rounded-lg">
              <Power className={`w-4 h-4 ${cronEnabled ? 'text-green-400' : 'text-muted-foreground'}`} />
              <span className="text-sm text-muted-foreground">Daily 6am PST</span>
              <Switch
                checked={cronEnabled ?? false}
                onCheckedChange={toggleCron}
                disabled={togglingCron || cronEnabled === null}
              />
            </div>
            <Button variant="outline" onClick={() => fetchStatus(true)} disabled={loading}>
              <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button
              onClick={() => triggerRun(hasRunToday)}
              disabled={triggering || isRunning}
              variant={hasRunToday && !isRunning ? "destructive" : "default"}
            >
              {triggering ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : isRunning ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Play className="w-4 h-4 mr-2" />
              )}
              {isRunning ? 'Running...' : hasRunToday ? 'Force Re-Run' : 'Run Now'}
            </Button>
          </div>
        </div>

        {/* Live Progress */}
        {liveProgress && (
          <Card className="border-blue-500/50 bg-blue-500/10">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <Loader2 className="w-5 h-5 animate-spin text-blue-400" />
                <span className="text-sm font-medium">{liveProgress}</span>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Processed Videos */}
        <Card>
          <CardHeader>
            <CardTitle>Processed Videos</CardTitle>
            <CardDescription>Videos that have been cloned (won't be selected again)</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin" />
              </div>
            ) : processedVideos.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">No videos processed yet.</p>
            ) : (
              <div className="space-y-3">
                {processedVideos.map((video) => (
                  <div key={video.id} className="flex items-start gap-4 p-3 bg-muted/50 rounded-lg overflow-hidden">
                    {video.original_thumbnail_url && (
                      <img
                        src={video.original_thumbnail_url}
                        alt={video.original_title}
                        className="w-32 h-18 object-cover rounded"
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        {getStatusBadge(video.status)}
                        {video.outlier_multiplier && (
                          <Badge variant="outline" className="text-xs">
                            {video.outlier_multiplier.toFixed(1)}x outlier
                          </Badge>
                        )}
                      </div>
                      <p className="font-medium truncate">{video.original_title}</p>
                      {video.cloned_title && (
                        <p className="text-sm text-muted-foreground truncate">→ {video.cloned_title}</p>
                      )}
                      <div className="flex gap-4 mt-1 text-xs text-muted-foreground">
                        <span>Duration: {formatDuration(video.duration_seconds)}</span>
                        <span>Processed: {formatDate(video.processed_at)}</span>
                      </div>
                      <div className="flex gap-3 mt-1">
                        {video.youtube_url && (
                          <a
                            href={video.youtube_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-blue-400 hover:underline"
                          >
                            View on YouTube
                          </a>
                        )}
                        {video.project_id && (
                          <button
                            onClick={() => navigate(`/?project=${video.project_id}`)}
                            className="text-xs text-green-400 hover:underline"
                          >
                            View Project
                          </button>
                        )}
                      </div>
                      {video.error_message && (
                        <p className="text-xs text-red-400 mt-1 truncate">{video.error_message}</p>
                      )}
                      {video.status === 'processing' && video.current_step && (
                        <p className="text-xs text-blue-400 mt-1 truncate">
                          <Loader2 className="w-3 h-3 inline mr-1 animate-spin" />
                          {video.current_step}
                        </p>
                      )}
                    </div>
                    <div className="flex gap-2 shrink-0">
                      {video.status === 'failed' && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => retryVideo(video.video_id)}
                          disabled={retrying === video.video_id}
                        >
                          {retrying === video.video_id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <RotateCcw className="w-4 h-4" />
                          )}
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => deleteVideo(video.video_id)}
                        disabled={deleting === video.video_id}
                        className="text-red-400 hover:text-red-300 hover:border-red-400"
                      >
                        {deleting === video.video_id ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Trash2 className="w-4 h-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
