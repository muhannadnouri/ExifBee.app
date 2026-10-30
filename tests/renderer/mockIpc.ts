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

/**
 * Replaces the Tauri bridge before any app script runs. Each Add files… adds the next read as one
 * file; `read_file` answers by ID like the Rust registry; `dropFiles` emits a files-dropped event.
 */
export async function mockIpc(page: Page, reads: MockRead[] = SAMPLE_READS) {
  await page.addInitScript((queue: MockRead[]) => {
    const registered = new Map<string, MockRead>();
    const register = (read: MockRead) => {
      const id = `f${registered.size + 1}`;
      registered.set(id, read);
      return { id, name: read.sourceFile.split('/').pop() ?? '', path: read.sourceFile };
    };
    const callbacks = new Map<number, (message: unknown) => void>();
    const dropListeners = new Set<number>();
    type Args = Record<string, unknown>;
    // Typed against the app's command map, so a new or changed command breaks this mock at compile time.
    const responses: { [K in keyof Commands]: (args: Args) => Commands[K] } = {
      app_info: () => ({ version: '0.1.0', settingsWarning: null }),
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
            if (args.event === 'files-dropped') dropListeners.add(Number(args.handler));
            return Number(args.handler);
          }
          if (command === 'plugin:event|unlisten')
            return dropListeners.delete(Number(args.eventId));
          return responses[command as keyof Commands](args);
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
      __mockDrop: (dropped: MockRead[], duplicates: string[], rejected: MockRejected[]) => {
        const payload = { added: dropped.map(register), duplicates, rejected };
        for (const id of dropListeners)
          callbacks.get(id)?.({ event: 'files-dropped', id, payload });
      },
    });
  }, reads);
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

/** Pins a saved theme the way a previous session would have left it. */
export async function savedTheme(page: Page, theme: string) {
  await page.addInitScript((value: string) => {
    if (!sessionStorage.getItem('theme-seeded')) {
      localStorage.setItem('exifbee.theme', value);
      sessionStorage.setItem('theme-seeded', '1');
    }
  }, theme);
}
