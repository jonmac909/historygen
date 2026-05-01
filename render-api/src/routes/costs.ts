/**
 * Costs API - Retrieve cost tracking data for projects
 */

import { Router, Request, Response } from 'express';
import { getProjectCosts, getProjectCostsByStep, getCostSummary } from '../lib/cost-tracker';

const router = Router();

/**
 * GET /costs/summary
 * Get aggregated cost summary across all projects
 */
router.get('/summary', async (req: Request, res: Response) => {
  const range = (req.query.range as string) || 'month';
  if (!['today', 'yesterday', 'week', 'month', 'all', 'custom'].includes(range)) {
    return res.status(400).json({ error: 'Invalid range' });
  }
  try {
    const start = req.query.start as string | undefined;
    const end = req.query.end as string | undefined;
    const summary = await getCostSummary(range as any, start, end);
    return res.json({ success: true, ...summary });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /costs/runpod-status
 * Live RunPod account balance and spend rate
 */
router.get('/runpod-status', async (req: Request, res: Response) => {
  const apiKey = process.env.RUNPOD_API_KEY;
  if (!apiKey) {
    return res.json({ success: false, error: 'RUNPOD_API_KEY not configured' });
  }

  try {
    const resp = await fetch('https://api.runpod.io/graphql?api_key=' + apiKey, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: '{ myself { currentSpendPerHr clientBalance spendLimit } }',
      }),
    });
    const data = await resp.json();
    const me = data?.data?.myself;
    if (!me) {
      return res.json({ success: false, error: 'Failed to fetch RunPod data' });
    }
    return res.json({
      success: true,
      balance: me.clientBalance,
      spendPerHr: me.currentSpendPerHr,
      spendLimit: me.spendLimit,
    });
  } catch (error: any) {
    return res.json({ success: false, error: error.message });
  }
});

/**
 * GET /costs/:projectId
 * Get all costs for a project
 */
router.get('/:projectId', async (req: Request, res: Response) => {
  const { projectId } = req.params;
  const { byStep } = req.query; // Optional query param to aggregate by step

  if (!projectId) {
    return res.status(400).json({ success: false, error: 'Project ID is required' });
  }

  try {
    if (byStep === 'true') {
      const costs = await getProjectCostsByStep(projectId);
      return res.json({ success: true, ...costs });
    } else {
      const costs = await getProjectCosts(projectId);
      return res.json({ success: true, ...costs });
    }
  } catch (error: any) {
    console.error('[costs] Error fetching costs:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
