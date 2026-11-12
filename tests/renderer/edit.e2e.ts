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

// @req FR-009, SEC-005, UX-006, UX-004
test('deletes a tag, removes a group or all metadata, and asks before discarding', async ({
  page,
}) => {
  await mockIpc(page, [PHOTO]);
  await page.goto('/');
  await addVia(page, 'Files…');
  const metadata = page.getByRole('region', { name: 'Metadata' });

  // Delete one tag from its editor; the destructive button stands apart from Stage.
  await metadata.getByRole('button', { name: 'Edit IFD0:Make' }).click();
  await page
    .getByRole('dialog', { name: 'Edit tag' })
    .getByRole('button', { name: 'Delete tag' })
    .click();

  // Remove a group chosen in the tree, by keyboard through the menu.
  await metadata
    .getByRole('navigation', { name: 'Tag groups' })
    .getByRole('button', { name: /XMP-dc/ })
    .click();
  const remove = metadata
    .getByRole('group', { name: 'Change metadata' })
    .getByRole('button', { name: 'Remove' });
  await remove.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Remove XMP-dc group…' })).toBeFocused();
  await page.keyboard.press('Enter');
  const group = page.getByRole('dialog', { name: 'Remove XMP-dc group' });
  await expect(group.getByRole('list', { name: 'Tags that would be removed' })).toHaveText(
    'XMP-dc (1) Subject',
  );
  expect(await violations(page)).toEqual([]);
  await group.getByRole('button', { name: 'Stage removal of 1 tag' }).click();

  // All metadata is high impact: staging needs an explicit acknowledgement.
  await remove.click();
  await page.getByRole('menuitem', { name: 'Remove all metadata…' }).click();
  const all = page.getByRole('dialog', { name: 'Remove all metadata' });
  const stageAll = all.getByRole('button', { name: 'Stage removal of 2 tags' });
  await expect(stageAll).toBeDisabled();
  await all.getByRole('checkbox', { name: /I understand/ }).check();
  expect(await violations(page)).toEqual([]);
  await stageAll.click();

  await page.getByRole('button', { name: /Actions \(3 staged\)/ }).click();
  const staged = page.getByRole('region', { name: 'Staged for photo.jpg' });
  await expect(staged.getByRole('listitem')).toHaveText([
    'IFD0:Make Canon → (removed)Undo',
    'XMP-dc group removes 1 tagUndo',
    'All metadata High impact removes 2 tagsUndo',
  ]);
  expect(await violations(page)).toEqual([]);

  await page.getByRole('button', { name: 'Discard all' }).click();
  const confirm = page.getByRole('dialog', { name: 'Discard all staged changes?' });
  await expect(confirm.getByRole('button', { name: 'Keep changes' })).toBeFocused();
  expect(await violations(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(staged.getByRole('listitem')).toHaveCount(3);
  await page.getByRole('button', { name: 'Discard all' }).click();
  await confirm.getByRole('button', { name: 'Discard 3 changes' }).click();
  await expect(page.getByText(/No staged changes/)).toBeVisible();
});
