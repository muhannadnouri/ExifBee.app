// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tagsOf } from '../../../tests/support/tags';
import type { FileMetadata } from '../../lib/ipc';
import { RemoveGroupDialog } from './RemoveGroupDialog';

const ipc = vi.hoisted(() => ({ previewRemoval: vi.fn(), cancelRemovalPreview: vi.fn() }));
vi.mock('../../lib/ipc', () => ipc);

HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
  this.open = false;
  this.dispatchEvent(new Event('close'));
};

const file = (sourceFile = '/f/photo.jpg'): FileMetadata => ({
  sourceFile,
  error: null,
  unsupported: false,
  writeAccess: true,
  formatWritable: true,
  warnings: [],
  tags: tagsOf(
    {
      'IFD0:Make': 'Canon',
      'IFD0:Artist': 'Ann',
      'ExifIFD:DateTimeOriginal': '2026:01:02 03:04:05',
      'PNG:ImageWidth': '10',
      'PNG:Title': 'T',
      'System:FileName': 'photo.jpg',
    },
    {
      'IFD0:Make': ['EXIF', 'writable'],
      'IFD0:Artist': ['EXIF', 'writable'],
      'ExifIFD:DateTimeOriginal': ['EXIF', 'writable'],
      'PNG:ImageWidth': ['PNG', 'readOnly'],
      'PNG:Title': ['PNG', 'writable'],
    },
  ),
});
/** What the dry run reports: the named tags of `metadata`. */
const removes = (metadata: FileMetadata, keys: string[], messages: string[] = []) => ({
  removed: metadata.tags.filter((tag) => keys.includes(tag.key)),
  messages,
});

function open(group: string, metadata = file()) {
  const onStage = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <RemoveGroupDialog
      fileId="f1"
      file={metadata}
      group={group}
      onStage={onStage}
      onClose={onClose}
    />,
  );
  return { onStage, onClose, view, dialog: within(screen.getByRole('dialog')) };
}
const stage = () => screen.getByRole('button', { name: /^Stage removal/ }) as HTMLButtonElement;

beforeEach(() => {
  ipc.previewRemoval.mockReset();
  ipc.cancelRemovalPreview.mockReset().mockResolvedValue(true);
});
afterEach(cleanup);

// @req FR-009, UX-006, SEC-005
describe('remove group', () => {
  it('lists exactly what the dry run removes, including groups stored inside, and stages it', async () => {
    const user = userEvent.setup();
    ipc.previewRemoval.mockResolvedValue(
      removes(file(), ['IFD0:Make', 'IFD0:Artist', 'ExifIFD:DateTimeOriginal']),
    );
    const { onStage, dialog } = open('IFD0');
    expect(dialog.getByText(/Your file is not changed/)).toBeTruthy();
    expect(stage().disabled).toBe(true);
    await dialog.findByText(/Removes/);
    expect(ipc.previewRemoval).toHaveBeenCalledWith('f1', 'IFD0');
    const list = dialog.getByRole('list', { name: 'Tags that would be removed' });
    expect(list.textContent).toBe('IFD0 (2) Make, ArtistExifIFD (1) DateTimeOriginal');
    expect(dialog.getByText(/Also removes ExifIFD, because it is stored inside IFD0/)).toBeTruthy();
    expect(dialog.getByText(/photo.jpg_original/)).toBeTruthy();
    await user.click(stage());
    expect(onStage).toHaveBeenCalledWith(
      {
        kind: 'deleteGroup',
        group: 'IFD0',
        removed: ['IFD0:Make', 'IFD0:Artist', 'ExifIFD:DateTimeOriginal'],
      },
      null,
    );
  });

  it('says which tags stay because ExifTool cannot remove them', async () => {
    ipc.previewRemoval.mockResolvedValue(removes(file(), ['PNG:Title']));
    const { dialog } = open('PNG');
    expect(await dialog.findByText(/1 tag stays: ExifTool cannot remove it/)).toBeTruthy();
    expect(dialog.queryByText(/Also removes/)).toBeNull();
  });

  it('asks for an explicit acknowledgement before staging all-metadata removal', async () => {
    const user = userEvent.setup();
    ipc.previewRemoval.mockResolvedValue(removes(file(), ['IFD0:Make', 'PNG:Title']));
    const { onStage, dialog } = open('All');
    await dialog.findByText(/Removes/);
    expect(stage().disabled).toBe(true);
    await user.click(
      dialog.getByRole('checkbox', { name: /I understand this removes all metadata/ }),
    );
    expect(stage().disabled).toBe(false);
    await user.click(stage());
    expect(onStage.mock.calls[0]?.[0]).toMatchObject({ kind: 'deleteGroup', group: 'All' });
  });

  it('offers nothing to stage when there is nothing to remove, with ExifTool’s reason', async () => {
    ipc.previewRemoval.mockResolvedValue({ removed: [], messages: ["Can't write ZIP files"] });
    const { dialog } = open('All', file('/f/archive.zip'));
    expect(await dialog.findByText(/Nothing to remove.*Can't write ZIP files/)).toBeTruthy();
    expect(stage().disabled).toBe(true);
  });

  it('refuses a file this user may not change without trying anything', () => {
    const { dialog } = open('IFD0', { ...file(), writeAccess: false });
    expect(dialog.getByText(/do not have permission to change this file/)).toBeTruthy();
    expect(ipc.previewRemoval).not.toHaveBeenCalled();
    expect(stage().disabled).toBe(true);
  });

  it('warns that removed PDF values stay recoverable inside the file', async () => {
    const pdf = file('/f/report.pdf');
    ipc.previewRemoval.mockResolvedValue(removes(pdf, ['IFD0:Artist']));
    const { dialog } = open('IFD0', pdf);
    expect(await dialog.findByText(/can still be recovered from the file/)).toBeTruthy();
  });

  it('stops the dry run when closed before it finishes, and only then', async () => {
    ipc.previewRemoval.mockReturnValue(new Promise(() => undefined));
    open('XMP').view.unmount();
    expect(ipc.cancelRemovalPreview).toHaveBeenCalledOnce();
    ipc.previewRemoval.mockResolvedValue(removes(file(), ['IFD0:Make']));
    const { view, dialog } = open('IFD0');
    await dialog.findByText(/Removes/);
    view.unmount();
    expect(ipc.cancelRemovalPreview).toHaveBeenCalledOnce();
  });
});
