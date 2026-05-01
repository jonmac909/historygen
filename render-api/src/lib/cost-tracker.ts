/**
 * Cost Tracker - Tracks and saves pipeline generation costs to Supabase
 *
 * Pricing (verified from Scottish Highlands project):
 * - Claude Sonnet 4.5: $3/1M input tokens, $15/1M output tokens
 * - Fish Speech: $0.008/minute audio output
 * - Z-Image: $0.0084/image
 * - Seedance 1.5 Pro (Kie.ai): $0.08/clip
 * - Whisper: $0.006/minute
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Pricing constants (updated for 24GB PRO @ $1.12/hr)
export const PRICING = {
  runpod_gpu: 0.000311,             // per GPU-second (24GB PRO @ $1.12/hr)
  kie_video: 0.08,                  // per Seedance clip via Kie.ai
  kie_image: 0.0325,                // per thumbnail from Kie.ai
  // Legacy — keep for backward compat with old DB rows
  claude_input: 3 / 1_000_000,
  claude_output: 15 / 1_000_000,
  claude_vision: 0.004,
  fish_speech: 0.008,
  voxcpm2: 0.019,
  z_image: 0.003,
  seedance: 0.08,
  whisper: 0.006,
  runpod_cpu: 0.0003733,
};

// Initialize Supabase client (lazy)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (!supabase) {
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Supabase credentials not configured');
    }
    supabase = createClient(supabaseUrl, supabaseKey);
  }
  return supabase;
}

export interface CostRecord {
  projectId: string;
  videoId?: string;
  source: 'auto_poster' | 'manual';
  step: string;
  service: string;
  units: number;
  unitType: string;
}

export interface SavedCost extends CostRecord {
  id: string;
  unitCost: number;
  totalCost: number;
  createdAt: string;
}

/**
 * Calculate cost and save to Supabase
 * Returns the total cost for this entry
 */
export async function saveCost(params: CostRecord): Promise<number> {
  const { projectId, videoId, source, step, service, units, unitType } = params;

  // Calculate unit cost based on service and unit type
  let unitCost: number;

  switch (service) {
    case 'claude':
      unitCost = unitType === 'input_tokens' ? PRICING.claude_input : PRICING.claude_output;
      break;
    case 'claude_vision':
      unitCost = PRICING.claude_vision;
      break;
    case 'fish_speech':
      unitCost = PRICING.fish_speech;
      break;
    case 'voxcpm2':
      unitCost = PRICING.voxcpm2;
      break;
    case 'z_image':
      unitCost = PRICING.z_image;
      break;
    case 'seedance':
      // Flat rate per clip
      unitCost = PRICING.seedance;
      break;
    case 'whisper':
      unitCost = PRICING.whisper;
      break;
    case 'runpod_gpu':
      unitCost = PRICING.runpod_gpu;
      break;
    case 'kie_video':
      unitCost = PRICING.kie_video;
      break;
    case 'kie_image':
      unitCost = PRICING.kie_image;
      break;
    case 'runpod_cpu':
      unitCost = PRICING.runpod_cpu;
      break;
    default:
      console.warn(`[cost-tracker] Unknown service: ${service}`);
      unitCost = 0;
  }

  const totalCost = units * unitCost;

  try {
    await getSupabase()
      .from('project_costs')
      .insert({
        project_id: projectId,
        video_id: videoId || null,
        source,
        step,
        service,
        units,
        unit_type: unitType,
        unit_cost: unitCost,
        total_cost: totalCost,
      });

    console.log(`[cost-tracker] Saved cost: ${step}/${service} = $${totalCost.toFixed(6)} (${units} ${unitType})`);
    return totalCost;
  } catch (e) {
    console.error('[cost-tracker] Error saving cost:', e);
    return totalCost; // Still return cost even if save fails
  }
}

/**
 * Get all costs for a project
 */
export async function getProjectCosts(projectId: string): Promise<{
  steps: Array<{
    step: string;
    service: string;
    units: number;
    unitType: string;
    unitCost: number;
    totalCost: number;
  }>;
  totalCost: number;
}> {
  try {
    const { data, error } = await getSupabase()
      .from('project_costs')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: true });

    if (error || !data) {
      return { steps: [], totalCost: 0 };
    }

    const steps = data.map((row: any) => ({
      step: row.step,
      service: row.service,
      units: row.units,
      unitType: row.unit_type,
      unitCost: row.unit_cost,
      totalCost: row.total_cost,
    }));

    const totalCost = steps.reduce((sum, s) => sum + s.totalCost, 0);

    return { steps, totalCost };
  } catch (e) {
    console.error('[cost-tracker] Error getting project costs:', e);
    return { steps: [], totalCost: 0 };
  }
}

/**
 * Get aggregated costs by step for a project (combines multiple entries per step)
 */
export async function getProjectCostsByStep(projectId: string): Promise<{
  steps: Array<{
    step: string;
    totalCost: number;
    breakdown: Array<{
      service: string;
      units: number;
      unitType: string;
      cost: number;
    }>;
  }>;
  totalCost: number;
}> {
  try {
    const { data, error } = await getSupabase()
      .from('project_costs')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: true });

    if (error || !data) {
      return { steps: [], totalCost: 0 };
    }

    // Group by step
    const stepMap = new Map<string, {
      totalCost: number;
      breakdown: Array<{
        service: string;
        units: number;
        unitType: string;
        cost: number;
      }>;
    }>();

    for (const row of data) {
      const existing = stepMap.get(row.step) || { totalCost: 0, breakdown: [] };
      existing.totalCost += row.total_cost;
      existing.breakdown.push({
        service: row.service,
        units: row.units,
        unitType: row.unit_type,
        cost: row.total_cost,
      });
      stepMap.set(row.step, existing);
    }

    const steps = Array.from(stepMap.entries()).map(([step, data]) => ({
      step,
      ...data,
    }));

    const totalCost = steps.reduce((sum, s) => sum + s.totalCost, 0);

    return { steps, totalCost };
  } catch (e) {
    console.error('[cost-tracker] Error getting project costs by step:', e);
    return { steps: [], totalCost: 0 };
  }
}

/**
 * Get aggregated cost summary across all projects for a given time range
 */
export async function getCostSummary(range: 'today' | 'yesterday' | 'week' | 'month' | 'all' | 'custom', start?: string, end?: string): Promise<{
  totalCost: number;
  projectCount: number;
  avgCostPerProject: number;
  costByService: { service: string; cost: number }[];
  costByStep: { step: string; cost: number }[];
  costByDay: { date: string; cost: number }[];
  projects: { projectId: string; title: string; cost: number; date: string }[];
}> {
  const intervalMap: Record<string, string> = {
    today: '1 day',
    week: '7 days',
    month: '30 days',
  };

  const sb = getSupabase();

  // Build query with optional date filter
  let query = sb
    .from('project_costs')
    .select('project_id, step, service, units, unit_type, total_cost, created_at')
    .order('created_at', { ascending: false });

  if (range === 'custom' && start && end) {
    query = query.gte('created_at', new Date(start).toISOString()).lte('created_at', new Date(end + 'T23:59:59').toISOString());
  } else if (range === 'yesterday') {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    query = query.gte('created_at', yesterday.toISOString()).lt('created_at', today.toISOString());
  } else if (range !== 'all') {
    const cutoff = new Date();
    const days = range === 'today' ? 1 : range === 'week' ? 7 : 30;
    cutoff.setDate(cutoff.getDate() - days);
    query = query.gte('created_at', cutoff.toISOString());
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to fetch cost data: ${error.message}`);
  }

  const rows = data || [];

  // Aggregate by service
  const serviceMap = new Map<string, number>();
  for (const row of rows) {
    serviceMap.set(row.service, (serviceMap.get(row.service) || 0) + row.total_cost);
  }
  const costByService = Array.from(serviceMap.entries())
    .map(([service, cost]) => ({ service, cost }))
    .sort((a, b) => b.cost - a.cost);

  // Aggregate by step
  const stepMap = new Map<string, number>();
  for (const row of rows) {
    stepMap.set(row.step, (stepMap.get(row.step) || 0) + row.total_cost);
  }
  const costByStep = Array.from(stepMap.entries())
    .map(([step, cost]) => ({ step, cost }))
    .sort((a, b) => b.cost - a.cost);

  // Aggregate by day (last 30 days regardless of range)
  const dayMap = new Map<string, number>();
  const dayCutoff = new Date();
  dayCutoff.setDate(dayCutoff.getDate() - 30);
  for (const row of rows) {
    const rowDate = new Date(row.created_at);
    if (rowDate >= dayCutoff) {
      const dateKey = rowDate.toISOString().split('T')[0];
      dayMap.set(dateKey, (dayMap.get(dateKey) || 0) + row.total_cost);
    }
  }
  const costByDay = Array.from(dayMap.entries())
    .map(([date, cost]) => ({ date, cost }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Aggregate by project
  const projectMap = new Map<string, { cost: number; date: string }>();
  for (const row of rows) {
    const existing = projectMap.get(row.project_id);
    if (existing) {
      existing.cost += row.total_cost;
      if (row.created_at < existing.date) {
        existing.date = row.created_at;
      }
    } else {
      projectMap.set(row.project_id, { cost: row.total_cost, date: row.created_at });
    }
  }

  // Fetch project titles
  const projectIds = Array.from(projectMap.keys());
  let titleMap = new Map<string, string>();
  if (projectIds.length > 0) {
    const { data: projects } = await sb
      .from('generation_projects')
      .select('id, video_title')
      .in('id', projectIds);

    if (projects) {
      for (const p of projects) {
        titleMap.set(p.id, p.video_title || '');
      }
    }
  }

  const projectList = Array.from(projectMap.entries())
    .map(([projectId, { cost, date }]) => ({
      projectId,
      title: titleMap.get(projectId) || '',
      cost,
      date,
    }))
    .sort((a, b) => b.cost - a.cost);

  const totalCost = rows.reduce((sum, r) => sum + r.total_cost, 0);
  const projectCount = projectMap.size;
  const avgCostPerProject = projectCount > 0 ? totalCost / projectCount : 0;

  return {
    totalCost,
    projectCount,
    avgCostPerProject,
    costByService,
    costByStep,
    costByDay,
    projects: projectList,
  };
}
