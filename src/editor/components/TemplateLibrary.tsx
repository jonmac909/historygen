/**
 * TemplateLibrary - Browse and manage editing templates
 */
import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Plus, Trash2, Eye } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { createClient } from '@supabase/supabase-js';
import { EditingTemplate } from '../types';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
);

interface TemplateLibraryProps {
  onTemplateSelect: (templateId: string | null) => void;
  selectedTemplateId: string | null;
  refreshKey?: number;
}

export function TemplateLibrary({ onTemplateSelect, selectedTemplateId, refreshKey }: TemplateLibraryProps) {
  const [templates, setTemplates] = useState<EditingTemplate[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadTemplates();
  }, [refreshKey]);

  const loadTemplates = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('editing_templates')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;
      const normalized = (data || []).map((template: any) => ({
        id: template.id,
        name: template.name,
        description: template.description,
        source: template.source,
        created_at: template.created_at,
        updated_at: template.updated_at,
        textStyles: template.text_styles || template.textStyles || [],
        transitions: template.transitions || {},
        brollPatterns: template.broll_patterns || template.brollPatterns || {},
        pacing: template.pacing || {},
      } as EditingTemplate));

      setTemplates(normalized);
    } catch (error: any) {
      console.error('Failed to load templates:', error);
      toast({
        title: 'Error',
        description: 'Failed to load templates',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const deleteTemplate = async (id: string) => {
    try {
      const { error } = await supabase
        .from('editing_templates')
        .delete()
        .eq('id', id);

      if (error) throw error;

      setTemplates(templates.filter((t) => t.id !== id));
      if (selectedTemplateId === id) {
        onTemplateSelect(null);
      }

      toast({
        title: 'Success',
        description: 'Template deleted',
      });
    } catch (error: any) {
      console.error('Failed to delete template:', error);
      toast({
        title: 'Error',
        description: 'Failed to delete template',
        variant: 'destructive',
      });
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <p className="text-muted-foreground">Loading templates...</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Template Library</h2>
          <p className="text-muted-foreground">
            Manage your editing style templates
          </p>
        </div>
        <Button>
          <Plus className="w-4 h-4 mr-2" />
          Create Template
        </Button>
      </div>

      {templates.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <p className="text-muted-foreground mb-4">
              No templates yet. Upload an example video to learn a template.
            </p>
            <Button variant="outline">
              <Plus className="w-4 h-4 mr-2" />
              Learn from Example
            </Button>
          </CardContent>
        </Card>
      ) : (
        <ScrollArea className="h-[600px]">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {templates.map((template) => (
              <Card
                key={template.id}
                className={`cursor-pointer transition-all ${
                  selectedTemplateId === template.id
                    ? 'ring-2 ring-primary'
                    : 'hover:shadow-lg'
                }`}
                onClick={() =>
                  onTemplateSelect(
                    selectedTemplateId === template.id ? null : template.id
                  )
                }
              >
                <CardHeader>
                  <CardTitle className="text-lg">{template.name}</CardTitle>
                  <CardDescription>{template.description}</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {/* Template Stats */}
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="secondary">
                        {template.textStyles?.length || 0} Text Styles
                      </Badge>
                      <Badge variant="secondary">
                        {template.transitions?.type || 'No transitions'}
                      </Badge>
                      <Badge variant="secondary">
                        {template.pacing?.energyLevel || 'Medium'} Energy
                      </Badge>
                    </div>

                    {/* Source */}
                    {template.source && (
                      <p className="text-xs text-muted-foreground truncate">
                        Source: {template.source}
                      </p>
                    )}

                    {/* Actions */}
                    <div className="flex gap-2 pt-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        onClick={(e) => {
                          e.stopPropagation();
                          // TODO: Preview template
                        }}
                      >
                        <Eye className="w-4 h-4 mr-1" />
                        Preview
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteTemplate(template.id);
                        }}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
