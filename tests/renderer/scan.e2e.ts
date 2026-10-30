import { expect, test } from '@playwright/test';
import { cancelledScans, mockIpc, scanUpdate } from './mockIpc';
import type { MockRead, MockScanUpdate } from './mockIpc';

const read = (sourceFile: string): MockRead => ({
  sourceFile,
  error: null,
  warnings: [],
  tags: [],
});
const update = (change: Partial<MockScanUpdate>): MockScanUpdate => ({
  scanId: 1,
  root: '/home/user/Photos',
  state: 'Running',
  added: [],
  problems: [],
  counts: { added: 0, duplicates: 0, filtered: 0, skipped: 0 },
  ...change,
});

// @req FR-004, FR-021
test('a folder scan shows its policy, progress and an honest partial result when stopped', async ({
  page,
}) => {
  await mockIpc(page, []);
  await page.goto('/');
  const files = page.getByRole('region', { name: 'Files' });
  // The link policy is visible without opening the options.
  await expect(files.getByText('links outside not followed')).toBeVisible();
  await files.getByText('Folder options').click();
  await files.getByRole('checkbox', { name: 'Include hidden files and folders' }).check();
  await expect(files.getByText('hidden files included')).toBeVisible();
  const only = files.getByRole('textbox', { name: 'Only these extensions (empty = all)' });
  await only.fill('jpg, PDF');
  await only.blur();
  await expect(files.getByText('only .jpg, .PDF')).toBeVisible();

  await page.getByRole('button', { name: 'Add folder…' }).click();
  await scanUpdate(
    page,
    update({
      added: [read('/home/user/Photos/a.jpg'), read('/home/user/Photos/sub/b.pdf')],
      problems: [
        { path: '/home/user/Photos/out', reason: 'link points outside the folder (not followed)' },
      ],
      counts: { added: 2, duplicates: 0, filtered: 3, skipped: 1 },
    }),
  );
  await expect(files.getByRole('option')).toHaveText(['a.jpg', 'b.pdf']);
  await expect(files.getByRole('status')).toContainText(
    'Scanning /home/user/Photos… 2 added, 3 left out by options, 1 skipped',
  );
  // The first file found is inspected right away.
  await expect(page.locator('caption')).toHaveText('/home/user/Photos/a.jpg');

  await files.getByRole('button', { name: 'Stop' }).click();
  expect(await cancelledScans(page)).toEqual([1]);
  await scanUpdate(
    page,
    update({ state: 'Cancelled', counts: { added: 2, duplicates: 0, filtered: 3, skipped: 1 } }),
  );
  await expect(files.getByRole('status')).toContainText(
    'Scan of /home/user/Photos stopped before finishing: 2 added, 3 left out by options, 1 skipped so far.',
  );
  await page.getByRole('button', { name: /Log/ }).click();
  await expect(page.getByRole('log')).toContainText(
    'Skipped: /home/user/Photos/out: link points outside the folder (not followed)',
  );
  await files.getByRole('button', { name: 'Dismiss' }).click();
  await expect(files.getByRole('status')).toHaveCount(0);
});

// @req NFR-001
test('a 200,000-file scan keeps every update cheap, Stop answers at once and the list stays navigable', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await mockIpc(page, []);
  await page.goto('/');
  await page.evaluate(() => {
    const longest = { ms: 0 };
    Object.assign(window, { __longestTask: longest });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longest.ms = Math.max(longest.ms, entry.duration);
    }).observe({ type: 'longtask', buffered: false });
  });
  const longestTask = () =>
    page.evaluate(() => (window as unknown as { __longestTask: { ms: number } }).__longestTask.ms);
  await page.getByRole('button', { name: 'Add folder…' }).click();

  // Home-folder scale (a real one had ~200,000 files) in updates of 10,000, about what Rust
  // finds per 200 ms update on a fast disk.
  const root = '/home/user';
  let added = 0;
  for (let batch = 0; batch < 20; batch++) {
    const files = Array.from({ length: 10_000 }, (_, i) =>
      read(`${root}/${String(batch).padStart(2, '0')}/${String(i).padStart(5, '0')}.jpg`),
    );
    added += files.length;
    await scanUpdate(
      page,
      update({ root, added: files, counts: { added, duplicates: 0, filtered: 0, skipped: 0 } }),
    );
  }
  const files = page.getByRole('region', { name: 'Files' });
  await expect(files.getByRole('status')).toContainText('200,000 added');
  // Only the rows in view are in the page, whatever the list size.
  expect(await files.getByRole('option').count()).toBeLessThan(100);

  // Stop is acknowledged immediately, before Rust reports the end.
  const stop = files.getByRole('button', { name: 'Stop' });
  const clicked = Date.now();
  await stop.click();
  await expect(files.getByRole('button', { name: 'Stopping…' })).toBeDisabled();
  const stopMs = Date.now() - clicked;
  await scanUpdate(
    page,
    update({ root, state: 'Cancelled', counts: { added, duplicates: 0, filtered: 0, skipped: 0 } }),
  );
  await expect(files.getByRole('status')).toContainText('stopped before finishing: 200,000 added');

  // The last of 200,000 files is one keypress away and gets rendered when reached.
  const list = page.getByRole('listbox', { name: 'Files' });
  await list.focus();
  await page.keyboard.press('End');
  const last = page.getByRole('option', { name: `${root}/19/09999.jpg` });
  await expect(last).toHaveAttribute('aria-selected', 'true');
  await expect(last).toHaveAttribute('aria-posinset', '200000');
  await expect(last).toBeInViewport();

  const longestMs = await longestTask();
  console.log(
    `200k scan: longest main-thread task ${longestMs} ms, Stop acknowledged in ${stopMs} ms`,
  );
  // Bounds leave room for slow CI; locally both are far below.
  expect(longestMs).toBeLessThan(250);
  expect(stopMs).toBeLessThan(1_000);
});
