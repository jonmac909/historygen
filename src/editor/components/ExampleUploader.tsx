/**
 * ExampleUploader - Upload example videos to learn templates
 */
import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Upload, Link as LinkIcon, Loader2 } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { readSseStream } from '@/lib/sse';
import type { EditingTemplate } from '../types';

interface ExampleUploaderProps {
  onTemplateCreated?: (template: EditingTemplate) => void;
}

export function ExampleUploader({ onTemplateCreated }: ExampleUploaderProps) {
  const [uploadMode, setUploadMode] = useState<'file' | 'url'>('url');
  const [videoUrl, setVideoUrl] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState('');

  const analyzeExample = async () => {
    if (!videoUrl.trim() || !templateName.trim()) {
      toast({
        title: 'Missing Information',
        description: 'Please provide both video URL and template name',
        variant: 'destructive',
      });
      return;
    }

    if (uploadMode === 'file') {
      toast({
        title: 'File upload not supported yet',
        description: 'Please use a URL for now',
        variant: 'destructive',
      });
      return;
    }

    try {
      setAnalyzing(true);
      setProgress(0);
      setProgressMessage('Starting analysis...');

      // Call backend API with SSE streaming
      const apiUrl = import.meta.env.VITE_RENDER_API_URL || 'http://localhost:10000';
      const response = await fetch(`${apiUrl}/video-editor/analyze-example`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoUrl, templateName }),
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      await readSseStream(response, ({ event, data }) => {
        if (event === 'progress') {
          const parsed = JSON.parse(data) as { progress?: number; message?: string };
          if (parsed.progress !== undefined) {
            setProgress(parsed.progress);
          }
          if (parsed.message) {
            setProgressMessage(parsed.message);
          }
          return;
        }

        if (event === 'complete') {
          const parsed = JSON.parse(data) as { template?: EditingTemplate };
          if (parsed.template) {
            onTemplateCreated?.(parsed.template);
          }
          setProgress(100);
          setProgressMessage('Template learned!');
          toast({
            title: 'Success',
            description: 'Template learned from example video!',
          });
          return;
        }

        if (event === 'error') {
          const parsed = JSON.parse(data) as { error?: string };
          throw new Error(parsed.error || 'Analysis failed');
        }
      });

      setVideoUrl('');
      setTemplateName('');
      setProgress(0);
      setProgressMessage('');
    } catch (error: any) {
      console.error('Failed to analyze example:', error);
      toast({
        title: 'Error',
        description: 'Failed to analyze example video',
        variant: 'destructive',
      });
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold mb-2">Learn from Example</h2>
        <p className="text-muted-foreground">
          Upload an example video to extract editing styles, text animations, and transitions
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Upload Example Video</CardTitle>
          <CardDescription>
            Provide a video that demonstrates the editing style you want to learn
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Upload Mode Toggle */}
          <div className="flex gap-2">
            <Button
              variant={uploadMode === 'url' ? 'default' : 'outline'}
              onClick={() => setUploadMode('url')}
              className="flex-1"
            >
              <LinkIcon className="w-4 h-4 mr-2" />
              URL
            </Button>
            <Button
              variant={uploadMode === 'file' ? 'default' : 'outline'}
              onClick={() => setUploadMode('file')}
              className="flex-1"
            >
              <Upload className="w-4 h-4 mr-2" />
              File Upload
            </Button>
          </div>

          {/* Video Input */}
          <div className="space-y-2">
            <Label htmlFor="videoInput">
              {uploadMode === 'url' ? 'Video URL' : 'Video File'}
            </Label>
            {uploadMode === 'url' ? (
              <Input
                id="videoInput"
                placeholder="https://youtube.com/watch?v=... or direct video URL"
                value={videoUrl}
                onChange={(e) => setVideoUrl(e.target.value)}
                disabled={analyzing}
              />
            ) : (
              <Input
                id="videoInput"
                type="file"
                accept="video/*"
                disabled={analyzing}
              />
            )}
          </div>

          {/* Template Name */}
          <div className="space-y-2">
            <Label htmlFor="templateName">Template Name</Label>
            <Input
              id="templateName"
              placeholder="e.g., Fast-paced Tech Reviews"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              disabled={analyzing}
            />
          </div>

          {/* Progress */}
          {analyzing && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Analyzing video...</span>
                <span className="font-medium">{progress}%</span>
              </div>
              <Progress value={progress} />
              <p className="text-xs text-muted-foreground">
                {progressMessage || (
                  <>
                    {progress < 30 && 'Detecting scenes and transitions...'}
                    {progress >= 30 && progress < 60 && 'Extracting text styles...'}
                    {progress >= 60 && progress < 90 && 'Analyzing pacing and timing...'}
                    {progress >= 90 && 'Saving template...'}
                  </>
                )}
              </p>
            </div>
          )}

          {/* Analyze Button */}
          <Button
            onClick={analyzeExample}
            disabled={analyzing || !videoUrl.trim() || !templateName.trim()}
            className="w-full"
            size="lg"
          >
            {analyzing ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Analyzing...
              </>
            ) : (
              <>
                <Upload className="w-4 h-4 mr-2" />
                Analyze & Learn Template
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Info Card */}
      <Card className="bg-muted/50">
        <CardHeader>
          <CardTitle className="text-base">What will be extracted?</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li>• Text styles (font, size, color, position)</li>
            <li>• Animation types (fade, slide, typewriter, etc.)</li>
            <li>• Transition patterns (cuts, fades, dissolves)</li>
            <li>• Pacing information (scene duration, energy level)</li>
            <li>• B-roll insertion patterns</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
