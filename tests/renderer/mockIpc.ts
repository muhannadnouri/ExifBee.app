import type { Page } from '@playwright/test';

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
    tags: { 'File:FileType': 'PDF', 'PDF:Title': 'Quarterly report' },
  },
  {
    sourceFile: '/home/user/Pictures/IMG_0042.jpg',
    error: null,
    warnings: ['JPEG format error'],
    tags: {
      'ExifTool:ExifToolVersion': 13.55,
      'File:FileType': 'JPEG',
      'IFD0:Make': 'Canon',
      'XMP-tiff:Copy1:Make': 'Canon (XMP)',
      'XMP-dc:Title': 'Bee on lavender',
      'XMP-dc:Subject': ['bee', 'fixture'],
    },
  },
];

/** Replaces the Tauri bridge before any app script runs; each Add files… returns the next read. */
export async function mockIpc(page: Page, reads: MockRead[] = SAMPLE_READS) {
  await page.addInitScript((queue: MockRead[]) => {
    const responses: Record<string, () => unknown> = {
      app_info: () => ({ version: '0.1.0', settingsWarning: null }),
      exiftool_status: () => ({
        isOverride: false,
        path: '/usr/bin/exiftool',
        version: '13.55',
        minimumVersion: '12.76',
        error: null,
      }),
      read_selected_file: () => queue.shift() ?? null,
    };
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        transformCallback: () => 0,
        invoke: async (command: string) => responses[command]?.() ?? null,
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
