import { invoke } from '@tauri-apps/api/core';
import type { InvokeArgs } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AppError } from './bindings/AppError';
import type { AppInfo } from './bindings/AppInfo';
import type { ExifToolStatus } from './bindings/ExifToolStatus';
import type { FileMetadata } from './bindings/FileMetadata';
import type { ImportResult } from './bindings/ImportResult';
import { toAppError } from './errors';

export type { AppError, AppInfo, ExifToolStatus, FileMetadata, ImportResult };
export type { ImportedFile } from './bindings/ImportedFile';
export type { RejectedPath } from './bindings/RejectedPath';
export type { ErrorKind } from './bindings/ErrorKind';
export type { MetadataValue } from './bindings/MetadataValue';
export type { StructField } from './bindings/StructField';
export type { TagEntry } from './bindings/TagEntry';

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
};

/** Runtime list of `Commands` keys; the `Record` type keeps it complete. */
export const COMMAND_NAMES = Object.keys({
  app_info: true,
  exiftool_status: true,
  choose_exiftool_override: true,
  reset_exiftool_override: true,
  add_files: true,
  read_file: true,
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

/**
 * Calls `handler` with each drop's import result (dropped paths are registered in Rust, as with
 * `addFiles`). Resolves to a function that stops listening.
 */
export const onFilesDropped = (handler: (result: ImportResult) => void) =>
  listen<ImportResult>('files-dropped', (event) => handler(event.payload));
