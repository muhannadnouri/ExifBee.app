// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tagsOf } from '../../../tests/support/tags';
import type { FileMetadata, TagEntry } from '../../lib/ipc';
import { TagEditorDialog } from './TagEditorDialog';

const ipc = vi.hoisted(() => ({ rawTextIsUtf8: vi.fn(), searchTags: vi.fn() }));
vi.mock('../../lib/ipc', () => ipc);

// jsdom has no modal <dialog>; enough of it for open/close and the close event.
HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
  this.open = false;
  this.dispatchEvent(new Event('close'));
};

const file = (formatWritable: boolean | null = true): FileMetadata => ({
  sourceFile: '/f/photo.jpg',
  error: null,
  unsupported: false,
  writeAccess: true,
  formatWritable,
  warnings: [],
  tags: tagsOf(
    {
      'IFD0:Make': 'Canon',
      'IFD0:Model': 'EOS',
      'XMP-dc:Subject': ['bee', 'two, words'],
      'XMP-iptcCore:CreatorContactInfo': { CiAdrCity: 'Town' },
      'Composite:ImageSize': '10x2',
      'System:FileName': 'photo.jpg',
      'Odd:Thing': 'v',
      'MakerNotes:Copy1:Lens': 'A',
      'MakerNotes:Copy2:Lens': 'B',
    },
    {
      'IFD0:Make': ['EXIF', 'writable'],
      'IFD0:Model': ['EXIF', 'writable'],
      'XMP-dc:Subject': ['XMP', 'writable'],
      'XMP-iptcCore:CreatorContactInfo': ['XMP', 'writable'],
      'Composite:ImageSize': ['Composite', 'readOnly'],
      'System:FileName': ['File', 'writable'],
      'MakerNotes:Copy1:Lens': ['MakerNotes', 'writable'],
      'MakerNotes:Copy2:Lens': ['MakerNotes', 'writable'],
    },
  ),
});
const tag = (metadata: FileMetadata, key: string) =>
  metadata.tags.find((candidate) => candidate.key === key) as TagEntry;

function open(key: string | null, metadata = file()) {
  const onStage = vi.fn();
  const onClose = vi.fn();
  render(
    <TagEditorDialog
      fileId="f1"
      file={metadata}
      tag={key ? tag(metadata, key) : null}
      onStage={onStage}
      onClose={onClose}
    />,
  );
  return { onStage, onClose, dialog: within(screen.getByRole('dialog')) };
}
const stageButton = () => screen.getByRole('button', { name: 'Stage change' }) as HTMLButtonElement;

beforeEach(() => {
  ipc.rawTextIsUtf8.mockReset().mockResolvedValue(true);
  ipc.searchTags.mockReset().mockResolvedValue({ total: 0, tags: [] });
});
afterEach(cleanup);

// @req FR-008, UX-006, TST-003
describe('tag editor', () => {
  it('stages a new text value for a writable tag, with the value it replaces', async () => {
    const user = userEvent.setup();
    const { onStage, onClose, dialog } = open('IFD0:Make');
    await vi.waitFor(() => expect(ipc.rawTextIsUtf8).toHaveBeenCalledWith('f1', 'IFD0', 'Make'));
    // Unchanged: nothing to stage.
    await vi.waitFor(() => expect(dialog.getByRole('textbox', { name: 'New value' })).toBeTruthy());
    expect(stageButton().disabled).toBe(true);
    await user.clear(dialog.getByRole('textbox', { name: 'New value' }));
    await user.type(dialog.getByRole('textbox', { name: 'New value' }), 'x<FileName');
    await user.click(stageButton());
    expect(onStage).toHaveBeenCalledWith(
      { kind: 'set', group: 'IFD0', name: 'Make', value: { kind: 'text', text: 'x<FileName' } },
      'Canon',
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('allows an empty value, which is written as empty rather than deleting the tag', async () => {
    const user = userEvent.setup();
    const { onStage, dialog } = open('IFD0:Model');
    await vi.waitFor(() => expect(stageButton()).toBeTruthy());
    await user.clear(dialog.getByRole('textbox', { name: 'New value' }));
    await vi.waitFor(() => expect(stageButton().disabled).toBe(false));
    await user.click(stageButton());
    expect(onStage.mock.calls[0]?.[0].value).toEqual({ kind: 'text', text: '' });
  });

  it('edits a list item by item: a comma stays inside its item, and empty items are refused', async () => {
    const user = userEvent.setup();
    const { onStage, dialog } = open('XMP-dc:Subject');
    const item = (n: number) => dialog.getByRole('textbox', { name: `Item ${n}` });
    await vi.waitFor(() => expect(item(2)).toBeTruthy());
    expect((item(2) as HTMLInputElement).value).toBe('two, words');
    await user.click(dialog.getByRole('button', { name: 'Add item' }));
    expect(stageButton().disabled).toBe(true);
    expect(dialog.getByText('Every item needs a value.')).toBeTruthy();
    await user.type(item(3), 'ñ 🐝');
    await user.click(dialog.getByRole('button', { name: 'Move item 3 up' }));
    await user.click(dialog.getByRole('button', { name: 'Remove item 1' }));
    await vi.waitFor(() => expect(stageButton().disabled).toBe(false));
    await user.click(stageButton());
    expect(onStage.mock.calls[0]?.[0].value).toEqual({
      kind: 'list',
      items: ['ñ 🐝', 'two, words'],
    });
  });

  it('explains why a tag cannot be edited and offers nothing to stage', async () => {
    for (const [key, reason] of [
      ['Composite:ImageSize', 'not writable through the selected ExifTool version'],
      ['System:FileName', 'File system properties'],
      ['XMP-iptcCore:CreatorContactInfo', 'Structures and binary data need dedicated operations'],
      ['MakerNotes:Copy1:Lens', 'ExifTool cannot change one of them on its own'],
    ] as const) {
      const { dialog } = open(key);
      expect(dialog.getByText(new RegExp(reason))).toBeTruthy();
      expect(dialog.queryByRole('textbox')).toBeNull();
      expect(stageButton().disabled).toBe(true);
      cleanup();
    }
  });

  it('refuses to start from shown text when the stored bytes are not text', async () => {
    ipc.rawTextIsUtf8.mockResolvedValue(false);
    const { dialog } = open('IFD0:Make');
    expect(await dialog.findByText(/what is shown is not what is stored/)).toBeTruthy();
    expect(dialog.queryByRole('textbox')).toBeNull();
    expect(stageButton().disabled).toBe(true);
  });

  it('warns, but allows staging, when write support is unknown', async () => {
    const user = userEvent.setup();
    const { onStage, dialog } = open('Odd:Thing');
    expect(dialog.getByText(/Write support could not be confirmed/)).toBeTruthy();
    await vi.waitFor(() => expect(dialog.getByRole('textbox', { name: 'New value' })).toBeTruthy());
    await user.type(dialog.getByRole('textbox', { name: 'New value' }), '2');
    await vi.waitFor(() => expect(stageButton().disabled).toBe(false));
    await user.click(stageButton());
    expect(onStage).toHaveBeenCalledOnce();
  });
});

// @req FR-009, SEC-005, UX-006
describe('delete tag', () => {
  const deleteButton = () => screen.queryByRole('button', { name: 'Delete tag' });

  it('stages the deletion of one tag with the value it removes', async () => {
    const user = userEvent.setup();
    const { onStage, onClose } = open('IFD0:Make');
    await user.click(deleteButton() as HTMLElement);
    expect(onStage).toHaveBeenCalledWith(
      { kind: 'deleteTag', group: 'IFD0', name: 'Make' },
      'Canon',
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('deletes a structure it cannot edit, but never a tag it cannot change', async () => {
    const { dialog } = open('XMP-iptcCore:CreatorContactInfo');
    expect(dialog.getByText(/The tag can still be deleted/)).toBeTruthy();
    expect(deleteButton()).toBeTruthy();
    expect(stageButton().disabled).toBe(true);
    cleanup();
    for (const key of ['Composite:ImageSize', 'System:FileName', 'MakerNotes:Copy1:Lens']) {
      open(key);
      expect(deleteButton()).toBeNull();
      cleanup();
    }
    open(null);
    expect(deleteButton()).toBeNull();
  });

  it('refuses edits and deletions on a file this user may not change', () => {
    const { dialog } = open('IFD0:Make', { ...file(), writeAccess: false });
    expect(dialog.getByText(/do not have permission to change this file/)).toBeTruthy();
    expect(deleteButton()).toBeNull();
    expect(stageButton().disabled).toBe(true);
  });
});

// @req FR-008, FR-007, UX-006
describe('add tag', () => {
  const listed = (group1: string, name: string) => ({
    group1,
    name,
    group0: 'XMP',
    writable: true,
  });

  it('searches ExifTool’s writable tags, then stages a new list value for the one picked', async () => {
    const user = userEvent.setup();
    ipc.searchTags.mockImplementation(async (query: string) => ({
      total: 2,
      tags: query
        ? [listed('XMP-dc', 'Creator')]
        : [listed('XMP-dc', 'Creator'), listed('XMP-dc', 'Rights')],
    }));
    const { onStage, dialog } = open(null);
    await user.type(dialog.getByRole('searchbox', { name: 'Find a writable tag' }), 'creator');
    await vi.waitFor(() => expect(ipc.searchTags).toHaveBeenLastCalledWith('creator'));
    await user.click(await dialog.findByRole('button', { name: /^XMP-dc:Creator/ }));
    await user.click(dialog.getByRole('radio', { name: 'A list of values' }));
    await user.type(dialog.getByRole('textbox', { name: 'Item 1' }), 'Ann');
    await user.click(stageButton());
    expect(onStage).toHaveBeenCalledWith(
      { kind: 'set', group: 'XMP-dc', name: 'Creator', value: { kind: 'list', items: ['Ann'] } },
      null,
    );
  });

  it('edits instead of duplicating a tag the file already has, and refuses a read-only format', async () => {
    const user = userEvent.setup();
    ipc.searchTags.mockResolvedValue({ total: 1, tags: [listed('IFD0', 'Make')] });
    const { dialog } = open(null);
    await user.click(await dialog.findByRole('button', { name: /^IFD0:Make/ }));
    await vi.waitFor(() =>
      expect(
        (dialog.getByRole('textbox', { name: 'New value' }) as HTMLTextAreaElement).value,
      ).toBe('Canon'),
    );
    cleanup();

    const { dialog: other } = open(null, file(false));
    await user.click(await other.findByRole('button', { name: /^IFD0:Make/ }));
    cleanup();
    ipc.searchTags.mockResolvedValue({ total: 1, tags: [listed('XMP-dc', 'Rights')] });
    const { dialog: third } = open(null, file(false));
    await user.click(await third.findByRole('button', { name: /^XMP-dc:Rights/ }));
    expect(third.getByText(/not writable through the selected ExifTool version/)).toBeTruthy();
    expect(stageButton().disabled).toBe(true);
  });
});
