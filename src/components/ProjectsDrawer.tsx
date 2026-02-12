import { useState, useEffect } from "react";
import { FolderOpen, Trash2, ChevronRight, ChevronDown, Loader2, Heart, Globe, Clock, Archive, Square, ServerCog, Play, AlertCircle, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { stopPipeline, startFullPipeline } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import {
  getRootProjects,
  getProjectVersions,
  deleteProject,
  getArchivedProjects,
  toggleFavorite,
  upsertProject,
  formatDate,
  type Project,
} from "@/lib/projectStore";

interface ProjectsDrawerProps {
  onOpenProject?: (project: Project) => void;
  onViewFavorites?: () => void;
}

// Status options for projects
type ProjectStatus = 'in_progress' | 'live' | 'archived' | 'running';

const STATUS_OPTIONS: { value: ProjectStatus; label: string; icon: typeof Clock }[] = [
  { value: 'in_progress', label: 'In Progress', icon: Clock },
  { value: 'live', label: 'Live', icon: Globe },
  { value: 'archived', label: 'Archived', icon: Archive },
];

// Running status is shown separately, not in the dropdown
const RUNNING_STATUS = { value: 'running' as const, label: 'Running on Server', icon: ServerCog };

// Get a nice label for the current pipeline step
function getRunningStepLabel(step: string | undefined): string {
  switch (step) {
    case 'transcript': return 'Transcript';
    case 'script': return 'Script';
    case 'audio': return 'Audio';
    case 'captions': return 'Captions';
    case 'prompts': return 'Prompts';
    case 'images': return 'Images';
    case 'clips': return 'Clips';
    case 'render': return 'Render';
    case 'complete': return 'Complete';
    default: return 'Starting';
  }
}

// Filter options including 'all' and 'running'
type FilterOption = 'all' | ProjectStatus;

export function ProjectsDrawer({ onOpenProject, onViewFavorites }: ProjectsDrawerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Project | null>(null);
  const [statusFilter, setStatusFilter] = useState<FilterOption>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Load all projects when drawer opens
  useEffect(() => {
    if (isOpen) {
      setIsLoading(true);
      console.log('[ProjectsDrawer] Loading projects at', new Date().toISOString());
      Promise.all([getRootProjects(), getArchivedProjects()])
        .then(([rootProjects, archived]) => {
          console.log('[ProjectsDrawer] Loaded', rootProjects.length, 'root projects,', archived.length, 'archived');
          // Log first 3 projects with their timestamps
          rootProjects.slice(0, 3).forEach((p, i) => {
            console.log(`[ProjectsDrawer] #${i + 1}: "${p.videoTitle}" updated_at:`, new Date(p.updatedAt).toISOString());
          });
          // Combine all projects, mapping 'completed' to 'live' for display
          const allCombined = [
            ...rootProjects.map(p => ({
              ...p,
              status: p.status === 'completed' ? 'live' as const : p.status
            })),
            ...archived
          ];
          // Sort by updatedAt descending
          allCombined.sort((a, b) => b.updatedAt - a.updatedAt);
          setAllProjects(allCombined);
        })
        .catch(err => console.error('[ProjectsDrawer] Failed to load projects:', err))
        .finally(() => setIsLoading(false));
    }
  }, [isOpen]);

  const handleDelete = async (project: Project) => {
    setDeletingId(project.id);

    try {
      // If project is running on server, stop the pipeline first
      if (project.status === 'running') {
        console.log('[ProjectsDrawer] Stopping running pipeline before delete:', project.id);
        try {
          await stopPipeline(project.id);
        } catch (stopErr) {
          console.warn('[ProjectsDrawer] Failed to stop pipeline (may already be stopped):', stopErr);
        }
      }

      // Delete all files in the project folder from Supabase storage
      const { data: files, error: listError } = await supabase.storage
        .from("generated-assets")
        .list(project.id);

      if (listError) {
        console.error("Error listing files:", listError);
      } else if (files && files.length > 0) {
        const filePaths = files.map(f => `${project.id}/${f.name}`);
        const { error: deleteError } = await supabase.storage
          .from("generated-assets")
          .remove(filePaths);

        if (deleteError) {
          console.error("Error deleting files:", deleteError);
        } else {
          console.log(`Deleted ${filePaths.length} files from storage`);
        }
      }

      // Remove from project store (Supabase)
      await deleteProject(project.id);
      setAllProjects(prev => prev.filter(p => p.id !== project.id));

      toast({
        title: "Project Deleted",
        description: `"${project.videoTitle}" has been removed.`,
      });
    } catch (error) {
      console.error("Error deleting project:", error);
      toast({
        title: "Delete Failed",
        description: "Could not delete project files. Try again.",
        variant: "destructive",
      });
    } finally {
      setDeletingId(null);
      setConfirmDelete(null);
    }
  };

  const handleStatusChange = async (project: Project, newStatus: ProjectStatus) => {
    try {
      // Map 'live' back to 'completed' for database
      const dbStatus = newStatus === 'live' ? 'completed' : newStatus;
      await upsertProject({ id: project.id, status: dbStatus });

      // Update local state with new status and updated timestamp, then re-sort
      const now = Date.now();
      setAllProjects(prev => {
        const updated = prev.map(p =>
          p.id === project.id ? { ...p, status: newStatus, updatedAt: now } : p
        );
        // Re-sort by updatedAt descending (newest first)
        return updated.sort((a, b) => b.updatedAt - a.updatedAt);
      });

      const statusLabel = STATUS_OPTIONS.find(s => s.value === newStatus)?.label || newStatus;
      toast({
        title: "Status Updated",
        description: `"${project.videoTitle}" is now ${statusLabel}.`,
      });
    } catch (error) {
      console.error("Error updating status:", error);
      toast({
        title: "Error",
        description: "Could not update project status.",
        variant: "destructive",
      });
    }
  };

  const handleToggleFavorite = async (project: Project, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const newValue = await toggleFavorite(project.id);
      // Update project in the list with new timestamp and re-sort
      const now = Date.now();
      setAllProjects(prev => {
        const updated = prev.map(p =>
          p.id === project.id ? { ...p, isFavorite: newValue, updatedAt: now } : p
        );
        return updated.sort((a, b) => b.updatedAt - a.updatedAt);
      });
      toast({
        title: newValue ? "Added to Favorites" : "Removed from Favorites",
        description: `"${project.videoTitle}" ${newValue ? 'added to' : 'removed from'} favorites.`,
      });
    } catch (error) {
      console.error("Error toggling favorite:", error);
      toast({
        title: "Error",
        description: "Could not update favorite status.",
        variant: "destructive",
      });
    }
  };

  const handleStopPipeline = (project: Project) => {
    // Update local state to show cancelled status
    const now = Date.now();
    setAllProjects(prev => {
      const updated = prev.map(p =>
        p.id === project.id ? { ...p, status: 'cancelled' as const, updatedAt: now } : p
      );
      return updated.sort((a, b) => b.updatedAt - a.updatedAt);
    });
    toast({
      title: "Pipeline Stopped",
      description: `"${project.videoTitle}" will stop after current step.`,
    });
  };

  const handleResumePipeline = async (project: Project) => {
    // Update local state to show running status
    const now = Date.now();
    setAllProjects(prev => {
      const updated = prev.map(p =>
        p.id === project.id ? { ...p, status: 'running' as const, updatedAt: now } : p
      );
      return updated.sort((a, b) => b.updatedAt - a.updatedAt);
    });

    toast({
      title: "Resuming Pipeline",
      description: `Restarting "${project.videoTitle}" from the beginning...`,
    });

    try {
      // Restart the pipeline with the same settings
      const result = await startFullPipeline({
        projectId: project.id,
        youtubeUrl: project.sourceUrl,
        title: project.videoTitle,
        topic: project.settings?.topic,
        wordCount: project.settings?.wordCount || 3000,
        imageCount: project.settings?.imageCount || 100,
        generateClips: true,
        clipCount: 12,
        clipDuration: 5,
        effects: { smoke_embers: true },
      });

      if (result.success) {
        toast({
          title: "Pipeline Resumed!",
          description: `"${project.videoTitle}" is now running on the server.`,
        });
      } else {
        // Revert status on failure
        setAllProjects(prev => {
          const updated = prev.map(p =>
            p.id === project.id ? { ...p, status: 'failed' as const, updatedAt: Date.now() } : p
          );
          return updated.sort((a, b) => b.updatedAt - a.updatedAt);
        });
        toast({
          title: "Failed to Resume",
          description: result.error || "Unknown error",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error('Failed to resume pipeline:', error);
      setAllProjects(prev => {
        const updated = prev.map(p =>
          p.id === project.id ? { ...p, status: 'failed' as const, updatedAt: Date.now() } : p
        );
        return updated.sort((a, b) => b.updatedAt - a.updatedAt);
      });
      toast({
        title: "Error",
        description: "Failed to resume pipeline",
        variant: "destructive",
      });
    }
  };

  // Filter projects based on status filter and search query
  const filteredProjects = allProjects.filter(p => {
    // Status filter
    if (statusFilter !== 'all' && p.status !== statusFilter) return false;
    // Search filter (case-insensitive)
    if (searchQuery && !p.videoTitle.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  // Count non-archived projects for badge
  const activeProjectCount = allProjects.filter(p => p.status !== 'archived').length;

  // Count running pipelines (important for token usage awareness)
  const runningCount = allProjects.filter(p => p.status === 'running').length;

  return (
    <>
      <Sheet open={isOpen} onOpenChange={setIsOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground hover:text-foreground">
            <FolderOpen className="w-4 h-4" />
            <span className="hidden sm:inline">Projects</span>
            {runningCount > 0 ? (
              <span className="flex items-center gap-1 bg-amber-500/20 text-amber-500 text-xs px-1.5 py-0.5 rounded-full">
                <span className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-pulse" />
                {runningCount} running
              </span>
            ) : activeProjectCount > 0 && (
              <span className="bg-primary/20 text-primary text-xs px-1.5 py-0.5 rounded-full">
                {activeProjectCount}
              </span>
            )}
          </Button>
        </SheetTrigger>
        <SheetContent className="w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FolderOpen className="w-5 h-5 text-primary" />
                Projects
              </div>
              {onViewFavorites && (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => {
                    onViewFavorites();
                    setIsOpen(false);
                  }}
                >
                  <Heart className="w-3.5 h-3.5" />
                  Favorites
                </Button>
              )}
            </SheetTitle>

            {/* Running count banner - always visible if pipelines are running */}
            {runningCount > 0 && (
              <div className="flex items-center gap-2 mt-3 p-2 bg-amber-500/10 border border-amber-500/30 rounded-lg">
                <ServerCog className="w-4 h-4 text-amber-500 animate-spin" />
                <span className="text-sm text-amber-500 font-medium">
                  {runningCount} pipeline{runningCount > 1 ? 's' : ''} running on server
                </span>
              </div>
            )}

            {/* Search Input */}
            <div className="relative mt-3">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search projects..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 pr-8 h-8 text-sm"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Status Filter Dropdown */}
            <div className="flex items-center gap-2 mt-2">
              <span className="text-xs text-muted-foreground">Filter:</span>
              <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as FilterOption)}>
                <SelectTrigger className="h-7 w-[170px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" className="text-xs">
                    All ({allProjects.length})
                  </SelectItem>
                  {allProjects.filter(p => p.status === 'running').length > 0 && (
                    <SelectItem value="running" className="text-xs">
                      <span className="flex items-center gap-1.5">
                        <ServerCog className="w-3 h-3 shrink-0 text-amber-500" />
                        <span className="whitespace-nowrap">Running ({allProjects.filter(p => p.status === 'running').length})</span>
                      </span>
                    </SelectItem>
                  )}
                  <SelectItem value="in_progress" className="text-xs">
                    <span className="flex items-center gap-1.5">
                      <Clock className="w-3 h-3 shrink-0" />
                      <span className="whitespace-nowrap">In Progress ({allProjects.filter(p => p.status === 'in_progress').length})</span>
                    </span>
                  </SelectItem>
                  <SelectItem value="live" className="text-xs">
                    <span className="flex items-center gap-1.5">
                      <Globe className="w-3 h-3 shrink-0" />
                      <span className="whitespace-nowrap">Live ({allProjects.filter(p => p.status === 'live').length})</span>
                    </span>
                  </SelectItem>
                  <SelectItem value="archived" className="text-xs">
                    <span className="flex items-center gap-1.5">
                      <Archive className="w-3 h-3 shrink-0" />
                      <span className="whitespace-nowrap">Archived ({allProjects.filter(p => p.status === 'archived').length})</span>
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </SheetHeader>

          <div className="mt-4 space-y-2 max-h-[calc(100vh-180px)] overflow-y-auto">
            {isLoading ? (
              <div className="text-center py-12 text-muted-foreground">
                <Loader2 className="w-8 h-8 mx-auto mb-3 animate-spin opacity-50" />
                <p>Loading projects...</p>
              </div>
            ) : allProjects.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <FolderOpen className="w-12 h-12 mx-auto mb-3 opacity-30" />
                <p>No projects yet</p>
                <p className="text-sm mt-1">Projects will appear here as you work</p>
              </div>
            ) : filteredProjects.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <FolderOpen className="w-12 h-12 mx-auto mb-3 opacity-30" />
                <p>No {statusFilter === 'in_progress' ? 'in progress' : statusFilter} projects</p>
              </div>
            ) : (
              filteredProjects.map(project => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  onOpen={onOpenProject}
                  onDelete={() => setConfirmDelete(project)}
                  onStatusChange={(status) => handleStatusChange(project, status)}
                  onToggleFavorite={(e) => handleToggleFavorite(project, e)}
                  onStopPipeline={handleStopPipeline}
                  onResumePipeline={handleResumePipeline}
                  deletingId={deletingId}
                  setIsOpen={setIsOpen}
                />
              ))
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!confirmDelete} onOpenChange={() => setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Project?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete "{confirmDelete?.videoTitle}" and all its generated files (audio, captions, images) from storage. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmDelete && handleDelete(confirmDelete)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// Separate component for project cards with status selector
function ProjectCard({
  project,
  onOpen,
  onDelete,
  onStatusChange,
  onToggleFavorite,
  onStopPipeline,
  onResumePipeline,
  deletingId,
  setIsOpen,
}: {
  project: Project;
  onOpen?: (project: Project) => void;
  onDelete: () => void;
  onStatusChange: (status: ProjectStatus) => void;
  onToggleFavorite?: (e: React.MouseEvent) => void;
  onStopPipeline?: (project: Project) => void;
  onResumePipeline?: (project: Project) => void;
  deletingId: string | null;
  setIsOpen: (open: boolean) => void;
}) {
  const [versions, setVersions] = useState<Project[]>([]);
  const [isVersionsOpen, setIsVersionsOpen] = useState(false);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isResuming, setIsResuming] = useState(false);

  // Load versions when dropdown is opened
  const handleVersionToggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isVersionsOpen && versions.length === 0) {
      setLoadingVersions(true);
      try {
        const allVersions = await getProjectVersions(project.id);
        // Filter to only show older versions (not the current one)
        setVersions(allVersions.filter(v => v.id !== project.id));
      } catch (err) {
        console.error('[ProjectCard] Failed to load versions:', err);
      } finally {
        setLoadingVersions(false);
      }
    }
    setIsVersionsOpen(!isVersionsOpen);
  };

  // Get current status (map 'completed' to 'live' for display)
  const displayStatus = project.status === 'completed' ? 'live' : (project.status as ProjectStatus);
  const isRunning = project.status === 'running';

  const handleStopPipeline = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isStopping) return;

    setIsStopping(true);
    try {
      const result = await stopPipeline(project.id);
      if (result.success) {
        onStopPipeline?.(project);
      }
    } catch (error) {
      console.error('Failed to stop pipeline:', error);
    } finally {
      setIsStopping(false);
    }
  };

  const handleResumePipeline = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isResuming || !onResumePipeline) return;

    setIsResuming(true);
    try {
      await onResumePipeline(project);
    } finally {
      // Keep loading for a bit to prevent spam (parent will update status)
      setTimeout(() => setIsResuming(false), 3000);
    }
  };

  return (
    <div className="space-y-1">
      <div
        className="flex items-start justify-between p-3 bg-card rounded-lg border border-border hover:border-primary/30 hover:bg-accent/50 transition-colors cursor-pointer group"
        onClick={() => {
          if (onOpen) {
            onOpen(project);
            setIsOpen(false);
          }
        }}
      >
        <div className="flex-1 min-w-0 mr-2">
          <p className="font-medium text-foreground truncate text-sm" title={project.videoTitle}>
            {project.videoTitle}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {formatDate(project.updatedAt, true)} • <span className="font-mono">{project.id.slice(0, 8)}</span>
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {/* Running indicator with current step and stop button */}
          {isRunning ? (
            <div className="flex items-center gap-1">
              <span className="flex items-center gap-1.5 text-xs px-2 py-1 bg-amber-500/20 text-amber-600 rounded-md">
                <span className="w-2 h-2 bg-amber-500 rounded-full animate-pulse" />
                {getRunningStepLabel(project.currentStep)}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0 h-7 w-7 text-red-500 hover:text-red-600 hover:bg-red-500/10"
                onClick={handleStopPipeline}
                disabled={isStopping}
                title="Stop pipeline"
              >
                {isStopping ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Square className="w-3.5 h-3.5 fill-current" />
                )}
              </Button>
            </div>
          ) : project.status === 'failed' || project.status === 'cancelled' ? (
            /* Failed/Cancelled status with resume button */
            <div className="flex items-center gap-1">
              <span className="flex items-center gap-1.5 text-xs px-2 py-1 bg-red-500/20 text-red-500 rounded-md">
                <AlertCircle className="w-3 h-3" />
                {project.status === 'failed' ? 'Failed' : 'Stopped'}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0 h-7 w-7 text-green-500 hover:text-green-600 hover:bg-green-500/10"
                onClick={handleResumePipeline}
                disabled={isResuming}
                title="Resume pipeline"
              >
                {isResuming ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5 fill-current" />
                )}
              </Button>
            </div>
          ) : (
            /* Status selector for non-running projects */
            <div className="flex items-center gap-1">
              <Select
                value={displayStatus}
                onValueChange={(value) => onStatusChange(value as ProjectStatus)}
              >
                <SelectTrigger
                  className="h-7 w-auto text-xs"
                  onClick={(e) => e.stopPropagation()}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value} className="text-xs">
                      <span className="flex items-center gap-1.5 whitespace-nowrap">
                        <option.icon className="w-3 h-3 shrink-0" />
                        {option.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {/* Version dropdown toggle */}
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={handleVersionToggle}
            title="Show previous versions"
          >
            {loadingVersions ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isVersionsOpen ? 'rotate-180' : ''}`} />
            )}
          </Button>
          {/* Favorite button */}
          {onToggleFavorite && (
            <Button
              variant="ghost"
              size="icon"
              className={`shrink-0 h-7 w-7 ${project.isFavorite ? 'text-red-500 hover:text-red-600' : 'text-muted-foreground hover:text-red-500'}`}
              onClick={onToggleFavorite}
              title={project.isFavorite ? "Remove from favorites" : "Add to favorites"}
            >
              <Heart className={`w-3.5 h-3.5 ${project.isFavorite ? 'fill-current' : ''}`} />
            </Button>
          )}
          {/* Delete button */}
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 h-7 w-7 text-muted-foreground hover:text-destructive"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            disabled={deletingId === project.id}
            title="Delete project"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* Versions dropdown */}
      {isVersionsOpen && versions.length > 0 && (
        <div className="ml-4 space-y-1">
          {versions.map(version => (
            <div
              key={version.id}
              className="flex items-center justify-between p-2 pl-3 bg-muted/50 rounded border border-border/50 hover:bg-accent/30 cursor-pointer text-sm"
              onClick={() => {
                if (onOpen) {
                  onOpen(version);
                  setIsOpen(false);
                }
              }}
            >
              <span className="text-muted-foreground">
                V{version.versionNumber} • {formatDate(version.updatedAt)}
              </span>
              <ChevronRight className="w-3 h-3 text-muted-foreground" />
            </div>
          ))}
        </div>
      )}

      {/* No previous versions message */}
      {isVersionsOpen && versions.length === 0 && !loadingVersions && (
        <div className="ml-4 p-2 text-xs text-muted-foreground italic">
          No previous versions
        </div>
      )}
    </div>
  );
}
