import { beforeEach, describe, expect, it, vi } from 'vitest';
import libRs from '../../src-tauri/src/lib.rs?raw';
import errorRs from '../../src-tauri/src/domain/error.rs?raw';
import { ERROR_KINDS, ERROR_TEXT, toAppError } from './errors';
import { COMMAND_NAMES, appInfo, readFile } from './ipc';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

beforeEach(() => invoke.mockReset());

// @req NFR-004, SEC-008
describe('typed IPC contract', () => {
  it('lists exactly the commands Rust registers in generate_handler!', () => {
    const handler = /generate_handler!\[([^\]]*)\]/.exec(libRs)?.[1] ?? '';
    const registered = [...handler.matchAll(/commands::(\w+)/g)].map((match) => match[1]);
    expect(registered.length).toBeGreaterThan(0);
    expect([...COMMAND_NAMES].sort()).toEqual(registered.sort());
  });

  it('has wording for exactly the error kinds Rust defines', () => {
    const body = /pub enum ErrorKind \{([\s\S]*?)\n\}/.exec(errorRs)?.[1] ?? '';
    const rustKinds = [...body.matchAll(/^\s{4}(\w+),$/gm)].map((match) => match[1]);
    expect(rustKinds).toHaveLength(9);
    expect([...ERROR_KINDS].sort()).toEqual(rustKinds.sort());
    const titles = ERROR_KINDS.map((kind) => ERROR_TEXT[kind].title);
    expect(new Set(titles).size).toBe(titles.length);
    for (const kind of ERROR_KINDS) expect(ERROR_TEXT[kind].hint.length).toBeGreaterThan(10);
  });

  it('turns every command rejection into an AppError', async () => {
    invoke.mockRejectedValueOnce({ kind: 'Unsupported', message: 'too old' });
    await expect(appInfo()).rejects.toEqual({ kind: 'Unsupported', message: 'too old' });

    invoke.mockRejectedValueOnce('IPC channel closed');
    await expect(appInfo()).rejects.toEqual({ kind: 'Internal', message: 'IPC channel closed' });

    // A kind the UI does not know (e.g. from a mismatched build) is never passed through.
    invoke.mockRejectedValueOnce({ kind: 'Mystery', message: 'x' });
    await expect(appInfo()).rejects.toMatchObject({ kind: 'Internal' });

    invoke.mockResolvedValueOnce({ version: '0.1.0', settingsWarning: null });
    await expect(appInfo()).resolves.toEqual({ version: '0.1.0', settingsWarning: null });
    expect(invoke).toHaveBeenLastCalledWith('app_info', undefined);

    // Files are named by the opaque ID Rust issued, never by path.
    invoke.mockResolvedValueOnce({ sourceFile: '/a.jpg', error: null, warnings: [], tags: [] });
    await readFile('f1');
    expect(invoke).toHaveBeenLastCalledWith('read_file', { id: 'f1' });
  });

  it('normalizes non-object values defensively', () => {
    expect(toAppError(null)).toEqual({ kind: 'Internal', message: 'null' });
    expect(toAppError({ kind: 'Internal' })).toEqual({
      kind: 'Internal',
      message: '[object Object]',
    });
  });
});
