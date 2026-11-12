import { Button } from '../../components/atoms/Button';
import type { SetTag } from '../../lib/ipc';
import './StagedChanges.css';

export type StagedEdit = { fileId: string; fileName: string; edit: SetTag; before: string | null };

/** The key one staged change replaces: one change per file and `Group:Tag`. */
export const stagedKey = (fileId: string, { group, name }: SetTag) => `${fileId}\n${group}:${name}`;

const shown = ({ value }: SetTag) =>
  value.kind === 'text' ? (value.text === '' ? '(empty)' : value.text) : value.items.join(', ');

type Props = {
  staged: StagedEdit[];
  onUndo: (item: StagedEdit) => void;
  onDiscardAll: () => void;
};

/**
 * Staged changes, grouped by file, each with Undo (S4-T01). Nothing here has been written:
 * applying them is the plan and confirmation step (S4-T03, S4-T07).
 */
export function StagedChanges({ staged, onUndo, onDiscardAll }: Props) {
  if (staged.length === 0)
    return <p className="muted">No staged changes. Use Edit on a tag, or Add tag, to stage one.</p>;
  const files = [...new Set(staged.map((item) => item.fileId))];
  return (
    <div className="staged">
      <p className="muted">
        Nothing is written yet: staged changes are applied after you review a plan.
      </p>
      {files.map((fileId) => {
        const items = staged.filter((item) => item.fileId === fileId);
        return (
          <section key={fileId} aria-label={`Staged for ${items[0]?.fileName}`}>
            <h3>{items[0]?.fileName}</h3>
            <ul>
              {items.map((item) => (
                <li key={stagedKey(fileId, item.edit)}>
                  <span className="staged-change">
                    <strong>
                      {item.edit.group}:{item.edit.name}
                    </strong>{' '}
                    {item.before === null ? (
                      <span className="muted">(new) </span>
                    ) : (
                      <span className="muted">
                        {item.before === '' ? '(empty)' : item.before} →{' '}
                      </span>
                    )}
                    {shown(item.edit)}
                  </span>
                  <Button
                    aria-label={`Undo ${item.edit.group}:${item.edit.name}`}
                    onClick={() => onUndo(item)}
                  >
                    Undo
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <Button onClick={onDiscardAll}>Discard all</Button>
    </div>
  );
}
