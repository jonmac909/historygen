import { useState, useEffect } from "react";
import { Video, Plus, ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getAllProjects, type Project } from "@/lib/projectStore";

interface AllProjectsViewProps {
  onSelectProject: (projectId: string) => void;
  onNewProject: () => void;
  onBack?: () => void;
  currentProjectId?: string;
}

export function AllProjectsView({
  onSelectProject,
  onNewProject,
  onBack,
  currentProjectId,
}: AllProjectsViewProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadProjects = async () => {
      setIsLoading(true);
      const allProjects = await getAllProjects();
      // Sort by updatedAt, most recent first
      allProjects.sort((a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
      setProjects(allProjects);
      setIsLoading(false);
    };
    loadProjects();
  }, []);

  // Get thumbnail for a project
  const getProjectThumbnail = (project: Project): string | null => {
    // Priority: selected thumbnail > first thumbnail > first image
    if (project.thumbnails && project.thumbnails.length > 0) {
      const selectedIdx = project.selectedThumbnailIndex ?? 0;
      return project.thumbnails[selectedIdx] || project.thumbnails[0];
    }
    if (project.imageUrls && project.imageUrls.length > 0) {
      return project.imageUrls[0];
    }
    return null;
  };

  // Get display title for a project
  const getProjectTitle = (project: Project): string => {
    return project.videoTitle || "Untitled Project";
  };

  // Get status badge text and style info
  const getStatusBadge = (project: Project): { text: string; isRunning: boolean } => {
    if (project.status === 'running') return { text: 'Running on Server', isRunning: true };
    if (project.status === 'failed') return { text: 'Failed', isRunning: false };
    if (project.status === 'cancelled') return { text: 'Cancelled', isRunning: false };
    if (project.status === 'completed') return { text: 'Complete', isRunning: false };
    if (project.smokeEmbersVideoUrl || project.embersVideoUrl || project.videoUrl) return { text: 'Rendered', isRunning: false };
    if (project.imageUrls && project.imageUrls.length > 0) return { text: 'Images Ready', isRunning: false };
    if (project.srtContent) return { text: 'Captions Ready', isRunning: false };
    if (project.audioUrl) return { text: 'Audio Ready', isRunning: false };
    if (project.script) return { text: 'Script Ready', isRunning: false };
    return { text: 'In Progress', isRunning: false };
  };

  return (
    <div className="w-full max-w-4xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          {onBack && (
            <Button variant="ghost" size="icon" onClick={onBack}>
              <ChevronLeft className="w-5 h-5" />
            </Button>
          )}
          <h1 className="text-2xl font-bold text-foreground">All Projects</h1>
        </div>
        <Button onClick={onNewProject} className="gap-2">
          <Plus className="w-4 h-4" />
          New Project
        </Button>
      </div>

      {/* Projects Grid */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      ) : projects.length === 0 ? (
        <div className="text-center py-12 space-y-4">
          <Video className="w-12 h-12 mx-auto text-muted-foreground opacity-50" />
          <p className="text-muted-foreground">No projects yet</p>
          <Button onClick={onNewProject} className="gap-2">
            <Plus className="w-4 h-4" />
            Create your first project
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {projects.map((project) => {
            const thumbnail = getProjectThumbnail(project);
            const title = getProjectTitle(project);
            const { text: statusText, isRunning } = getStatusBadge(project);
            const isCurrent = project.id === currentProjectId;

            return (
              <button
                key={project.id}
                onClick={() => onSelectProject(project.id)}
                className={`group text-left rounded-xl overflow-hidden border transition-all hover:scale-[1.02] hover:shadow-lg ${
                  isCurrent
                    ? 'border-primary ring-2 ring-primary/20'
                    : 'border-border hover:border-primary/40'
                }`}
              >
                {/* Thumbnail */}
                <div className="relative aspect-video bg-muted">
                  {thumbnail ? (
                    <img
                      src={thumbnail}
                      alt={title}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <Video className="w-10 h-10 text-muted-foreground opacity-30" />
                    </div>
                  )}
                  {/* Status badge */}
                  <div className="absolute top-2 right-2">
                    <span className={`text-xs px-2 py-1 rounded-full flex items-center gap-1.5 ${
                      isRunning
                        ? 'bg-amber-500/90 text-white'
                        : statusText === 'Complete'
                        ? 'bg-green-500/90 text-white'
                        : statusText === 'Rendered'
                        ? 'bg-blue-500/90 text-white'
                        : statusText === 'Failed' || statusText === 'Cancelled'
                        ? 'bg-red-500/90 text-white'
                        : 'bg-black/70 text-white'
                    }`}>
                      {isRunning && (
                        <span className="w-2 h-2 bg-white rounded-full animate-pulse" />
                      )}
                      {statusText}
                    </span>
                  </div>
                  {/* Current indicator */}
                  {isCurrent && (
                    <div className="absolute top-2 left-2">
                      <span className="text-xs px-2 py-1 rounded-full bg-primary text-primary-foreground">
                        Current
                      </span>
                    </div>
                  )}
                </div>

                {/* Info */}
                <div className="p-4 space-y-1">
                  <h3 className="font-medium text-foreground line-clamp-2 group-hover:text-primary transition-colors">
                    {title}
                  </h3>
                    <p className="text-xs text-muted-foreground">
                    Updated {new Date(project.updatedAt).toLocaleDateString()}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
