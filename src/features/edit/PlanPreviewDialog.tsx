import { useEffect, useState } from 'react';
import { Button } from '../../components/atoms/Button';
import { Notice } from '../../components/atoms/Notice';
import { Dialog } from '../../components/Dialog';
import { cancelRemovalPreview, planChanges } from '../../lib/ipc';
import type { PlannedChange, PlanPreview, StagedFile } from '../../lib/ipc';
import { toAppError } from '../../lib/errors';
import './PlanPreviewDialog.css';

type Props = { files: StagedFile[]; onClose: () => void };

type State =
  | { phase: 'checking' }
  | { phase: 'ready'; plan: PlanPreview }
  | { phase: 'failed'; message: string };

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

function ChangeLine({ change }: { change: PlannedChange }) {
  return (
    <li>
      <strong>{change.target}</strong>{' '}
      {change.removes.length > 0 ? (
        <>
          removes {plural(change.removes.length, 'tag')}:{' '}
          <span className="muted">{change.removes.join(', ')}</span>
        </>
      ) : (
        <>
          <span className="muted">
            {change.before === null ? '(new)' : change.before === '' ? '(empty)' : change.before} →
          </span>{' '}
          {change.after === null ? '(removed)' : change.after === '' ? '(empty)' : change.after}
        </>
      )}
    </li>
  );
}

/**
 * What applying the staged changes would do (S4-T03, DEC-030): Rust re-checks every file (still
 * the one inspected, writable, no leftovers) and every change against a fresh read, and the
 * diff shows values as they are now. Nothing is written; applying arrives with S4-T04/S4-T07.
 */
export function PlanPreviewDialog({ files, onClose }: Props) {
  const [state, setState] = useState<State>({ phase: 'checking' });

  useEffect(() => {
    let live = true;
    let running = true;
    planChanges(files)
      .then(
        (plan) => live && setState({ phase: 'ready', plan }),
        (error: unknown) =>
          live && setState({ phase: 'failed', message: toAppError(error).message }),
      )
      .finally(() => (running = false));
    return () => {
      live = false;
      // Group removals are dry-run again while checking; closing stops that work.
      if (running) void cancelRemovalPreview().catch(() => undefined);
    };
  }, [files]);

  const plan = state.phase === 'ready' ? state.plan : null;
  const ready = plan?.files.filter((file) => file.problems.length === 0).length ?? 0;
  const skipped = (plan?.files.length ?? 0) - ready;

  return (
    <Dialog id="plan-preview" title="Review changes" open onClose={onClose}>
      <div className="plan">
        {state.phase === 'checking' && (
          <p role="status">Checking each file and change against the files as they are now…</p>
        )}
        {state.phase === 'failed' && <Notice tone="error">{state.message}</Notice>}
        {plan && (
          <p role="status">
            <strong>{plural(ready, 'file')}</strong> would change
            {skipped > 0 && (
              <>
                ; <strong>{skipped}</strong> skipped
              </>
            )}
            .
          </p>
        )}
        {plan?.files.map((file) => (
          <section key={file.id} className="plan-file" aria-label={`Plan for ${file.name}`}>
            <h3>{file.name}</h3>
            <p className="muted plan-path">
              {file.link
                ? `${file.link} is a link; the real file changes: ${file.target}`
                : file.target}
            </p>
            {file.problems.length > 0 ? (
              <Notice tone="warning">
                Skipped, nothing will change in this file:
                <ul>
                  {file.problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </Notice>
            ) : (
              <ul className="plan-changes">
                {file.changes.map((change) => (
                  <ChangeLine key={change.target} change={change} />
                ))}
              </ul>
            )}
            {file.warnings.map((warning) => (
              <Notice key={warning} tone="warning">
                {warning}
              </Notice>
            ))}
            {file.backup && <p className="muted">Backup of the original: {file.backup}</p>}
          </section>
        ))}
        <p className="muted">Nothing has been written. Applying changes is not available yet.</p>
        <div className="dialog-actions">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    </Dialog>
  );
}
