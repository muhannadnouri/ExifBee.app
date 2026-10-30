import type { AppError, FileMetadata, ImportedFile } from '../../lib/ipc';
import './FilePane.css';

type Props = {
  files: ImportedFile[];
  reads: Record<string, FileMetadata>;
  failures: Record<string, AppError>;
  selected: string | null;
  onSelect: (file: ImportedFile) => void;
};

/** Files added in this session, any format, with the full path as each one's accessible name. */
export function FilePane({ files, reads, failures, selected, onSelect }: Props) {
  if (files.length === 0)
    return <p className="muted">No files yet. Use Add files… or drop files onto the window.</p>;
  return (
    <ul className="file-list">
      {files.map((file) => {
        const read = reads[file.id];
        const flag =
          failures[file.id] || read?.error
            ? ' (error)'
            : read && read.warnings.length > 0
              ? ' (warning)'
              : '';
        return (
          <li key={file.id}>
            <button
              type="button"
              aria-label={file.path + flag}
              aria-current={file.id === selected ? 'true' : undefined}
              title={file.path}
              onClick={() => onSelect(file)}
            >
              {file.name}
              {flag && <span className="file-flag">{flag}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
