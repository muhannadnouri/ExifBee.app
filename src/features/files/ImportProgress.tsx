import { useEffect, useState } from 'react';
import { Button } from '../../components/atoms/Button';
import type { ReadCounts, ReadUpdate, ScanUpdate } from '../../lib/ipc';
import { describeScanOptions } from './AddFolderDialog';
import './ImportProgress.css';

/** One round of adding files: its folder scans and its background checking, from start to end. */
export type ImportRound = {
  id: number;
  scans: ScanUpdate[];
  /** The latest read run of this round, kept after it ends. */
  reads: ReadUpdate | null;
  /** Totals of earlier read runs in this round (a scan can start a new run after one ends). */
  readsBefore: ReadCounts;
};

export const NO_READS: ReadCounts = { done: 0, total: 0, errors: 0, warnings: 0, unsupported: 0 };

const number = (value: number) => value.toLocaleString('en-US');

export const isRunning = (round: ImportRound) =>
  round.scans.some((scan) => scan.state === 'Running') || round.reads?.state === 'Running';

/** Checking totals across the round's read runs. */
export function checked(round: ImportRound): ReadCounts {
  const now = round.reads?.counts ?? NO_READS;
  const before = round.readsBefore;
  return {
    done: before.done + now.done,
    total: before.total + now.total,
    errors: before.errors + now.errors,
    warnings: before.warnings + now.warnings,
    unsupported: before.unsupported + now.unsupported,
  };
}

/** How a finished round ended, in one sentence: for the card, the status and the Log. */
export function roundResult(round: ImportRound): {
  tone: 'info' | 'warning' | 'error';
  text: string;
} {
  const failedScan = round.scans.find((scan) => scan.state === 'Failed');
  if (failedScan) {
    const reason = failedScan.problems[0]?.reason;
    return {
      tone: 'error',
      text: `Could not scan ${failedScan.root}${reason ? `: ${reason}` : ''}.`,
    };
  }
  if (round.reads?.state === 'Failed')
    return {
      tone: 'error',
      text: `Files were not checked: ${round.reads.message ?? 'ExifTool is not available'}.`,
    };
  const counts = checked(round);
  const listed =
    round.scans.length > 0
      ? round.scans.reduce((sum, scan) => sum + scan.counts.added, 0)
      : counts.total;
  const stopped =
    round.scans.some((scan) => scan.state === 'Cancelled') || round.reads?.state === 'Cancelled';
  if (stopped)
    return {
      tone: 'warning',
      text: `Stopped: ${number(listed)} listed, ${number(counts.done)} checked. Selecting a file still reads it.`,
    };
  const problems = [
    counts.errors > 0 && `${number(counts.errors)} with errors`,
    counts.warnings > 0 && `${number(counts.warnings)} with warnings`,
    counts.unsupported > 0 && `${number(counts.unsupported)} unsupported`,
  ].filter(Boolean);
  return {
    tone: 'info',
    text: `Done: ${number(listed)} files added, ${number(counts.done)} checked${problems.length ? ` (${problems.join(', ')})` : ''}.`,
  };
}

type Props = {
  round: ImportRound;
  stopping: boolean;
  onCancel: () => void;
  onDismiss: () => void;
};

/**
 * Progress for adding files, above the file list where the files appear (DEC-023, NN/g progress
 * indicators): what is happening in words, a percent-done bar once the total is known, Cancel
 * while running, then a one-line result. A round without a folder scan appears only after 1 s,
 * so quick imports do not flash a card. Not a live region: the hidden status announces the start
 * and the result, not every update.
 */
export function ImportProgress({ round, stopping, onCancel, onDismiss }: Props) {
  const running = isRunning(round);
  // Only time spent running counts: a round that ends cleanly within 1 s never shows.
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!running) return;
    const timer = window.setTimeout(() => setLate(true), 1000);
    return () => window.clearTimeout(timer);
  }, [running]);
  const result = running ? null : roundResult(round);
  if (round.scans.length === 0 && !late && result?.tone !== 'warning' && result?.tone !== 'error')
    return null;

  const counts = checked(round);
  const [only] = round.scans;
  const title =
    round.scans.length === 0
      ? 'Checking new files'
      : only && round.scans.length === 1
        ? `Adding ${only.root}`
        : `Adding ${round.scans.length} folders`;

  return (
    <section
      className={`import-progress import-progress-${result?.tone ?? 'running'}`}
      aria-label="Adding files"
    >
      <div className="import-progress-head">
        <h3 title={title}>{title}</h3>
        {running ? (
          <Button onClick={onCancel} disabled={stopping}>
            {stopping ? 'Stopping…' : 'Cancel'}
          </Button>
        ) : (
          <Button onClick={onDismiss}>Dismiss</Button>
        )}
      </div>
      {result ? (
        <p role={result.tone === 'error' ? 'alert' : undefined}>{result.text}</p>
      ) : (
        <>
          {round.scans.map((scan) => {
            const { added, filtered, skipped } = scan.counts;
            const extra = [
              filtered > 0 && `${number(filtered)} left out`,
              skipped > 0 && `${number(skipped)} skipped`,
            ]
              .filter(Boolean)
              .join(', ');
            const prefix = round.scans.length > 1 ? `${scan.root}: ` : '';
            return (
              <p key={scan.scanId}>
                {prefix}
                {scan.state === 'Running' ? 'Finding files… ' : 'Found '}
                {number(added)} {scan.state === 'Running' ? 'found' : 'files'}
                {extra && `, ${extra}`}
              </p>
            );
          })}
          {counts.total > 0 ? (
            <div className="import-progress-check">
              <progress max={counts.total} value={counts.done} aria-label="Files checked" />
              <span>
                Checking {number(counts.done)} of {number(counts.total)}
              </span>
            </div>
          ) : (
            <p className="muted">Checking starts as files are found.</p>
          )}
          {only && <p className="muted">{describeScanOptions(only.options)}</p>}
        </>
      )}
    </section>
  );
}
