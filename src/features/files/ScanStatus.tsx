import { Button } from '../../components/atoms/Button';
import { Notice } from '../../components/atoms/Notice';
import type { ScanUpdate } from '../../lib/ipc';

type Props = { scan: ScanUpdate; stopping: boolean; onStop: () => void; onDismiss: () => void };

const number = (value: number) => value.toLocaleString('en-US');

/** Running totals, then an honest end state: complete, stopped (partial) or failed. */
export function scanSummary({ root, state, counts }: ScanUpdate) {
  const totals = [
    `${number(counts.added)} added`,
    counts.duplicates > 0 && `${number(counts.duplicates)} already listed`,
    counts.filtered > 0 && `${number(counts.filtered)} left out by options`,
    counts.skipped > 0 && `${number(counts.skipped)} skipped`,
  ]
    .filter(Boolean)
    .join(', ');
  switch (state) {
    case 'Running':
      return `Scanning ${root}… ${totals}`;
    case 'Complete':
      return `Scanned ${root}: ${totals}.`;
    case 'Cancelled':
      return `Scan of ${root} stopped before finishing: ${totals} so far.`;
    case 'Failed':
      return `Could not scan ${root}.`;
  }
}

/** One scan's banner: Stop while running, Dismiss once finished; the Log lists every skipped item. */
export function ScanStatus({ scan, stopping, onStop, onDismiss }: Props) {
  const running = scan.state === 'Running';
  return (
    <Notice
      tone={scan.state === 'Failed' ? 'error' : scan.state === 'Complete' ? 'info' : 'warning'}
      actions={
        running ? (
          <Button onClick={onStop} disabled={stopping}>
            {stopping ? 'Stopping…' : 'Stop'}
          </Button>
        ) : (
          <Button onClick={onDismiss}>Dismiss</Button>
        )
      }
    >
      {scanSummary(scan)}
      {!running && scan.counts.skipped > 0 && ' The Log lists each skipped item.'}
    </Notice>
  );
}
