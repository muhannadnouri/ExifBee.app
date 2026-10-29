// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileMetadata } from '../lib/ipc';
import { App, DEFAULT_LAYOUT, FILES_WIDTH, LAYOUT_KEY, loadLayout } from './App';

const { readSelectedFile } = vi.hoisted(() => ({ readSelectedFile: vi.fn() }));
vi.mock('../lib/ipc', () => ({
  readSelectedFile,
  isAppError: (value: unknown) => typeof value === 'object' && value !== null && 'kind' in value,
}));

const file = (sourceFile: string, extra: Partial<FileMetadata> = {}): FileMetadata => ({
  sourceFile,
  error: null,
  warnings: [],
  tags: { 'File:FileType': 'JPEG', 'XMP-dc:Title': '<img src=x onerror=alert(1)>' },
  ...extra,
});

beforeEach(() => {
  localStorage.clear();
  readSelectedFile.mockReset();
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
