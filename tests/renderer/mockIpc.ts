import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Commands, StagedFile } from '../../src/lib/ipc';
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
 * Replaces the Tauri bridge before any app script runs. Each Add → Files… adds the next read as
 * one file; `read_file` answers by ID like the Rust registry; Add → Folder… picks
 * /home/user/Photos and confirming it starts scan 1, 2, …;
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
      const readsCancelled: true[] = [];
      const prioritized: string[][] = [];
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
          return {
            unsupported: false,
            formatWritable: true,
            writeAccess: true,
            ...read,
          } as Commands['read_file'];
        },
        pick_folder: () => '/home/user/Photos',
        scan_picked_folder: () => ++scans,
        cancel_scan: ({ scanId }) => cancelledScans.push(Number(scanId)) > 0,
        cancel_reads: () => readsCancelled.push(true) > 0,
        // The real dry run is proven against ExifTool (tag_delete.rs); here, the group's tags.
        preview_removal: ({ id, group }) => ({
          removed: (
            (registered.get(String(id))?.tags ?? []) as Commands['read_file']['tags']
          ).filter(
            (tag) =>
              !['System', 'ExifTool', 'Composite'].includes(tag.group1) &&
              (group === 'All' || tag.group1 === group || tag.group0 === group),
          ),
          messages: [],
        }),
        cancel_removal_preview: () => false,
        // Ready files change, a *locked* file is skipped (what the real executor reports).
        apply_plan: () => ({
          files: [...registered].map(([id, read]) => {
            const locked = read.sourceFile.includes('locked');
            return {
              id,
              name: read.sourceFile.split('/').pop() ?? id,
              outcome: locked ? 'skipped' : 'changed',
              message: locked ? 'You do not have permission to change this file.' : null,
              backup: locked ? null : `${read.sourceFile}_original`,
              warnings: [],
              details: [],
              exitCode: locked ? null : 0,
            } as const;
          }),
        }),
        // The real checks are proven against ExifTool (plan.rs); here, a plan from the mock's
        // own tags, and a file named *locked* is skipped the way a 0444 file would be.
        plan_changes: ({ files }) => ({
          planId: 1,
          files: (files as StagedFile[]).map((staged) => {
            const read = registered.get(staged.id);
            const tags = (read?.tags ?? []) as Commands['read_file']['tags'];
            const text = (tag: Commands['read_file']['tags'][number] | undefined) =>
              tag === undefined
                ? null
                : tag.value.kind === 'text'
                  ? tag.value.text
                  : tag.value.kind === 'list'
                    ? tag.value.items
                        .map((item) => (item.kind === 'text' ? item.text : ''))
                        .join(', ')
                    : '';
            const locked = read?.sourceFile.includes('locked') ?? false;
            return {
              id: staged.id,
              name: read?.sourceFile.split('/').pop() ?? staged.id,
              target: read?.sourceFile ?? '',
              link: null,
              problems: locked
                ? [
                    'You do not have permission to change this file or the folder it is in, so it is left as it is.',
                  ]
                : [],
              warnings: [],
              backup: locked ? null : `${read?.sourceFile}_original`,
              changes: staged.changes.map((change) => {
                if (change.kind === 'deleteGroup')
                  return {
                    target: change.group === 'All' ? 'All metadata' : `${change.group} group`,
                    before: null,
                    after: null,
                    removes: tags
                      .filter(
                        (tag) =>
                          change.group === 'All' ||
                          tag.group1 === change.group ||
                          tag.group0 === change.group,
                      )
                      .filter((tag) => !['System', 'ExifTool', 'Composite'].includes(tag.group1))
                      .map((tag) => `${tag.group1}:${tag.name}`),
                    copies: [],
                    cannotCopy: [],
                  };
                // A copy writes every non-file tag of the source; nothing is dropped.
                if (change.kind === 'copyTags') {
                  const source = registered.get(change.source);
                  const from = (source?.tags ?? []) as Commands['read_file']['tags'];
                  return {
                    target: `Copy from ${source?.sourceFile.split('/').pop() ?? change.source}: ${
                      change.what.kind === 'all'
                        ? 'all metadata'
                        : change.what.kind === 'group'
                          ? `${change.what.group} group`
                          : `${change.what.tags.length} tags`
                    }`,
                    before: null,
                    after: null,
                    removes: [],
                    copies: from
                      .filter(
                        (t) => !['System', 'ExifTool', 'Composite', 'File'].includes(t.group1),
                      )
                      .map((t) => ({ key: `${t.group1}:${t.name}`, value: text(t) ?? '' })),
                    cannotCopy: [],
                  };
                }
                const tag = tags.find((t) => t.group1 === change.group && t.name === change.name);
                return {
                  target: `${change.group}:${change.name}`,
                  before: text(tag),
                  after:
                    change.kind === 'deleteTag'
                      ? null
                      : change.value.kind === 'text'
                        ? change.value.text
                        : change.value.items.join(', '),
                  removes: [],
                  copies: [],
                  cannotCopy: [],
                };
              }),
            };
          }),
        }),
        search_tags: () => ({
          total: 2,
          tags: [
            { group1: 'XMP-dc', name: 'Creator', group0: 'XMP', writable: true },
            { group1: 'XMP-dc', name: 'Rights', group0: 'XMP', writable: true },
          ],
        }),
        raw_text_is_utf8: () => true,
        prioritize_reads: ({ ids }) => {
          prioritized.push(ids as string[]);
          return null;
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
              listeners.set(Number(args.handler), String(args.event));
              return Number(args.handler);
            }
            if (command === 'plugin:event|unlisten') return listeners.delete(Number(args.eventId));
            return responses[command as keyof Commands](args);
          },
        },
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
        __cancelledScans: cancelledScans,
        __readsCancelled: readsCancelled,
        __prioritized: prioritized,
        __mockRead: (update: unknown) => emit('read-progress', update),
        __mockDrop: (dropped: MockRead[], duplicates: string[], rejected: MockRejected[]) =>
          emit('files-dropped', { added: dropped.map(register), duplicates, rejected }),
        __mockScan: (update: MockScanUpdate) =>
          emit('scan-progress', {
            options: defaultScanOptions,
            ...update,
            added: update.added.map(register),
          }),
      });
    },
    [reads, DEFAULT_SCAN_OPTIONS] as const,
  );
}

/** Accessible names of the tag table's row headers (the full `Group:Tag` keys), once they match. */
export const expectRowHeaders = (page: Page, keys: string[]) =>
  expect
    .poll(() =>
      page
        .getByRole('rowheader')
        .evaluateAll((headers) => headers.map((header) => header.getAttribute('aria-label'))),
    )
    .toEqual(keys);

/** Add ▾ → Files… or Folder…, as a pointer user does it. */
export async function addVia(page: Page, item: 'Files…' | 'Folder…') {
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('menuitem', { name: new RegExp(`^${item}`) }).click();
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
  options?: typeof DEFAULT_SCAN_OPTIONS;
};

/** Simulates one progress update of a folder scan running in Rust. */
export const scanUpdate = (page: Page, update: MockScanUpdate) =>
  page.evaluate(
    (update) =>
      (window as unknown as { __mockScan: (u: MockScanUpdate) => void }).__mockScan(update),
    update,
  );

/** Simulates one background read update from Rust (results name registered IDs: f1, f2, …). */
export const readUpdate = (page: Page, update: MockReadUpdate) =>
  page.evaluate(
    (update) =>
      (window as unknown as { __mockRead: (u: MockReadUpdate) => void }).__mockRead(update),
    update,
  );

export type MockReadUpdate = {
  state: 'Running' | 'Complete' | 'Cancelled' | 'Failed';
  results: {
    id: string;
    fileType: string | null;
    error: string | null;
    unsupported: boolean;
    warnings: string[];
    tagCount: number;
  }[];
  counts: { done: number; total: number; errors: number; warnings: number; unsupported: number };
  message: string | null;
};

/** Each list of file IDs the app asked Rust to check first. */
export const prioritized = (page: Page) =>
  page.evaluate(() => (window as unknown as { __prioritized: string[][] }).__prioritized);

/** How many times the app asked Rust to stop reading. */
export const readsCancelled = (page: Page) =>
  page.evaluate(() => (window as unknown as { __readsCancelled: true[] }).__readsCancelled.length);

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
