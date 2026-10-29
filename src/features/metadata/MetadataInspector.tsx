import { ErrorNotice } from '../../components/ErrorNotice';
import type { AppError, FileMetadata } from '../../lib/ipc';
import { MetadataValueView } from './MetadataValueView';
import './MetadataInspector.css';

type Props = { file: FileMetadata | null; failure: AppError | null; reading: boolean };

/** Untrusted ExifTool output is only ever rendered as React text, never as HTML. */
export function MetadataInspector({ file, failure, reading }: Props) {
  if (failure) return <ErrorNotice error={failure} />;
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
          {file.tags.map((tag) => (
            <tr key={tag.key}>
              <th scope="row">{tag.key}</th>
              <td>
                <MetadataValueView value={tag.value} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
