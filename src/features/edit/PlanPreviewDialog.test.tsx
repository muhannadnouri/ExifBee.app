// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilePlan, StagedFile } from '../../lib/ipc';
import { PlanPreviewDialog } from './PlanPreviewDialog';

const ipc = vi.hoisted(() => ({ planChanges: vi.fn(), cancelRemovalPreview: vi.fn() }));
vi.mock('../../lib/ipc', () => ipc);

HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
  this.open = false;
  this.dispatchEvent(new Event('close'));
};

const staged: StagedFile[] = [
  {
    id: 'f1',
    changes: [{ kind: 'set', group: 'IFD0', name: 'Make', value: { kind: 'text', text: 'Nikon' } }],
  },
];
const ready: FilePlan = {
  id: 'f1',
  name: 'link.jpg',
  target: '/real/photo.jpg',
  link: '/home/user/link.jpg',
  problems: [],
  warnings: ['A backup from an earlier change already exists (/real/photo.jpg_original).'],
  backup: null,
  changes: [
    { target: 'IFD0:Make', before: 'Canon', after: 'Nikon', removes: [] },
    { target: 'IFD0:Artist', before: 'Ann', after: null, removes: [] },
    { target: 'XMP-dc:Creator', before: null, after: 'Bo', removes: [] },
    { target: 'XMP-dc group', before: null, after: null, removes: ['XMP-dc:Title'] },
  ],
};
const skipped: FilePlan = {
  id: 'f2',
  name: 'old.jpg',
  target: '/home/user/old.jpg',
  link: null,
  problems: ['The file changed after it was read; open it again to see its current metadata.'],
  warnings: [],
  backup: null,
  changes: [],
};

beforeEach(() => {
  ipc.planChanges.mockReset();
  ipc.cancelRemovalPreview.mockReset().mockResolvedValue(true);
});
afterEach(cleanup);

// @req FR-010, SEC-004, SEC-006, FR-014
describe('plan preview', () => {
  it('shows each file’s real target, readable diff, warnings and skipped reasons', async () => {
    ipc.planChanges.mockResolvedValue({ files: [ready, { ...skipped }] });
    render(<PlanPreviewDialog files={staged} onClose={() => undefined} />);
    const dialog = within(screen.getByRole('dialog', { name: 'Review changes' }));
    expect(dialog.getByText(/Checking each file/)).toBeTruthy();
    expect(ipc.planChanges).toHaveBeenCalledWith(staged);

    expect((await dialog.findByText(/would change/)).textContent).toBe(
      '1 file would change; 1 skipped.',
    );
    const first = within(dialog.getByRole('region', { name: 'Plan for link.jpg' }));
    expect(first.getByText(/is a link; the real file changes: \/real\/photo.jpg/)).toBeTruthy();
    expect(first.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'IFD0:Make Canon → Nikon',
      'IFD0:Artist Ann → (removed)',
      'XMP-dc:Creator (new) → Bo',
      'XMP-dc group removes 1 tag: XMP-dc:Title',
    ]);
    expect(first.getByText(/backup from an earlier change already exists/)).toBeTruthy();

    const second = within(dialog.getByRole('region', { name: 'Plan for old.jpg' }));
    expect(second.getByText(/Skipped, nothing will change in this file/)).toBeTruthy();
    expect(second.getByText(/changed after it was read/)).toBeTruthy();
    expect(
      dialog.getByText('Nothing has been written. Applying changes is not available yet.'),
    ).toBeTruthy();
    // Applying is not offered before the executor and approval steps exist.
    expect(dialog.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Close',
      'Close',
    ]);
  });

  it('names the backup ExifTool would create', async () => {
    ipc.planChanges.mockResolvedValue({
      files: [{ ...ready, link: null, warnings: [], backup: '/real/photo.jpg_original' }],
    });
    render(<PlanPreviewDialog files={staged} onClose={() => undefined} />);
    expect(
      await screen.findByText('Backup of the original: /real/photo.jpg_original'),
    ).toBeTruthy();
  });

  it('shows why a plan could not be made, and stops checking when closed early', async () => {
    ipc.planChanges.mockRejectedValueOnce({ kind: 'ScopeViolation', message: 'f9 is not a file' });
    render(<PlanPreviewDialog files={staged} onClose={() => undefined} />);
    expect(await screen.findByText('f9 is not a file')).toBeTruthy();
    cleanup();
    expect(ipc.cancelRemovalPreview).not.toHaveBeenCalled();

    ipc.planChanges.mockReturnValue(new Promise(() => undefined));
    render(<PlanPreviewDialog files={staged} onClose={() => undefined} />).unmount();
    expect(ipc.cancelRemovalPreview).toHaveBeenCalledOnce();
  });
});
