import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/atoms/Button';
import { Dialog } from '../../components/Dialog';
import type { CopySelection, CopyTags, DeleteGroup, DeleteTag, SetTag } from '../../lib/ipc';
import './StagedChanges.css';

/** One staged change: a new value (S4-T01), a deleted tag or removed group (S4-T02), or a copy
 * from another file (S4-T06; `sourceName` is for display only). */
export type Change =
  | ({ kind: 'set' } & SetTag)
  | ({ kind: 'deleteTag' } & DeleteTag)
  /** `removed` is the `Group:Tag` of each tag the dry run found, for marking rows. */
  | ({ kind: 'deleteGroup'; removed: string[] } & DeleteGroup)
  | ({ kind: 'copyTags'; sourceName: string } & CopyTags);

export type StagedEdit = { fileId: string; fileName: string; edit: Change; before: string | null };

/** `all metadata`, `XMP-dc group`, `IFD0:Make`, `3 tags`. */
export const copyWhat = (what: CopySelection) =>
  what.kind === 'all'
    ? 'all metadata'
    : what.kind === 'group'
      ? `${what.group} group`
      : what.tags.length === 1
        ? `${what.tags[0]?.group}:${what.tags[0]?.name}`
        : `${what.tags.length} tags`;

/** What a change is about, e.g. `IFD0:Make`, `XMP-dc group`, `All metadata`, a copy. */
export const changeLabel = (edit: Change) =>
  edit.kind === 'copyTags'
    ? `Copy from ${edit.sourceName}: ${copyWhat(edit.what)}`
    : edit.kind !== 'deleteGroup'
      ? `${edit.group}:${edit.name}`
      : edit.group === 'All'
        ? 'All metadata'
        : `${edit.group} group`;

/** The key one staged change replaces: one change per file and tag, or per file and group. */
export const stagedKey = (fileId: string, edit: Change) => `${fileId}\n${changeLabel(edit)}`;

const shown = (edit: Change) => {
  if (edit.kind === 'copyTags') return '';
  if (edit.kind === 'deleteTag') return '(removed)';
  if (edit.kind === 'deleteGroup')
    return `removes ${edit.removed.length} ${edit.removed.length === 1 ? 'tag' : 'tags'}`;
  const { value } = edit;
  return value.kind === 'text'
    ? value.text === ''
      ? '(empty)'
      : value.text
    : value.items.join(', ');
};

type Props = {
  staged: StagedEdit[];
  onUndo: (item: StagedEdit) => void;
  onDiscardAll: () => void;
  /** Opens the plan: what applying the staged changes would do, checked in Rust. */
  onReview: () => void;
};

/**
 * Staged changes, grouped by file, each with Undo (S4-T01, S4-T02). Nothing here has been
 * written: applying them is the plan and confirmation step (S4-T03, S4-T07). Discarding more
 * than one change cannot be undone, so it asks first.
 */
export function StagedChanges({ staged, onUndo, onDiscardAll, onReview }: Props) {
  const [confirming, setConfirming] = useState(false);
  const keep = useRef<HTMLButtonElement>(null);
  // The safe choice gets focus; this runs after the dialog's own showModal (child effects first).
  useEffect(() => {
    if (confirming) keep.current?.focus();
  }, [confirming]);
  if (staged.length === 0)
    return (
      <p className="muted">No staged changes. Use Edit on a tag, Add tag or Remove to stage one.</p>
    );
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
                    <strong>{changeLabel(item.edit)}</strong>{' '}
                    {item.edit.kind === 'deleteGroup' && item.edit.group === 'All' && (
                      <span className="staged-high-impact">High impact </span>
                    )}
                    {item.edit.kind === 'deleteGroup' ||
                    item.edit.kind === 'copyTags' ? null : item.before === null ? (
                      <span className="muted">(new) </span>
                    ) : (
                      <span className="muted">
                        {item.before === '' ? '(empty)' : item.before} →{' '}
                      </span>
                    )}
                    {shown(item.edit)}
                  </span>
                  <Button
                    aria-label={`Undo ${changeLabel(item.edit)}`}
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
      <div className="staged-actions">
        <Button className="button-primary" onClick={onReview}>
          Review changes…
        </Button>
        <Button onClick={() => (staged.length > 1 ? setConfirming(true) : onDiscardAll())}>
          Discard all
        </Button>
      </div>
      <Dialog
        id="discard-staged"
        title="Discard all staged changes?"
        open={confirming}
        onClose={() => setConfirming(false)}
      >
        <p>
          {staged.length} staged changes for {files.length} {files.length === 1 ? 'file' : 'files'}{' '}
          will be discarded. This cannot be undone.
        </p>
        <div className="dialog-actions">
          <Button ref={keep} onClick={() => setConfirming(false)}>
            Keep changes
          </Button>
          <Button
            className="button-danger"
            onClick={() => {
              setConfirming(false);
              onDiscardAll();
            }}
          >
            Discard {staged.length} changes
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
