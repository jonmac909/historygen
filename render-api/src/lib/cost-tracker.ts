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

// Pricing constants (verified from Scottish Highlands project)
export const PRICING = {
  claude_input: 3 / 1_000_000,      // $3 per 1M input tokens
  claude_output: 15 / 1_000_000,    // $15 per 1M output tokens
  claude_vision: 0.004,             // per image scanned with Claude Vision
  fish_speech: 0.008,               // $0.008/minute audio output
  z_image: 0.0084,                  // $0.0084/image
  seedance: 0.08,                   // per clip (flat rate via Kie.ai)
  whisper: 0.006,                   // $0.006/minute
  runpod_cpu: 0.0003733,            // per second of processing
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
