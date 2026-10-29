import { expect, test } from '@playwright/test';
import { mockIpc, savedTheme } from './mockIpc';

// Baselines are generated and compared only in the pinned Playwright container:
// `npm run test:e2e:renderer:docker` writes missing baselines; after a reviewed visual change,
// `npm run test:e2e:renderer:docker -- --update-snapshots=changed`. CI never writes them.

for (const mode of ['light', 'dark'] as const) {
  // @req UX-002, UX-003
  test.describe(`${mode} theme snapshots`, () => {
    test.beforeEach(async ({ page }) => {
      await savedTheme(page, mode);
      await mockIpc(page);
    });

    test('empty workbench', async ({ page }) => {
      await page.goto('/');
      await expect(page).toHaveScreenshot(`empty-${mode}.png`);
    });

    test('workbench with files, warning, error and open drawers', async ({ page }) => {
      await page.goto('/');
      const add = page.getByRole('button', { name: 'Add files…' });
      await add.click();
      await add.click();
      await page.getByRole('button', { name: /Actions/ }).click();
      await page.getByRole('button', { name: /Log/ }).click();
      await expect(page.getByRole('log')).toContainText('IMG_0042.jpg');
      await expect(page).toHaveScreenshot(`workbench-${mode}.png`);

      // 1280×800 at 200% scaling is a 640×400 page.
      await page.setViewportSize({ width: 640, height: 400 });
      await expect(page).toHaveScreenshot(`workbench-${mode}-640x400.png`);
    });
  });
}
