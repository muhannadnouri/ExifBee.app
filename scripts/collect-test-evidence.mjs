#!/usr/bin/env node
// Joins the per-test evidence records written by the Rust harness (EXIFBEE_EVIDENCE_DIR) with the
// requirement IDs from each test's `@req` comment, so IDs live only in the test source (SPEC §12.1
// TestEvidence). Usage: node scripts/collect-test-evidence.mjs <evidence-dir> <report.json>
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG = '@' + 'req';

/** Requirement IDs on the comment line(s) above `fn <test>(`, skipping attributes. */
export function requirementsFor(source, test) {
  const lines = source.split('\n');
  const index = lines.findIndex((line) => new RegExp(`^\\s*fn ${test}\\s*\\(`).test(line));
  if (index < 0) return [];
  for (let i = index - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('#[')) continue;
    const match = line.match(new RegExp(`^//\\s*${TAG}\\s+(.*)$`));
    return match ? match[1].split(/[\s,]+/).filter(Boolean) : [];
  }
  return [];
}

/**
 * @param {{ records: object[], sources: Record<string, string> }} input
 * @returns {{ records: object[], errors: string[] }}
 */
export function collect({ records, sources }) {
  const errors = [];
  const joined = records.map((record) => {
    const source = sources[record.suite];
    const requirements = source ? requirementsFor(source, record.test) : [];
    if (requirements.length === 0) {
      errors.push(`${record.suite}::${record.test} has no ${TAG} requirement IDs`);
    }
    if (record.status !== 'passed') errors.push(`${record.suite}::${record.test} ${record.status}`);
    return { ...record, requirements };
  });
  joined.sort((a, b) => `${a.suite}::${a.test}`.localeCompare(`${b.suite}::${b.test}`));
  return { records: joined, errors };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, out] = process.argv.slice(2);
  if (!dir || !out) {
    console.error('usage: collect-test-evidence.mjs <evidence-dir> <report.json>');
    process.exit(2);
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const records = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));
  const sources = Object.fromEntries(
    [...new Set(records.map((record) => record.suite))].map((suite) => {
      try {
        return [suite, readFileSync(join(root, 'src-tauri', 'tests', `${suite}.rs`), 'utf8')];
      } catch {
        return [suite, ''];
      }
    }),
  );
  const report = collect({ records, sources });
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(
    `test evidence: ${report.records.length} records, ${report.errors.length} problem(s)`,
  );
  if (report.errors.length > 0) {
    console.error(report.errors.join('\n'));
    process.exit(1);
  }
}
