// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tagsOf } from '../../tests/support/tags';
import type {
  ExifToolStatus,
  FileMetadata,
  ImportResult,
  ImportedFile,
  ReadSummary,
  ReadUpdate,
  ScanOptions,
  ScanUpdate,
} from '../lib/ipc';
import { App, DEFAULT_LAYOUT, FILES_WIDTH, LAYOUT_KEY, loadLayout } from './App';

const ipc = vi.hoisted(() => ({
  addFiles: vi.fn(),
  readFile: vi.fn(),
  onFilesDropped: vi.fn(),
  onScanProgress: vi.fn(),
  onReadProgress: vi.fn(),
  cancelReads: vi.fn(),
  pickFolder: vi.fn(),
  scanPickedFolder: vi.fn(),
  cancelScan: vi.fn(),
  appInfo: vi.fn(),
  exiftoolStatus: vi.fn(),
  chooseExiftoolOverride: vi.fn(),
  resetExiftoolOverride: vi.fn(),
}));
const { addFiles, readFile } = ipc;
vi.mock('../lib/ipc', () => ipc);

const healthy: ExifToolStatus = {
  isOverride: false,
  resolvedPath: null,
  path: '/usr/bin/exiftool',
  version: '13.55',
  minimumVersion: '12.76',
  error: null,
};

// jsdom has no modal <dialog>; enough of it for open/close and the close event.
HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
  this.open = false;
  this.dispatchEvent(new Event('close'));
};

const file = (sourceFile: string, extra: Partial<FileMetadata> = {}): FileMetadata => ({
  sourceFile,
  error: null,
  unsupported: false,
  warnings: [],
  tags: tagsOf({ 'File:FileType': 'JPEG', 'XMP-dc:Title': '<img src=x onerror=alert(1)>' }),
  ...extra,
});

/** A file as Rust registers it; tests use the path as its ID. */
const entry = (path: string): ImportedFile => ({
  id: path,
  name: path.split('/').pop() ?? path,
  path,
});
const imported = (paths: string[], extra: Partial<ImportResult> = {}): ImportResult => ({
  added: paths.map(entry),
  duplicates: [],
  rejected: [],
  ...extra,
});
/** Reads answered by ID; an ID without a read rejects like an unknown one in Rust. */
const answerReads = (reads: FileMetadata[]) =>
  readFile.mockImplementation(async (id: string) => {
    const read = reads.find((candidate) => candidate.sourceFile === id);
    if (!read) throw { kind: 'ScopeViolation', message: `${id} is not a file` };
    return read;
  });
const unlisten = vi.fn();
let dropHandler: (result: ImportResult) => void = () => undefined;
let scanHandler: (update: ScanUpdate) => void = () => undefined;
let readHandler: (update: ReadUpdate) => void = () => undefined;
const scanOptions: ScanOptions = {
  recursive: true,
  includeHidden: false,
  followOutsideLinks: false,
  includeExtensions: [],
  excludeExtensions: [],
};

/** Add ▾ → Files… or Folder…, the way a pointer user does it. */
const addViaMenu = async (user: ReturnType<typeof userEvent.setup>, item: 'Files…' | 'Folder…') => {
  await user.click(screen.getByRole('button', { name: 'Add' }));
  await user.click(screen.getByRole('menuitem', { name: new RegExp(`^${item}`) }));
};

beforeEach(() => {
  localStorage.clear();
  Object.values(ipc).forEach((mock) => mock.mockReset());
  unlisten.mockReset();
  ipc.appInfo.mockResolvedValue({ version: '0.1.0', settingsWarning: null, scanOptions });
  ipc.exiftoolStatus.mockResolvedValue(healthy);
  ipc.onReadProgress.mockImplementation(async (handler: typeof readHandler) => {
    readHandler = handler;
    return unlisten;
  });
  ipc.onScanProgress.mockImplementation(async (handler: typeof scanHandler) => {
    scanHandler = handler;
    return unlisten;
  });
  ipc.onFilesDropped.mockImplementation(async (handler: typeof dropHandler) => {
    dropHandler = handler;
    return unlisten;
  });
});
afterEach(cleanup);

// @req UX-001, UX-005
describe('application shell', () => {
  it('shows the toolbar, both panes and both drawers with useful empty states', () => {
    render(<App />);
    expect(screen.getByRole('toolbar', { name: 'Main toolbar' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add' }).getAttribute('aria-haspopup')).toBe('menu');
    for (const name of [/^Theme: System/, 'Keyboard shortcuts', 'Settings'])
      expect(screen.getByRole('button', { name })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Files' }).textContent).toContain(
      'drop files onto the window',
    );
    expect(screen.getByRole('region', { name: 'Metadata' }).textContent).toContain('Ctrl+O');
    expect(screen.getByRole('button', { name: /Actions/ }).getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(screen.getByRole('button', { name: /Log/ }).getAttribute('aria-expanded')).toBe('false');
  });

  it('adds files, reads each one when inspected, skips duplicates with a notice and logs it all', async () => {
    const user = userEvent.setup();
    addFiles
      .mockResolvedValueOnce(imported(['/photos/a.jpg']))
      .mockResolvedValueOnce(imported(['/docs/b.pdf']))
      .mockResolvedValueOnce(imported([], { duplicates: ['/photos/a.jpg'] }));
    answerReads([file('/photos/a.jpg'), file('/docs/b.pdf', { error: 'File format error' })]);
    render(<App />);

    for (let i = 0; i < 3; i++) await addViaMenu(user, 'Files…');

    const pane = screen.getByRole('region', { name: 'Files' });
    const files = within(pane);
    // The duplicate is not listed twice; the notice says so.
    expect(files.getAllByRole('option').map((item) => item.textContent)).toEqual([
      'a.jpg',
      'b.pdf (error)',
    ]);
    expect(within(pane).getByRole('status').textContent).toContain(
      'Skipped 1 file already in the list.',
    );
    const metadata = screen.getByRole('region', { name: 'Metadata' });
    expect(within(metadata).getByRole('alert').textContent).toBe(
      'ExifTool error: File format error',
    );

    await user.click(files.getByRole('option', { name: '/photos/a.jpg' }));
    expect(within(metadata).getByRole('table').textContent).toContain('/photos/a.jpg');
    // Hostile values render as text only.
    expect(metadata.innerHTML).not.toContain('<img');
    // Already read: selecting again does not run ExifTool again.
    expect(readFile).toHaveBeenCalledTimes(2);

    await user.click(files.getByRole('button', { name: 'Dismiss' }));
    expect(within(pane).queryByRole('status')).toBeNull();

    await user.click(screen.getByRole('button', { name: /Log/ }));
    // Newest event first.
    expect(
      within(screen.getByRole('log'))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'warning: Already in the list, skipped: /photos/a.jpg',
      'error: /docs/b.pdf: File format error',
      'info: Added 1 file',
      'info: Read /photos/a.jpg',
      'info: Added 1 file',
    ]);
  });

  it('lists dropped files of every kind, reports what was refused and stops listening on unmount', async () => {
    const user = userEvent.setup();
    const paths = ['/m/photo.jpg', '/m/report.pdf', '/m/movie.mp4', '/m/archive.zip', '/m/unknown'];
    answerReads(paths.map((path) => file(path)));
    const { unmount } = render(<App />);
    await vi.waitFor(() => expect(ipc.onFilesDropped).toHaveBeenCalledOnce());

    act(() =>
      dropHandler(
        imported(paths, {
          duplicates: ['/m/old.jpg'],
          rejected: [{ path: '/m/folder', reason: 'folders cannot be added yet' }],
        }),
      ),
    );
    const files = within(screen.getByRole('region', { name: 'Files' }));
    expect(files.getAllByRole('option').map((item) => item.textContent)).toEqual([
      'photo.jpg',
      'report.pdf',
      'movie.mp4',
      'archive.zip',
      'unknown',
    ]);
    expect(files.getByRole('status').textContent).toBe(
      'Skipped 1 file already in the list. 1 item was not added. The Log lists each one.Dismiss',
    );
    // The first new file is inspected right away.
    await within(screen.getByRole('region', { name: 'Metadata' })).findByRole('table');
    expect(readFile).toHaveBeenCalledWith('/m/photo.jpg');

    await user.click(screen.getByRole('button', { name: /Log/ }));
    expect(screen.getByRole('log').textContent).toContain(
      'warning: Not added: /m/folder: folders cannot be added yet',
    );
    unmount();
    // All three listeners (drops, scans, reads) stop.
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(3));
  });

  it('reports failed reads and imports instead of failing silently, and retries a failed read', async () => {
    const user = userEvent.setup();
    addFiles
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(imported(['/a.jpg']))
      .mockRejectedValueOnce({ kind: 'Internal', message: 'registry lock poisoned' });
    readFile.mockRejectedValueOnce({
      kind: 'DependencyMissing',
      message: 'ExifTool was not found. Install it using your Linux package manager.',
    });
    render(<App />);

    // A cancelled dialog changes nothing.
    await addViaMenu(user, 'Files…');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('region', { name: 'Files' }).textContent).toContain('No files yet');

    await user.keyboard('{Control>}o{/Control}');
    const metadata = screen.getByRole('region', { name: 'Metadata' });
    expect((await within(metadata).findByRole('alert')).textContent).toContain(
      'ExifTool was not found',
    );
    const files = within(screen.getByRole('region', { name: 'Files' }));
    expect(files.getByRole('option', { name: '/a.jpg (error)' })).toBeTruthy();

    // After fixing ExifTool, selecting the file again reads it again.
    answerReads([file('/a.jpg')]);
    await user.click(files.getByRole('option', { name: '/a.jpg (error)' }));
    await within(metadata).findByRole('table');
    expect(within(metadata).queryByRole('alert')).toBeNull();

    await addViaMenu(user, 'Files…');
    expect(files.getByRole('alert').textContent).toContain('registry lock poisoned');
  });
});

// @req FR-004, FR-021, NFR-001, UX-001
describe('folder scans', () => {
  const scan = (change: Partial<ScanUpdate>): ScanUpdate => ({
    scanId: 3,
    root: '/photos',
    state: 'Running',
    added: [],
    problems: [],
    counts: { added: 0, duplicates: 0, filtered: 0, skipped: 0 },
    options: scanOptions,
    ...change,
  });

  it('asks for the folder first, then confirms it with the options shown at that moment', async () => {
    const user = userEvent.setup();
    ipc.pickFolder
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('/home/user/Photos')
      .mockResolvedValueOnce('/home/user/Other')
      .mockResolvedValueOnce('/home/user/Third');
    ipc.scanPickedFolder.mockResolvedValue(3);
    render(<App />);
    await vi.waitFor(() => expect(ipc.appInfo).toHaveBeenCalled());

    // Cancelling the native dialog opens nothing.
    await addViaMenu(user, 'Folder…');
    expect(screen.queryByRole('dialog', { name: 'Add folder' })).toBeNull();

    await user.keyboard('{Control>}{Shift>}o{/Shift}{/Control}');
    const dialog = await screen.findByRole('dialog', { name: 'Add folder' });
    expect(dialog.textContent).toContain('/home/user/Photos');
    await user.click(within(dialog).getByRole('button', { name: 'Choose…' }));
    expect(dialog.textContent).toContain('/home/user/Other');

    await user.click(
      within(dialog).getByRole('checkbox', { name: 'Include hidden files and folders' }),
    );
    await user.click(within(dialog).getByText('Filter by extension'));
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Only these extensions (empty = all)' }),
      'jpg, .PNG',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Add folder' }));
    expect(ipc.scanPickedFolder).toHaveBeenCalledWith({
      ...scanOptions,
      includeHidden: true,
      includeExtensions: ['jpg', '.PNG'],
    });
    expect((dialog as HTMLDialogElement).open).toBe(false);

    // The next folder starts from the options used last.
    await addViaMenu(user, 'Folder…');
    const again = await screen.findByRole('dialog', { name: 'Add folder' });
    expect(
      (
        within(again).getByRole('checkbox', {
          name: 'Include hidden files and folders',
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });

  it('shows a scan in a progress card above the list, with Cancel and an honest result', async () => {
    const user = userEvent.setup();
    ipc.cancelScan.mockResolvedValue(true);
    answerReads([file('/photos/a.jpg'), file('/photos/b.jpg')]);
    render(<App />);
    await vi.waitFor(() => expect(ipc.onScanProgress).toHaveBeenCalledOnce());
    act(() =>
      scanHandler(
        scan({
          added: [entry('/photos/a.jpg')],
          problems: [{ path: '/photos/fifo', reason: 'not a regular file' }],
          counts: { added: 1, duplicates: 0, filtered: 0, skipped: 1 },
        }),
      ),
    );
    act(() =>
      scanHandler(
        scan({
          added: [entry('/photos/b.jpg')],
          counts: { added: 2, duplicates: 0, filtered: 4, skipped: 1 },
        }),
      ),
    );
    const region = screen.getByRole('region', { name: 'Adding files' });
    const card = within(region);
    expect(card.getByRole('heading').textContent).toBe('Adding /photos');
    expect(card.getByText(/^Finding files/).textContent).toBe(
      'Finding files… 2 found, 4 left out, 1 skipped',
    );
    expect(card.getByText(/^Subfolders/).textContent).toBe(
      'Subfolders · no hidden files · links outside not followed',
    );
    expect(card.getByText('Checking starts as files are found.')).toBeTruthy();
    const pane = within(screen.getByRole('region', { name: 'Files' }));
    expect(pane.getAllByRole('option').map((item) => item.textContent)).toEqual(['a.jpg', 'b.jpg']);
    // Only the first file found is inspected; later batches do not steal the selection.
    await within(screen.getByRole('region', { name: 'Metadata' })).findByRole('table');
    expect(readFile).toHaveBeenCalledExactlyOnceWith('/photos/a.jpg');

    await user.click(card.getByRole('button', { name: 'Cancel' }));
    expect(ipc.cancelScan).toHaveBeenCalledWith(3);
    expect((card.getByRole('button', { name: 'Stopping…' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    act(() =>
      scanHandler(
        scan({ state: 'Cancelled', counts: { added: 2, duplicates: 0, filtered: 4, skipped: 1 } }),
      ),
    );
    expect(card.getByText(/^Stopped/).textContent).toBe(
      'Stopped: 2 listed, 0 checked. Selecting a file still reads it.',
    );

    await user.click(screen.getByRole('button', { name: /Log/ }));
    const log = screen.getByRole('log').textContent;
    expect(log).toContain('warning: Stopped: 2 listed, 0 checked.');
    expect(log).toContain('warning: Skipped: /photos/fifo: not a regular file');
    await user.click(card.getByRole('button', { name: 'Dismiss' }));
    expect(region.isConnected).toBe(false);
  });
});

// @req FR-005, NFR-002, UX-005
describe('background metadata reads', () => {
  const summary = (id: string, change: Partial<ReadSummary> = {}): ReadSummary => ({
    id,
    fileType: 'JPEG',
    error: null,
    unsupported: false,
    warnings: [],
    tagCount: 40,
    ...change,
  });
  const counts = (done: number, total: number, errors = 0, warnings = 0, unsupported = 0) => ({
    done,
    total,
    errors,
    warnings,
    unsupported,
  });
  const scanOf = (state: ScanUpdate['state'], added: string[], total: number): ScanUpdate => ({
    scanId: 3,
    root: '/home/user/m',
    state,
    added: added.map(entry),
    problems: [],
    counts: { added: total, duplicates: 0, filtered: 0, skipped: 0 },
    options: scanOptions,
  });
  const reading = (
    state: ReadUpdate['state'],
    done: number,
    total: number,
    results: ReadSummary[] = [],
  ) => act(() => readHandler({ state, results, counts: counts(done, total), message: null }));

  it('shows scanning and checking in one card with one bar, and one Cancel stops both', async () => {
    const user = userEvent.setup();
    ipc.cancelScan.mockResolvedValue(true);
    ipc.cancelReads.mockResolvedValue(true);
    answerReads([file('/m/a.jpg')]);
    render(<App />);
    await vi.waitFor(() => expect(ipc.onReadProgress).toHaveBeenCalledOnce());
    const paths = ['/m/a.jpg', '/m/broken.jpg', '/m/odd.mp4', '/m/cache.bin'];
    act(() => scanHandler(scanOf('Running', paths, 4)));
    act(() =>
      readHandler({
        state: 'Running',
        results: [
          summary('/m/broken.jpg', { fileType: null, error: 'File format error' }),
          summary('/m/odd.mp4', { fileType: 'MP4', warnings: ['Truncated mdat atom'] }),
          summary('/m/cache.bin', {
            fileType: null,
            error: 'Unknown file type',
            unsupported: true,
          }),
        ],
        counts: counts(3, 4, 1, 1, 1),
        message: null,
      }),
    );

    const card = within(screen.getByRole('region', { name: 'Adding files' }));
    expect(card.getByRole('heading').textContent).toBe('Adding /home/user/m');
    const bar = card.getByRole('progressbar', { name: 'Files checked' }) as HTMLProgressElement;
    expect([bar.value, bar.max]).toEqual([3, 4]);
    expect(card.getByText(/^Checking/).textContent).toBe('Checking 3 of 4');
    const pane = within(screen.getByRole('region', { name: 'Files' }));
    expect(pane.getByText(/^4 files/).textContent).toBe(
      '4 files · 1 with errors · 1 with warnings · 1 unsupported',
    );
    expect(pane.getAllByRole('option').map((row) => row.getAttribute('aria-label'))).toEqual([
      '/m/a.jpg',
      '/m/broken.jpg (error)',
      '/m/odd.mp4 (warning)',
      '/m/cache.bin (unsupported)',
    ]);

    await user.click(card.getByRole('button', { name: 'Cancel' }));
    expect(ipc.cancelScan).toHaveBeenCalledWith(3);
    expect(ipc.cancelReads).toHaveBeenCalledOnce();
    act(() => scanHandler(scanOf('Cancelled', [], 4)));
    // Still stopping until the reads report their end too.
    expect(card.getByRole('button', { name: 'Stopping…' })).toBeTruthy();
    reading('Cancelled', 3, 4);
    expect(card.getByText(/^Stopped/).textContent).toBe(
      'Stopped: 4 listed, 3 checked. Selecting a file still reads it.',
    );

    await user.click(screen.getByRole('button', { name: /Log/ }));
    const log = screen.getByRole('log').textContent;
    expect(log).toContain('error: /m/broken.jpg: File format error');
    // An unknown format is counted, not logged as an error.
    expect(log).not.toContain('cache.bin');
  });

  it('keeps one total when a scan starts a second read run in the same round', async () => {
    render(<App />);
    await vi.waitFor(() => expect(ipc.onReadProgress).toHaveBeenCalledOnce());
    act(() => scanHandler(scanOf('Running', [], 180)));
    reading('Running', 50, 100);
    reading('Complete', 100, 100);
    reading('Running', 30, 80);
    const card = within(screen.getByRole('region', { name: 'Adding files' }));
    expect(card.getByText(/^Checking/).textContent).toBe('Checking 130 of 180');
    act(() => scanHandler(scanOf('Complete', [], 180)));
    reading('Complete', 80, 80);
    expect(card.getByText(/^Done/).textContent).toBe('Done: 180 files added, 180 checked.');
  });

  it('a quick import leaves no card; one that takes over a second shows its progress', async () => {
    render(<App />);
    await vi.waitFor(() => expect(ipc.onReadProgress).toHaveBeenCalledOnce());
    reading('Running', 0, 3);
    reading('Complete', 3, 3);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(screen.queryByRole('region', { name: 'Adding files' })).toBeNull();

    reading('Running', 0, 500);
    expect(screen.queryByRole('region', { name: 'Adding files' })).toBeNull();
    const card = await screen.findByRole('region', { name: 'Adding files' }, { timeout: 2000 });
    expect(within(card).getByRole('heading').textContent).toBe('Checking new files');
  });

  it('shows an unsupported file neutrally when it is inspected', async () => {
    const user = userEvent.setup();
    addFiles.mockResolvedValueOnce(imported(['/m/cache.bin']));
    answerReads([file('/m/cache.bin', { error: 'Unknown file type', unsupported: true })]);
    render(<App />);
    await addViaMenu(user, 'Files…');
    const metadata = within(screen.getByRole('region', { name: 'Metadata' }));
    expect((await metadata.findByText(/^Unsupported format/)).textContent).toContain(
      'ExifTool does not recognize this file type',
    );
    expect(metadata.queryByRole('alert')).toBeNull();
  });

  it('says so at once when ExifTool cannot be used for checking', () => {
    render(<App />);
    act(() =>
      readHandler({
        state: 'Failed',
        results: [],
        counts: counts(0, 4),
        message: 'ExifTool was not found',
      }),
    );
    const card = within(screen.getByRole('region', { name: 'Adding files' }));
    expect(card.getByRole('alert').textContent).toBe(
      'Files were not checked: ExifTool was not found.',
    );
  });
});

// @req UX-002
describe('theme switcher', () => {
  it('cycles System → Light → Dark, says what a click does, and keeps the choice', async () => {
    const user = userEvent.setup();
    const theme = () => screen.getByRole('button', { name: /^Theme:/ });
    const { unmount } = render(<App />);
    expect(theme().getAttribute('aria-label')).toBe('Theme: System. Switch to Light');

    await user.click(theme());
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(theme().getAttribute('title')).toBe('Theme: Light. Switch to Dark');
    unmount();

    render(<App />);
    expect(theme().getAttribute('aria-label')).toBe('Theme: Light. Switch to Dark');
    await user.click(theme());
    expect(document.documentElement.dataset.theme).toBe('dark');
    await user.click(theme());
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});

// @req UX-001, UX-004
describe('Add menu', () => {
  it('works from the keyboard: ↓ opens it on Files…, arrows move, Esc closes and returns focus', async () => {
    const user = userEvent.setup();
    addFiles.mockResolvedValue(null);
    render(<App />);
    const add = screen.getByRole('button', { name: 'Add' });
    add.focus();
    await user.keyboard('{ArrowDown}');
    expect(add.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement?.textContent).toBe('Files…Ctrl+O');
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement?.textContent).toBe('Folder…Ctrl+Shift+O');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(add);

    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}');
    expect(addFiles).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

// @req UX-008
describe('resizing and layout persistence', () => {
  it('resizes the files pane with the keyboard within bounds and remembers it', async () => {
    const user = userEvent.setup();
    render(<App />);
    const splitter = screen.getByRole('separator', { name: 'Resize files pane' });
    splitter.focus();

    await user.keyboard('{ArrowRight}');
    expect(splitter.getAttribute('aria-valuenow')).toBe(String(DEFAULT_LAYOUT.filesWidth + 16));
    await user.keyboard('{End}');
    expect(splitter.getAttribute('aria-valuenow')).toBe(String(FILES_WIDTH.max));
    await user.keyboard('{Home}{ArrowLeft}');
    expect(splitter.getAttribute('aria-valuenow')).toBe(String(FILES_WIDTH.min));
    expect(document.activeElement).toBe(splitter);
    expect(loadLayout().filesWidth).toBe(FILES_WIDTH.min);
  });

  it('ignores corrupt or out-of-range stored layout', () => {
    localStorage.setItem(LAYOUT_KEY, '{"filesWidth":99999,"drawerHeight":"tall","logOpen":1}');
    expect(loadLayout()).toEqual({ ...DEFAULT_LAYOUT, filesWidth: FILES_WIDTH.max });
    localStorage.setItem(LAYOUT_KEY, 'not json');
    expect(loadLayout()).toEqual(DEFAULT_LAYOUT);
  });
});

// @req UX-001
describe('keyboard navigation and focus', () => {
  it('keeps focus on the control used when drawers open, close and panes change', async () => {
    const user = userEvent.setup();
    addFiles
      .mockResolvedValueOnce(imported(['/a.jpg']))
      .mockResolvedValueOnce(imported(['/b.jpg']));
    answerReads([file('/a.jpg'), file('/b.jpg')]);
    render(<App />);
    await addViaMenu(user, 'Files…');
    await addViaMenu(user, 'Files…');

    const logToggle = screen.getByRole('button', { name: /Log/ });
    await user.click(logToggle);
    expect(logToggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(logToggle);
    expect(screen.getByRole('separator', { name: 'Resize drawers' })).toBeTruthy();
    await user.click(logToggle);
    expect(document.activeElement).toBe(logToggle);

    // Clicking a row focuses the list (one Tab stop) and selects that row.
    const list = screen.getByRole('listbox', { name: 'Files' });
    const first = within(list).getByRole('option', { name: '/a.jpg' });
    await user.click(first);
    expect(document.activeElement).toBe(list);
    expect(first.getAttribute('aria-selected')).toBe('true');
    expect(list.getAttribute('aria-activedescendant')).toBe(first.id);
  });

  it('moves through the file list with the keyboard and reads only where the selection rests', async () => {
    const user = userEvent.setup();
    // jsdom has no layout or scrolling, so all 30 rows fit the drawn window; scale is in scan.e2e.ts.
    const paths = Array.from({ length: 30 }, (_, i) => `/f/${String(i).padStart(2, '0')}.jpg`);
    addFiles.mockResolvedValueOnce(imported(paths));
    answerReads(paths.map((path) => file(path)));
    render(<App />);
    await addViaMenu(user, 'Files…');
    const list = screen.getByRole('listbox', { name: 'Files' });
    await within(screen.getByRole('region', { name: 'Metadata' })).findByRole('table');
    expect(readFile).toHaveBeenCalledTimes(1);

    list.focus();
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    const selected = () => list.querySelector('[aria-selected="true"]')?.getAttribute('aria-label');
    expect(selected()).toBe('/f/03.jpg');
    await user.keyboard('{End}');
    expect(selected()).toBe('/f/29.jpg');
    // Every row reports its place in the whole list, rendered or not.
    expect(list.querySelector('[aria-selected="true"]')?.getAttribute('aria-posinset')).toBe('30');
    expect(list.querySelector('[role="option"]')?.getAttribute('aria-setsize')).toBe('30');
    await user.keyboard('{Home}');
    expect(selected()).toBe('/f/00.jpg');
    // Passing over 03 and 29 started no read; resting on a file reads it.
    await user.keyboard('{ArrowDown}');
    await vi.waitFor(() => expect(readFile).toHaveBeenLastCalledWith('/f/01.jpg'));
    expect(readFile).toHaveBeenCalledTimes(2);
  });
});

// @req FR-001, FR-002, UX-005, UX-010, NFR-007
describe('settings and ExifTool dependency', () => {
  it('explains a missing ExifTool at startup and offers settings with install commands', async () => {
    const user = userEvent.setup();
    ipc.exiftoolStatus.mockResolvedValue({
      ...healthy,
      path: null,
      version: null,
      error: { kind: 'DependencyMissing', message: 'ExifTool was not found.' },
    });
    render(<App />);

    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('ExifTool is not installed');
    expect(banner.textContent).toContain('ExifTool was not found.');
    await user.click(within(banner).getByRole('button', { name: 'Open settings' }));
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog.textContent).toContain('sudo apt install libimage-exiftool-perl');
    expect(dialog.textContent).toContain('sudo pacman -S perl-image-exiftool');
    expect(dialog.textContent).toContain('12.76 or newer');
  });

  it('shows the recovered-settings warning once, logs it, and lets the user dismiss it', async () => {
    const user = userEvent.setup();
    ipc.appInfo.mockResolvedValue({
      version: '0.1.0',
      settingsWarning: 'Settings could not be used: not valid JSON. Defaults are in use.',
      scanOptions,
    });
    render(<App />);

    const metadata = screen.getByRole('region', { name: 'Metadata' });
    const warning = await within(metadata).findByText(/Settings could not be used/);
    await user.click(screen.getByRole('button', { name: /Log/ }));
    expect(screen.getByRole('log').textContent).toContain('warning: Settings could not be used');
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(warning.isConnected).toBe(false);
  });

  it('keeps the previous setting when the chosen executable is not ExifTool', async () => {
    const user = userEvent.setup();
    ipc.chooseExiftoolOverride.mockResolvedValue({
      ...healthy,
      isOverride: true,
      path: '/home/user/not-exiftool',
      version: null,
      error: {
        kind: 'ProcessFailure',
        message: '/home/user/not-exiftool is not a working ExifTool',
      },
    });
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    await within(dialog).findByText('/usr/bin/exiftool');

    await user.click(within(dialog).getByRole('button', { name: 'Choose executable…' }));
    expect(within(dialog).getByRole('alert').textContent).toContain(
      'That file is not a usable ExifTool, so the previous setting was kept.',
    );
    // The status card still shows the working executable.
    expect(dialog.textContent).toContain('Automatic detection');
  });

  it('applies a valid override and can return to automatic detection', async () => {
    const user = userEvent.setup();
    ipc.chooseExiftoolOverride.mockResolvedValue({
      ...healthy,
      isOverride: true,
      path: '/opt/exiftool/exiftool',
      resolvedPath: '/opt/exiftool/Image-ExifTool-13.55/exiftool',
    });
    ipc.resetExiftoolOverride.mockResolvedValue(healthy);
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = screen.getByRole('dialog', { name: 'Settings' });

    await user.click(within(dialog).getByRole('button', { name: 'Choose executable…' }));
    expect(dialog.textContent).toContain('You (custom executable)');
    expect(dialog.textContent).toContain('/opt/exiftool/exiftool');
    // A symlinked choice shows where it really leads.
    expect(dialog.textContent).toContain('Resolves to/opt/exiftool/Image-ExifTool-13.55/exiftool');

    await user.click(within(dialog).getByRole('button', { name: 'Use automatic detection' }));
    expect(ipc.resetExiftoolOverride).toHaveBeenCalledOnce();
    expect(dialog.textContent).toContain('Automatic detection');
    expect(within(dialog).queryByRole('button', { name: 'Use automatic detection' })).toBeNull();
  });

  it('shows About information with the ExifTool attribution', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    await within(dialog).findByText(/ExifBee 0\.1\.0/);
    expect(dialog.textContent).toContain('Powered by ExifTool by Phil Harvey');
    expect(dialog.textContent).toContain('not affiliated with or endorsed by');
    expect(dialog.textContent).toContain('version 13.55 in use');
  });
});

// @req UX-005, NFR-004
describe('failed background calls', () => {
  it('surface as a banner and a log entry, never as an unhandled rejection', async () => {
    const user = userEvent.setup();
    ipc.appInfo.mockRejectedValue({ kind: 'Internal', message: 'settings lock poisoned' });
    ipc.exiftoolStatus.mockRejectedValue({ kind: 'ProcessFailure', message: 'probe crashed' });
    render(<App />);

    const banner = await within(screen.getByRole('region', { name: 'Metadata' })).findByRole(
      'alert',
    );
    expect(banner.textContent).toContain('ExifTool did not complete');
    expect(banner.textContent).toContain('probe crashed');
    await user.click(screen.getByRole('button', { name: /Log/ }));
    expect(screen.getByRole('log').textContent).toContain(
      'App info: Internal: settings lock poisoned',
    );
  });
});
