import { invoke } from '@tauri-apps/api/core';

// Mirrors the Rust `FileMetadata` / `AppError` shapes; S1-T05 replaces these with typed bindings.
export type FileMetadata = {
  sourceFile: string;
  error: string | null;
  warnings: string[];
  tags: Record<string, unknown>;
};
export type AppError = { kind: string; message: string };

/** Opens the native file dialog in Rust and reads the chosen file; `null` when cancelled. */
export const readSelectedFile = () => invoke<FileMetadata | null>('read_selected_file');

export const isAppError = (value: unknown): value is AppError =>
  typeof value === 'object' && value !== null && 'kind' in value && 'message' in value;
