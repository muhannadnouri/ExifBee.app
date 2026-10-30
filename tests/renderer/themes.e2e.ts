import { expect, test } from '@playwright/test';
import { savedTheme } from './mockIpc';

// Token values from src/styles/tokens.css (--bg).
const LIGHT_BG = 'rgb(247, 246, 243)';
const DARK_BG = 'rgb(27, 26, 24)';
const bodyBackground = (page: import('@playwright/test').Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

// @req UX-002
test.describe('theme behavior', () => {
  test('a saved theme is applied before the app script runs (no wrong-theme flash)', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await savedTheme(page, 'dark');
    // Block every app script: what renders is what the user sees before React loads.
    // (Aborting rather than stalling, since a pending module script delays DOMContentLoaded.)
    await page.route('**/assets/*.js', (route) => route.abort());
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
    await expect.poll(() => bodyBackground(page)).toBe(DARK_BG);
    expect(await page.locator('#root').innerHTML()).toBe('');
  });

  test('all three modes persist across reloads', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    const theme = page.getByRole('button', { name: /^Theme:/ });

    // One button cycles System → Light → Dark → System; each choice survives a reload.
    for (const [label, background] of [
      ['Theme: Light. Switch to Dark', LIGHT_BG],
      ['Theme: Dark. Switch to System', DARK_BG],
      ['Theme: System. Switch to Light', LIGHT_BG],
    ] as const) {
      await theme.click();
      await page.reload();
      await expect(theme).toHaveAccessibleName(label);
      expect(await bodyBackground(page)).toBe(background);
    }
  });

  test('System mode follows OS light/dark changes live, without a reload', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    await expect(page.getByRole('button', { name: /^Theme:/ })).toHaveAccessibleName(
      'Theme: System. Switch to Light',
    );
    expect(await bodyBackground(page)).toBe(LIGHT_BG);

    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => bodyBackground(page)).toBe(DARK_BG);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => bodyBackground(page)).toBe(LIGHT_BG);
  });

  test('an explicit theme ignores the OS setting', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await savedTheme(page, 'light');
    await page.goto('/');
    expect(await bodyBackground(page)).toBe(LIGHT_BG);
  });
});
