import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { addVia, dropFiles, mockIpc, readUpdate, savedTheme, scanUpdate } from './mockIpc';

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

    test('populated workbench with errors, warnings, skip notice, progress card and open drawers has no violations', async ({
      page,
    }) => {
      await page.goto('/');
      await addVia(page, 'Files…');
      await addVia(page, 'Files…');
      await dropFiles(page, [], ['/home/user/Pictures/IMG_0042.jpg']);
      await expect(page.getByRole('button', { name: 'Dismiss' })).toBeVisible();
      await scanUpdate(page, {
        scanId: 1,
        root: '/home/user/Pictures',
        state: 'Running',
        added: [],
        problems: [],
        counts: { added: 120, duplicates: 2, filtered: 5, skipped: 1 },
      });
      const card = page.getByRole('region', { name: 'Adding files' });
      await expect(card.getByRole('button', { name: 'Cancel' })).toBeVisible();
      await readUpdate(page, {
        state: 'Running',
        results: [],
        counts: { done: 40, total: 122, errors: 1, warnings: 2, unsupported: 3 },
        message: null,
      });
      await expect(card).toContainText('Checking 40 of 122');
      expect(await audit(page)).toEqual([]);
    });

    test('open Add menu and Add folder dialog have no violations', async ({ page }) => {
      await page.goto('/');
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(page.getByRole('menu')).toBeVisible();
      expect(await audit(page)).toEqual([]);
      await page.getByRole('menuitem', { name: /^Folder…/ }).click();
      await expect(page.getByRole('dialog', { name: 'Add folder' })).toContainText(
        '/home/user/Photos',
      );
      await page.getByText('Filter by extension').click();
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
      await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
      await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
      expect(await audit(page)).toEqual([]);
    });
  });
}
