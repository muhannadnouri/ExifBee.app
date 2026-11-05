import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { addVia, mockIpc, readUpdate, scanUpdate } from '../renderer/mockIpc';
import type { MockRead } from '../renderer/mockIpc';
import { tagsOf } from '../support/tags';

// UI lag and renderer memory at 1,000 and 10,000 entries (S3-T06), in the production build with
// the Tauri bridge mocked. Runs only through `npm run bench:metadata` (EXIFBEE_BENCH set); writes
// <EXIFBEE_BENCH_OUT>/ui.json. Long tasks are main-thread work over 50 ms; input latency is the
// Event Timing API's duration (input → next paint), where events under 16 ms are not reported
// and count as 16 ms (the API's floor).

const RUNS = 3;
const samplesMs: Record<string, number[]> = {};
const sample = (metric: string, ms: number) => (samplesMs[metric] ??= []).push(Math.round(ms));
let heapBytes = 0;

test.afterAll(() => {
  const out = process.env.EXIFBEE_BENCH_OUT;
  if (!out) throw new Error('set EXIFBEE_BENCH_OUT (run through `npm run bench:metadata`)');
  writeFileSync(
    join(out, 'ui.json'),
    JSON.stringify(
      { scenario: 'ui', samplesMs, renderer: { usedJSHeapBytes: heapBytes } },
      null,
      2,
    ),
  );
});

async function watch(page: Page) {
  await page.evaluate(() => {
    const stats = { longest: 0, events: [] as number[], keys: 0 };
    Object.assign(window, { __bench: stats });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        stats.longest = Math.max(stats.longest, entry.duration);
    }).observe({ type: 'longtask', buffered: false });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        if (entry.name === 'keydown') stats.events.push(entry.duration);
    }).observe({
      type: 'event',
      durationThreshold: 16,
      buffered: false,
    } as PerformanceObserverInit);
    document.addEventListener('keydown', () => stats.keys++, true);
  });
}
const stats = (page: Page) =>
  page.evaluate(() => {
    const bench = (
      window as unknown as { __bench: { longest: number; events: number[]; keys: number } }
    ).__bench;
    const result = { ...bench, events: [...bench.events] };
    bench.longest = 0;
    bench.events = [];
    bench.keys = 0;
    return result;
  });
const p95 = (durations: number[], count: number) => {
  // Keys with no reported event were under the 16 ms floor.
  const all = [...durations, ...Array(Math.max(0, count - durations.length)).fill(16)].sort(
    (a, b) => a - b,
  );
  return all[Math.min(all.length - 1, Math.floor(all.length * 0.95))] ?? 16;
};

const read = (sourceFile: string): MockRead => ({
  sourceFile,
  error: null,
  warnings: [],
  tags: [],
});
function bigFile(count: number): MockRead {
  const plain: Record<string, string | string[]> = {};
  for (let i = 0; i < count; i++)
    plain[`G${i % 40}:Tag${String(i).padStart(5, '0')}`] =
      i % 6 === 0 ? [`keyword ${i}`, 'bee', 'fixture'] : `value ${i}`;
  return { sourceFile: `/bench/${count}.bin`, error: null, warnings: [], tags: tagsOf(plain) };
}

for (const [label, count] of [
  ['1k', 1_000],
  ['10k', 10_000],
] as const) {
  test(`file list: ${label} files stream in and stay navigable`, async ({ page }) => {
    for (let run = 0; run < RUNS; run++) {
      await mockIpc(page, []);
      await page.goto('/');
      await watch(page);
      const batch = 500;
      for (let start = 0; start < count; start += batch) {
        const files = Array.from({ length: batch }, (_, i) => read(`/bench/${start + i}.jpg`));
        await scanUpdate(page, {
          scanId: 1,
          root: '/bench',
          state: 'Running',
          added: files,
          problems: [],
          counts: { added: start + batch, duplicates: 0, filtered: 0, skipped: 0 },
        });
        await readUpdate(page, {
          state: 'Running',
          results: files.map((_, i) => ({
            id: `f${start + i + 1}`,
            fileType: 'JPEG',
            error: null,
            unsupported: false,
            warnings: [],
            tagCount: 30,
          })),
          counts: { done: start + batch, total: count, errors: 0, warnings: 0, unsupported: 0 },
          message: null,
        });
      }
      sample(`fileListStreamLongestTask${label}`, (await stats(page)).longest);
      await page.getByRole('listbox', { name: 'Files' }).focus();
      for (let i = 0; i < 20; i++) await page.keyboard.press('PageDown');
      const keys = await stats(page);
      sample(`fileListKeyP95${label}`, p95(keys.events, keys.keys));
    }
  });

  test(`tag table: ${label} tags open, search and scroll`, async ({ page }) => {
    for (let run = 0; run < RUNS; run++) {
      await mockIpc(page, [bigFile(count)]);
      await page.goto('/');
      await watch(page);
      await addVia(page, 'Files…');
      await page.getByRole('searchbox', { name: 'Find tags' }).waitFor();
      sample(`tagTableOpenLongestTask${label}`, (await stats(page)).longest);

      await page.getByRole('searchbox', { name: 'Find tags' }).focus();
      await page.keyboard.type('tag0099', { delay: 30 });
      for (let i = 0; i < 7; i++) await page.keyboard.press('Backspace', { delay: 30 });
      const typing = await stats(page);
      sample(`tagSearchKeyP95${label}`, p95(typing.events, typing.keys));
      sample(`tagSearchLongestTask${label}`, typing.longest);

      const pane = page.locator('.metadata-pane');
      for (let i = 0; i < 30; i++) await pane.evaluate((node) => (node.scrollTop += 600));
      await page.evaluate(() => new Promise(requestAnimationFrame));
      sample(`tagScrollLongestTask${label}`, (await stats(page)).longest);

      if (label === '10k' && run === RUNS - 1)
        heapBytes = await page.evaluate(
          () =>
            (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
              ?.usedJSHeapSize ?? 0,
        );
    }
  });
}
