// Filter, sort and group-tree timings on 1,000 and 10,000 tags (S3-T06), using the app's own
// tagFilter module (Node 24 strips the TypeScript types). Writes <out>/filter.json.
// Usage: node tests/performance/filter.bench.mjs <out-dir>
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { filterTags, groupTree, sortTags } from '../../src/features/metadata/tagFilter.ts';
import { tagsOf } from '../support/tags.ts';

const GROUPS = ['IFD0', 'ExifIFD', 'XMP-dc', 'XMP-tiff', 'MakerNotes', 'Composite', 'QuickTime'];

function tags(count) {
  const plain = {};
  const capabilities = {};
  for (let i = 0; i < count; i++) {
    const group = GROUPS[i % GROUPS.length];
    const key = `${group}:Tag${i}`;
    plain[key] =
      i % 9 === 0
        ? [`keyword ${i}`, 'bee', 'fixture']
        : i % 13 === 0
          ? { City: `City ${i}` }
          : `value ${i}`;
    capabilities[key] = [group.startsWith('XMP') ? 'XMP' : 'EXIF', i % 4 ? 'writable' : 'readOnly'];
  }
  return tagsOf(plain, capabilities);
}

/** Runs `work` 3 times to warm up, then `runs` timed times; returns the samples in ms. */
function time(work, runs = 25) {
  for (let i = 0; i < 3; i++) work();
  return Array.from({ length: runs }, () => {
    const started = performance.now();
    work();
    return Math.round((performance.now() - started) * 1000) / 1000;
  });
}

const samplesMs = {};
for (const [label, count] of [
  ['1k', 1_000],
  ['10k', 10_000],
]) {
  const list = tags(count);
  const all = { text: '', scope: null, writable: 'all' };
  samplesMs[`filterText${label}`] = time(() => filterTags(list, { ...all, text: 'bee' }));
  samplesMs[`filterScoped${label}`] = time(() =>
    filterTags(list, {
      text: 'tag1',
      scope: { family: 'XMP', group: 'XMP-dc' },
      writable: 'writable',
    }),
  );
  samplesMs[`sortValue${label}`] = time(() => sortTags(list, { key: 'value', descending: false }));
  samplesMs[`groupTree${label}`] = time(() => groupTree(list));
}

const out = process.argv[2];
if (!out) {
  console.error('usage: filter.bench.mjs <out-dir>');
  process.exit(2);
}
writeFileSync(join(out, 'filter.json'), JSON.stringify({ scenario: 'filter', samplesMs }, null, 2));
