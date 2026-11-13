// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplyResult, FilePlan, StagedFile } from '../../lib/ipc';
import { PlanPreviewDialog } from './PlanPreviewDialog';

const ipc = vi.hoisted(() => ({
  planChanges: vi.fn(),
  applyPlan: vi.fn(),
  cancelRemovalPreview: vi.fn(),
}));
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
const noop = () => undefined;
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
    {
      target: 'XMP-dc group',
      before: null,
      after: null,
      removes: ['XMP-dc:Title', 'Google:ImageData', 'Google:ImageData'],
    },
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
  ipc.applyPlan.mockReset();
  ipc.cancelRemovalPreview.mockReset().mockResolvedValue(true);
});
afterEach(cleanup);

// @req FR-010, SEC-004, SEC-006, FR-014
describe('plan preview', () => {
  it('shows each file’s real target, readable diff, warnings and skipped reasons', async () => {
    ipc.planChanges.mockResolvedValue({ planId: 4, files: [ready, { ...skipped }] });
    render(<PlanPreviewDialog files={staged} onApplied={noop} onClose={noop} />);
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
      // Long lists are folded, and repeated tags are counted instead of listed again.
      'XMP-dc group removes 3 tagsShow the tagsXMP-dc:Title, Google:ImageData ×2',
    ]);
    expect(first.getByText(/backup from an earlier change already exists/)).toBeTruthy();

    const second = within(dialog.getByRole('region', { name: 'Plan for old.jpg' }));
    expect(second.getByText(/Skipped, nothing will change in this file/)).toBeTruthy();
    expect(second.getByText(/changed after it was read/)).toBeTruthy();
    // Reviewing writes nothing: applying needs the explicit button.
    expect(ipc.applyPlan).not.toHaveBeenCalled();
    expect(dialog.getByRole('button', { name: 'Apply to 1 file' })).toBeTruthy();
  });

  it('names the backup ExifTool would create', async () => {
    ipc.planChanges.mockResolvedValue({
      files: [{ ...ready, link: null, warnings: [], backup: '/real/photo.jpg_original' }],
    });
    render(<PlanPreviewDialog files={staged} onApplied={noop} onClose={noop} />);
    expect(
      await screen.findByText('Backup of the original: /real/photo.jpg_original'),
    ).toBeTruthy();
  });

  it('shows why a plan could not be made, and stops checking when closed early', async () => {
    ipc.planChanges.mockRejectedValueOnce({ kind: 'ScopeViolation', message: 'f9 is not a file' });
    render(<PlanPreviewDialog files={staged} onApplied={noop} onClose={noop} />);
    expect(await screen.findByText('f9 is not a file')).toBeTruthy();
    cleanup();
    expect(ipc.cancelRemovalPreview).not.toHaveBeenCalled();

    ipc.planChanges.mockReturnValue(new Promise(() => undefined));
    render(<PlanPreviewDialog files={staged} onApplied={noop} onClose={noop} />).unmount();
    expect(ipc.cancelRemovalPreview).toHaveBeenCalledOnce();
  });
});

// @req FR-011, FR-014, SEC-004, SEC-005
describe('apply', () => {
  const result: ApplyResult = {
    files: [
      {
        id: 'f1',
        name: 'link.jpg',
        outcome: 'changed',
        message: null,
        backup: '/real/photo.jpg_original',
        warnings: ['[minor] Fixed something'],
        details: [],
        exitCode: 0,
      },
      {
        id: 'f2',
        name: 'old.jpg',
        outcome: 'skipped',
        message: 'The file changed after it was read.',
        backup: null,
        warnings: [],
        details: [],
        exitCode: 0,
      },
    ],
  };

  it('applies the reviewed plan once with backups by default and reports each file', async () => {
    const user = userEvent.setup();
    const onApplied = vi.fn();
    ipc.planChanges.mockResolvedValue({ planId: 4, files: [ready, skipped] });
    ipc.applyPlan.mockResolvedValue(result);
    render(<PlanPreviewDialog files={staged} onApplied={onApplied} onClose={noop} />);
    const dialog = within(screen.getByRole('dialog', { name: 'Review changes' }));
    const box = (await dialog.findByRole('checkbox', {
      name: 'Keep a backup of each original (recommended)',
    })) as HTMLInputElement;
    expect(box.checked).toBe(true);
    await user.click(dialog.getByRole('button', { name: 'Apply to 1 file' }));
    expect(ipc.applyPlan).toHaveBeenCalledWith(4, 'keepBackups');
    expect((await dialog.findByText(/changed, 1 skipped/)).textContent).toBe(
      '1 changed, 1 skipped.',
    );
    expect(onApplied).toHaveBeenCalledWith(result);
    const done = within(dialog.getByRole('region', { name: 'Result for link.jpg' }));
    expect(done.getByText('Changed and verified')).toBeTruthy();
    expect(done.getByText('Backup of the original: /real/photo.jpg_original')).toBeTruthy();
    expect(done.getByText('ExifTool warning: [minor] Fixed something')).toBeTruthy();
    expect(dialog.getByRole('region', { name: 'Result for old.jpg' }).textContent).toContain(
      'Skipped, the file is as it was: The file changed after it was read.',
    );
    expect(dialog.queryByRole('button', { name: /Apply/ })).toBeNull();
  });

  it('overwrites originals only after unticking backups and confirming', async () => {
    const user = userEvent.setup();
    ipc.planChanges.mockResolvedValue({ planId: 5, files: [ready] });
    ipc.applyPlan.mockResolvedValue(result);
    render(<PlanPreviewDialog files={staged} onApplied={noop} onClose={noop} />);
    await user.click(await screen.findByRole('checkbox', { name: /Keep a backup/ }));
    expect(screen.getByText(/they cannot be restored from a backup/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Apply without backups…' }));
    const confirm = within(screen.getByRole('dialog', { name: 'Apply without backups?' }));
    expect(document.activeElement?.textContent).toBe('Keep backups');
    // The safe answer puts backups back and runs nothing.
    await user.click(confirm.getByRole('button', { name: 'Keep backups' }));
    expect(ipc.applyPlan).not.toHaveBeenCalled();
    expect(
      (screen.getByRole('checkbox', { name: /Keep a backup/ }) as HTMLInputElement).checked,
    ).toBe(true);

    await user.click(screen.getByRole('checkbox', { name: /Keep a backup/ }));
    await user.click(screen.getByRole('button', { name: 'Apply without backups…' }));
    await user.click(screen.getByRole('button', { name: 'Overwrite originals' }));
    expect(ipc.applyPlan).toHaveBeenCalledWith(5, 'overwriteOriginals');
  });

  // @req FR-017
  it('never counts a write that does not read back as planned as a success', async () => {
    const user = userEvent.setup();
    ipc.planChanges.mockResolvedValue({ planId: 8, files: [ready] });
    ipc.applyPlan.mockResolvedValue({
      files: [
        {
          id: 'f1',
          name: 'link.jpg',
          outcome: 'mismatch',
          message: null,
          backup: '/real/photo.jpg_original',
          warnings: ["Can't convert IFD0:Orientation (not in PrintConv)"],
          details: ['IFD0:Orientation: planned 6, not in the file'],
          exitCode: 0,
        },
        {
          id: 'f2',
          name: 'old.jpg',
          outcome: 'failed',
          message: 'Writing of ZIP files is not yet supported',
          backup: null,
          warnings: [],
          details: [],
          exitCode: 1,
        },
      ],
    });
    render(<PlanPreviewDialog files={staged} onApplied={noop} onClose={noop} />);
    await user.click(await screen.findByRole('button', { name: 'Apply to 1 file' }));
    expect((await screen.findByText(/not as planned/)).textContent).toBe(
      '0 changed, 1 not as planned, 1 failed.',
    );
    const mismatch = within(screen.getByRole('region', { name: 'Result for link.jpg' }));
    expect(mismatch.getByText('Written, but it does not read back as planned')).toBeTruthy();
    expect(mismatch.getByRole('listitem').textContent).toBe(
      'IFD0:Orientation: planned 6, not in the file',
    );
    expect(mismatch.getByText(/Backup of the original/)).toBeTruthy();
    expect(mismatch.getByText(/Can't convert IFD0:Orientation/)).toBeTruthy();
    const failed = within(screen.getByRole('region', { name: 'Result for old.jpg' }));
    expect(failed.getByText('ExifTool exit status 1')).toBeTruthy();
  });

  it('notes values ExifTool stored in another form on a verified change', async () => {
    const user = userEvent.setup();
    ipc.planChanges.mockResolvedValue({ planId: 9, files: [ready] });
    ipc.applyPlan.mockResolvedValue({
      files: [
        {
          id: 'f1',
          name: 'link.jpg',
          outcome: 'changed',
          message: null,
          backup: null,
          warnings: [],
          details: ['ExifIFD:ExposureTime: stored as 1/200'],
          exitCode: 0,
        },
      ],
    });
    render(<PlanPreviewDialog files={staged} onApplied={noop} onClose={noop} />);
    await user.click(await screen.findByRole('button', { name: 'Apply to 1 file' }));
    expect(await screen.findByText('Changed and verified')).toBeTruthy();
    expect(screen.getByText('ExifIFD:ExposureTime: stored as 1/200')).toBeTruthy();
  });

  it('offers nothing to apply when every file is skipped, and shows a refused apply', async () => {
    const user = userEvent.setup();
    ipc.planChanges.mockResolvedValue({ planId: 6, files: [skipped] });
    render(<PlanPreviewDialog files={staged} onApplied={noop} onClose={noop} />);
    expect(await screen.findByText('Nothing can be applied.')).toBeTruthy();
    expect((screen.getByRole('button', { name: /Apply/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    cleanup();

    ipc.planChanges.mockResolvedValue({ planId: 7, files: [ready] });
    ipc.applyPlan.mockRejectedValue({ kind: 'InvalidInput', message: 'review them again' });
    render(<PlanPreviewDialog files={staged} onApplied={noop} onClose={noop} />);
    await user.click(await screen.findByRole('button', { name: 'Apply to 1 file' }));
    expect(await screen.findByText('review them again')).toBeTruthy();
  });
});
