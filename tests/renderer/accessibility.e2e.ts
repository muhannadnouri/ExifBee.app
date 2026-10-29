import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mockIpc, savedTheme } from './mockIpc';

// WCAG 2.2 A/AA rules, checked in a real browser so contrast and layout rules apply.
const audit = async (page: Page) => {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return violations.map((violation) => ({
    rule: violation.id,
    impact: violation.impact,
    targets: violation.nodes.map((node) => node.target.join(' ')),
  }));
};

for (const mode of ['light', 'dark'] as const) {
  // @req UX-004, UX-003, FR-001
  test.describe(`axe audit (${mode})`, () => {
    test.beforeEach(async ({ page }) => {
      await savedTheme(page, mode);
      await mockIpc(page);
    });

    test('empty workbench has no WCAG A/AA violations', async ({ page }) => {
      await page.goto('/');
      expect(await audit(page)).toEqual([]);
    });

    test('populated workbench with errors, warnings and open drawers has no violations', async ({
      page,
    }) => {
      await page.goto('/');
      const add = page.getByRole('button', { name: 'Add files…' });
      await add.click();
      await add.click();
      await page.getByRole('button', { name: /Actions/ }).click();
      await page.getByRole('button', { name: /Log/ }).click();
      await expect(page.getByRole('log')).toContainText('IMG_0042.jpg');
      expect(await audit(page)).toEqual([]);
    });

    test('settings dialog has no violations', async ({ page }) => {
      await page.goto('/');
      await page.getByRole('button', { name: 'Settings' }).click();
      const dialog = page.getByRole('dialog', { name: 'Settings' });
      await expect(dialog).toContainText('/usr/bin/exiftool');
      expect(await audit(page)).toEqual([]);
    });

    test('keyboard shortcuts dialog has no violations', async ({ page }) => {
      await page.goto('/');
      await page.getByRole('button', { name: 'Shortcuts' }).click();
      await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
      expect(await audit(page)).toEqual([]);
    });
  });
}
