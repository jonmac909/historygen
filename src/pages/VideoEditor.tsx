/**
 * VideoEditor Page - AI-powered video editing with learned templates
 */
import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TemplateLibrary } from '@/editor/components/TemplateLibrary';
import { ExampleUploader } from '@/editor/components/ExampleUploader';
import { RawVideoInput } from '@/editor/components/RawVideoInput';
import { EditPreview } from '@/editor/components/EditPreview';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Wand2, Upload, Film, Library } from 'lucide-react';
import type { EditingTemplate, EditorProject } from '@/editor/types';

export default function VideoEditor() {
  const [activeTab, setActiveTab] = useState('templates');
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [templatesRefreshKey, setTemplatesRefreshKey] = useState(0);
  const [projectsRefreshKey, setProjectsRefreshKey] = useState(0);

  const handleTemplateCreated = (template: EditingTemplate) => {
    setTemplatesRefreshKey((prev) => prev + 1);
    setSelectedTemplateId(template.id);
    setActiveTab('templates');
  };

  const handleProjectCreated = (_project: EditorProject) => {
    setProjectsRefreshKey((prev) => prev + 1);
    setActiveTab('preview');
  };

  return (
    <div className="container mx-auto py-8 px-4 max-w-7xl">
      <div className="mb-8">
        <h1 className="text-4xl font-bold mb-2 flex items-center gap-3">
          <Wand2 className="w-10 h-10" />
          AI Video Editor
        </h1>
        <p className="text-muted-foreground text-lg">
          Learn editing styles from examples and automatically apply them to raw footage
        </p>
      </div>

      {/* Workflow Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Library className="w-5 h-5" />
              1. Learn Templates
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CardDescription>
              Upload example videos to extract editing styles, text animations, and transitions
            </CardDescription>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Upload className="w-5 h-5" />
              2. Upload Raw Video
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CardDescription>
              Upload raw footage for AI analysis and scene detection
            </CardDescription>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Film className="w-5 h-5" />
              3. Auto-Edit & Render
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CardDescription>
              AI generates edit decisions using your templates and renders the final video
            </CardDescription>
          </CardContent>
        </Card>
      </div>

      {/* Main Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="templates">Templates</TabsTrigger>
          <TabsTrigger value="learn">Learn from Example</TabsTrigger>
          <TabsTrigger value="upload">Upload Video</TabsTrigger>
          <TabsTrigger value="preview">Preview & Render</TabsTrigger>
        </TabsList>

        <TabsContent value="templates" className="space-y-4">
          <TemplateLibrary
            onTemplateSelect={setSelectedTemplateId}
            selectedTemplateId={selectedTemplateId}
            refreshKey={templatesRefreshKey}
          />
        </TabsContent>

        <TabsContent value="learn" className="space-y-4">
          <ExampleUploader onTemplateCreated={handleTemplateCreated} />
        </TabsContent>

        <TabsContent value="upload" className="space-y-4">
          <RawVideoInput
            selectedTemplateId={selectedTemplateId}
            onProjectCreated={handleProjectCreated}
          />
        </TabsContent>

        <TabsContent value="preview" className="space-y-4">
          <EditPreview refreshKey={projectsRefreshKey} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
