import { invoke } from '@tauri-apps/api/core';
import { useState } from 'react';

// Mirrors the Rust `FileMetadata` / `AppError` shapes; S1-T05 replaces these with typed bindings.
export type FileMetadata = {
  sourceFile: string;
  error: string | null;
  warnings: string[];
  tags: Record<string, unknown>;
};
export type AppError = { kind: string; message: string };

type ReadState =
  | { status: 'idle' }
  | { status: 'reading' }
  | { status: 'read'; file: FileMetadata }
  | { status: 'failed'; error: AppError };

const display = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

/** Untrusted ExifTool output is only ever rendered as React text, never as HTML. */
export function ReadResult({ state }: { state: ReadState }) {
  switch (state.status) {
    case 'idle':
      return <p>Choose any file to read its metadata with ExifTool.</p>;
    case 'reading':
      return <p aria-live="polite">Reading…</p>;
    case 'failed':
      return (
        <p role="alert">
          {state.error.kind}: {state.error.message}
        </p>
      );
    case 'read': {
      const { file } = state;
      return (
        <section aria-label="Metadata">
          {file.error && <p role="alert">ExifTool error: {file.error}</p>}
          {file.warnings.map((warning) => (
            <p key={warning}>ExifTool warning: {warning}</p>
          ))}
          <table>
            <caption>{file.sourceFile}</caption>
            <thead>
              <tr>
                <th scope="col">Group:Tag</th>
                <th scope="col">Value</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(file.tags).map(([key, value]) => (
                <tr key={key}>
                  <td>{key}</td>
                  <td>{display(value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      );
    }
  }
}

export function App() {
  const [state, setState] = useState<ReadState>({ status: 'idle' });

  const readFile = async () => {
    setState({ status: 'reading' });
    try {
      const file = await invoke<FileMetadata | null>('read_selected_file');
      setState(file ? { status: 'read', file } : { status: 'idle' });
    } catch (error) {
      setState({ status: 'failed', error: error as AppError });
    }
  };

  return (
    <main>
      <h1>ExifBee</h1>
      <button type="button" onClick={readFile} disabled={state.status === 'reading'}>
        Open file…
      </button>
      <ReadResult state={state} />
    </main>
  );
}
