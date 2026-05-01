import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fetchCostSummary, fetchProjectCosts, type CostSummary } from '@/lib/api';

const STEP_LABELS: Record<string, string> = {
  audio: 'Audio',
  images: 'Images',
  video_clips: 'Video Clips',
  render: 'Render',
  thumbnail: 'Thumbnails',
  // Legacy steps (no longer tracked but may exist in old DB rows)
  script: 'Script',
  captions: 'Captions',
  image_prompts: 'Image Prompts',
  clip_prompts: 'Clip Prompts',
  youtube_metadata: 'YT Metadata',
  title_rewrite: 'Title Rewrite',
  thumbnail_analysis: 'Thumbnail Analysis',
  content_scan: 'Content Scan',
  short_hooks: 'Short Hooks',
};

const SERVICE_LABELS: Record<string, string> = {
  runpod_gpu: 'RunPod GPU',
  kie_video: 'Kie.ai Video',
  kie_image: 'Kie.ai Image',
  // Legacy
  voxcpm2: 'TTS (legacy)',
  z_image: 'Images (legacy)',
  seedance: 'Clips (legacy)',
  fish_speech: 'Fish (legacy)',
  runpod_cpu: 'Render (legacy)',
  whisper: 'Whisper (legacy)',
  claude: 'Claude (legacy)',
};

type Range = 'today' | 'yesterday' | 'week' | 'month' | 'all' | 'custom';

function fmt(value: number): string {
  return `$${value.toFixed(2)}`;
}

function fmtDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

interface ExpandedSteps {
  steps: Array<{ step: string; totalCost: number }>;
  loading: boolean;
}

export default function CostDashboard() {
  const navigate = useNavigate();
  const [range, setRange] = useState<Range>('month');
  const [data, setData] = useState<CostSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, ExpandedSteps>>({});
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [runpod, setRunpod] = useState<{ balance: number; spendPerHr: number; spendLimit: number } | null>(null);

  useEffect(() => {
    const renderUrl = import.meta.env.VITE_RENDER_API_URL;
    if (!renderUrl) return;
    fetch(`${renderUrl}/costs/runpod-status`).then(r => r.json()).then(d => {
      if (d.success) setRunpod(d);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (range === 'custom' && (!startDate || !endDate)) return;
    let cancelled = false;
    setLoading(true);
    const queryRange = range === 'custom' ? `custom&start=${startDate}&end=${endDate}` : range;
    fetchCostSummary(queryRange as any).then((result) => {
      if (!cancelled) {
        setData(result);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [range, startDate, endDate]);

  const handleToggle = async (projectId: string) => {
    if (expanded[projectId]) {
      const next = { ...expanded };
      delete next[projectId];
      setExpanded(next);
      return;
    }

    setExpanded((prev) => ({
      ...prev,
      [projectId]: { steps: [], loading: true },
    }));

    const result = await fetchProjectCosts(projectId);
    if (result.success && result.costs) {
      setExpanded((prev) => ({
        ...prev,
        [projectId]: {
          steps: result.costs!.steps.map((s) => ({ step: s.step, totalCost: s.totalCost })),
          loading: false,
        },
      }));
    } else {
      setExpanded((prev) => ({
        ...prev,
        [projectId]: { steps: [], loading: false },
      }));
    }
  };

  const ranges: { key: Range; label: string }[] = [
    { key: 'today', label: 'Today' },
    { key: 'yesterday', label: 'Yesterday' },
    { key: 'week', label: 'Week' },
    { key: 'month', label: 'Month' },
    { key: 'all', label: 'All' },
  ] as const;

  return (
    <div className="max-w-5xl mx-auto py-4 px-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => navigate('/')}>
            <ArrowLeft className="w-3 h-3 mr-1" /> Back
          </Button>
          <h1 className="text-lg font-bold text-gray-900">Costs</h1>
        </div>
        <div className="flex items-center gap-1">
          {ranges.map((r) => (
            <Button
              key={r.key}
              variant={range === r.key ? 'default' : 'outline'}
              size="sm"
              className="text-xs px-2 py-1 h-7"
              onClick={() => setRange(r.key)}
            >
              {r.label}
            </Button>
          ))}
          <span className="text-gray-300 mx-1">|</span>
          <input
            type="date"
            value={startDate}
            onChange={(e) => { setStartDate(e.target.value); setRange('custom'); }}
            className="text-xs border border-gray-300 rounded px-1.5 py-0.5 h-7 w-28"
          />
          <span className="text-xs text-gray-400">to</span>
          <input
            type="date"
            value={endDate}
            onChange={(e) => { setEndDate(e.target.value); setRange('custom'); }}
            className="text-xs border border-gray-300 rounded px-1.5 py-0.5 h-7 w-28"
          />
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="text-xs text-gray-500">Loading...</div>
        </div>
      ) : !data ? (
        <div className="text-center py-12">
          <p className="text-gray-500 text-xs">No cost data available.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Summary row */}
          <div className="grid grid-cols-3 lg:grid-cols-5 gap-2">
            <div className="bg-white rounded-lg border border-gray-200 px-3 py-2">
              <p className="text-xs text-gray-500">Total Spend</p>
              <p className="text-base font-semibold text-gray-900">{fmt(data.totalCost)}</p>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 px-3 py-2">
              <p className="text-xs text-gray-500">Videos</p>
              <p className="text-base font-semibold text-gray-900">{data.projectCount}</p>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 px-3 py-2">
              <p className="text-xs text-gray-500">Avg / Video</p>
              <p className="text-base font-semibold text-gray-900">{fmt(data.avgCostPerProject)}</p>
            </div>
            {runpod && (
              <>
                <div className="bg-white rounded-lg border border-blue-200 px-3 py-2">
                  <p className="text-xs text-blue-500">RunPod Balance</p>
                  <p className="text-base font-semibold text-blue-700">{fmt(runpod.balance)}</p>
                </div>
                <div className="bg-white rounded-lg border border-blue-200 px-3 py-2">
                  <p className="text-xs text-blue-500">Spend / hr</p>
                  <p className="text-base font-semibold text-blue-700">{fmt(runpod.spendPerHr)}</p>
                </div>
              </>
            )}
          </div>

          {/* Project table */}
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Project</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.projects.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-3 py-8 text-center text-xs text-gray-500">
                      No projects found for this period.
                    </td>
                  </tr>
                ) : (
                  data.projects.map((project) => {
                    const exp = expanded[project.projectId];
                    const isOpen = !!exp;
                    return (
                      <React.Fragment key={project.projectId}>
                        <tr
                          className="hover:bg-gray-50 cursor-pointer"
                          onClick={() => handleToggle(project.projectId)}
                        >
                          <td className="px-3 py-2 text-gray-900 font-medium">
                            <span className="mr-1 text-gray-400">{isOpen ? '▾' : '▸'}</span>
                            {project.title || project.projectId.slice(0, 8)}
                          </td>
                          <td className="px-3 py-2 text-gray-500">{fmtDate(project.date)}</td>
                          <td className="px-3 py-2 text-right text-gray-900 font-medium">{fmt(project.cost)}</td>
                        </tr>
                        {isOpen && (
                          <tr>
                            <td colSpan={3} className="bg-gray-50 px-6 py-1">
                              {exp.loading ? (
                                <div className="py-1 text-xs text-gray-400">Loading...</div>
                              ) : exp.steps.length === 0 ? (
                                <div className="py-1 text-xs text-gray-400">No breakdown.</div>
                              ) : (
                                <table className="w-full">
                                  <tbody>
                                    {exp.steps.map((s) => (
                                      <tr key={s.step}>
                                        <td className="py-0.5 text-xs text-gray-500">{STEP_LABELS[s.step] ?? s.step}</td>
                                        <td className="py-0.5 text-xs text-right text-gray-700">{fmt(s.totalCost)}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
