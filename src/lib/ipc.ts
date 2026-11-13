import { invoke } from '@tauri-apps/api/core';
import type { InvokeArgs } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AppError } from './bindings/AppError';
import type { AppInfo } from './bindings/AppInfo';
import type { ExifToolStatus } from './bindings/ExifToolStatus';
import type { FileMetadata } from './bindings/FileMetadata';
import type { ImportResult } from './bindings/ImportResult';
import type { ReadUpdate } from './bindings/ReadUpdate';
import type { ScanOptions } from './bindings/ScanOptions';
import type { TagPage } from './bindings/TagPage';
import type { ApplyResult } from './bindings/ApplyResult';
import type { BackupPolicy } from './bindings/BackupPolicy';
import type { PlanPreview } from './bindings/PlanPreview';
import type { RemovalPreview } from './bindings/RemovalPreview';
import type { StagedFile } from './bindings/StagedFile';
import type { ScanUpdate } from './bindings/ScanUpdate';
import { toAppError } from './errors';

export type {
  AppError,
  AppInfo,
  ExifToolStatus,
  FileMetadata,
  ImportResult,
  ScanOptions,
  ScanUpdate,
};
export type {
  ApplyResult,
  BackupPolicy,
  PlanPreview,
  ReadUpdate,
  RemovalPreview,
  StagedFile,
  TagPage,
};
export type { FileOutcome } from './bindings/FileOutcome';
export type { Outcome } from './bindings/Outcome';
export type { FilePlan } from './bindings/FilePlan';
export type { PlanCommands } from './bindings/PlanCommands';
export type { PlannedChange } from './bindings/PlannedChange';
export type { CopySelection } from './bindings/CopySelection';
export type { CopyTags } from './bindings/CopyTags';
export type { CopiedTag } from './bindings/CopiedTag';
export type { DeleteGroup } from './bindings/DeleteGroup';
export type { TagName } from './bindings/TagName';
export type { DeleteTag } from './bindings/DeleteTag';
export type { EditValue } from './bindings/EditValue';
export type { SetTag } from './bindings/SetTag';
export type { TagCapability } from './bindings/TagCapability';
export type { ReadCounts } from './bindings/ReadCounts';
export type { ReadSummary } from './bindings/ReadSummary';
export type { ScanCounts } from './bindings/ScanCounts';
export type { ScanState } from './bindings/ScanState';
export type { ImportedFile } from './bindings/ImportedFile';
export type { RejectedPath } from './bindings/RejectedPath';
export type { ErrorKind } from './bindings/ErrorKind';
export type { MetadataValue } from './bindings/MetadataValue';
export type { StructField } from './bindings/StructField';
export type { TagEntry } from './bindings/TagEntry';
export type { Writability } from './bindings/Writability';

/**
 * Every Rust command and its result type (DEC-018). Payload types are generated from Rust by
 * ts-rs into `./bindings`; this map must list exactly the commands in `generate_handler!`
 * (src-tauri/src/lib.rs), which `ipc.test.ts` checks. No command takes a path: files come from
 * dialogs and drops handled in Rust, and later commands name them by opaque ID (SEC-008).
 */
export type Commands = {
  app_info: AppInfo;
  exiftool_status: ExifToolStatus;
  choose_exiftool_override: ExifToolStatus | null;
  reset_exiftool_override: ExifToolStatus;
  add_files: ImportResult | null;
  read_file: FileMetadata;
  pick_folder: string | null;
  scan_picked_folder: number;
  cancel_scan: boolean;
  cancel_reads: boolean;
  prioritize_reads: null;
  search_tags: TagPage;
  raw_text_is_utf8: boolean;
  preview_removal: RemovalPreview;
  cancel_removal_preview: boolean;
  plan_changes: PlanPreview;
  apply_plan: ApplyResult;
};

/** Runtime list of `Commands` keys; the `Record` type keeps it complete. */
export const COMMAND_NAMES = Object.keys({
  app_info: true,
  exiftool_status: true,
  choose_exiftool_override: true,
  reset_exiftool_override: true,
  add_files: true,
  read_file: true,
  pick_folder: true,
  scan_picked_folder: true,
  cancel_scan: true,
  cancel_reads: true,
  prioritize_reads: true,
  search_tags: true,
  raw_text_is_utf8: true,
  preview_removal: true,
  cancel_removal_preview: true,
  plan_changes: true,
  apply_plan: true,
} satisfies Record<keyof Commands, true>) as (keyof Commands)[];

/** The only `invoke` call in the app (lint-enforced); rejections always become an `AppError`. */
async function call<K extends keyof Commands>(command: K, args?: InvokeArgs): Promise<Commands[K]> {
  try {
    return await invoke<Commands[K]>(command, args);
  } catch (error) {
    throw toAppError(error);
  }
}

export const appInfo = () => call('app_info');
/** Re-resolves ExifTool now; also the UI's Retry. */
export const exiftoolStatus = () => call('exiftool_status');
/** Native file dialog in Rust; saved only if valid. `null` when cancelled. */
export const chooseExiftoolOverride = () => call('choose_exiftool_override');
export const resetExiftoolOverride = () => call('reset_exiftool_override');
/** Native multi-select dialog in Rust; adds the chosen files without reading them. `null` when cancelled. */
export const addFiles = () => call('add_files');
/** Reads a file added in this session; an ID Rust did not issue is a `ScopeViolation`. */
export const readFile = (id: string) => call('read_file', { id });

/** Native folder dialog in Rust; Rust keeps the choice and returns its path for display only. */
export const pickFolder = () => call('pick_folder');
/** Scans the folder chosen with `pickFolder` with these options (also used for dropped folders). */
export const scanPickedFolder = (options: ScanOptions) => call('scan_picked_folder', { options });
export const cancelScan = (scanId: number) => call('cancel_scan', { scanId });

/** Writable tags (never System ones) whose `Group:Tag` contains `query`, for Add tag; at most 100. */
export const searchTags = (query: string) => call('search_tags', { query });
/** Whether a tag's stored bytes are valid UTF-8, so editing may start from its shown text. */
export const rawTextIsUtf8 = (id: string, group: string, name: string) =>
  call('raw_text_is_utf8', { id, group, name });
/** Tags that removing `group` (or `All`) would take away, found on a private copy; the file is only read. */
export const previewRemoval = (id: string, group: string) => call('preview_removal', { id, group });
/** Stops the removal preview in progress; `false` if there was none. */
export const cancelRemovalPreview = () => call('cancel_removal_preview');
/** Re-checks every staged file and change in Rust and says what applying them would do; writes nothing. */
export const planChanges = (files: StagedFile[]) => call('plan_changes', { files });
/** Runs the reviewed plan `planId` once; only the backup policy comes from the renderer. */
export const applyPlan = (planId: number, policy: BackupPolicy) =>
  call('apply_plan', { planId, policy });

/** Calls `handler` with every folder scan update (new files, problems, running totals, end state). */
export const onScanProgress = (handler: (update: ScanUpdate) => void) =>
  listen<ScanUpdate>('scan-progress', (event) => handler(event.payload));

/** Stops the background metadata reads; `false` if nothing was being read. */
export const cancelReads = () => call('cancel_reads');
/** Checks these files next if they are still queued (the rows in view); unknown IDs are ignored. */
export const prioritizeReads = (ids: string[]) => call('prioritize_reads', { ids });

/** Calls `handler` with each background read update (per-file summaries and running totals). */
export const onReadProgress = (handler: (update: ReadUpdate) => void) =>
  listen<ReadUpdate>('read-progress', (event) => handler(event.payload));

/**
 * Calls `handler` with each drop's import result (dropped paths are registered in Rust, as with
 * `addFiles`). Resolves to a function that stops listening.
 */
export const onFilesDropped = (handler: (result: ImportResult) => void) =>
  listen<ImportResult>('files-dropped', (event) => handler(event.payload));
