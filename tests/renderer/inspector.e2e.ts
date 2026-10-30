import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { addVia, expectRowHeaders, mockIpc } from './mockIpc';
import type { MockRead } from './mockIpc';
import { tagsOf } from '../support/tags';

// A file with thousands of tags (MakerNotes-heavy raw files reach a few thousand), where the same
// tag names repeat across groups and some are read-only.
const GROUPS = ['IFD0', 'ExifIFD', 'XMP-dc', 'XMP-tiff', 'MakerNotes', 'Composite'];
const FAMILY: Record<string, string> = {
  IFD0: 'EXIF',
  ExifIFD: 'EXIF',
  'XMP-dc': 'XMP',
  'XMP-tiff': 'XMP',
  MakerNotes: 'MakerNotes',
  Composite: 'Composite',
};
const plain: Record<string, string> = {};
const capabilities: Record<string, [string, 'writable' | 'readOnly']> = {};
for (let i = 0; i < 3_000; i++) {
  const group = GROUPS[i % GROUPS.length] ?? 'IFD0';
  const key = `${group}:Tag${Math.floor(i / GROUPS.length)}`;
  plain[key] = `value ${i}`;
  capabilities[key] = [FAMILY[group] ?? 'Other', group === 'Composite' ? 'readOnly' : 'writable'];
}
plain['IFD0:Make'] = 'Canon';
plain['XMP-tiff:Make'] = 'Canon (XMP)';
capabilities['IFD0:Make'] = ['EXIF', 'writable'];
capabilities['XMP-tiff:Make'] = ['XMP', 'writable'];
const BIG: MockRead = {
  sourceFile: '/home/user/raw/big.cr3',
  error: null,
  warnings: [],
  tags: tagsOf(plain, capabilities),
};

// @req FR-006, UX-006, NFR-001
test('a group-qualified value is found among 3,000 tags without the window stalling', async ({
  page,
}) => {
  await mockIpc(page, [BIG]);
  await page.goto('/');
  await page.evaluate(() => {
    const longest = { ms: 0 };
    Object.assign(window, { __longestTask: longest });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longest.ms = Math.max(longest.ms, entry.duration);
    }).observe({ type: 'longtask', buffered: false });
  });
  await addVia(page, 'Files…');
  const metadata = page.getByRole('region', { name: 'Metadata' });
  await expect(metadata).toContainText('3,002 tags');
  const opened = await page.evaluate(
    () => (window as unknown as { __longestTask: { ms: number } }).__longestTask.ms,
  );

  await page.evaluate(
    () => ((window as unknown as { __longestTask: { ms: number } }).__longestTask.ms = 0),
  );
  await page.keyboard.press('Control+f');
  await page.keyboard.type('xmp-tiff:make');
  await expectRowHeaders(page, ['XMP-tiff:Make']);
  await expect(metadata).toContainText('Canon (XMP)');
  const typing = await page.evaluate(
    () => (window as unknown as { __longestTask: { ms: number } }).__longestTask.ms,
  );
  // Opening renders every row (one long task, ~0.3 s here); virtualizing the tag table is
  // S3-T05. Searching afterwards must not stall.
  console.log(`3,000 tags: opening ${opened} ms, longest task while searching ${typing} ms`);

  // Same name in two groups: ":make" (any group, tag Make) finds both, told apart by group.
  // A bare "make" also matches the MakerNotes group, as it should.
  await page.getByRole('searchbox', { name: 'Find tags' }).fill(':make');
  await expectRowHeaders(page, ['IFD0:Make', 'XMP-tiff:Make']);
  // Read-only tags are one choice away.
  await page.getByRole('searchbox', { name: 'Find tags' }).fill('');
  await page.getByRole('combobox', { name: 'Show' }).selectOption('readOnly');
  await expect(metadata).toContainText('500 of 3,002 tags');
  expect(typing).toBeLessThan(250);
});

// @req UX-004, UX-006
test('the inspector with a scoped, sorted and filtered table has no WCAG A/AA violations', async ({
  page,
}) => {
  await mockIpc(page, [BIG]);
  await page.goto('/');
  await addVia(page, 'Files…');
  const metadata = page.getByRole('region', { name: 'Metadata' });
  await metadata.getByRole('button', { name: /^XMP/ }).first().click();
  await metadata.getByRole('button', { name: 'Tag', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Find tags' }).fill('tag1');
  await expect(metadata.getByRole('columnheader', { name: /Tag/ })).toHaveAttribute(
    'aria-sort',
    'ascending',
  );
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(violations.map((violation) => violation.id)).toEqual([]);
});
