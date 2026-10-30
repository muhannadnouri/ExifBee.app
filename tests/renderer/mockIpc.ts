import type { Page } from '@playwright/test';
import type { Commands } from '../../src/lib/ipc';
import { tagsOf } from '../support/tags';

// Plain shape for addInitScript: the recursive JsonValue in FileMetadata is too deep for
// Playwright's argument-serialization types (TS2589). Cast back at the typed boundary below.
export type MockRead = {
  sourceFile: string;
  error: string | null;
  warnings: string[];
  tags: object;
};

/** Deterministic sample reads: a PDF with a per-file error and a JPEG with a warning. */
export const SAMPLE_READS: MockRead[] = [
  {
    sourceFile: '/home/user/Documents/report.pdf',
    error: 'File format error',
    warnings: [],
    tags: tagsOf({ 'File:FileType': 'PDF', 'PDF:Title': 'Quarterly report' }),
  },
  {
    sourceFile: '/home/user/Pictures/IMG_0042.jpg',
    error: null,
    warnings: ['JPEG format error'],
    tags: tagsOf({
      'ExifTool:ExifToolVersion': '13.55',
      'File:FileType': 'JPEG',
      'IFD0:Make': 'Canon',
      'XMP-tiff:Copy1:Make': 'Canon (XMP)',
      'XMP-dc:Title': 'Bee on lavender',
      'XMP-dc:Subject': ['bee', 'fixture'],
    }),
  },
];

type MockRejected = { path: string; reason: string };

/** Default folder options, as Rust's `ScanOptions::default()` reports them in `app_info`. */
const DEFAULT_SCAN_OPTIONS = {
  recursive: true,
  includeHidden: false,
  followOutsideLinks: false,
  includeExtensions: [],
  excludeExtensions: [],
};

/**
 * Replaces the Tauri bridge before any app script runs. Each Add files… adds the next read as one
 * file; `read_file` answers by ID like the Rust registry; Add folder… starts scan 1, 2, …;
 * `dropFiles` and `scanUpdate` emit the events Rust would.
 */
export async function mockIpc(page: Page, reads: MockRead[] = SAMPLE_READS) {
  await page.addInitScript(
    ([queue, defaultScanOptions]) => {
      const registered = new Map<string, MockRead>();
      const register = (read: MockRead) => {
        const id = `f${registered.size + 1}`;
        registered.set(id, read);
        return { id, name: read.sourceFile.split('/').pop() ?? '', path: read.sourceFile };
      };
      const callbacks = new Map<number, (message: unknown) => void>();
      const listeners = new Map<number, string>();
      const emit = (event: string, payload: unknown) => {
        for (const [id, name] of listeners)
          if (name === event) callbacks.get(id)?.({ event, id, payload });
      };
      let scans = 0;
      const cancelledScans: number[] = [];
      type Args = Record<string, unknown>;
      // Typed against the app's command map, so a new or changed command breaks this mock at compile time.
      const responses: { [K in keyof Commands]: (args: Args) => Commands[K] } = {
        app_info: () => ({
          version: '0.1.0',
          settingsWarning: null,
          scanOptions: defaultScanOptions,
        }),
        exiftool_status: () => ({
          isOverride: false,
          resolvedPath: null,
          path: '/usr/bin/exiftool',
          version: '13.55',
          minimumVersion: '12.76',
          error: null,
        }),
        choose_exiftool_override: () => null,
        reset_exiftool_override: () => responses.exiftool_status({}),
        add_files: () => {
          const read = queue.shift();
          return read ? { added: [register(read)], duplicates: [], rejected: [] } : null;
        },
        read_file: ({ id }) => {
          const read = registered.get(String(id));
          if (!read) throw { kind: 'ScopeViolation', message: `${String(id)} is not a file` };
          return read as Commands['read_file'];
        },
        add_folder: () => ++scans,
        cancel_scan: ({ scanId }) => cancelledScans.push(Number(scanId)) > 0,
        set_scan_options: ({ options }) => options as Commands['set_scan_options'],
      };
      Object.assign(window, {
        __TAURI_INTERNALS__: {
          transformCallback: (callback: (message: unknown) => void) => {
            const id = callbacks.size + 1;
            callbacks.set(id, callback);
            return id;
          },
          invoke: async (command: string, args: Args = {}) => {
            if (command === 'plugin:event|listen') {
              listeners.set(Number(args.handler), String(args.event));
              return Number(args.handler);
            }
            if (command === 'plugin:event|unlisten') return listeners.delete(Number(args.eventId));
            return responses[command as keyof Commands](args);
          },
        },
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
        __cancelledScans: cancelledScans,
        __mockDrop: (dropped: MockRead[], duplicates: string[], rejected: MockRejected[]) =>
          emit('files-dropped', { added: dropped.map(register), duplicates, rejected }),
        __mockScan: (update: MockScanUpdate) =>
          emit('scan-progress', { ...update, added: update.added.map(register) }),
      });
    },
    [reads, DEFAULT_SCAN_OPTIONS] as const,
  );
}

/** Simulates files dropped on the window, after Rust registered them. */
export const dropFiles = (
  page: Page,
  dropped: MockRead[],
  duplicates: string[] = [],
  rejected: MockRejected[] = [],
) =>
  page.evaluate(
    ([dropped, duplicates, rejected]) =>
      (
        window as unknown as {
          __mockDrop: (r: MockRead[], d: string[], x: MockRejected[]) => void;
        }
      ).__mockDrop(dropped, duplicates, rejected),
    [dropped, duplicates, rejected] as const,
  );

/** A scan-progress payload whose new files are given as reads (registered like Rust would). */
export type MockScanUpdate = {
  scanId: number;
  root: string;
  state: 'Running' | 'Complete' | 'Cancelled' | 'Failed';
  added: MockRead[];
  problems: MockRejected[];
  counts: { added: number; duplicates: number; filtered: number; skipped: number };
};

/** Simulates one progress update of a folder scan running in Rust. */
export const scanUpdate = (page: Page, update: MockScanUpdate) =>
  page.evaluate(
    (update) =>
      (window as unknown as { __mockScan: (u: MockScanUpdate) => void }).__mockScan(update),
    update,
  );

/** Scan IDs the app asked Rust to stop. */
export const cancelledScans = (page: Page) =>
  page.evaluate(() => (window as unknown as { __cancelledScans: number[] }).__cancelledScans);

/** Pins a saved theme the way a previous session would have left it. */
export async function savedTheme(page: Page, theme: string) {
  await page.addInitScript((value: string) => {
    if (!sessionStorage.getItem('theme-seeded')) {
      localStorage.setItem('exifbee.theme', value);
      sessionStorage.setItem('theme-seeded', '1');
    }
  }, theme);
}
