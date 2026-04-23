/**
 * Costs API - Retrieve cost tracking data for projects
 */

import { Router, Request, Response } from 'express';
import { getProjectCosts, getProjectCostsByStep } from '../lib/cost-tracker';

const router = Router();

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
