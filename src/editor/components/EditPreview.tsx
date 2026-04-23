/**
 * EditPreview - Preview auto-generated edits and render final video
 */
import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Film, Download, AlertCircle, Play } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { createClient } from '@supabase/supabase-js';
import { Player } from '@remotion/player';
import { DynamicVideo } from '../remotion/DynamicVideo';
import type { EditorProject, RemotionVideoProps } from '../types';
import { readSseStream } from '@/lib/sse';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
);

interface EditPreviewProps {
  refreshKey?: number;
}

export function EditPreview({ refreshKey }: EditPreviewProps) {
  const [projects, setProjects] = useState<EditorProject[]>([]);
  const [selectedProject, setSelectedProject] = useState<EditorProject | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadProjects();
  }, [refreshKey]);

  const loadProjects = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('editor_projects')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setProjects(data || []);
    } catch (error: any) {
      console.error('Failed to load projects:', error);
    } finally {
      setLoading(false);
    }
  };

  const [rendering, setRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderMessage, setRenderMessage] = useState('');

  const renderVideo = async (projectId: string) => {
    try {
      setRendering(true);
      setRenderProgress(0);
      setRenderMessage('Starting render...');

      const apiUrl = import.meta.env.VITE_RENDER_API_URL || 'http://localhost:10000';
      const response = await fetch(`${apiUrl}/video-editor/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      await readSseStream(response, ({ event, data }) => {
        if (event === 'progress') {
          const parsed = JSON.parse(data) as { progress?: number; message?: string };
          if (parsed.progress !== undefined) {
            setRenderProgress(parsed.progress);
          }
          if (parsed.message) {
            setRenderMessage(parsed.message);
          }
          return;
        }

        if (event === 'complete') {
          setRenderProgress(100);
          setRenderMessage('Render complete');
          void loadProjects();
          return;
        }

        if (event === 'error') {
          const parsed = JSON.parse(data) as { error?: string };
          throw new Error(parsed.error || 'Rendering failed');
        }
      });
    } catch (error: any) {
      console.error('Rendering failed:', error);
      alert('Rendering failed: ' + error.message);
    } finally {
      setRendering(false);
      setRenderProgress(0);
      setRenderMessage('');
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-2xl font-bold mb-2">Preview & Render</h2>
          <p className="text-muted-foreground">Loading projects...</p>
        </div>
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-2xl font-bold mb-2">Preview & Render</h2>
          <p className="text-muted-foreground">
            Preview your auto-generated edits and render the final video
          </p>
        </div>

        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            No projects yet. Upload a raw video first to generate edits.
          </AlertDescription>
        </Alert>

        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Film className="w-16 h-16 text-muted-foreground mb-4" />
            <p className="text-lg font-medium mb-2">No Projects Yet</p>
            <p className="text-muted-foreground text-center max-w-md mb-4">
              Upload a raw video with a selected template to generate AI-powered edits
            </p>
            <Button variant="outline">Go to Upload</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Convert project to Remotion props
  const getRemotionProps = (project: EditorProject): RemotionVideoProps => {
    const analysis = project.analysis as any;
    const durationInFrames = Math.floor((analysis?.duration || 60) * 30); // 30 FPS

    return {
      rawVideoUrl: project.raw_video_url,
      editDecisions: project.edit_decisions,
      fps: 30,
      durationInFrames,
      width: 1920,
      height: 1080,
    };
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold mb-2">Preview & Render</h2>
        <p className="text-muted-foreground">
          Preview your auto-generated edits and render the final video
        </p>
      </div>

      {/* Project List */}
      <Card>
        <CardHeader>
          <CardTitle>Your Projects ({projects.length})</CardTitle>
          <CardDescription>Select a project to preview and render</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {projects.map((project) => (
              <div
                key={project.id}
                className={`p-4 border rounded-lg cursor-pointer transition-colors ${
                  selectedProject?.id === project.id
                    ? 'border-primary bg-primary/5'
                    : 'hover:bg-muted'
                }`}
                onClick={() => setSelectedProject(project)}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">{project.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {project.edit_decisions.length} edit decisions
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedProject(project);
                    }}
                  >
                    <Play className="w-4 h-4 mr-1" />
                    Preview
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Preview Player */}
      {selectedProject && (
        <Card>
          <CardHeader>
            <CardTitle>Preview: {selectedProject.name}</CardTitle>
            <CardDescription>
              Real-time preview with Remotion Player
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="mb-4">
              <Player
                component={DynamicVideo}
                inputProps={getRemotionProps(selectedProject)}
                durationInFrames={getRemotionProps(selectedProject).durationInFrames}
                fps={30}
                compositionWidth={1920}
                compositionHeight={1080}
                style={{
                  width: '100%',
                  aspectRatio: '16/9',
                }}
                controls
                loop
              />
            </div>
            {rendering && (
              <div className="mb-4">
                <div className="flex items-center justify-between text-sm mb-2">
                  <span className="text-muted-foreground">{renderMessage || 'Rendering...'}</span>
                  <span className="font-medium">{renderProgress}%</span>
                </div>
                <Progress value={renderProgress} />
              </div>
            )}
            <div className="flex gap-2">
              <Button
                className="flex-1"
                onClick={() => renderVideo(selectedProject.id)}
                disabled={rendering}
              >
                <Film className="w-4 h-4 mr-2" />
                {rendering ? 'Rendering...' : 'Render Final Video'}
              </Button>
              <Button variant="outline" className="flex-1" disabled={rendering}>
                <Download className="w-4 h-4 mr-2" />
                Export Project
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
