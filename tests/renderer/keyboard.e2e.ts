import { expect, test } from '@playwright/test';
import { mockIpc } from './mockIpc';

const focusedName = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    return element?.getAttribute('aria-label') ?? element?.textContent?.trim() ?? '';
  });

// @req UX-004, FR-019
test.describe('keyboard-only use', () => {
  test.beforeEach(async ({ page }) => {
    await mockIpc(page);
    await page.goto('/');
  });

  test('the read flow works without a pointer', async ({ page }) => {
    // Tab to Add files and activate it, then add a second file with the shortcut.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Add files…' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toHaveText('Could not fully read report.pdf');
    await page.keyboard.press('Control+o');
    await expect(page.getByRole('status')).toHaveText('Read IMG_0042.jpg');

    // Focus is still on Add files; Tab on through the toolbar to the files list.
    await expect(page.getByRole('button', { name: 'Add files…' })).toBeFocused();
    for (const step of [
      'Shortcuts',
      'Settings',
      'Theme',
      '/home/user/Documents/report.pdf (error)',
    ]) {
      await page.keyboard.press('Tab');
      await expect(
        page.getByRole(step === 'Theme' ? 'combobox' : 'button', { name: step }),
      ).toBeFocused();
    }
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alert')).toHaveText('ExifTool error: File format error');

    // The metadata pane is a Tab stop, so a long tag table can be scrolled from the keyboard.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('region', { name: 'Metadata' })).toBeFocused();

    // Next come the drawer toggles; open the Log with the keyboard.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: /Actions/ })).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('log')).toContainText('report.pdf');
  });

  test('the shortcuts dialog opens from the keyboard, keeps focus inside and returns it on Esc', async ({
    page,
  }) => {
    const opener = page.getByRole('button', { name: 'Shortcuts' });
    await opener.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
    await expect(dialog).toContainText('Ctrl+O');

    // Modal: Tab cycles within the dialog's own controls.
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test('Tab reaches every control, each with a name, and never gets stuck', async ({ page }) => {
    await page.getByRole('button', { name: 'Add files…' }).click();
    await page.getByRole('button', { name: /Log/ }).click();
    await page.locator('body').click({ position: { x: 1, y: 1 } });

    const visited: string[] = [];
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      visited.push(await focusedName(page));
    }
    // Every stop has an accessible name, and focus cycles back to the first control.
    expect(visited.filter((name) => name === '')).toEqual([]);
    const first = visited[0];
    expect(visited.indexOf(first ?? '', 1)).toBeGreaterThan(0);
    for (const control of ['Add files…', 'Shortcuts', 'Resize files pane']) {
      expect(visited.some((name) => name.startsWith(control))).toBe(true);
    }
  });
});
