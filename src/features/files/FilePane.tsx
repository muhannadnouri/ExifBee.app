import type { FileMetadata } from '../../lib/ipc';
import './FilePane.css';

const baseName = (path: string) => path.split('/').pop() || path;

type Props = {
  files: FileMetadata[];
  selected: string | null;
  onSelect: (sourceFile: string) => void;
};

/** Files read in this session; any format is listed, with the full path as its accessible name. */
export function FilePane({ files, selected, onSelect }: Props) {
  if (files.length === 0) return <p className="muted">No files yet. Use Add files… to start.</p>;
  return (
    <ul className="file-list">
      {files.map((file) => {
        const flag = file.error ? ' (error)' : file.warnings.length > 0 ? ' (warning)' : '';
        return (
          <li key={file.sourceFile}>
            <button
              type="button"
              aria-label={file.sourceFile + flag}
              aria-current={file.sourceFile === selected ? 'true' : undefined}
              title={file.sourceFile}
              onClick={() => onSelect(file.sourceFile)}
            >
              {baseName(file.sourceFile)}
              {flag && <span className="file-flag">{flag}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
