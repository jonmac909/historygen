/**
 * Layer 7 — Browser lifecycle (Playwright). RED until Phase 1+2+2.5 complete
 * AND playwright.config.ts webServer array is wired up (separate Phase 2 step
 * that depends on render-api /health existing — do NOT modify the config here).
 *
 * Pipeline: sign in -> open existing test project -> Generate Short ->
 * watch SSE-driven UI through script/images/audio/clips/render -> assert the
 * <video> src points at http://localhost:3000/assets/renders/.*\.mp4 and the
 * first frame paints (canvas not empty).
 *
 * Skips cleanly if LOCAL_TEST_USER / LOCAL_TEST_PASS / LOCAL_TEST_PROJECT_ID
 * env vars are absent so it does not fail in environments without test creds.
 */

import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

test.describe('@local-inference @e2e @slow local-inference end-to-end', () => {
  test('local-inference end-to-end shorts pipeline', async ({ page }) => {
    const user = process.env.LOCAL_TEST_USER;
    const pass = process.env.LOCAL_TEST_PASS;
    const projectId = process.env.LOCAL_TEST_PROJECT_ID;

    test.skip(
      !user || !pass || !projectId,
      'LOCAL_TEST_USER / LOCAL_TEST_PASS / LOCAL_TEST_PROJECT_ID env vars required',
    );

    // 1) Open frontend
    await page.goto('http://localhost:5173');
    await page.waitForLoadState('networkidle');

    // 2) Sign in
    await page.getByLabel(/email/i).fill(user!);
    await page.getByLabel(/password/i).fill(pass!);
    await page.getByRole('button', { name: /sign in|log in/i }).click();
    await page.waitForLoadState('networkidle');

    // 3) Open the existing test project
    await page.goto(`http://localhost:5173/project/${projectId}`);
    await page.waitForLoadState('networkidle');

    // 4) Click Generate Short
    await page.getByRole('button', { name: /generate short/i }).click();

    // 5) Wait for SSE-driven UI through stages: script -> images -> audio -> clips -> render
    const stageNames = ['script', 'images', 'audio', 'clips', 'render'];
    for (const stage of stageNames) {
      await expect(
        page.getByTestId(`stage-${stage}`).or(page.getByText(new RegExp(stage, 'i'))),
      ).toBeVisible({ timeout: 30 * 60 * 1000 });
    }

    // 6) Final video element src points at localhost:3000/assets/renders/...
    const video = page.locator('video').first();
    await expect(video).toBeVisible({ timeout: 30 * 60 * 1000 });
    const src = await video.getAttribute('src');
    expect(src).toMatch(/^http:\/\/localhost:3000\/assets\/renders\/.*\.mp4$/);

    // 7) First frame paints (canvas not empty)
    await video.evaluate((el: HTMLVideoElement) => el.play());
    await page.waitForTimeout(1500);
    const painted = await video.evaluate((el: HTMLVideoElement) => {
      const canvas = document.createElement('canvas');
      canvas.width = el.videoWidth || 16;
      canvas.height = el.videoHeight || 16;
      const ctx = canvas.getContext('2d');
      if (!ctx) return false;
      try {
        ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        // Painted = at least one non-zero alpha pixel
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] !== 0) return true;
        }
        return false;
      } catch {
        return false;
      }
    });
    expect(painted).toBe(true);
  });
});
