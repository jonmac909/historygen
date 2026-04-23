import { useState, useEffect, useMemo } from "react";
import { Video, Heart, ChevronLeft, Tag, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getFavoriteProjects, toggleFavorite, type Project } from "@/lib/projectStore";
import { toast } from "@/hooks/use-toast";

interface FavoritesViewProps {
  onSelectProject: (project: Project) => void;
  onBack?: () => void;
}

export function FavoritesView({
  onSelectProject,
  onBack,
}: FavoritesViewProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);

  useEffect(() => {
    const loadProjects = async () => {
      setIsLoading(true);
      const favoriteProjects = await getFavoriteProjects();
      // Sort by updatedAt, most recent first
      favoriteProjects.sort((a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
      setProjects(favoriteProjects);
      setIsLoading(false);
    };
    loadProjects();
  }, []);

  // Get all unique tags from projects
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    projects.forEach(project => {
      project.tags?.forEach(tag => tagSet.add(tag));
    });
    return Array.from(tagSet).sort();
  }, [projects]);

  // Filter projects by selected tag
  const filteredProjects = useMemo(() => {
    if (!selectedTag) return projects;
    return projects.filter(project => project.tags?.includes(selectedTag));
  }, [projects, selectedTag]);

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

  // Handle unfavorite
  const handleUnfavorite = async (e: React.MouseEvent, projectId: string) => {
    e.stopPropagation(); // Prevent selecting the project
    try {
      await toggleFavorite(projectId);
      // Remove from local state immediately for responsive UI
      setProjects(prev => prev.filter(p => p.id !== projectId));
      toast({
        title: "Removed from favorites",
        description: "Project has been removed from your favorites.",
      });
    } catch (error) {
      console.error('Error toggling favorite:', error);
      toast({
        title: "Error",
        description: "Failed to remove from favorites.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="w-full max-w-4xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        {onBack && (
          <Button variant="ghost" size="icon" onClick={onBack}>
            <ChevronLeft className="w-5 h-5" />
          </Button>
        )}
        <div className="flex items-center gap-2">
          <Heart className="w-6 h-6 text-red-500 fill-red-500" />
          <h1 className="text-2xl font-bold text-foreground">Favorites</h1>
        </div>
      </div>

      {/* Tag Filter */}
      {allTags.length > 0 && (
        <div className="mb-6 space-y-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Tag className="w-4 h-4" />
            <span>Filter by tag</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setSelectedTag(null)}
              className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                !selectedTag
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80'
              }`}
            >
              All
            </button>
            {allTags.map(tag => (
              <button
                key={tag}
                onClick={() => setSelectedTag(selectedTag === tag ? null : tag)}
                className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                  selectedTag === tag
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                }`}
              >
                {tag}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Projects Grid */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      ) : projects.length === 0 ? (
        <div className="text-center py-12 space-y-4">
          <Heart className="w-12 h-12 mx-auto text-muted-foreground opacity-50" />
          <p className="text-muted-foreground">No favorite projects yet</p>
          <p className="text-sm text-muted-foreground">
            Add projects to favorites from the Projects drawer
          </p>
        </div>
      ) : filteredProjects.length === 0 ? (
        <div className="text-center py-12 space-y-4">
          <Tag className="w-12 h-12 mx-auto text-muted-foreground opacity-50" />
          <p className="text-muted-foreground">No projects with tag "{selectedTag}"</p>
          <Button variant="outline" size="sm" onClick={() => setSelectedTag(null)}>
            Clear filter
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredProjects.map((project) => {
            const thumbnail = getProjectThumbnail(project);
            const title = getProjectTitle(project);

            return (
              <button
                key={project.id}
                onClick={() => onSelectProject(project)}
                className="group text-left rounded-xl overflow-hidden border transition-all hover:scale-[1.02] hover:shadow-lg border-border hover:border-primary/40"
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
                  {/* Unfavorite button */}
                  <button
                    onClick={(e) => handleUnfavorite(e, project.id)}
                    className="absolute top-2 right-2 p-1.5 rounded-full bg-black/50 hover:bg-black/70 transition-colors"
                    title="Remove from favorites"
                  >
                    <Heart className="w-5 h-5 text-red-500 fill-red-500 hover:fill-red-400" />
                  </button>
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
