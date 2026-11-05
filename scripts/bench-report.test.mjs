import { describe, expect, it } from 'vitest';
import { isBusy, metrics, regressions, sameMachine, stats } from './bench-report.mjs';

const ms = (median) => ({ unit: 'ms', median });

// @req NFR-006, TST-005
describe('performance report', () => {
  it('reports the distribution, unaffected by sample order', () => {
    expect(stats([5, 1, 3])).toEqual({ n: 3, median: 3, p95: 5, min: 1, max: 5 });
    expect(stats([1, 2, 3, 4]).median).toBe(2);
    expect(stats(Array.from({ length: 100 }, (_, i) => i + 1)).p95).toBe(95);
  });

  it('names every timing and memory figure by scenario', () => {
    const result = metrics([
      {
        scenario: 'read_1k',
        samplesMs: { total: [2, 4, 6] },
        peakRssKiB: 10,
        exiftoolPeakRssKiB: 5,
      },
      { scenario: 'ui', samplesMs: {}, renderer: { usedJSHeapBytes: 2048 } },
    ]);
    expect(result['read_1k.total']).toMatchObject({ unit: 'ms', median: 4 });
    expect(result['read_1k.peakRss']).toMatchObject({ unit: 'KiB', median: 10 });
    expect(result['read_1k.exiftoolPeakRss']).toMatchObject({ median: 5 });
    expect(result['ui.rendererHeap']).toMatchObject({ unit: 'KiB', median: 2 });
  });

  it('alerts only past the threshold, ignoring sub-millisecond noise and missing metrics', () => {
    const baseline = {
      slower: ms(100),
      within: ms(100),
      faster: ms(100),
      tiny: ms(0.1),
      appeared: ms(0),
      memory: { unit: 'KiB', median: 1000 },
    };
    const found = regressions(
      {
        slower: ms(126),
        within: ms(125),
        faster: ms(50),
        tiny: ms(0.5), // five times slower, but under 1 ms
        appeared: ms(60), // a long task where there was none
        memory: { unit: 'KiB', median: 1300 },
        brandNew: ms(9999),
      },
      baseline,
    );
    expect(found.map(({ name }) => name)).toEqual(['slower', 'appeared', 'memory']);
    expect(found[0]).toEqual({ name: 'slower', unit: 'ms', baseline: 100, current: 126 });
  });

  it('tells when timings are comparable and when the machine was busy', () => {
    const machine = { cpu: 'X', cores: 8 };
    expect(sameMachine(machine, { cpu: 'X', cores: 8 })).toBe(true);
    expect(sameMachine(machine, { cpu: 'Y', cores: 8 })).toBe(false);
    expect(isBusy({ load1: 5, cores: 8 })).toBe(true);
    expect(isBusy({ load1: 3, cores: 8 })).toBe(false);
  });
});
