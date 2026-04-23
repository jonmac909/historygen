import { test, expect } from '@playwright/test';

test('Live demo - watch the browser interact with HistoryVidGen', async ({ page }) => {
  // Slow down actions so you can watch
  test.slow();

  console.log('🚀 Opening HistoryVidGen...');
  await page.goto('https://historyvidgen.com/');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  console.log('📝 Clicking on the URL input field...');
  const urlInput = page.locator('input[placeholder*="YouTube"]');
  await urlInput.click();
  await page.waitForTimeout(1000);

  console.log('⌨️ Typing a YouTube URL...');
  await urlInput.fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await page.waitForTimeout(2000);

  console.log('⚙️ Clicking Settings...');
  await page.locator('text=Settings').first().click();
  await page.waitForTimeout(2000);

  console.log('📸 Taking screenshot of settings...');
  await page.screenshot({ path: 'test-results/settings-page.png', fullPage: true });

  console.log('❌ Closing settings modal...');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(2000);

  console.log('✅ Demo complete!');
});
