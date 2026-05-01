/**
 * Image Scanner API - Scans generated images for content issues and historical accuracy
 */

import { Router, Request, Response } from 'express';
import { moderateImage, rewritePromptForSafety, ViolationType } from '../lib/content-moderator';

const router = Router();

interface ScanImagesRequest {
  // Frontend sends images as array of objects with index and imageUrl
  images?: Array<{ index: number; imageUrl: string }>;
  // Legacy: also accept imageUrls as array of strings
  imageUrls?: string[];
  eraTopic: string;
  projectId?: string;
}

interface ScanResult {
  index: number;
  imageUrl: string;
  safe: boolean;
  violations: string[];
  confidence: number;
  details: string;
}

interface RewritePromptRequest {
  originalPrompt: string;
  scriptContext: string;
  violations: string[];
  eraTopic: string;
}

// POST /scan-images - Scan images for content issues (streaming)
router.post('/', async (req: Request, res: Response) => {
  const { images, imageUrls, eraTopic, projectId }: ScanImagesRequest = req.body;

  // Support both formats: images (array of {index, imageUrl}) or imageUrls (array of strings)
  const urls: string[] = images
    ? images.map(img => img.imageUrl)
    : (imageUrls || []);

  if (urls.length === 0) {
    return res.status(400).json({ error: 'No image URLs provided' });
  }

  if (!eraTopic) {
    return res.status(400).json({ error: 'Era/topic is required for historical accuracy checking' });
  }

  // Setup SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const sendEvent = (data: object) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Keepalive
  const heartbeatInterval = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15000);

  const cleanup = () => {
    clearInterval(heartbeatInterval);
  };

  try {
    const total = urls.length;
    const results: ScanResult[] = [];
    let scannedCount = 0;
    let flaggedCount = 0;

    console.log(`[scan-images] Starting scan of ${total} images for era: ${eraTopic}`);

    sendEvent({
      type: 'start',
      total,
      message: `Scanning ${total} images for content and historical accuracy...`,
    });

    // Process images with limited concurrency to avoid rate limits
    const MAX_CONCURRENT = 3;
    const startTime = Date.now();

    for (let i = 0; i < total; i += MAX_CONCURRENT) {
      const batch = urls.slice(i, Math.min(i + MAX_CONCURRENT, total));
      const batchStartIndex = i;

      const batchResults = await Promise.all(
        batch.map(async (url, batchIdx) => {
          const index = batchStartIndex + batchIdx;
          try {
            const result = await moderateImage(url, eraTopic);
            return {
              index,
              imageUrl: url,
              safe: result.safe,
              violations: result.violations,
              confidence: result.confidence,
              details: result.details,
            };
          } catch (error) {
            console.error(`[scan-images] Error scanning image ${index}:`, error);
            return {
              index,
              imageUrl: url,
              safe: true, // Default to safe on error
              violations: [],
              confidence: 0,
              details: `Scan error: ${error instanceof Error ? error.message : 'Unknown'}`,
            };
          }
        })
      );

      // Send progress for each result
      for (const result of batchResults) {
        results.push(result);
        scannedCount++;
        if (!result.safe) {
          flaggedCount++;
        }

        sendEvent({
          type: 'result',
          index: result.index,
          safe: result.safe,
          violations: result.violations,
          confidence: result.confidence,
          details: result.details,
          progress: Math.round((scannedCount / total) * 100),
        });
      }

      // Small delay between batches to avoid rate limits
      if (i + MAX_CONCURRENT < total) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    const elapsed = Date.now() - startTime;
    console.log(`[scan-images] Completed: ${scannedCount} scanned, ${flaggedCount} flagged in ${elapsed}ms`);

    sendEvent({
      type: 'complete',
      total,
      passed: total - flaggedCount,
      flagged: flaggedCount,
      results: results.filter(r => !r.safe), // Only return flagged results in summary
      elapsedMs: elapsed,
    });

    cleanup();
    res.end();

  } catch (error) {
    console.error('[scan-images] Fatal error:', error);
    sendEvent({
      type: 'error',
      error: error instanceof Error ? error.message : 'Scan failed',
    });
    cleanup();
    res.end();
  }
});

// POST /scan-images/rewrite - Rewrite a prompt to fix violations
router.post('/rewrite', async (req: Request, res: Response) => {
  const { originalPrompt, scriptContext, violations, eraTopic }: RewritePromptRequest = req.body;

  if (!originalPrompt || !violations || violations.length === 0 || !eraTopic) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    console.log(`[scan-images/rewrite] Rewriting prompt for violations: ${violations.join(', ')}`);

    const result = await rewritePromptForSafety(
      originalPrompt,
      scriptContext || '',
      violations as ViolationType[],
      eraTopic
    );

    res.json({
      success: true,
      newPrompt: result.newPrompt,
      changes: result.changes,
    });

  } catch (error) {
    console.error('[scan-images/rewrite] Error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Rewrite failed',
    });
  }
});

export default router;
