import { test, expect } from '@playwright/test';

test.describe('HistoryVidGen App', () => {
  test('homepage loads successfully', async ({ page }) => {
    await page.goto('https://historyvidgen.com/');

    // Wait for page to load
    await page.waitForLoadState('networkidle');

    // Take a screenshot
    await page.screenshot({ path: 'test-results/homepage.png', fullPage: true });

    // Check page title exists
    const title = await page.title();
    console.log('Page title:', title);

    // Check for main content
    const body = await page.locator('body');
    await expect(body).toBeVisible();
  });

  test('check main UI elements', async ({ page }) => {
    await page.goto('https://historyvidgen.com/');
    await page.waitForLoadState('networkidle');

    // Log all visible text for analysis
    const pageContent = await page.locator('body').textContent();
    console.log('Page content preview:', pageContent?.substring(0, 500));

    // Take screenshot of current state
    await page.screenshot({ path: 'test-results/ui-elements.png', fullPage: true });
  });
});
