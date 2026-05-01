import React from "react";

const BATCH_STEPS: Record<number, string[]> = {
  1: ["transcript", "script"],
  2: ["audio", "captions", "image_prompts", "images"],
  3: ["clip_prompts", "clips"],
  4: ["render"],
};

function formatStepLabel(step: string): string {
  return step
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

interface FactoryProgressGridProps {
  projectIds: string[];
  projectTitles: Record<string, string>;
  stepStatuses: Record<string, Record<string, string>>;
  progressValues: Record<string, Record<string, number>>;
  currentBatch: number;
}

function StatusCell({ status, progress }: { status: string | undefined; progress?: number }) {
  switch (status) {
    case "running":
      return (
        <div className="flex flex-col items-center gap-1 min-w-[60px]">
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className="bg-blue-500 h-2 rounded-full transition-all duration-300"
              style={{ width: `${Math.min(progress || 0, 99)}%` }}
            />
          </div>
          <span className="text-xs text-blue-600 font-medium">{Math.min(progress || 0, 99)}%</span>
        </div>
      );
    case "done":
      return (
        <svg className="w-5 h-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      );
    case "failed":
      return (
        <svg className="w-5 h-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      );
    case "skipped":
      return <span className="inline-block w-4 h-0.5 bg-gray-300 rounded" />;
    default:
      return (
        <span className="inline-block w-3 h-3 rounded-full border-2 border-gray-300" />
      );
  }
}

export function FactoryProgressGrid({
  projectIds,
  projectTitles,
  stepStatuses,
  progressValues,
  currentBatch,
}: FactoryProgressGridProps) {
  const steps = BATCH_STEPS[currentBatch] || [];

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50 border-b border-gray-200">
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Project
            </th>
            {steps.map((step) => (
              <th
                key={step}
                className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider"
              >
                {formatStepLabel(step)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {projectIds.map((pid) => {
            const projectSteps = stepStatuses[pid] || {};
            const projectProgress = progressValues[pid] || {};
            return (
              <tr key={pid} className="hover:bg-gray-50">
                <td className="px-4 py-3 text-gray-900 font-medium truncate max-w-[200px]">
                  {projectTitles[pid] || pid.slice(0, 8)}
                </td>
                {steps.map((step) => (
                  <td key={step} className="px-4 py-3 text-center">
                    <div className="flex items-center justify-center">
                      <StatusCell
                        status={projectSteps[step]}
                        progress={projectProgress[step]}
                      />
                    </div>
                  </td>
                ))}
              </tr>
            );
          })}
          {projectIds.length === 0 && (
            <tr>
              <td
                colSpan={steps.length + 1}
                className="px-6 py-12 text-center text-sm text-gray-500"
              >
                No projects in this batch.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
