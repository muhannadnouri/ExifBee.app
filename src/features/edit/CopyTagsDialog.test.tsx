// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tagsOf } from '../../../tests/support/tags';
import type { FileMetadata, ImportedFile } from '../../lib/ipc';
import { CopyTagsDialog } from './CopyTagsDialog';

HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
  this.open = false;
  this.dispatchEvent(new Event('close'));
};

const source: FileMetadata = {
  sourceFile: '/p/source.jpg',
  error: null,
  unsupported: false,
  writeAccess: true,
  formatWritable: true,
  warnings: [],
  tags: tagsOf(
    {
      'IFD0:Make': 'Canon',
      'XMP-dc:Title': 'T',
      'XMP-dc:Subject': ['a'],
      'System:FileName': 'source.jpg',
      'File:FileType': 'JPEG',
    },
    {
      'IFD0:Make': ['EXIF', 'writable'],
      'XMP-dc:Title': ['XMP', 'writable'],
      'XMP-dc:Subject': ['XMP', 'writable'],
      'System:FileName': ['File', 'writable'],
      'File:FileType': ['File', 'readOnly'],
    },
  ),
};
const file = (id: string, name: string): ImportedFile => ({ id, name, path: `/p/${name}` });
const files = [
  file('f1', 'source.jpg'),
  file('f2', 'a.png'),
  file('f3', 'b.pdf'),
  ...Array.from({ length: 250 }, (_, index) => file(`m${index}`, `many-${index}.jpg`)),
];

function open(shown = source.tags, group?: string) {
  const onStage = vi.fn();
  render(
    <CopyTagsDialog
      sourceId="f1"
      source={source}
      files={files}
      shown={shown}
      group={group}
      onStage={onStage}
      onClose={() => undefined}
    />,
  );
  return {
    onStage,
    dialog: within(screen.getByRole('dialog', { name: 'Copy tags to other files' })),
  };
}
const stage = () => screen.getByRole('button', { name: /^Stage copy/ }) as HTMLButtonElement;

afterEach(cleanup);

// @req FR-013, SEC-006, UX-008
describe('copy tags dialog', () => {
  it('stages all metadata to the chosen files, never offering the source itself', async () => {
    const user = userEvent.setup();
    const { onStage, dialog } = open();
    const list = within(dialog.getByRole('list', { name: 'Files to copy to' }));
    expect(list.queryByRole('checkbox', { name: 'source.jpg' })).toBeNull();
    expect(stage().disabled).toBe(true);
    await user.click(list.getByRole('checkbox', { name: 'a.png' }));
    await user.click(list.getByRole('checkbox', { name: 'b.pdf' }));
    await user.click(stage());
    expect(onStage).toHaveBeenCalledWith(['f2', 'f3'], {
      kind: 'copyTags',
      source: 'f1',
      what: { kind: 'all' },
      sourceName: 'source.jpg',
    });
  });

  it('offers the tree’s group first, and only groups that can be copied', async () => {
    const user = userEvent.setup();
    const { onStage, dialog } = open(source.tags, 'XMP-dc');
    expect((dialog.getByRole('radio', { name: 'One group' }) as HTMLInputElement).checked).toBe(
      true,
    );
    const groups = [
      ...dialog.getByRole('combobox', { name: 'Group to copy' }).querySelectorAll('option'),
    ];
    expect(groups.map((option) => option.textContent)).toEqual(['EXIF', 'IFD0', 'XMP', 'XMP-dc']);
    await user.click(dialog.getByRole('checkbox', { name: 'a.png' }));
    await user.click(stage());
    expect(onStage.mock.calls[0]?.[1].what).toEqual({ kind: 'group', group: 'XMP-dc' });
  });

  it('copies exactly the tags the table shows, leaving out what cannot be copied', async () => {
    const user = userEvent.setup();
    const shown = source.tags.filter((tag) => ['IFD0:Make', 'System:FileName'].includes(tag.key));
    const { onStage, dialog } = open(shown);
    await user.click(dialog.getByRole('radio', { name: 'The tag shown in the table' }));
    await user.click(dialog.getByRole('checkbox', { name: 'a.png' }));
    await user.click(stage());
    expect(onStage.mock.calls[0]?.[1].what).toEqual({
      kind: 'tags',
      tags: [{ group: 'IFD0', name: 'Make' }],
    });
  });

  it('keeps long file lists fast: shows 200 at a time, selects every match', async () => {
    const user = userEvent.setup();
    const { onStage, dialog } = open();
    expect(dialog.getAllByRole('checkbox')).toHaveLength(200);
    expect(dialog.getByText('Showing 200 of 252; type to narrow.')).toBeTruthy();
    await user.type(dialog.getByRole('searchbox', { name: 'Find files' }), 'many-24');
    // many-24 and many-240…249
    await user.click(dialog.getByRole('button', { name: 'Select all 11 matching' }));
    expect(dialog.getByRole('status').textContent).toBe('11 chosen');
    await user.click(stage());
    expect(onStage.mock.calls[0]?.[0]).toHaveLength(11);
  });
});
