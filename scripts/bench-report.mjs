// Pure logic of the performance report (S3-T06, SPEC §6.4): turns scenario results into metric
// statistics and compares them with a baseline. tests/performance/run.mjs does the running.

/** Alert when a median is this much slower than the baseline (SPEC §6.4's initial proposal). */
export const REGRESSION_THRESHOLD = 0.25;
/** Slowdowns smaller than this are timer noise on sub-millisecond metrics, whatever the ratio. */
const MIN_ALERT_MS = 1;

/** Nearest-rank percentile of ascending values. */
const percentile = (sorted, share) =>
  sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * share) - 1)];

export function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

/** `{ "<scenario>.<metric>": { unit, ...stats } }` for every timing and memory figure. */
export function metrics(scenarios) {
  const result = {};
  for (const { scenario, samplesMs, peakRssKiB, exiftoolPeakRssKiB, renderer } of scenarios) {
    for (const [name, samples] of Object.entries(samplesMs))
      result[`${scenario}.${name}`] = { unit: 'ms', ...stats(samples) };
    if (peakRssKiB) result[`${scenario}.peakRss`] = { unit: 'KiB', ...stats([peakRssKiB]) };
    if (exiftoolPeakRssKiB)
      result[`${scenario}.exiftoolPeakRss`] = { unit: 'KiB', ...stats([exiftoolPeakRssKiB]) };
    if (renderer)
      result[`${scenario}.rendererHeap`] = {
        unit: 'KiB',
        ...stats([Math.round(renderer.usedJSHeapBytes / 1024)]),
      };
  }
  return result;
}

/**
 * Metrics whose median is over `threshold` worse than the baseline's. These are alerts for a
 * person to investigate (the machine may be the cause), never proof that code regressed. Metrics
 * missing on either side are skipped.
 */
export function regressions(current, baseline, threshold = REGRESSION_THRESHOLD) {
  const found = [];
  for (const [name, now] of Object.entries(current)) {
    const before = baseline[name];
    if (!before) continue;
    const slack = now.unit === 'ms' ? MIN_ALERT_MS : 0;
    if (now.median > before.median * (1 + threshold) && now.median - before.median >= slack)
      found.push({ name, unit: now.unit, baseline: before.median, current: now.median });
  }
  return found;
}

/** Timings compare only between runs on the same machine. */
export const sameMachine = (a, b) => a.cpu === b.cpu && a.cores === b.cores;
/** Other work on the machine skews timings, so a busy start is flagged in the report. */
export const isBusy = ({ load1, cores }) => load1 > cores / 2;
