import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { addVia, mockIpc, scanUpdate } from './mockIpc';
import type { MockRead } from './mockIpc';
import { tagsOf } from '../support/tags';

// 10,000 tags whose rows differ in height, as real ones do: every 5th is a wrapped list and
// every 7th a multi-line structure.
const plain: Record<string, string | string[] | Record<string, string>> = {};
for (let i = 0; i < 10_000; i++) {
  const key = `G${i % 40}:Tag${String(i).padStart(5, '0')}`;
  plain[key] =
    i % 7 === 0
      ? { Street: `${i} Long Road`, City: 'Fixture City', Country: 'Nowhere' }
      : i % 5 === 0
        ? Array.from({ length: 12 }, (_, n) => `keyword-${i}-${n}`)
        : `value ${i}`;
}
const TEN_K: MockRead = {
  sourceFile: '/home/user/huge.bin',
  error: null,
  warnings: [],
  tags: tagsOf(plain),
};

const longestTask = (page: Page) =>
  page.evaluate(() => (window as unknown as { __longestTask: { ms: number } }).__longestTask.ms);
const watchLongTasks = (page: Page) =>
  page.evaluate(() => {
    const longest = { ms: 0 };
    Object.assign(window, { __longestTask: longest });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longest.ms = Math.max(longest.ms, entry.duration);
    }).observe({ type: 'longtask', buffered: false });
  });
/** Two frames: lets scroll handlers, measurement and the redraw they cause settle. */
const settle = (page: Page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
const pane = (page: Page) => page.locator('.metadata-pane');

async function openTenK(page: Page) {
  await mockIpc(page, [TEN_K]);
  await page.goto('/');
  await watchLongTasks(page);
  await addVia(page, 'Files…');
  await expect(page.getByRole('region', { name: 'Metadata' })).toContainText('10,000 tags');
}

// @req NFR-002, UX-008
test('10,000 tags open without a long task and only the rows near the view are drawn', async ({
  page,
}) => {
  await openTenK(page);
  expect(await longestTask(page)).toBeLessThan(250);
  const table = page.getByRole('table');
  await expect(table).toHaveAttribute('aria-rowcount', '10001');
  expect(await page.locator('tr[data-key]').count()).toBeLessThan(150);

  // The last tag is reachable by scrolling, and gets drawn there.
  await pane(page).evaluate((node) => (node.scrollTop = node.scrollHeight));
  await settle(page);
  await pane(page).evaluate((node) => (node.scrollTop = node.scrollHeight));
  await expect(page.getByRole('rowheader', { name: 'G39:Tag09999' })).toBeInViewport();
  expect(await page.locator('tr[data-key]').count()).toBeLessThan(150);
});

// @req UX-008
test('scrolling up into rows never measured moves the view by exactly the scroll, no jumps', async ({
  page,
}) => {
  await openTenK(page);
  await pane(page).evaluate((node) => (node.scrollTop = node.scrollHeight));
  await settle(page);
  for (let step = 0; step < 12; step++) {
    // Anchor: the first row whose top is inside the pane.
    const before = await page.evaluate(() => {
      const view = document.querySelector('.metadata-pane')?.getBoundingClientRect();
      const row = [...document.querySelectorAll<HTMLElement>('tr[data-key]')].find(
        (row) => view && row.getBoundingClientRect().top >= view.top,
      );
      return { key: row?.dataset.key ?? '', top: row?.getBoundingClientRect().top ?? 0 };
    });
    await pane(page).evaluate((node) => (node.scrollTop -= 400));
    await settle(page);
    await settle(page);
    const after = await page.evaluate(
      (key) => document.querySelector(`tr[data-key="${key}"]`)?.getBoundingClientRect().top ?? NaN,
      before.key,
    );
    // Within 3 px: the correction is only as exact as a whole-pixel scroll position.
    expect(Math.abs(after - (before.top + 400)), `${before.key} at step ${step}`).toBeLessThan(3);
  }
});

// @req UX-004, UX-008
test('focus stays on a row’s Copy button while that row is scrolled far out of view', async ({
  page,
}) => {
  await openTenK(page);
  const copy = page.getByRole('button', { name: 'Copy value of G0:Tag00000' });
  await copy.focus();
  await pane(page).evaluate((node) => (node.scrollTop = node.scrollHeight / 2));
  await settle(page);
  await expect(copy).toBeFocused();
  // Its row is kept drawn even though everything around the middle is drawn too.
  expect(await page.locator('tr[data-key]').count()).toBeLessThan(150);
  // Moving on from it with the keyboard works: focus goes to the next row's first button.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Edit G1:Tag00001' })).toBeFocused();
});

// @req UX-004, NFR-003
test('keyboard selection crosses drawn-row boundaries in a 10,000-file list without losing focus', async ({
  page,
}) => {
  await mockIpc(page, []);
  await page.goto('/');
  const files = Array.from({ length: 10_000 }, (_, i) => ({
    sourceFile: `/m/${String(i).padStart(5, '0')}.jpg`,
    error: null,
    warnings: [],
    tags: [],
  }));
  await scanUpdate(page, {
    scanId: 1,
    root: '/m',
    state: 'Complete',
    added: files,
    problems: [],
    counts: { added: files.length, duplicates: 0, filtered: 0, skipped: 0 },
  });
  const list = page.getByRole('listbox', { name: 'Files' });
  await list.focus();
  await page.keyboard.press('Home');
  for (let step = 0; step < 40; step++) {
    await page.keyboard.press('PageDown');
    const active = await list.getAttribute('aria-activedescendant');
    // The selected row exists, is on screen, and the list kept focus.
    expect(active, `step ${step}`).not.toBeNull();
    await expect(page.locator(`[id="${active}"]`)).toBeInViewport();
    await expect(list).toBeFocused();
  }
  await page.keyboard.press('ArrowUp');
  await expect(list).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('option', { name: '/m/09999.jpg' })).toBeInViewport();
  await page.keyboard.press('Home');
  await expect(page.getByRole('option', { name: '/m/00000.jpg' })).toBeInViewport();
});
