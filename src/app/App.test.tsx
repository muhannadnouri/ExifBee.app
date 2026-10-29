// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExifToolStatus, FileMetadata } from '../lib/ipc';
import { App, DEFAULT_LAYOUT, FILES_WIDTH, LAYOUT_KEY, loadLayout } from './App';

const ipc = vi.hoisted(() => ({
  readSelectedFile: vi.fn(),
  appInfo: vi.fn(),
  exiftoolStatus: vi.fn(),
  chooseExiftoolOverride: vi.fn(),
  resetExiftoolOverride: vi.fn(),
}));
const { readSelectedFile } = ipc;
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
  warnings: [],
  tags: { 'File:FileType': 'JPEG', 'XMP-dc:Title': '<img src=x onerror=alert(1)>' },
  ...extra,
});

beforeEach(() => {
  localStorage.clear();
  Object.values(ipc).forEach((mock) => mock.mockReset());
  ipc.appInfo.mockResolvedValue({ version: '0.1.0', settingsWarning: null });
  ipc.exiftoolStatus.mockResolvedValue(healthy);
});
afterEach(cleanup);

// @req UX-001, UX-005
describe('application shell', () => {
  it('shows the toolbar, both panes and both drawers with useful empty states', () => {
    render(<App />);
    expect(screen.getByRole('toolbar', { name: 'Main toolbar' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add files…' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Files' }).textContent).toContain('No files yet');
    expect(screen.getByRole('region', { name: 'Metadata' }).textContent).toContain('Ctrl+O');
    expect(screen.getByRole('button', { name: /Actions/ }).getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(screen.getByRole('button', { name: /Log/ }).getAttribute('aria-expanded')).toBe('false');
  });

  it('adds read files to the files pane, inspects the selected one and logs the outcome', async () => {
    const user = userEvent.setup();
    readSelectedFile
      .mockResolvedValueOnce(file('/photos/a.jpg'))
      .mockResolvedValueOnce(file('/docs/b.pdf', { error: 'File format error' }))
      .mockResolvedValueOnce(file('/photos/a.jpg'));
    render(<App />);

    for (let i = 0; i < 3; i++)
      await user.click(screen.getByRole('button', { name: 'Add files…' }));

    const files = within(screen.getByRole('region', { name: 'Files' }));
    // Re-adding the same path does not duplicate it.
    expect(files.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(
      ['/docs/b.pdf (error)', '/photos/a.jpg'],
    );
    const metadata = screen.getByRole('region', { name: 'Metadata' });
    expect(within(metadata).getByRole('table').textContent).toContain('/photos/a.jpg');
    // Hostile values render as text only.
    expect(metadata.innerHTML).not.toContain('<img');

    await user.click(files.getByRole('button', { name: '/docs/b.pdf (error)' }));
    expect(within(metadata).getByRole('alert').textContent).toBe(
      'ExifTool error: File format error',
    );

    await user.click(screen.getByRole('button', { name: /Log/ }));
    expect(screen.getByRole('log').textContent).toContain('error: /docs/b.pdf: File format error');
    // Newest event first.
    expect(
      within(screen.getByRole('log'))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'info: Read /photos/a.jpg',
      'error: /docs/b.pdf: File format error',
      'info: Read /photos/a.jpg',
    ]);
  });

  it('reports a failed read instead of failing silently, and a cancelled dialog changes nothing', async () => {
    const user = userEvent.setup();
    readSelectedFile.mockResolvedValueOnce(null).mockRejectedValueOnce({
      kind: 'DependencyMissing',
      message: 'ExifTool was not found. Install it using your Linux package manager.',
    });
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Add files…' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('region', { name: 'Files' }).textContent).toContain('No files yet');

    await user.keyboard('{Control>}o{/Control}');
    expect(screen.getByRole('alert').textContent).toContain('ExifTool was not found');
  });
});

// @req UX-002
describe('theme switcher', () => {
  it('applies the chosen theme immediately and keeps it across reloads', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<App />);
    const select = screen.getByRole('combobox', { name: 'Theme' });
    expect((select as HTMLSelectElement).value).toBe('system');

    await user.selectOptions(select, 'dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    unmount();

    render(<App />);
    expect((screen.getByRole('combobox', { name: 'Theme' }) as HTMLSelectElement).value).toBe(
      'dark',
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'Theme' }), 'system');
    expect(document.documentElement.dataset.theme).toBeUndefined();
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
    readSelectedFile.mockResolvedValueOnce(file('/a.jpg')).mockResolvedValueOnce(file('/b.jpg'));
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Add files…' }));
    await user.click(screen.getByRole('button', { name: 'Add files…' }));

    const logToggle = screen.getByRole('button', { name: /Log/ });
    await user.click(logToggle);
    expect(logToggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(logToggle);
    expect(screen.getByRole('separator', { name: 'Resize drawers' })).toBeTruthy();
    await user.click(logToggle);
    expect(document.activeElement).toBe(logToggle);

    const first = screen.getByRole('button', { name: '/a.jpg' });
    await user.click(first);
    expect(document.activeElement).toBe(first);
    expect(first.getAttribute('aria-current')).toBe('true');
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
