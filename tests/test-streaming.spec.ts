import { test, expect } from '@playwright/test';

test('verify streaming script tokens display in UI', async ({ page }) => {
  // Navigate to the deployed app
  await page.goto('https://historygenai.netlify.app');

  console.log('✓ Navigated to app');

  // Wait for app to load
  await page.waitForSelector('input[placeholder*="YouTube"]', { timeout: 10000 });

  console.log('✓ App loaded');

  // Enter a short YouTube URL for testing (this is a 2-minute history video)
  const testUrl = 'https://www.youtube.com/watch?v=xuCn8ux2gbs';
  await page.fill('input[placeholder*="YouTube"]', testUrl);

  console.log('✓ Entered YouTube URL:', testUrl);

  // Click Generate button
  await page.click('button:has-text("Generate")');

  console.log('✓ Clicked Generate button');

  // Wait for transcript to load and click Continue
  await page.waitForSelector('text=Review Script', { timeout: 30000 });
  await page.click('button:has-text("Continue")');

  console.log('✓ Transcript loaded, starting script generation...');

  // Monitor for streaming tokens in the UI
  let foundStreamingTokens = false;
  let streamingText = '';

  // Set up a listener for network requests to see if tokens are being sent
  page.on('console', msg => {
    console.log('Browser console:', msg.text());
  });

  // Watch for changes in the processing modal
  const maxWaitTime = 120000; // 2 minutes
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitTime) {
    // Get the current step text
    const stepText = await page.locator('[class*="step"]').filter({ hasText: 'Rewriting Script' }).first().textContent();

    if (stepText) {
      console.log('Current step text:', stepText);

      // Check if we see streaming preview (text in quotes)
      if (stepText.includes('"') && stepText.includes('...')) {
        foundStreamingTokens = true;
        streamingText = stepText;
        console.log('✓ FOUND STREAMING TOKENS!');
        console.log('Preview text:', stepText);
        break;
      }

      // Check if script generation completed (might be too fast to catch tokens)
      if (stepText.includes('Review Audio')) {
        console.log('⚠ Script completed before we could verify streaming tokens');
        console.log('Final text:', stepText);
        break;
      }
    }

    // Wait a bit before checking again
    await page.waitForTimeout(500);
  }

  // Take a screenshot for visual inspection
  await page.screenshot({ path: 'streaming-test-screenshot.png', fullPage: true });
  console.log('✓ Screenshot saved to streaming-test-screenshot.png');

  if (foundStreamingTokens) {
    console.log('\n✅ SUCCESS: Streaming tokens are displaying in the UI!');
    console.log('Preview text:', streamingText);
  } else {
    console.log('\n❌ FAILED: No streaming tokens detected in UI');
    console.log('This could mean:');
    console.log('1. Frontend not deployed yet (check Netlify)');
    console.log('2. Tokens streaming too fast to catch');
    console.log('3. UI not updating with streaming preview');
  }

  expect(foundStreamingTokens).toBe(true);
});
