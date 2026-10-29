import { invoke } from '@tauri-apps/api/core';
import type { AppError } from './bindings/AppError';
import type { AppInfo } from './bindings/AppInfo';
import type { ExifToolStatus } from './bindings/ExifToolStatus';
import type { FileMetadata } from './bindings/FileMetadata';
import { toAppError } from './errors';

export type { AppError, AppInfo, ExifToolStatus, FileMetadata };
export type { ErrorKind } from './bindings/ErrorKind';
export type { MetadataValue } from './bindings/MetadataValue';
export type { StructField } from './bindings/StructField';
export type { TagEntry } from './bindings/TagEntry';

/**
 * Every Rust command and its result type (DEC-018). Payload types are generated from Rust by
 * ts-rs into `./bindings`; this map must list exactly the commands in `generate_handler!`
 * (src-tauri/src/lib.rs), which `ipc.test.ts` checks. None take arguments yet: paths come from
 * dialogs opened in Rust, never from the renderer (SEC-008).
 */
export type Commands = {
  app_info: AppInfo;
  exiftool_status: ExifToolStatus;
  choose_exiftool_override: ExifToolStatus | null;
  reset_exiftool_override: ExifToolStatus;
  read_selected_file: FileMetadata | null;
};

/** Runtime list of `Commands` keys; the `Record` type keeps it complete. */
export const COMMAND_NAMES = Object.keys({
  app_info: true,
  exiftool_status: true,
  choose_exiftool_override: true,
  reset_exiftool_override: true,
  read_selected_file: true,
} satisfies Record<keyof Commands, true>) as (keyof Commands)[];

/** The only `invoke` call in the app (lint-enforced); rejections always become an `AppError`. */
async function call<K extends keyof Commands>(command: K): Promise<Commands[K]> {
  try {
    return await invoke<Commands[K]>(command);
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
/** Opens the native file dialog in Rust and reads the chosen file; `null` when cancelled. */
export const readSelectedFile = () => call('read_selected_file');
