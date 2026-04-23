/**
 * Vision Test Comparison Endpoint
 *
 * Compares Claude Vision vs LLaVA-NeXT-Video side-by-side for quality evaluation.
 * Phase 1: Proof-of-Concept testing before production deployment.
 */

import { Router, Request, Response } from 'express';
import { describeFrames as claudeDescribeFrames } from '../lib/vision-describer';
import { generateDescriptions as opensourceDescribeFrames } from '../lib/opensource-vision-client';
import { downloadVideo, extractFrames, uploadFramesToSupabase } from '../lib/video-preprocessor';
import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'crypto';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';

const router = Router();

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

interface ComparisonRequest {
  videoUrl: string;
  frameCount?: number;        // Number of frames to test (default: 10)
  useKeyframes?: boolean;     // Use scene keyframes vs random frames
}

interface ComparisonFrame {
  frameIndex: number;
  frameUrl: string;
  claudeDescription: string;
  opensourceDescription: string;
  claudeError?: string;
  opensourceError?: string;
}

interface ComparisonResponse {
  videoUrl: string;
  frameCount: number;
  frames: ComparisonFrame[];
  claudeCost: number;
  opensourceCost: number;
  costSavingsPercent: number;
}

/**
 * POST /vision-test/compare
 *
 * Compare Claude Vision vs Open-Source Vision on a video
 */
router.post('/compare', async (req: Request, res: Response) => {
  try {
    const { videoUrl, frameCount = 10, useKeyframes = true } = req.body as ComparisonRequest;

    if (!videoUrl) {
      res.status(400).json({ error: 'videoUrl is required' });
      return;
    }

    console.log(`[vision-test] Starting comparison for ${videoUrl} (${frameCount} frames)`);

    // Create temp directory for video processing
    const tempDir = path.join(os.tmpdir(), `vision-test-${randomBytes(8).toString('hex')}`);
    await fs.mkdir(tempDir, { recursive: true });

    let videoPath: string;
    let frameUrls: string[] = [];

    try {
      // Step 1: Download video
      console.log('[vision-test] Downloading video...');
      videoPath = path.join(tempDir, 'video.mp4');
      const { duration, tier } = await downloadVideo(videoUrl, videoPath);
      console.log(`[vision-test] Downloaded video: ${duration}s (tier ${tier})`);

      // Step 2: Extract frames
      console.log('[vision-test] Extracting frames...');
      const framesDir = path.join(tempDir, 'frames');
      await fs.mkdir(framesDir, { recursive: true });

      // Extract frames at 1 FPS
      const framePaths = await extractFrames(videoPath, framesDir, 1);
      console.log(`[vision-test] Extracted ${framePaths.length} frames`);

      // Upload frames to Supabase (for URL access)
      const testVideoId = `vision-test-${randomBytes(8).toString('hex')}`;
      const allFrameUrls = await uploadFramesToSupabase(testVideoId, framePaths);

      // Take first N frames (or all if less than N)
      const framesToTest = Math.min(frameCount, allFrameUrls.length);
      frameUrls = allFrameUrls.slice(0, framesToTest);

      console.log(`[vision-test] Testing ${frameUrls.length} frames`);

      // Step 3: Generate descriptions with BOTH models in parallel
      console.log('[vision-test] Generating descriptions with both models...');

      const [claudeResults, opensourceResults] = await Promise.all([
        // Claude Vision
        claudeDescribeFrames(frameUrls, {
          batchSize: 10,
          maxConcurrent: 3,
        }).catch(err => {
          console.error('[vision-test] Claude Vision error:', err);
          return frameUrls.map((_, idx) => ({
            frameIndex: idx,
            description: '',
            error: err.message,
          }));
        }),

        // Open-Source Vision
        opensourceDescribeFrames(frameUrls, {
          batchSize: 10,
          maxConcurrent: 4,
        }).catch(err => {
          console.error('[vision-test] Open-source vision error:', err);
          return {
            descriptions: frameUrls.map(() => ''),
            failedIndices: frameUrls.map((_, idx) => idx),
            count: 0,
          };
        }),
      ]);

      // Step 4: Build comparison results
      const frames: ComparisonFrame[] = [];

      for (let i = 0; i < frameUrls.length; i++) {
        const claudeResult = Array.isArray(claudeResults)
          ? claudeResults.find(r => r.frameIndex === i)
          : undefined;

        const opensourceDesc = Array.isArray(opensourceResults.descriptions)
          ? opensourceResults.descriptions[i]
          : '';

        const opensourceFailed = opensourceResults.failedIndices?.includes(i);

        frames.push({
          frameIndex: i,
          frameUrl: frameUrls[i],
          claudeDescription: claudeResult?.description || '',
          opensourceDescription: opensourceDesc || '',
          claudeError: claudeResult?.error,
          opensourceError: opensourceFailed ? 'Frame processing failed' : undefined,
        });
      }

      // Step 5: Calculate costs
      // Claude Vision: $3/1M input tokens, $15/1M output tokens
      // Assume ~1,600 tokens per image input, ~100 tokens per output
      const claudeInputTokens = frameUrls.length * 1600;
      const claudeOutputTokens = frameUrls.length * 100;
      const claudeCost = (claudeInputTokens / 1_000_000) * 3 + (claudeOutputTokens / 1_000_000) * 15;

      // Open-source: $0.00049/s × ~1.5s per frame
      const opensourceCost = frameUrls.length * 1.5 * 0.00049;

      const costSavingsPercent = ((claudeCost - opensourceCost) / claudeCost) * 100;

      const response: ComparisonResponse = {
        videoUrl,
        frameCount: frames.length,
        frames,
        claudeCost,
        opensourceCost,
        costSavingsPercent,
      };

      console.log('[vision-test] Comparison complete');
      console.log(`[vision-test] Claude cost: $${claudeCost.toFixed(4)}, Open-source cost: $${opensourceCost.toFixed(4)}`);
      console.log(`[vision-test] Savings: ${costSavingsPercent.toFixed(1)}%`);

      res.json(response);

    } finally {
      // Cleanup temp directory
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
        console.log('[vision-test] Cleaned up temp directory');
      } catch (err) {
        console.warn('[vision-test] Failed to cleanup temp directory:', err);
      }
    }

  } catch (error: any) {
    console.error('[vision-test] Error:', error);
    res.status(500).json({
      error: 'Vision test comparison failed',
      details: error.message,
    });
  }
});

/**
 * GET /vision-test/health
 *
 * Check if both vision services are available
 */
router.get('/health', async (req: Request, res: Response) => {
  try {
    const [claudeAvailable, opensourceAvailable] = await Promise.all([
      // Claude Vision (always available if API key is set)
      Promise.resolve(!!process.env.ANTHROPIC_API_KEY),

      // Open-source vision endpoint
      (async () => {
        const { checkVisionAvailability } = await import('../lib/opensource-vision-client');
        const status = await checkVisionAvailability();
        return status.available;
      })(),
    ]);

    res.json({
      claude: {
        available: claudeAvailable,
        endpoint: 'Anthropic API',
      },
      opensource: {
        available: opensourceAvailable,
        endpoint: process.env.RUNPOD_VISION_ENDPOINT_ID || 'Not configured',
      },
    });

  } catch (error: any) {
    res.status(500).json({
      error: 'Health check failed',
      details: error.message,
    });
  }
});

export default router;
