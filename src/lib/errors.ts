import type { AppError } from './bindings/AppError';
import type { ErrorKind } from './bindings/ErrorKind';

/**
 * User-facing wording for every error category (S1-T05). `Record<ErrorKind, …>` makes this
 * exhaustive: a new kind in Rust regenerates `ErrorKind` and fails the build until it is handled.
 * The Rust `message` stays the specific detail shown under the title.
 */
export const ERROR_TEXT: Record<ErrorKind, { title: string; hint: string }> = {
  DependencyMissing: {
    title: 'ExifTool is not installed',
    hint: 'Install ExifTool with your package manager, then choose Retry in Settings.',
  },
  Unsupported: {
    title: 'Not supported',
    hint: 'Upgrade ExifTool or choose a different executable in Settings.',
  },
  InvalidInput: {
    title: 'That selection cannot be used',
    hint: 'Choose a regular file and try again.',
  },
  ScopeViolation: {
    title: 'Outside the allowed folders',
    hint: 'Add the folder that contains this file first.',
  },
  ProcessFailure: {
    title: 'ExifTool did not complete',
    hint: 'Check the ExifTool installation in Settings; the details below explain what happened.',
  },
  Cancelled: { title: 'Cancelled', hint: 'Nothing else was changed.' },
  PartialFailure: {
    title: 'Some files were not processed',
    hint: 'Review the per-file results in the Log.',
  },
  VerificationMismatch: {
    title: 'The result could not be verified',
    hint: 'The file may not contain what was requested; review it before continuing.',
  },
  Internal: {
    title: 'Something went wrong in ExifBee',
    hint: 'Try again; if it keeps happening, report it with the details below.',
  },
};

export const ERROR_KINDS = Object.keys(ERROR_TEXT) as ErrorKind[];

export const isAppError = (value: unknown): value is AppError =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as AppError).message === 'string' &&
  ERROR_KINDS.includes((value as AppError).kind);

/** Anything a command can reject with becomes an `AppError`; unknown shapes are `Internal`. */
export const toAppError = (error: unknown): AppError =>
  isAppError(error) ? error : { kind: 'Internal', message: String(error) };
