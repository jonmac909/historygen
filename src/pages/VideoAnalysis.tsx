/**
 * Video Analysis - VideoRAG Intelligence Page
 *
 * Shows:
 * - Analyzed videos list with status
 * - Trigger new analysis
 * - Q&A interface for querying video patterns
 * - Aggregated insights dashboard
 */

import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  ArrowLeft,
  Play,
  RefreshCw,
  CheckCircle,
  XCircle,
  Loader2,
  Search,
  BarChart3,
  Video,
  Palette,
  Eye,
  Trash2,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const API_BASE_URL = import.meta.env.VITE_RENDER_API_URL || '';
const renderApiKey = import.meta.env.VITE_INTERNAL_API_KEY;
const renderAuthHeader = renderApiKey ? { 'X-Internal-Api-Key': renderApiKey } : {};

interface AnalyzedVideo {
  id: string;
  video_id: string;
  video_url: string;
  title: string | null;
  channel_name: string | null;
  duration_seconds: number | null;
  view_count: number | null;
  status: 'pending' | 'downloading' | 'extracting' | 'analyzing' | 'complete' | 'failed';
  progress: number;
  error_message: string | null;
  avg_scene_duration: number | null;
  cuts_per_minute: number | null;
  dominant_colors: string[] | null;
  analyzed_at: string | null;
  created_at: string;
}

interface Insights {
  videoCount: number;
  avgSceneDuration: number | null;
  avgCutsPerMinute: number | null;
  topColors: { color: string; frequency: number }[];
  sceneRange: [number, number] | null;
}

export default function VideoAnalysis() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [videos, setVideos] = useState<AnalyzedVideo[]>([]);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [newVideoUrl, setNewVideoUrl] = useState('');
  const [healthStatus, setHealthStatus] = useState<{ imagebind: boolean; supabase: boolean } | null>(null);
  const [currentAnalysis, setCurrentAnalysis] = useState<{
    videoId: string;
    title?: string;
    status: string;
    progress: number;
    error?: string;
    statusMessage?: string;
  } | null>(null);
  const [selectedVideo, setSelectedVideo] = useState<AnalyzedVideo | null>(null);
  const [videoDetails, setVideoDetails] = useState<any>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);

  // Refs for auto-scrolling to response
  const dialogContentRef = useRef<HTMLDivElement>(null);
  const responseRef = useRef<HTMLDivElement>(null);

  // Poll analysis status
  const pollAnalysisStatus = async (videoId: string) => {
    try {
      const response = await fetch(`${API_BASE_URL}/video-analysis/status/${videoId}`, {
        headers: renderAuthHeader,
      });
      const data = await response.json();

      if (data.success) {
        setCurrentAnalysis({
          videoId,
          title: data.title,
          status: data.status,
          progress: data.progress || 0,
          error: data.error,
          statusMessage: data.status_message,
        });

        // Keep polling if still processing
        if (data.status !== 'complete' && data.status !== 'failed') {
          setTimeout(() => pollAnalysisStatus(videoId), 2000);
        } else {
          // Analysis done - refresh videos list
          if (data.status === 'complete') {
            fetchVideos();
            toast({
              title: 'Analysis complete',
              description: `Video ${videoId} has been analyzed`,
            });
          } else if (data.status === 'failed') {
            toast({
              title: 'Analysis failed',
              description: data.error || 'Unknown error',
              variant: 'destructive',
            });
          }
          // Clear after a delay so user can see final status
          setTimeout(() => setCurrentAnalysis(null), 5000);
        }
      }
    } catch (err) {
      console.error('Failed to poll status:', err);
    }
  };

  // Fetch analyzed videos and insights
  const fetchVideos = async () => {
    try {
      // Fetch both insights and videos list in parallel
      const [insightsRes, videosRes] = await Promise.all([
        fetch(`${API_BASE_URL}/video-analysis/insights`, { headers: renderAuthHeader }),
        fetch(`${API_BASE_URL}/video-analysis/videos`, { headers: renderAuthHeader }),
      ]);

      if (insightsRes.ok) {
        const data = await insightsRes.json();
        setInsights(data.insights);
      }

      if (videosRes.ok) {
        const data = await videosRes.json();
        setVideos(data.videos || []);
      }
    } catch (err) {
      console.error('Failed to fetch videos:', err);
    }
  };

  // Fetch video details for preview
  const fetchVideoDetails = async (videoId: string) => {
    setLoadingDetails(true);
    try {
      const response = await fetch(`${API_BASE_URL}/video-analysis/${videoId}`, {
        headers: renderAuthHeader,
      });
      if (response.ok) {
        const data = await response.json();
        setVideoDetails(data);
      }
    } catch (err) {
      console.error('Failed to fetch video details:', err);
    } finally {
      setLoadingDetails(false);
    }
  };

  // Delete a video
  const deleteVideo = async (videoId: string, e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent opening preview
    if (!confirm('Delete this video analysis?')) return;

    try {
      const response = await fetch(`${API_BASE_URL}/video-analysis/${videoId}`, {
        method: 'DELETE',
        headers: renderAuthHeader,
      });
      const data = await response.json();
      if (data.success) {
        toast({ title: 'Deleted', description: 'Video analysis removed' });
        fetchVideos(); // Refresh list
      } else {
        throw new Error(data.error);
      }
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    }
  };

  // Video-specific chat state
  const [videoQuery, setVideoQuery] = useState('');
  const [videoQueryResponse, setVideoQueryResponse] = useState<string | null>(null);
  const [videoQuerying, setVideoQuerying] = useState(false);

  // Auto-scroll to response when it appears
  useEffect(() => {
    if (videoQueryResponse && responseRef.current) {
      // Scroll the response into view smoothly
      responseRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [videoQueryResponse]);

  // Ask question about specific video
  const askAboutVideo = async () => {
    if (!videoQuery.trim() || !selectedVideo) return;

    setVideoQuerying(true);
    setVideoQueryResponse(null);
    try {
      const response = await fetch(`${API_BASE_URL}/video-analysis/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...renderAuthHeader },
        body: JSON.stringify({
          question: videoQuery,
          videoIds: [selectedVideo.video_id],
        }),
      });

      const data = await response.json();
      if (data.success) {
        setVideoQueryResponse(data.answer);
      } else {
        throw new Error(data.error || 'Query failed');
      }
    } catch (err: any) {
      toast({ title: 'Query failed', description: err.message, variant: 'destructive' });
    } finally {
      setVideoQuerying(false);
    }
  };

  // Open video preview
  const openVideoPreview = (video: AnalyzedVideo) => {
    setSelectedVideo(video);
    setVideoDetails(null);
    setVideoQuery('');
    setVideoQueryResponse(null);
    fetchVideoDetails(video.video_id);
  };

  // Check service health
  const checkHealth = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/video-analysis/health`, {
        headers: renderAuthHeader,
      });
      if (response.ok) {
        const data = await response.json();
        setHealthStatus({
          imagebind: data.services?.imagebind?.available || false,
          supabase: data.services?.supabase || false,
        });
      }
    } catch (err) {
      console.error('Failed to check health:', err);
    }
  };

  // Initial fetch
  useEffect(() => {
    Promise.all([fetchVideos(), checkHealth()]).finally(() => setLoading(false));
  }, []);

  // Extract video ID from YouTube URL
  const extractVideoId = (url: string): string | null => {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
      /^[a-zA-Z0-9_-]{11}$/,
    ];
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return match[1] || match[0];
    }
    return null;
  };

  // Start analysis for a new video
  const startAnalysis = async () => {
    const videoId = extractVideoId(newVideoUrl.trim());
    if (!videoId) {
      toast({
        title: 'Invalid URL',
        description: 'Please enter a valid YouTube URL or video ID',
        variant: 'destructive',
      });
      return;
    }

    setAnalyzing(true);
    try {
      const response = await fetch(`${API_BASE_URL}/video-analysis/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...renderAuthHeader },
        body: JSON.stringify({ videoUrl: `https://www.youtube.com/watch?v=${videoId}` }),
      });

      const data = await response.json();
      if (data.success) {
        toast({
          title: 'Analysis started',
          description: `Processing video ${videoId}`,
        });
        setNewVideoUrl('');
        setCurrentAnalysis({
          videoId,
          status: data.status || 'pending',
          progress: 0,
        });
        // Start polling for progress
        setTimeout(() => pollAnalysisStatus(videoId), 1000);
      } else {
        throw new Error(data.error || 'Failed to start analysis');
      }
    } catch (err: any) {
      toast({
        title: 'Error',
        description: err.message,
        variant: 'destructive',
      });
    } finally {
      setAnalyzing(false);
    }
  };

  // Format duration
  const formatDuration = (seconds: number | null): string => {
    if (!seconds) return '-';
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return `${mins}m ${secs}s`;
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b">
        <div className="container mx-auto px-4 py-4 flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1">
            <h1 className="text-xl font-semibold">Video Analysis</h1>
          </div>
          <Button variant="outline" size="sm" onClick={() => { fetchVideos(); checkHealth(); }}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </div>

      <div className="container mx-auto px-4 py-6 space-y-6">

        {/* Analyze New Video */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Video className="h-5 w-5" />
              Analyze New Video
            </CardTitle>
            <CardDescription>
              Enter a YouTube URL to extract visual style patterns, pacing, and color analysis
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2">
              <Input
                placeholder="https://youtube.com/watch?v=... or video ID"
                value={newVideoUrl}
                onChange={(e) => setNewVideoUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && startAnalysis()}
                className="flex-1"
              />
              <Button onClick={startAnalysis} disabled={analyzing || !newVideoUrl.trim()}>
                {analyzing ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <Play className="h-4 w-4 mr-2" />
                )}
                Analyze
              </Button>
            </div>

            {/* Analysis Progress */}
            {currentAnalysis && (
              <div className="mt-4 p-4 border rounded-lg bg-muted/50">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    {currentAnalysis.status === 'failed' ? (
                      <XCircle className="h-4 w-4 text-red-500" />
                    ) : currentAnalysis.status === 'complete' ? (
                      <CheckCircle className="h-4 w-4 text-green-500" />
                    ) : (
                      <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                    )}
                    <span className="font-medium truncate max-w-[300px]" title={currentAnalysis.title || currentAnalysis.videoId}>
                      {currentAnalysis.title || currentAnalysis.videoId}
                    </span>
                    <Badge variant={
                      currentAnalysis.status === 'failed' ? 'destructive' :
                      currentAnalysis.status === 'complete' ? 'default' : 'secondary'
                    }>
                      {currentAnalysis.status}
                    </Badge>
                  </div>
                  <span className="text-sm font-mono">
                    {currentAnalysis.progress}%
                  </span>
                </div>
                {currentAnalysis.statusMessage && (
                  <div className="text-sm text-muted-foreground mb-2">
                    {currentAnalysis.statusMessage}
                  </div>
                )}
                <div className="w-full bg-muted rounded-full h-2">
                  <div
                    className={`h-2 rounded-full transition-all duration-300 ${
                      currentAnalysis.status === 'failed' ? 'bg-red-500' :
                      currentAnalysis.status === 'complete' ? 'bg-green-500' : 'bg-blue-500'
                    }`}
                    style={{ width: `${currentAnalysis.progress}%` }}
                  />
                </div>
                {currentAnalysis.error && (
                  <p className="mt-2 text-sm text-red-500">
                    Error: {currentAnalysis.error}
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>


        {/* Analyzed Videos List */}
        {videos.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Video className="h-5 w-5" />
                Analyzed Videos
              </CardTitle>
              <CardDescription>
                Click a video to view detailed analysis and ask questions
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {videos.map((video) => (
                  <div
                    key={video.video_id}
                    className="flex items-center justify-between p-3 border rounded-lg hover:bg-muted/50 cursor-pointer transition-colors"
                    onClick={() => video.status === 'complete' && openVideoPreview(video)}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex-shrink-0">
                        {video.status === 'complete' ? (
                          <CheckCircle className="h-5 w-5 text-green-500" />
                        ) : video.status === 'failed' ? (
                          <XCircle className="h-5 w-5 text-red-500" />
                        ) : (
                          <Loader2 className="h-5 w-5 animate-spin text-blue-500" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="font-medium truncate">
                          {video.title || video.video_id}
                        </p>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          {video.duration_seconds && (
                            <span>{Math.floor(video.duration_seconds / 60)}:{(video.duration_seconds % 60).toFixed(0).padStart(2, '0')}</span>
                          )}
                          {video.avg_scene_duration && (
                            <span>• {video.avg_scene_duration.toFixed(1)}s scenes</span>
                          )}
                          {video.cuts_per_minute && (
                            <span>• {video.cuts_per_minute.toFixed(1)} cuts/min</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {video.dominant_colors?.slice(0, 3).map((color, i) => (
                        <div
                          key={i}
                          className="w-4 h-4 rounded border"
                          style={{ backgroundColor: color }}
                          title={color}
                        />
                      ))}
                      {video.status === 'complete' && (
                        <Button variant="ghost" size="sm" className="ml-2">
                          <Eye className="h-4 w-4" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground hover:text-red-500"
                        onClick={(e) => deleteVideo(video.video_id, e)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Empty State */}
        {!loading && (!insights || insights.videoCount === 0) && (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <BarChart3 className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2">No videos analyzed yet</h3>
              <p className="text-muted-foreground mb-4 max-w-md">
                Start by analyzing a YouTube video above. The system will extract visual patterns,
                pacing, and color analysis that you can query.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Loading State */}
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>

      {/* Video Preview Modal */}
      <Dialog open={!!selectedVideo} onOpenChange={(open) => !open && setSelectedVideo(null)}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Video className="h-5 w-5" />
              {selectedVideo?.title || selectedVideo?.video_id}
            </DialogTitle>
            <DialogDescription>
              Video analysis details and scene breakdown
            </DialogDescription>
          </DialogHeader>

          {loadingDetails ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin" />
            </div>
          ) : videoDetails?.video ? (
            <div className="space-y-6">
              {/* YouTube Video Player */}
              <div className="aspect-video w-full rounded-lg overflow-hidden bg-black">
                <iframe
                  src={`https://www.youtube.com/embed/${selectedVideo?.video_id}`}
                  className="w-full h-full"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                  title={selectedVideo?.title || 'Video player'}
                />
              </div>

              {/* Video Info */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="text-center p-3 bg-muted rounded-lg">
                  <p className="text-2xl font-bold">{Math.floor((videoDetails.video.duration_seconds || 0) / 60)}:{((videoDetails.video.duration_seconds || 0) % 60).toFixed(0).padStart(2, '0')}</p>
                  <p className="text-xs text-muted-foreground">Duration</p>
                </div>
                <div className="text-center p-3 bg-muted rounded-lg">
                  <p className="text-2xl font-bold">{videoDetails.video.pacing_analysis?.scenes?.length || 0}</p>
                  <p className="text-xs text-muted-foreground">Scenes</p>
                </div>
                <div className="text-center p-3 bg-muted rounded-lg">
                  <p className="text-2xl font-bold">{videoDetails.video.avg_scene_duration?.toFixed(1) || '-'}s</p>
                  <p className="text-xs text-muted-foreground">Avg Scene</p>
                </div>
                <div className="text-center p-3 bg-muted rounded-lg">
                  <p className="text-2xl font-bold">{videoDetails.video.cuts_per_minute?.toFixed(1) || '-'}</p>
                  <p className="text-xs text-muted-foreground">Cuts/Min</p>
                </div>
              </div>

              {/* Color Palette */}
              {videoDetails.video.dominant_colors?.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium mb-2">Dominant Colors</h4>
                  <div className="flex flex-wrap gap-2">
                    {videoDetails.video.dominant_colors.map((color: string, i: number) => (
                      <div key={i} className="flex items-center gap-2 px-3 py-1.5 border rounded-lg">
                        <div
                          className="w-5 h-5 rounded border"
                          style={{ backgroundColor: color }}
                        />
                        <span className="text-sm font-mono">{color}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Scene Timeline */}
              {videoDetails.video.visual_analysis?.colors?.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium mb-2">Scene Color Timeline</h4>
                  <div className="flex h-8 rounded overflow-hidden border">
                    {videoDetails.video.visual_analysis.colors.map((scene: any, i: number) => {
                      const scenes = videoDetails.video.pacing_analysis?.scenes || [];
                      const sceneData = scenes[i];
                      const duration = sceneData ? sceneData.endSeconds - sceneData.startSeconds : 1;
                      const totalDuration = videoDetails.video.duration_seconds || 1;
                      const widthPercent = (duration / totalDuration) * 100;
                      return (
                        <div
                          key={i}
                          className="h-full hover:opacity-80 transition-opacity cursor-pointer"
                          style={{
                            backgroundColor: scene.dominantColor,
                            width: `${Math.max(widthPercent, 0.5)}%`,
                          }}
                          title={`Scene ${i + 1}: ${sceneData?.startSeconds?.toFixed(1) || 0}s - ${sceneData?.endSeconds?.toFixed(1) || 0}s`}
                        />
                      );
                    })}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Each segment represents a scene - width proportional to duration
                  </p>
                </div>
              )}

              {/* Ask Questions About This Video */}
              <div className="pt-4 border-t">
                <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
                  <Search className="h-4 w-4" />
                  Ask About This Video
                </h4>
                <div className="flex gap-2">
                  <Input
                    placeholder="What visual techniques are used? What's the pacing like?"
                    value={videoQuery}
                    onChange={(e) => setVideoQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && askAboutVideo()}
                    className="flex-1"
                  />
                  <Button onClick={askAboutVideo} disabled={videoQuerying || !videoQuery.trim()}>
                    {videoQuerying ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Search className="h-4 w-4" />
                    )}
                  </Button>
                </div>
                {videoQueryResponse && (
                  <div ref={responseRef} className="mt-3 p-3 bg-muted rounded-lg">
                    <p className="text-sm whitespace-pre-wrap">{videoQueryResponse}</p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <p className="text-muted-foreground text-center py-8">Failed to load video details</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
