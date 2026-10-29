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

/** Replaces the Tauri bridge before any app script runs; each Add files… returns the next read. */
export async function mockIpc(page: Page, reads: MockRead[] = SAMPLE_READS) {
  await page.addInitScript((queue: MockRead[]) => {
    // Typed against the app's command map, so a new or changed command breaks this mock at compile time.
    const responses: { [K in keyof Commands]: () => Commands[K] } = {
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
      reset_exiftool_override: () => responses.exiftool_status(),
      read_selected_file: () =>
        (queue.shift() as Commands['read_selected_file'] | undefined) ?? null,
    };
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        transformCallback: () => 0,
        invoke: async (command: keyof Commands) => responses[command](),
      },
    });
  }, reads);
}

/** Pins a saved theme the way a previous session would have left it. */
export async function savedTheme(page: Page, theme: string) {
  await page.addInitScript((value: string) => {
    if (!sessionStorage.getItem('theme-seeded')) {
      localStorage.setItem('exifbee.theme', value);
      sessionStorage.setItem('theme-seeded', '1');
    }
  }, theme);
}
