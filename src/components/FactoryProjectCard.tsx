import React, { useState, useMemo, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/hooks/use-toast";
import { upsertProject, type Project } from "@/lib/projectStore";
import { regenerateAudioSegment, recombineAudioSegments, generateImagesStreaming } from "@/lib/api";
import { AudioSegmentsPreviewModal } from "@/components/AudioSegmentsPreviewModal";
import { ImagesPreviewModal } from "@/components/ImagesPreviewModal";

interface FactoryProjectCardProps {
  projectId: string;
  project: Project;
  currentBatch: number;
  currentSubStep?: string | null;
  onUpdate: () => void;
}

function StatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    completed: "bg-green-100 text-green-800",
    done: "bg-green-100 text-green-800",
    failed: "bg-red-100 text-red-800",
    running: "bg-blue-100 text-blue-800",
    pending: "bg-gray-100 text-gray-600",
  };
  const classes = colorMap[status] || "bg-gray-100 text-gray-600";
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${classes}`}>
      {status}
    </span>
  );
}

function ScriptReview({
  projectId,
  project,
  onUpdate,
}: {
  projectId: string;
  project: Project;
  onUpdate: () => void;
}) {
  const [editedScript, setEditedScript] = useState(project.script || "");
  const [saving, setSaving] = useState(false);

  const wordCount = useMemo(() => {
    const trimmed = editedScript.trim();
    if (!trimmed) return 0;
    return trimmed.split(/\s+/).length;
  }, [editedScript]);

  const isDirty = editedScript !== (project.script || "");

  async function handleSave() {
    setSaving(true);
    try {
      await upsertProject({ id: projectId, script: editedScript });
      toast({ title: "Script saved" });
      onUpdate();
    } catch (err) {
      toast({
        title: "Failed to save script",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <Textarea
        value={editedScript}
        onChange={(e) => setEditedScript(e.target.value)}
        className="min-h-[200px] text-sm font-mono"
        placeholder="No script generated"
      />
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-500">{wordCount} words</span>
        <Button
          size="sm"
          disabled={saving || !isDirty}
          onClick={handleSave}
        >
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}

function MediaReview({ project }: { project: Project }) {
  const imageUrls = project.imageUrls || [];
  const displayCount = 12;
  const remaining = imageUrls.length - displayCount;

  return (
    <div className="space-y-4">
      {/* Audio */}
      {project.audioUrl && (
        <div className="space-y-1">
          <p className="text-sm font-medium text-gray-700">Audio</p>
          <audio controls src={project.audioUrl} className="w-full" />
          {project.audioSegments && (
            <p className="text-xs text-gray-500">
              {project.audioSegments.length} segments
            </p>
          )}
        </div>
      )}

      {/* Captions */}
      {project.srtContent && (
        <div className="space-y-1">
          <p className="text-sm font-medium text-gray-700">Captions</p>
          <pre className="text-xs bg-gray-50 rounded-lg p-3 overflow-auto max-h-[120px] border border-gray-200">
            {project.srtContent.slice(0, 200)}
            {project.srtContent.length > 200 && "..."}
          </pre>
        </div>
      )}

      {/* Images */}
      {imageUrls.length > 0 && (
        <div className="space-y-1">
          <p className="text-sm font-medium text-gray-700">
            Images ({imageUrls.length})
          </p>
          <div className="grid grid-cols-4 gap-2">
            {imageUrls.slice(0, displayCount).map((url, i) => (
              <img
                key={i}
                src={url}
                alt={`Generated image ${i + 1}`}
                className="w-full aspect-square object-cover rounded-lg border border-gray-200"
              />
            ))}
          </div>
          {remaining > 0 && (
            <p className="text-xs text-gray-500 text-center">
              +{remaining} more
            </p>
          )}
        </div>
      )}

      {!project.audioUrl && !project.srtContent && imageUrls.length === 0 && (
        <p className="text-sm text-gray-500 py-4 text-center">
          No media generated yet.
        </p>
      )}
    </div>
  );
}

function ClipsReview({ project }: { project: Project }) {
  const clips = project.clips || [];

  if (clips.length === 0) {
    return (
      <p className="text-sm text-gray-500 py-4 text-center">
        No clips generated yet.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3">
      {clips.map((clip, i) => (
        <div key={i} className="rounded-lg border border-gray-200 overflow-hidden">
          <video
            src={clip.videoUrl}
            controls
            className="w-full aspect-video bg-black"
          />
          {clip.prompt && (
            <p className="text-xs text-gray-500 p-2 truncate">{clip.prompt}</p>
          )}
        </div>
      ))}
    </div>
  );
}

function RenderReview({ project }: { project: Project }) {
  const videoUrl = project.smokeEmbersVideoUrl || project.videoUrl;

  if (!videoUrl) {
    return (
      <p className="text-sm text-gray-500 py-4 text-center">
        No render available yet.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <video controls src={videoUrl} className="w-full rounded-lg bg-black" />
      <a
        href={videoUrl}
        download
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm text-blue-600 hover:text-blue-700 hover:underline"
      >
        Download video
      </a>
    </div>
  );
}

function AudioReview({ project, projectId, onUpdate }: { project: Project; projectId: string; onUpdate: () => void }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [regeneratingIndexes, setRegeneratingIndexes] = useState<Set<number>>(new Set());

  const handleRegenerate = useCallback(async (segmentIndex: number, editedText?: string) => {
    setRegeneratingIndexes((prev) => new Set([...prev, segmentIndex]));
    try {
      await regenerateAudioSegment(projectId, segmentIndex, editedText);
      toast({ title: `Segment ${segmentIndex + 1} regenerated` });
      onUpdate();
    } catch (err) {
      toast({ title: "Regeneration failed", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    } finally {
      setRegeneratingIndexes((prev) => { const next = new Set(prev); next.delete(segmentIndex); return next; });
    }
  }, [projectId, onUpdate]);

  const handleRecombine = useCallback(async () => {
    try {
      await recombineAudioSegments(projectId);
      toast({ title: "Audio recombined" });
      onUpdate();
    } catch (err) {
      toast({ title: "Recombine failed", variant: "destructive" });
    }
  }, [projectId, onUpdate]);

  if (!project.audioUrl) {
    return <p className="text-sm text-gray-500 py-4 text-center">No audio generated yet.</p>;
  }
  return (
    <div className="space-y-2">
      <audio controls src={project.audioUrl} className="w-full" />
      <div className="flex items-center justify-between">
        {project.audioSegments && (
          <p className="text-xs text-gray-500">{project.audioSegments.length} segments, {project.audioDuration ? `${Math.round(project.audioDuration)}s` : ''}</p>
        )}
        <Button variant="outline" size="sm" onClick={() => setModalOpen(true)}>
          Edit Segments
        </Button>
      </div>

      <AudioSegmentsPreviewModal
        isOpen={modalOpen}
        segments={project.audioSegments || []}
        combinedAudioUrl={project.audioUrl}
        totalDuration={project.audioDuration}
        onConfirmAll={() => setModalOpen(false)}
        onRegenerate={handleRegenerate}
        onCancel={() => setModalOpen(false)}
        regeneratingIndexes={regeneratingIndexes}
        projectId={projectId}
        segmentsNeedRecombine={project.segmentsNeedRecombine}
        onRecombineAudio={handleRecombine}
      />
    </div>
  );
}

function CaptionsReview({ project }: { project: Project }) {
  if (!project.srtContent) {
    return <p className="text-sm text-gray-500 py-4 text-center">No captions generated yet.</p>;
  }
  return (
    <pre className="text-xs bg-gray-50 rounded-lg p-3 overflow-auto max-h-[200px] border border-gray-200">
      {project.srtContent.slice(0, 500)}{project.srtContent.length > 500 && '...'}
    </pre>
  );
}

function ImagePromptsReview({ project }: { project: Project }) {
  const prompts = project.imagePrompts || [];
  if (prompts.length === 0) {
    return <p className="text-sm text-gray-500 py-4 text-center">No image prompts generated yet.</p>;
  }
  return (
    <div className="space-y-2 max-h-[250px] overflow-auto">
      {prompts.slice(0, 10).map((p, i) => (
        <div key={i} className="text-xs bg-gray-50 rounded p-2 border border-gray-100">
          <span className="font-medium text-gray-700">#{i + 1}:</span> {p.sceneDescription || p.prompt || JSON.stringify(p)}
        </div>
      ))}
      {prompts.length > 10 && <p className="text-xs text-gray-500 text-center">+{prompts.length - 10} more</p>}
    </div>
  );
}

function ImagesReview({ project, projectId, onUpdate }: { project: Project; projectId: string; onUpdate: () => void }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [regeneratingIndices, setRegeneratingIndices] = useState<Set<number>>(new Set());
  const imageUrls = project.imageUrls || [];

  const handleRegenerate = useCallback((index: number, editedPrompt?: string) => {
    setRegeneratingIndices((prev) => new Set([...prev, index]));
    generateImagesStreaming(
      [(editedPrompt || project.imagePrompts?.[index]?.sceneDescription || '')],
      projectId,
      () => {},
    ).then(() => {
      onUpdate();
    }).finally(() => {
      setRegeneratingIndices((prev) => { const next = new Set(prev); next.delete(index); return next; });
    });
  }, [project, projectId, onUpdate]);

  if (imageUrls.length === 0) {
    return <p className="text-sm text-gray-500 py-4 text-center">No images generated yet.</p>;
  }
  const displayCount = 8;
  const remaining = imageUrls.length - displayCount;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-gray-700">{imageUrls.length} images</p>
        <Button variant="outline" size="sm" onClick={() => setModalOpen(true)}>
          Edit Images
        </Button>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {imageUrls.slice(0, displayCount).map((url, i) => (
          <img key={i} src={url} alt={`Image ${i + 1}`} className="w-full aspect-square object-cover rounded-lg border border-gray-200 cursor-pointer" onClick={() => setModalOpen(true)} />
        ))}
      </div>
      {remaining > 0 && <p className="text-xs text-gray-500 text-center">+{remaining} more</p>}

      <ImagesPreviewModal
        isOpen={modalOpen}
        images={imageUrls}
        prompts={project.imagePrompts?.map((p, i) => ({ index: i, prompt: p.prompt || '', sceneDescription: p.sceneDescription || '', startSeconds: p.startSeconds, endSeconds: p.endSeconds }))}
        srtContent={project.srtContent}
        projectId={projectId}
        onConfirm={() => setModalOpen(false)}
        onCancel={() => setModalOpen(false)}
        onRegenerate={handleRegenerate}
        regeneratingIndices={regeneratingIndices}
      />
    </div>
  );
}

export function FactoryProjectCard({
  projectId,
  project,
  currentBatch,
  currentSubStep,
  onUpdate,
}: FactoryProjectCardProps) {
  const projectStatus = project.status === "failed" ? "failed" : "completed";

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900 truncate">
          {project.videoTitle || projectId.slice(0, 8)}
        </h3>
        <StatusBadge status={projectStatus} />
      </div>

      {project.status === "failed" && (
        <div className="mb-4 p-3 bg-red-50 rounded-lg border border-red-200">
          <p className="text-sm text-red-700">
            This project failed during processing.
          </p>
        </div>
      )}

      {currentBatch === 1 && (
        <ScriptReview projectId={projectId} project={project} onUpdate={onUpdate} />
      )}
      {currentBatch === 2 && currentSubStep === 'audio' && <AudioReview project={project} projectId={projectId} onUpdate={onUpdate} />}
      {currentBatch === 2 && currentSubStep === 'captions' && <CaptionsReview project={project} />}
      {currentBatch === 2 && currentSubStep === 'image_prompts' && <ImagePromptsReview project={project} />}
      {currentBatch === 2 && currentSubStep === 'images' && <ImagesReview project={project} projectId={projectId} onUpdate={onUpdate} />}
      {currentBatch === 2 && !currentSubStep && <MediaReview project={project} />}
      {currentBatch === 3 && <ClipsReview project={project} />}
      {currentBatch === 4 && <RenderReview project={project} />}
    </div>
  );
}
