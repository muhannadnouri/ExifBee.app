import { expect, test } from '@playwright/test';
import { mockIpc, prioritized, readUpdate, readsCancelled, scanUpdate } from './mockIpc';
import type { MockRead, MockReadUpdate } from './mockIpc';

const read = (sourceFile: string): MockRead => ({
  sourceFile,
  error: null,
  warnings: [],
  tags: [],
});
const running = (
  results: MockReadUpdate['results'],
  counts: MockReadUpdate['counts'],
): MockReadUpdate => ({ state: 'Running', results, counts, message: null });
const summary = (id: string, change: Partial<MockReadUpdate['results'][number]> = {}) => ({
  id,
  fileType: 'JPEG',
  error: null,
  unsupported: false,
  warnings: [],
  tagCount: 40,
  ...change,
});

// @req FR-005, NFR-002
test('background reads flag files as summaries stream in over a large list, and can be stopped', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await mockIpc(page, []);
  await page.goto('/');

  const total = 20_000;
  const files = Array.from({ length: total }, (_, i) =>
    read(`/m/${String(i).padStart(5, '0')}.jpg`),
  );
  const counts = { added: total, duplicates: 0, filtered: 0, skipped: 0 };
  await scanUpdate(page, {
    scanId: 1,
    root: '/m',
    state: 'Complete',
    added: files,
    problems: [],
    counts,
  });

  // Measure from here: only the summary stream, not listing the files.
  await page.evaluate(() => {
    const longest = { ms: 0 };
    Object.assign(window, { __longestTask: longest });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longest.ms = Math.max(longest.ms, entry.duration);
    }).observe({ type: 'longtask', buffered: false });
  });
  // 200 updates of 100 summaries, as the Rust worker sends them; f2 is corrupt, f3 warns.
  for (let batch = 0; batch < 200; batch++) {
    const results = Array.from({ length: 100 }, (_, i) => {
      const id = `f${batch * 100 + i + 1}`;
      if (id === 'f2') return summary(id, { fileType: null, error: 'File format error' });
      if (id === 'f3') return summary(id, { warnings: ['JPEG format error'] });
      if (id === 'f4')
        return summary(id, { fileType: null, error: 'Unknown file type', unsupported: true });
      return summary(id);
    });
    const done = (batch + 1) * 100;
    await readUpdate(
      page,
      running(results, { done, total: total + 100, errors: 1, warnings: 1, unsupported: 1 }),
    );
  }
  const pane = page.getByRole('region', { name: 'Files' });
  // Checking alone (the scan had finished) shows its card once it has run for over a second.
  const card = page.getByRole('region', { name: 'Adding files' });
  await expect(card.getByRole('heading')).toHaveText('Checking new files');
  await expect(card).toContainText('Checking 20,000 of 20,100');
  await expect(pane.getByText(/^20,000 files/)).toHaveText(
    '20,000 files · 1 with errors · 1 with warnings · 1 unsupported',
  );
  await expect(pane.getByRole('option', { name: '/m/00003.jpg (unsupported)' })).toBeVisible();
  await expect(pane.getByRole('option', { name: '/m/00001.jpg (error)' })).toBeVisible();
  await expect(pane.getByRole('option', { name: '/m/00002.jpg (warning)' })).toBeVisible();
  const longestMs = await page.evaluate(
    () => (window as unknown as { __longestTask: { ms: number } }).__longestTask.ms,
  );
  console.log(`20k summaries: longest main-thread task ${longestMs} ms`);
  expect(longestMs).toBeLessThan(250);

  await card.getByRole('button', { name: 'Cancel' }).click();
  await expect(card.getByRole('button', { name: 'Stopping…' })).toBeDisabled();
  expect(await readsCancelled(page)).toBe(1);
  await readUpdate(page, {
    state: 'Cancelled',
    results: [],
    counts: { done: 20_000, total: 20_100, errors: 1, warnings: 1, unsupported: 1 },
    message: null,
  });
  await expect(card).toContainText(
    'Stopped: 20,100 listed, 20,000 checked. Selecting a file still reads it.',
  );
  await page.getByRole('button', { name: /Log/ }).click();
  await expect(page.getByRole('log')).toContainText('error: /m/00001.jpg: File format error');
  await expect(page.getByRole('log')).not.toContainText('00003.jpg');
});

// @req NFR-002, FR-005
test('the rows in view are sent to Rust to be checked first, also after scrolling', async ({
  page,
}) => {
  await mockIpc(page, []);
  await page.goto('/');
  const files = Array.from({ length: 5_000 }, (_, i) =>
    read(`/m/${String(i).padStart(4, '0')}.jpg`),
  );
  const counts = { added: files.length, duplicates: 0, filtered: 0, skipped: 0 };
  await scanUpdate(page, {
    scanId: 1,
    root: '/m',
    state: 'Complete',
    added: files,
    problems: [],
    counts,
  });
  // Reads are running, so the visible rows are prioritized.
  await readUpdate(
    page,
    running([], { done: 0, total: 5_000, errors: 0, warnings: 0, unsupported: 0 }),
  );
  await page.getByRole('listbox', { name: 'Files' }).focus();
  await page.keyboard.press('End');
  await expect.poll(async () => (await prioritized(page)).at(-1)?.includes('f5000')).toBe(true);
  const last = (await prioritized(page)).at(-1) ?? [];
  // Only a window of rows, never the whole list.
  expect(last.length).toBeLessThan(100);
  expect(last).not.toContain('f1');
});
