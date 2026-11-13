import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/atoms/Button';
import { Checkbox } from '../../components/atoms/Checkbox';
import { Notice } from '../../components/atoms/Notice';
import { Dialog } from '../../components/Dialog';
import { applyPlan, cancelRemovalPreview, planChanges } from '../../lib/ipc';
import type {
  ApplyResult,
  BackupPolicy,
  Outcome,
  PlannedChange,
  PlanPreview,
  StagedFile,
} from '../../lib/ipc';
import { toAppError } from '../../lib/errors';
import './PlanPreviewDialog.css';

type Props = {
  files: StagedFile[];
  /** Called with every outcome once ExifTool has run, even if the dialog was closed meanwhile. */
  onApplied: (result: ApplyResult) => void;
  onClose: () => void;
};

type State =
  | { phase: 'checking' }
  | { phase: 'ready'; plan: PlanPreview }
  | { phase: 'applying'; plan: PlanPreview }
  | { phase: 'done'; result: ApplyResult }
  | { phase: 'failed'; message: string };

const OUTCOME: Record<Outcome, string> = {
  changed: 'Changed and verified',
  mismatch: 'Written, but it does not read back as planned',
  unchanged: 'No change made',
  failed: 'Failed, the file is as it was',
  skipped: 'Skipped, the file is as it was',
};

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** `Group:Tag` → how many times it occurs, in first-seen order. */
function counted(keys: string[]) {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

function ChangeLine({ change }: { change: PlannedChange }) {
  return (
    <li>
      <strong>{change.target}</strong>{' '}
      {change.removes.length > 0 ? (
        <>
          removes {plural(change.removes.length, 'tag')}
          {/* All metadata can be hundreds of tags, many repeated: count repeats, fold the list. */}
          <details className="plan-removes">
            <summary>Show the tags</summary>
            <p className="muted" tabIndex={0}>
              {[...counted(change.removes)]
                .map(([key, count]) => (count > 1 ? `${key} ×${count}` : key))
                .join(', ')}
            </p>
          </details>
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
 * Review and approve (S4-T03, S4-T04; DEC-030, DEC-031): Rust re-checks every file and change
 * and shows what would happen; Apply runs exactly that plan, once. Backups are kept unless the
 * user unticks them and confirms; each file then reports its own outcome.
 */
export function PlanPreviewDialog({ files, onApplied, onClose }: Props) {
  const [state, setState] = useState<State>({ phase: 'checking' });
  const [keepBackups, setKeepBackups] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const live = useRef(true);
  const keep = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    live.current = true;
    let running = true;
    planChanges(files)
      .then(
        (plan) => live.current && setState({ phase: 'ready', plan }),
        (error: unknown) =>
          live.current && setState({ phase: 'failed', message: toAppError(error).message }),
      )
      .finally(() => (running = false));
    return () => {
      live.current = false;
      // Group removals are dry-run again while checking; closing stops that work.
      if (running) void cancelRemovalPreview().catch(() => undefined);
    };
  }, [files]);

  // The safe choice gets focus; this runs after the confirmation dialog's showModal.
  useEffect(() => {
    if (confirming) keep.current?.focus();
  }, [confirming]);

  const apply = (plan: PlanPreview, policy: BackupPolicy) => {
    setConfirming(false);
    setState({ phase: 'applying', plan });
    applyPlan(plan.planId, policy).then(
      (result) => {
        onApplied(result);
        if (live.current) setState({ phase: 'done', result });
      },
      (error: unknown) =>
        live.current && setState({ phase: 'failed', message: toAppError(error).message }),
    );
  };

  const plan = state.phase === 'ready' || state.phase === 'applying' ? state.plan : null;
  const ready = plan?.files.filter((file) => file.problems.length === 0).length ?? 0;
  const skipped = (plan?.files.length ?? 0) - ready;
  const result = state.phase === 'done' ? state.result : null;
  const count = (outcome: Outcome) =>
    result?.files.filter((file) => file.outcome === outcome).length ?? 0;

  return (
    <Dialog id="plan-preview" title="Review changes" open onClose={onClose}>
      <div className="plan">
        {state.phase === 'checking' && (
          <p role="status">Checking each file and change against the files as they are now…</p>
        )}
        {state.phase === 'failed' && <Notice tone="error">{state.message}</Notice>}
        {state.phase === 'ready' && (
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
        {state.phase === 'applying' && (
          <p role="status">
            Applying changes with ExifTool. Keep ExifBee open until this finishes…
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
            {file.backup && keepBackups && (
              <p className="muted">Backup of the original: {file.backup}</p>
            )}
          </section>
        ))}
        {result && (
          <>
            <p role="status">
              {[
                `${count('changed')} changed`,
                count('mismatch') > 0 && `${count('mismatch')} not as planned`,
                count('unchanged') > 0 && `${count('unchanged')} unchanged`,
                count('failed') > 0 && `${count('failed')} failed`,
                count('skipped') > 0 && `${count('skipped')} skipped`,
              ]
                .filter(Boolean)
                .join(', ')}
              .
            </p>
            {result.files.map((file) => (
              <section key={file.id} className="plan-file" aria-label={`Result for ${file.name}`}>
                <h3>{file.name}</h3>
                <p className={`plan-outcome plan-outcome-${file.outcome}`}>
                  <strong>{OUTCOME[file.outcome]}</strong>
                  {file.message && `: ${file.message}`}
                </p>
                {file.details.length > 0 && (
                  <ul className={file.outcome === 'mismatch' ? 'plan-differences' : 'muted'}>
                    {file.details.map((detail) => (
                      <li key={detail}>{detail}</li>
                    ))}
                  </ul>
                )}
                {file.backup && <p className="muted">Backup of the original: {file.backup}</p>}
                {file.warnings.map((warning) => (
                  <p key={warning} className="muted">
                    ExifTool warning: {warning}
                  </p>
                ))}
                {file.outcome === 'failed' && file.exitCode !== null && (
                  <p className="muted">ExifTool exit status {file.exitCode}</p>
                )}
              </section>
            ))}
          </>
        )}
        {plan && ready > 0 && (
          <>
            <Checkbox
              label="Keep a backup of each original (recommended)"
              checked={keepBackups}
              onChange={setKeepBackups}
            />
            {!keepBackups && (
              <Notice tone="warning">
                Without backups, ExifTool overwrites the originals: they cannot be restored from a
                backup.
              </Notice>
            )}
          </>
        )}
        {plan && ready === 0 && <p className="muted">Nothing can be applied.</p>}
        <div className="dialog-actions">
          <Button onClick={onClose}>{result ? 'Done' : 'Cancel'}</Button>
          {plan && (
            <Button
              className={keepBackups ? 'button-primary' : 'button-danger'}
              disabled={ready === 0 || state.phase === 'applying'}
              onClick={() => (keepBackups ? apply(plan, 'keepBackups') : setConfirming(true))}
            >
              {keepBackups ? `Apply to ${plural(ready, 'file')}` : 'Apply without backups…'}
            </Button>
          )}
        </div>
      </div>
      <Dialog
        id="overwrite-confirm"
        title="Apply without backups?"
        open={confirming}
        onClose={() => setConfirming(false)}
      >
        <p className="plan-confirm">
          ExifTool will overwrite {plural(ready, 'original file')}. {ready === 1 ? 'It' : 'They'}{' '}
          cannot be restored from a backup.
        </p>
        <div className="dialog-actions">
          <Button
            ref={keep}
            onClick={() => {
              setKeepBackups(true);
              setConfirming(false);
            }}
          >
            Keep backups
          </Button>
          <Button
            className="button-danger"
            onClick={() => plan && apply(plan, 'overwriteOriginals')}
          >
            Overwrite originals
          </Button>
        </div>
      </Dialog>
    </Dialog>
  );
}
