import React, { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/hooks/use-toast";
import {
  createFactoryBatch,
  runFactoryBatch,
  getFactoryStatus,
  cancelFactory,
} from "@/lib/api";
import type {
  FactoryProjectConfig,
  FactoryProgressEvent,
  FactoryBatchStatus,
} from "@/lib/api";
import { getProject, type Project } from "@/lib/projectStore";
import { FactoryProgressGrid } from "@/components/FactoryProgressGrid";
import { FactoryProjectCard } from "@/components/FactoryProjectCard";

const STORAGE_KEY = "factory-active-batch";
const MAX_PROJECTS = 5;
const TOTAL_BATCHES = 4;
const SSE_TIMEOUT_MS = 10000;
const POLL_INTERVAL_MS = 5000;
const BATCH_2_SUBSTEPS = ['audio', 'captions', 'image_prompts', 'images'] as const;
type Batch2SubStep = typeof BATCH_2_SUBSTEPS[number];

const SUBSTEP_LABELS: Record<string, string> = {
  audio: 'Audio',
  captions: 'Captions',
  image_prompts: 'Image Prompts',
  images: 'Images',
};

interface ProjectInput {
  mode: "url" | "script";
  url: string;
  script: string;
  title: string;
}

function createEmptyInput(): ProjectInput {
  return { mode: "url", url: "", script: "", title: "" };
}

interface FactoryModeProps {
  onExit: () => void;
  initialBatchId?: string;
}

// ---------------------------------------------------------------------------
// Setup View
// ---------------------------------------------------------------------------
function SetupView({
  onStart,
  onExit,
}: {
  onStart: (batchId: string, projectIds: string[], titles: Record<string, string>) => void;
  onExit: () => void;
}) {
  const [inputs, setInputs] = useState<ProjectInput[]>([createEmptyInput()]);
  const [wordCount, setWordCount] = useState<number | string>(3000);
  const [imageCount, setImageCount] = useState<number | string>(200);
  const [voiceSampleUrl, setVoiceSampleUrl] = useState("");
  const [ttsProvider, setTtsProvider] = useState("voxcpm2");
  const [starting, setStarting] = useState(false);

  function updateInput(index: number, patch: Partial<ProjectInput>) {
    setInputs((prev) =>
      prev.map((inp, i) => (i === index ? { ...inp, ...patch } : inp))
    );
  }

  function removeInput(index: number) {
    setInputs((prev) => prev.filter((_, i) => i !== index));
  }

  function addInput() {
    if (inputs.length >= MAX_PROJECTS) return;
    setInputs((prev) => [...prev, createEmptyInput()]);
  }

  async function handleStart() {
    const projects: FactoryProjectConfig[] = inputs
      .filter((inp) => {
        if (inp.mode === "url") return inp.url.trim().length > 0;
        return inp.script.trim().length > 0;
      })
      .map((inp) => ({
        ...(inp.mode === "url" ? { url: inp.url.trim() } : { script: inp.script.trim() }),
        title: inp.title.trim() || `Project ${inputs.indexOf(inp) + 1}`,
      }));

    if (projects.length === 0) {
      toast({ title: "Add at least one project", variant: "destructive" });
      return;
    }

    setStarting(true);
    try {
      const result = await createFactoryBatch(projects, {
        wordCount,
        imageCount,
        voiceSampleUrl: voiceSampleUrl.trim() || undefined,
        ttsProvider,
      });

      if (!result.success || !result.batchId || !result.projectIds) {
        toast({
          title: "Failed to create batch",
          description: result.error || "Unknown error",
          variant: "destructive",
        });
        return;
      }

      localStorage.setItem(STORAGE_KEY, result.batchId);
      const titles: Record<string, string> = {};
      result.projectIds.forEach((id, i) => {
        titles[id] = projects[i]?.title || `Project ${i + 1}`;
      });
      onStart(result.batchId, result.projectIds, titles);
    } catch (err) {
      toast({
        title: "Error creating batch",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Factory Pipeline</h1>
          <p className="mt-1 text-sm text-gray-500">
            Process up to {MAX_PROJECTS} projects in batches
          </p>
        </div>
        <Button variant="outline" onClick={onExit}>
          Back
        </Button>
      </div>

      {/* Project inputs */}
      <div className="space-y-4">
        {inputs.map((inp, idx) => (
          <div
            key={idx}
            className="bg-white rounded-xl border border-gray-200 p-6 space-y-3"
          >
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-gray-900">
                Project {idx + 1}
              </p>
              {inputs.length > 1 && (
                <button
                  onClick={() => removeInput(idx)}
                  className="p-1.5 text-gray-400 hover:text-gray-600 rounded-md hover:bg-gray-100"
                  title="Remove project"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>

            {/* Mode toggle */}
            <div className="flex gap-2">
              <button
                onClick={() => updateInput(idx, { mode: "url" })}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                  inp.mode === "url"
                    ? "bg-gray-900 text-white border-gray-900"
                    : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
                }`}
              >
                URL
              </button>
              <button
                onClick={() => updateInput(idx, { mode: "script" })}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                  inp.mode === "script"
                    ? "bg-gray-900 text-white border-gray-900"
                    : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
                }`}
              >
                Script
              </button>
            </div>

            {/* Source input */}
            {inp.mode === "url" ? (
              <Input
                value={inp.url}
                onChange={(e) => updateInput(idx, { url: e.target.value })}
                placeholder="YouTube URL"
              />
            ) : (
              <Textarea
                value={inp.script}
                onChange={(e) => updateInput(idx, { script: e.target.value })}
                placeholder="Paste script..."
                className="min-h-[100px]"
              />
            )}

            {/* Title */}
            <Input
              value={inp.title}
              onChange={(e) => updateInput(idx, { title: e.target.value })}
              placeholder="Project title"
            />
          </div>
        ))}
      </div>

      {inputs.length < MAX_PROJECTS && (
        <Button variant="outline" onClick={addInput} className="w-full">
          Add Project
        </Button>
      )}

      {/* Settings */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <h2 className="text-lg font-semibold text-gray-900">Settings</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Word Count
            </label>
            <Input
              type="number"
              value={wordCount}
              onChange={(e) => setWordCount(e.target.value === '' ? '' : Number(e.target.value))}
              min={500}
              max={10000}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Image Count
            </label>
            <Input
              type="number"
              value={imageCount}
              onChange={(e) => setImageCount(e.target.value === '' ? '' : Number(e.target.value))}
              min={10}
              max={500}
            />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Voice Sample URL
          </label>
          <Input
            value={voiceSampleUrl}
            onChange={(e) => setVoiceSampleUrl(e.target.value)}
            placeholder="https://example.com/voice-sample.wav"
          />
          <p className="mt-1 text-xs text-gray-500">
            Optional. Used for TTS voice cloning.
          </p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            TTS Provider
          </label>
          <select
            value={ttsProvider}
            onChange={(e) => setTtsProvider(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
          >
            <option value="voxcpm2">VoxCPM2</option>
            <option value="fish-speech">Fish Speech</option>
          </select>
        </div>
      </div>

      {/* Start */}
      <Button
        className="w-full"
        disabled={starting}
        onClick={handleStart}
      >
        {starting ? "Starting..." : "Start Factory"}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Progress View
// ---------------------------------------------------------------------------
function ProgressView({
  batchId,
  batchNumber,
  subStep,
  projectIds,
  projectTitles,
  onBatchComplete,
  onCancel,
}: {
  batchId: string;
  batchNumber: number;
  subStep?: string | null;
  projectIds: string[];
  projectTitles: Record<string, string>;
  onBatchComplete: (batch: number) => void;
  onCancel: () => void;
}) {
  const [stepStatuses, setStepStatuses] = useState<
    Record<string, Record<string, string>>
  >({});
  const [progressValues, setProgressValues] = useState<
    Record<string, Record<string, number>>
  >({});
  const [cancelling, setCancelling] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const textPanelRef = useRef<HTMLDivElement>(null);
  const lastEventRef = useRef(Date.now());
  const completedRef = useRef(false);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const applyStatus = useCallback((status: FactoryBatchStatus) => {
    setStepStatuses(status.step_statuses || {});
  }, []);

  // SSE stream
  useEffect(() => {
    completedRef.current = false;
    lastEventRef.current = Date.now();

    const handleProgress = (event: FactoryProgressEvent) => {
      lastEventRef.current = Date.now();

      if (event.type === "script_token" && event.text && event.projectId) {
        setActiveProjectId(event.projectId);
        setStreamingText((prev) => prev + event.text);
        return;
      }

      if (event.type === "progress" && event.projectId && event.step && event.status) {
        if (event.step === "script" && event.status === "running" && event.projectId !== activeProjectId) {
          setStreamingText('');
          setActiveProjectId(event.projectId);
        }
        if (event.step === "script" && event.status === "done") {
          setActiveProjectId(null);
        }

        setStepStatuses((prev) => {
          const projectSteps = prev[event.projectId!] || {};
          return {
            ...prev,
            [event.projectId!]: { ...projectSteps, [event.step!]: event.status! },
          };
        });

        if ((event as any).progress !== undefined) {
          setProgressValues((prev) => {
            const projectProgress = prev[event.projectId!] || {};
            const currentVal = projectProgress[event.step!] || 0;
            const newVal = (event as any).progress;
            if (newVal <= currentVal) return prev;
            return {
              ...prev,
              [event.projectId!]: { ...projectProgress, [event.step!]: newVal },
            };
          });
        }
      }

      if (event.type === "batch_complete" && !completedRef.current) {
        completedRef.current = true;
        onBatchComplete(batchNumber);
      }

      if (event.type === "error") {
        toast({
          title: "Batch error",
          description: event.error || event.message || "Unknown error",
          variant: "destructive",
        });
      }
    };

    runFactoryBatch(batchId, batchNumber, handleProgress, subStep || undefined);

    return () => {
      // Cleanup handled by stream ending
    };
  }, [batchId, batchNumber, subStep, onBatchComplete]);

  // Polling fallback
  useEffect(() => {
    pollIntervalRef.current = setInterval(async () => {
      if (completedRef.current) return;

      const elapsed = Date.now() - lastEventRef.current;
      if (elapsed < SSE_TIMEOUT_MS) return;

      const status = await getFactoryStatus(batchId);
      if (!status) return;

      applyStatus(status);

      if (
        status.status.includes("_review") ||
        status.status === "completed"
      ) {
        if (!completedRef.current) {
          completedRef.current = true;
          onBatchComplete(status.current_batch);
        }
      }
    }, POLL_INTERVAL_MS);

    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, [batchId, applyStatus, onBatchComplete]);

  useEffect(() => {
    if (textPanelRef.current) {
      textPanelRef.current.scrollTop = textPanelRef.current.scrollHeight;
    }
  }, [streamingText]);

  async function handleCancel() {
    setCancelling(true);
    try {
      await cancelFactory(batchId);
      localStorage.removeItem(STORAGE_KEY);
      onCancel();
    } catch (err) {
      toast({
        title: "Failed to cancel",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
      setCancelling(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {subStep
              ? `Batch ${batchNumber}: ${SUBSTEP_LABELS[subStep] || subStep} Running...`
              : `Batch ${batchNumber} Running...`}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Processing {projectIds.length} project{projectIds.length !== 1 ? "s" : ""}
          </p>
        </div>
        <Button
          variant="destructive"
          disabled={cancelling}
          onClick={handleCancel}
        >
          {cancelling ? "Cancelling..." : "Cancel"}
        </Button>
      </div>

      {batchNumber === 1 && activeProjectId && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <span className="text-sm font-medium text-gray-700">
                Writing script for {projectTitles[activeProjectId] || 'project'}
              </span>
            </div>
            {streamingText && (
              <span className="text-xs text-gray-500">
                {streamingText.split(/\s+/).filter(w => w.length > 0).length} words
              </span>
            )}
          </div>
          <div
            ref={textPanelRef}
            className="p-4 max-h-[400px] overflow-y-auto text-sm text-gray-800 leading-relaxed whitespace-pre-wrap"
          >
            {streamingText || (
              <span className="text-gray-400 italic">
                Analyzing transcript and preparing script...
              </span>
            )}
          </div>
        </div>
      )}

      <FactoryProgressGrid
        projectIds={projectIds}
        projectTitles={projectTitles}
        stepStatuses={stepStatuses}
        progressValues={progressValues}
        currentBatch={batchNumber}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Review View
// ---------------------------------------------------------------------------
function ReviewView({
  batchId,
  batchNumber,
  subStep,
  projectIds,
  onContinue,
  onExit,
}: {
  batchId: string;
  batchNumber: number;
  subStep?: string | null;
  projectIds: string[];
  onContinue: () => void;
  onExit: () => void;
}) {
  const [projects, setProjects] = useState<Record<string, Project>>({});
  const [loading, setLoading] = useState(true);

  const fetchProjects = useCallback(async () => {
    setLoading(true);
    const fetched: Record<string, Project> = {};
    const results = await Promise.all(
      projectIds.map((id) => getProject(id).then((p) => ({ id, project: p })))
    );
    for (const { id, project } of results) {
      if (project) {
        fetched[id] = project;
      }
    }
    setProjects(fetched);
    setLoading(false);
  }, [projectIds]);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  const isLastBatch = batchNumber >= TOTAL_BATCHES && !subStep;
  const isLastSubStep = batchNumber === 2 && subStep === 'images';

  function getNextLabel(): string {
    if (batchNumber === 2 && subStep) {
      const idx = BATCH_2_SUBSTEPS.indexOf(subStep as Batch2SubStep);
      if (idx < BATCH_2_SUBSTEPS.length - 1) {
        return `Continue to ${SUBSTEP_LABELS[BATCH_2_SUBSTEPS[idx + 1]]}`;
      }
      return 'Continue to Batch 3';
    }
    if (batchNumber === 1) return 'Continue to Audio';
    return `Continue to Batch ${batchNumber + 1}`;
  }

  function getReviewTitle(): string {
    if (batchNumber === 2 && subStep) {
      return `${SUBSTEP_LABELS[subStep] || subStep} Complete — Review`;
    }
    if (isLastBatch || isLastSubStep) return 'Factory Complete!';
    return `Batch ${batchNumber} Complete — Review`;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {getReviewTitle()}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            {(isLastBatch && !subStep)
              ? "All batches finished. Review your final output below."
              : "Review the results and continue when ready."}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => {
            localStorage.removeItem(STORAGE_KEY);
            onExit();
          }}>
            Start New
          </Button>
          <Button variant="outline" onClick={() => {
            localStorage.removeItem(STORAGE_KEY);
            onExit();
          }}>
            Exit
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="text-sm text-gray-500">Loading project data...</div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {projectIds.map((pid) => {
            const project = projects[pid];
            if (!project) return null;
            return (
              <FactoryProjectCard
                key={pid}
                projectId={pid}
                project={project}
                currentBatch={batchNumber}
                currentSubStep={subStep}
                onUpdate={fetchProjects}
              />
            );
          })}
        </div>
      )}

      {!(isLastBatch && !subStep) && !loading && (
        <Button className="w-full" onClick={onContinue}>
          {getNextLabel()}
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main FactoryMode Component
// ---------------------------------------------------------------------------
export function FactoryMode({ onExit, initialBatchId }: FactoryModeProps) {
  const [view, setView] = useState<"setup" | "progress" | "review">("setup");
  const [batchId, setBatchId] = useState<string | null>(initialBatchId || null);
  const [currentBatch, setCurrentBatch] = useState(1);
  const [currentSubStep, setCurrentSubStep] = useState<string | null>(null);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [projectTitles, setProjectTitles] = useState<Record<string, string>>({});
  const [initialized, setInitialized] = useState(false);

  // Resume from localStorage on mount
  useEffect(() => {
    async function resume() {
      const storedBatchId = initialBatchId || localStorage.getItem(STORAGE_KEY);
      if (!storedBatchId) {
        setInitialized(true);
        return;
      }

      const status = await getFactoryStatus(storedBatchId);
      if (!status) {
        localStorage.removeItem(STORAGE_KEY);
        setInitialized(true);
        return;
      }

      setBatchId(storedBatchId);
      setProjectIds(status.project_ids);

      // Extract batch number and optional sub-step from status
      // e.g. "batch2_audio_review" → batch 2, subStep "audio"
      // e.g. "batch2_review" → batch 2, no subStep
      const batchMatch = status.status.match(/batch(\d+)/);
      const batchNum = batchMatch ? parseInt(batchMatch[1], 10) : (status.current_batch || 1);
      setCurrentBatch(batchNum);

      const subStepMatch = status.status.match(/batch2_(audio|captions|image_prompts|images)_review/);
      if (subStepMatch) {
        setCurrentSubStep(subStepMatch[1]);
      } else if (batchNum === 2 && status.status === 'batch2_review') {
        setCurrentSubStep('images');
      }

      // Build titles from project IDs
      const titles: Record<string, string> = {};
      const fetched = await Promise.all(
        status.project_ids.map((id) =>
          getProject(id).then((p) => ({ id, title: p?.videoTitle }))
        )
      );
      for (const { id, title } of fetched) {
        titles[id] = title || id.slice(0, 8);
      }
      setProjectTitles(titles);

      if (
        status.status === "completed" ||
        status.status === "cancelled"
      ) {
        localStorage.removeItem(STORAGE_KEY);
        setView("setup");
      } else if (status.status.includes("_review")) {
        setView("review");
      } else if (status.status.includes("_running")) {
        setView("progress");
      } else {
        setView("setup");
      }

      setInitialized(true);
    }

    resume();
  }, [initialBatchId]);

  const handleStart = useCallback(
    (newBatchId: string, newProjectIds: string[], titles: Record<string, string>) => {
      setBatchId(newBatchId);
      setProjectIds(newProjectIds);
      setProjectTitles(titles);
      setCurrentBatch(1);
      setCurrentSubStep(null);
      setView("progress");
    },
    []
  );

  const handleBatchComplete = useCallback((batch: number) => {
    setCurrentBatch(batch);
    setView("review");
  }, []);

  const handleContinue = useCallback(() => {
    if (currentBatch === 2 && currentSubStep) {
      const idx = BATCH_2_SUBSTEPS.indexOf(currentSubStep as Batch2SubStep);
      if (idx < BATCH_2_SUBSTEPS.length - 1) {
        const nextSubStep = BATCH_2_SUBSTEPS[idx + 1];
        setCurrentSubStep(nextSubStep);
        setView("progress");
        return;
      }
    }

    if (currentBatch === 1) {
      setCurrentBatch(2);
      setCurrentSubStep(BATCH_2_SUBSTEPS[0]);
      setView("progress");
      return;
    }

    const nextBatch = currentBatch + 1;
    setCurrentBatch(nextBatch);
    setCurrentSubStep(null);
    setView("progress");
  }, [currentBatch, currentSubStep]);

  const handleCancel = useCallback(() => {
    setBatchId(null);
    setProjectIds([]);
    setCurrentBatch(1);
    setView("setup");
  }, []);

  if (!initialized) {
    return (
      <div className="max-w-6xl mx-auto py-8 px-4">
        <div className="flex items-center justify-center py-16">
          <div className="text-sm text-gray-500">Loading factory status...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto py-8 px-4">
      {view === "setup" && (
        <SetupView onStart={handleStart} onExit={onExit} />
      )}

      {view === "progress" && batchId && (
        <ProgressView
          batchId={batchId}
          batchNumber={currentBatch}
          subStep={currentSubStep}
          projectIds={projectIds}
          projectTitles={projectTitles}
          onBatchComplete={handleBatchComplete}
          onCancel={handleCancel}
        />
      )}

      {view === "review" && batchId && (
        <ReviewView
          batchId={batchId}
          batchNumber={currentBatch}
          subStep={currentSubStep}
          projectIds={projectIds}
          onContinue={handleContinue}
          onExit={handleCancel}
        />
      )}
    </div>
  );
}
