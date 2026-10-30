import { expect, test } from '@playwright/test';
import { addVia, cancelledScans, mockIpc, readUpdate, scanUpdate } from './mockIpc';
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
test('Add folder confirms the folder with its options, then a card shows progress and an honest stop', async ({
  page,
}) => {
  await mockIpc(page, []);
  await page.goto('/');
  await addVia(page, 'Folder…');
  const dialog = page.getByRole('dialog', { name: 'Add folder' });
  await expect(dialog).toContainText('/home/user/Photos');
  await dialog.getByRole('checkbox', { name: 'Include hidden files and folders' }).check();
  await dialog.getByText('Filter by extension').click();
  await dialog
    .getByRole('textbox', { name: 'Only these extensions (empty = all)' })
    .fill('jpg, PDF');
  await dialog.getByRole('button', { name: 'Add folder' }).click();
  await expect(dialog).toBeHidden();

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
  const files = page.getByRole('region', { name: 'Files' });
  await expect(files.getByRole('option')).toHaveText(['a.jpg', 'b.pdf']);
  // Progress sits above the list it fills, in plain words, with the policy in force.
  const card = page.getByRole('region', { name: 'Adding files' });
  await expect(card.getByRole('heading')).toHaveText('Adding /home/user/Photos');
  await expect(card).toContainText('Finding files… 2 found, 3 left out, 1 skipped');
  await expect(card).toContainText('links outside not followed');
  // The first file found is inspected right away.
  await expect(page.locator('caption')).toHaveText('/home/user/Photos/a.jpg');

  await card.getByRole('button', { name: 'Cancel' }).click();
  expect(await cancelledScans(page)).toEqual([1]);
  await scanUpdate(
    page,
    update({ state: 'Cancelled', counts: { added: 2, duplicates: 0, filtered: 3, skipped: 1 } }),
  );
  await expect(card).toContainText(
    'Stopped: 2 listed, 0 checked. Selecting a file still reads it.',
  );
  await expect(card.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
  await page.getByRole('button', { name: /Log/ }).click();
  await expect(page.getByRole('log')).toContainText(
    'Skipped: /home/user/Photos/out: link points outside the folder (not followed)',
  );
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
  // Home-folder scale (a real one had ~200,000 files) in 40 updates of 5,000. Smaller than a
  // fast disk's 200 ms batch, because the mock registering each batch inside the page counts
  // toward the measured task; bigger batches made the bound depend on machine load.
  const root = '/home/user';
  let added = 0;
  for (let batch = 0; batch < 40; batch++) {
    const files = Array.from({ length: 5_000 }, (_, i) =>
      read(`${root}/${String(batch).padStart(2, '0')}/${String(i).padStart(5, '0')}.jpg`),
    );
    added += files.length;
    await scanUpdate(
      page,
      update({ root, added: files, counts: { added, duplicates: 0, filtered: 0, skipped: 0 } }),
    );
  }
  const files = page.getByRole('region', { name: 'Files' });
  const card = page.getByRole('region', { name: 'Adding files' });
  await expect(card).toContainText('Finding files… 200,000 found');
  // Only the rows in view are in the page, whatever the list size.
  expect(await files.getByRole('option').count()).toBeLessThan(100);

  // Stop is acknowledged immediately, before Rust reports the end.
  const stop = card.getByRole('button', { name: 'Cancel' });
  const clicked = Date.now();
  await stop.click();
  await expect(card.getByRole('button', { name: 'Stopping…' })).toBeDisabled();
  const stopMs = Date.now() - clicked;
  await scanUpdate(
    page,
    update({ root, state: 'Cancelled', counts: { added, duplicates: 0, filtered: 0, skipped: 0 } }),
  );
  await expect(card).toContainText('Stopped: 200,000 listed, 0 checked.');

  // The last of 200,000 files is one keypress away and gets rendered when reached.
  const list = page.getByRole('listbox', { name: 'Files' });
  await list.focus();
  await page.keyboard.press('End');
  const last = page.getByRole('option', { name: `${root}/39/04999.jpg` });
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

// @req UX-001
test('log entry numbers stay fully visible at five digits', async ({ page }) => {
  await mockIpc(page, []);
  await page.goto('/');
  const problems = Array.from({ length: 12_345 }, (_, i) => ({
    path: `/x/${i}`,
    reason: 'not a regular file',
  }));
  const counts = { added: 0, duplicates: 0, filtered: 0, skipped: problems.length };
  await scanUpdate(page, update({ root: '/x', state: 'Complete', problems, counts }));
  await page.getByRole('button', { name: /Log/ }).click();
  // The widest marker ("12346. ") must fit the list's number gutter.
  const { marker, gutter } = await page.evaluate(() => {
    const list = document.querySelector('.log') as HTMLElement;
    const probe = document.createElement('span');
    probe.style.font = getComputedStyle(list.querySelector('li') as HTMLElement).font;
    probe.textContent = `${list.children.length}. `;
    document.body.append(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    return { marker: width, gutter: parseFloat(getComputedStyle(list).paddingInlineStart) };
  });
  expect(marker).toBeLessThanOrEqual(gutter);
});

// @req UX-008, NFR-001
test('at 640×400 a long folder name shrinks and Cancel, Theme and Settings stay on screen', async ({
  page,
}) => {
  await mockIpc(page);
  await page.setViewportSize({ width: 640, height: 400 });
  await page.goto('/');
  const root = '/home/user/A rather long folder name for photos';
  await scanUpdate(
    page,
    update({
      root,
      added: [read(`${root}/a.jpg`)],
      counts: { added: 38_911, duplicates: 0, filtered: 0, skipped: 0 },
    }),
  );
  await readUpdate(page, {
    state: 'Running',
    results: [],
    counts: { done: 9_700, total: 38_911, errors: 0, warnings: 0, unsupported: 0 },
    message: null,
  });
  for (const control of [
    page.getByRole('button', { name: 'Cancel' }),
    page.getByRole('button', { name: /^Theme:/ }),
    page.getByRole('button', { name: 'Settings' }),
  ]) {
    const box = await control.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 640, String(box?.x)).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(640);
  // The card's own controls stay inside its border.
  const card = await page.getByRole('region', { name: 'Adding files' }).boundingBox();
  for (const inside of [
    page.getByRole('button', { name: 'Cancel' }),
    page.getByRole('progressbar'),
  ]) {
    const box = await inside.boundingBox();
    expect(card && box && box.x + box.width <= card.x + card.width).toBe(true);
  }
});
