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

// @req FR-010, SEC-004, SEC-006, UX-004
test('reviews staged changes as a plan per file, with skipped files explained', async ({
  page,
}) => {
  await mockIpc(page, [PHOTO, { ...PHOTO, sourceFile: '/home/user/locked.jpg' }]);
  await page.goto('/');
  await addVia(page, 'Files…');
  const metadata = page.getByRole('region', { name: 'Metadata' });
  const editor = page.getByRole('dialog', { name: 'Edit tag' });
  await metadata.getByRole('button', { name: 'Edit IFD0:Make' }).click();
  await editor.getByRole('textbox', { name: 'New value' }).fill('Nikon');
  await editor.getByRole('button', { name: 'Stage change' }).click();
  await addVia(page, 'Files…');
  await page.getByRole('option', { name: /locked.jpg/ }).click();
  await metadata.getByRole('button', { name: 'Edit IFD0:Make' }).click();
  await editor.getByRole('button', { name: 'Delete tag' }).click();

  await page.getByRole('button', { name: /Actions \(2 staged\)/ }).click();
  await page.getByRole('button', { name: 'Review changes…' }).click();
  const review = page.getByRole('dialog', { name: 'Review changes' });
  await expect(review.getByText(/would change/)).toHaveText('1 file would change; 1 skipped.');
  const photo = review.getByRole('region', { name: 'Plan for photo.jpg' });
  await expect(photo.getByRole('listitem')).toHaveText(['IFD0:Make Canon → Nikon']);
  await expect(photo).toContainText('Backup of the original: /home/user/photo.jpg_original');
  await expect(review.getByRole('region', { name: 'Plan for locked.jpg' })).toContainText(
    'Skipped, nothing will change in this file',
  );
  expect(await violations(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(review).toBeHidden();
  await expect(page.getByRole('button', { name: 'Review changes…' })).toBeFocused();
});

// @req FR-011, FR-014, SEC-004, SEC-005, UX-004
test('applies a reviewed plan, with backups unless overwriting is confirmed', async ({ page }) => {
  await mockIpc(page, [PHOTO, { ...PHOTO, sourceFile: '/home/user/locked.jpg' }]);
  await page.goto('/');
  await addVia(page, 'Files…');
  const metadata = page.getByRole('region', { name: 'Metadata' });
  const editor = page.getByRole('dialog', { name: 'Edit tag' });
  await metadata.getByRole('button', { name: 'Edit IFD0:Make' }).click();
  await editor.getByRole('textbox', { name: 'New value' }).fill('Nikon');
  await editor.getByRole('button', { name: 'Stage change' }).click();
  await addVia(page, 'Files…');
  await page.getByRole('option', { name: /locked.jpg/ }).click();
  await metadata.getByRole('button', { name: 'Edit IFD0:Make' }).click();
  await editor.getByRole('button', { name: 'Delete tag' }).click();
  await page.getByRole('button', { name: /Actions \(2 staged\)/ }).click();
  await page.getByRole('button', { name: 'Review changes…' }).click();
  const review = page.getByRole('dialog', { name: 'Review changes' });

  // Unticking backups needs a confirmation whose safe answer has focus.
  await review.getByRole('checkbox', { name: /Keep a backup/ }).uncheck();
  await review.getByRole('button', { name: 'Apply without backups…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Apply without backups?' });
  await expect(confirm.getByRole('button', { name: 'Keep backups' })).toBeFocused();
  expect(await violations(page)).toEqual([]);
  await page.keyboard.press('Enter');
  await expect(review.getByRole('checkbox', { name: /Keep a backup/ })).toBeChecked();

  await review.getByRole('button', { name: 'Apply to 1 file' }).click();
  await expect(review.getByText(/changed,/)).toHaveText('1 changed, 1 skipped.');
  await expect(review.getByRole('region', { name: 'Result for photo.jpg' })).toContainText(
    'Backup of the original: /home/user/photo.jpg_original',
  );
  expect(await violations(page)).toEqual([]);
  await review.getByRole('button', { name: 'Done' }).click();

  // The written file left the staged list; the skipped one stays to be fixed or undone.
  const staged = page.getByRole('region', { name: /Staged for/ });
  await expect(staged).toHaveCount(1);
  await expect(staged).toHaveAccessibleName('Staged for locked.jpg');
  await page.getByRole('button', { name: 'Log' }).click();
  await expect(page.getByRole('log')).toContainText(
    'Changed and verified /home/user/photo.jpg; backup: /home/user/photo.jpg_original',
  );
});

// @req FR-013, SEC-004, UX-004
test('copies tags from the inspected file to other files through review', async ({ page }) => {
  await mockIpc(page, [PHOTO, { ...PHOTO, sourceFile: '/home/user/other.jpg', tags: [] }]);
  await page.goto('/');
  await addVia(page, 'Files…');
  await addVia(page, 'Files…');
  await page.getByRole('option', { name: /photo.jpg/ }).click();
  const metadata = page.getByRole('region', { name: 'Metadata' });
  await metadata.getByRole('button', { name: 'Copy to other files…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Copy tags to other files' });
  await dialog.getByRole('checkbox', { name: 'other.jpg' }).check();
  expect(await violations(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'Stage copy to 1 file' }).click();

  await page.getByRole('button', { name: /Actions \(1 staged\)/ }).click();
  await expect(page.getByRole('region', { name: 'Staged for other.jpg' })).toContainText(
    'Copy from photo.jpg: all metadata',
  );
  await page.getByRole('button', { name: 'Review changes…' }).click();
  const review = page.getByRole('dialog', { name: 'Review changes' });
  const plan = review.getByRole('region', { name: 'Plan for other.jpg' });
  await expect(plan).toContainText('Copy from photo.jpg: all metadata writes 2 tags');
  await plan.getByText('Show the tags').click();
  await expect(plan).toContainText('IFD0:Make = Canon, XMP-dc:Subject = bee, two, words');
  expect(await violations(page)).toEqual([]);
});
