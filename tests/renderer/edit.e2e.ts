import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { addVia, mockIpc } from './mockIpc';
import { tagsOf } from '../support/tags';

const PHOTO = {
  sourceFile: '/home/user/photo.jpg',
  error: null,
  warnings: [],
  tags: tagsOf(
    {
      'IFD0:Make': 'Canon',
      'XMP-dc:Subject': ['bee', 'two, words'],
      'Composite:ImageSize': '10x2',
    },
    {
      'IFD0:Make': ['EXIF', 'writable'],
      'XMP-dc:Subject': ['XMP', 'writable'],
      'Composite:ImageSize': ['Composite', 'readOnly'],
    },
  ),
};
const violations = async (page: Page) =>
  (
    await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze()
  ).violations.map((violation) => violation.id);

// @req FR-008, UX-006, UX-004
test('edits and adds tags into a staged list that can be undone, with nothing written', async ({
  page,
}) => {
  await mockIpc(page, [PHOTO]);
  await page.goto('/');
  await addVia(page, 'Files…');
  const metadata = page.getByRole('region', { name: 'Metadata' });

  // A read-only tag explains itself instead of offering a change.
  await metadata.getByRole('button', { name: 'Edit Composite:ImageSize' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit tag' });
  await expect(editor).toContainText('not writable through the selected ExifTool version');
  await expect(editor.getByRole('button', { name: 'Stage change' })).toBeDisabled();
  expect(await violations(page)).toEqual([]);
  await editor.getByRole('button', { name: 'Cancel' }).click();

  // A text value, then a list edited item by item.
  await metadata.getByRole('button', { name: 'Edit IFD0:Make' }).click();
  await editor.getByRole('textbox', { name: 'New value' }).fill('Nikon');
  await editor.getByRole('button', { name: 'Stage change' }).click();
  await metadata.getByRole('button', { name: 'Edit XMP-dc:Subject' }).click();
  await editor.getByRole('button', { name: 'Add item' }).click();
  await editor.getByRole('textbox', { name: 'Item 3' }).fill('ñ 🐝');
  expect(await violations(page)).toEqual([]);
  await editor.getByRole('button', { name: 'Stage change' }).click();

  // Add tag: search ExifTool's writable tags and stage a new one.
  await metadata.getByRole('button', { name: 'Add tag…' }).click();
  const adder = page.getByRole('dialog', { name: 'Add tag' });
  await adder.getByRole('button', { name: /^XMP-dc:Creator/ }).click();
  await adder.getByRole('textbox', { name: 'New value' }).fill('Ann');
  await adder.getByRole('button', { name: 'Stage change' }).click();

  await expect(metadata.getByRole('row', { name: /IFD0:Make/ })).toContainText('staged');
  await page.getByRole('button', { name: /Actions \(3 staged\)/ }).click();
  const staged = page.getByRole('region', { name: 'Staged for photo.jpg' });
  await expect(staged.getByRole('listitem')).toHaveText([
    'IFD0:Make Canon → NikonUndo',
    'XMP-dc:Subject bee, two, words → bee, two, words, ñ 🐝Undo',
    'XMP-dc:Creator (new) AnnUndo',
  ]);
  expect(await violations(page)).toEqual([]);
  await staged.getByRole('button', { name: 'Undo XMP-dc:Creator' }).click();
  await expect(staged.getByRole('listitem')).toHaveCount(2);
});
