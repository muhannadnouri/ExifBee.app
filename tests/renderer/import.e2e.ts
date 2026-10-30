import { expect, test } from '@playwright/test';
import { dropFiles, mockIpc } from './mockIpc';
import type { MockRead } from './mockIpc';
import { tagsOf } from '../support/tags';

const read = (sourceFile: string, fileType: string | null): MockRead => ({
  sourceFile,
  error: fileType ? null : 'Unknown file type',
  warnings: [],
  tags: tagsOf(fileType ? { 'File:FileType': fileType } : {}),
});

// Hostile names as the Rust registry would hand them over (real reads: tests/file_import.rs).
const DROPPED = [
  read('/home/user/-leading-hyphen.jpg', 'JPEG'),
  read('/home/user/مرحبا "quoted" report.pdf', 'PDF'),
  read("/home/user/it's a 🐝 movie.MP4", 'MP4'),
  read('/home/user/--archive; $(echo x).zip', 'ZIP'),
  read('/home/user/-dir with spaces/unknown', null),
];

// @req FR-003, NFR-005
test('dropped JPEG, PDF, MP4, ZIP and unknown files are listed and inspected by ID', async ({
  page,
}) => {
  await mockIpc(page, []);
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Files' })).toContainText('drop files');

  await dropFiles(
    page,
    DROPPED,
    ['/home/user/old.jpg'],
    [{ path: '/home/user/Pictures', reason: 'folders cannot be added yet' }],
  );
  const files = page.getByRole('region', { name: 'Files' });
  await expect(files.getByRole('option')).toHaveText([
    '-leading-hyphen.jpg',
    'مرحبا "quoted" report.pdf',
    "it's a 🐝 movie.MP4",
    '--archive; $(echo x).zip',
    'unknown',
  ]);
  await expect(files.getByRole('status')).toContainText(
    'Skipped 1 file already in the list. 1 item was not added.',
  );
  const metadata = page.getByRole('region', { name: 'Metadata' });
  await expect(metadata.locator('caption')).toHaveText('/home/user/-leading-hyphen.jpg');

  for (const { sourceFile } of DROPPED.slice(1)) {
    await files.getByTitle(sourceFile, { exact: true }).click();
    await expect(metadata.locator('caption')).toHaveText(sourceFile);
  }
  await expect(metadata.getByRole('alert')).toHaveText('ExifTool error: Unknown file type');

  await page.getByRole('button', { name: /Log/ }).click();
  await expect(page.getByRole('log')).toContainText(
    'Not added: /home/user/Pictures: folders cannot be added yet',
  );
});
