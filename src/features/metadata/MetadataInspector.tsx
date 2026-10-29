import type { AppError, FileMetadata } from '../../lib/ipc';
import './MetadataInspector.css';

const display = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

type Props = { file: FileMetadata | null; failure: AppError | null; reading: boolean };

/** Untrusted ExifTool output is only ever rendered as React text, never as HTML. */
export function MetadataInspector({ file, failure, reading }: Props) {
  if (failure) {
    return (
      <p role="alert" className="notice notice-error">
        {failure.message}
      </p>
    );
  }
  if (!file) {
    return (
      <p className="muted">
        {reading
          ? 'Reading…'
          : 'Add a file (Ctrl+O) to inspect its metadata. Any format ExifTool recognizes works, not only photos.'}
      </p>
    );
  }
  return (
    <>
      {file.error && (
        <p role="alert" className="notice notice-error">
          ExifTool error: {file.error}
        </p>
      )}
      {file.warnings.map((warning) => (
        <p key={warning} className="notice notice-warning">
          ExifTool warning: {warning}
        </p>
      ))}
      <table className="tags">
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
    </>
  );
}
