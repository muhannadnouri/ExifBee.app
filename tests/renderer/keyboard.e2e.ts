import { expect, test } from '@playwright/test';
import { addVia, mockIpc } from './mockIpc';

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
    // Tab to Add, open its menu with Enter and choose Files…, then add a second file with Ctrl+O.
    const add = page.getByRole('button', { name: 'Add', exact: true });
    await page.keyboard.press('Tab');
    await expect(add).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: /^Files…/ })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toHaveText('Could not fully read report.pdf');
    await page.keyboard.press('Control+o');
    await expect(page.getByRole('status')).toHaveText('Read IMG_0042.jpg');

    // Focus returned to Add; Tab on through the toolbar icons to the files list.
    await expect(add).toBeFocused();
    for (const step of [
      'Theme: System. Switch to Light',
      'Keyboard shortcuts',
      'Settings',
      'report.pdf', // the file list: one Tab stop, named here by its rows' text
    ]) {
      await page.keyboard.press('Tab');
      expect((await focusedName(page)).startsWith(step), step).toBe(true);
    }
    await expect(page.getByRole('listbox', { name: 'Files' })).toBeFocused();
    // Arrow keys move through the list; Home selects the first file and inspects it.
    await page.keyboard.press('Home');
    await expect(
      page.getByRole('option', { name: '/home/user/Documents/report.pdf (error)' }),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('alert')).toHaveText('ExifTool error: File format error');

    // The metadata pane is a Tab stop, so a long tag table can be scrolled from the keyboard.
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
    const opener = page.getByRole('button', { name: 'Keyboard shortcuts' });
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
    await addVia(page, 'Files…');
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
    for (const control of [
      'Add',
      'Theme:',
      'Keyboard shortcuts',
      'Settings',
      'Resize files pane',
    ]) {
      expect(visited.some((name) => name.startsWith(control))).toBe(true);
    }
  });
});
