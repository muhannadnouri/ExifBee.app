import { describe, expect, it } from 'vitest';
import { collect, requirementsFor } from './collect-test-evidence.mjs';

// Annotation lines are assembled at runtime so the traceability scan never reads these samples.
const tag = (ids) => ['//', '@' + 'req', ids].join(' ');
const source = [
  tag('FR-005, TST-002'),
  '#[test]',
  'fn reads_things() {}',
  '',
  '#[test]',
  'fn unannotated() {}',
].join('\n');

const record = (test, status = 'passed') => ({ suite: 'read_metadata', test, status });

// @req TST-008, OPS-001
describe('collect-test-evidence', () => {
  it('takes requirement IDs from the comment above the test, skipping attributes', () => {
    expect(requirementsFor(source, 'reads_things')).toEqual(['FR-005', 'TST-002']);
    expect(requirementsFor(source, 'unannotated')).toEqual([]);
    expect(requirementsFor(source, 'missing')).toEqual([]);
  });

  it('joins records with their requirements and reports gaps and failures', () => {
    const report = collect({
      records: [record('unannotated'), record('reads_things'), record('reads_things', 'failed')],
      sources: { read_metadata: source },
    });
    expect(report.records[0]).toMatchObject({
      test: 'reads_things',
      requirements: ['FR-005', 'TST-002'],
    });
    expect(report.errors).toEqual([
      'read_metadata::unannotated has no @req requirement IDs',
      'read_metadata::reads_things failed',
    ]);
  });
});
