import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkTraceability } from './check-spec-traceability.mjs';

const BASE_SPEC = `---
spec_version: 1.0.0
status: test
---

## 2. Requirements

| ID | Priority | Normative requirement | Evidence type |
|---|---|---|---|
| FR-001 | P0 | Discover tool | unit + integration |
| OPS-003 | P0 | No secrets in git | audit |
| FR-002 | P1 | DEPRECATED: replaced by FR-001 | integration |

## 7. Roadmap

- [x] **S0-T01 — Init.** **Acceptance:** works. **Evidence:** \`FR-001\`.
- [ ] **S0-T02 — Audit.** **Evidence:** \`OPS-003\`.
- [ ] ⏳ IN PROGRESS (agent, branch) **S0-T03 — Next.** **Evidence:** \`FR-001\`.

**Gate \`G0\` — accepted when S0-T01 is done.**

## 8. Notes

See \`FR-001\` and \`G0\`.
`;

// Annotation lines are assembled at runtime so the repository scan never reads these fixtures.
const tag = (ids) => ['//', '@' + 'req', ids].join(' ');
const source = (ids) => ({ path: 'src/a.test.ts', text: `${tag(ids)}\nit('x', () => {});\n` });

const check = (spec, sources = [source('FR-001')]) =>
  checkTraceability({ spec, specPath: 'SPEC.md', sources });

// @req OPS-002, TST-008
describe('checkTraceability', () => {
  it('passes a correct baseline without counting TODO requirements as missing', () => {
    expect(check(BASE_SPEC)).toEqual([]);
  });

  it('fails a checked automatable task that has no linked test', () => {
    const errors = check(BASE_SPEC, []);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/S0-T01.*FR-001/);
  });

  it('accepts a checked task whose evidence is manual/audit only', () => {
    const spec = BASE_SPEC.replace('- [ ] **S0-T02', '- [x] **S0-T02');
    expect(check(spec)).toEqual([]);
  });

  it('fails malformed and duplicate requirement definitions', () => {
    const malformed = BASE_SPEC.replace('| OPS-003 |', '| OPS-03 |');
    expect(check(malformed).join('\n')).toMatch(/malformed requirement ID "OPS-03"/);
    const duplicate = BASE_SPEC.replace('| OPS-003 |', '| FR-001 |');
    expect(check(duplicate).join('\n')).toMatch(/duplicate requirement ID FR-001/);
  });

  it('fails stale, deprecated and malformed annotations', () => {
    expect(check(BASE_SPEC, [source('FR-001, FR-999')]).join('\n')).toMatch(
      /unknown requirement FR-999/,
    );
    expect(check(BASE_SPEC, [source('FR-001 FR-002')]).join('\n')).toMatch(
      /deprecated requirement FR-002/,
    );
    expect(check(BASE_SPEC, [source('FR-001, fr-1')]).join('\n')).toMatch(
      /malformed requirement ID "fr-1"/,
    );
    expect(check(BASE_SPEC, [source('')]).join('\n')).toMatch(/names no requirement/);
  });

  it('fails invalid task status syntax', () => {
    for (const bad of [
      '- [X] **S0-T01 — Init.** **Evidence:** `FR-001`.',
      '- [ ] ⏳ IN PROGRESS **S0-T01 — Init.** **Evidence:** `FR-001`.',
      '- [x] ⛔ BLOCKED (tooling) **S0-T01 — Init.** **Evidence:** `FR-001`.',
      '- [ ] **S0-T1 — Init.** **Evidence:** `FR-001`.',
    ]) {
      const spec = BASE_SPEC.replace(/^- \[x\] \*\*S0-T01.*$/m, bad);
      expect(check(spec).join('\n'), bad).toMatch(/invalid task status line/);
    }
  });

  it('fails duplicate tasks and unknown task, gate and requirement references', () => {
    const duplicate = BASE_SPEC.replace('**S0-T02 — Audit', '**S0-T01 — Audit');
    expect(check(duplicate).join('\n')).toMatch(/duplicate task ID S0-T01/);
    const unknown = BASE_SPEC.replace('See `FR-001` and `G0`.', 'See `FR-404`, S9-T99 and `G7`.');
    const errors = check(unknown).join('\n');
    expect(errors).toMatch(/unknown requirement FR-404/);
    expect(errors).toMatch(/unknown task S9-T99/);
    expect(errors).toMatch(/unknown gate G7/);
  });

  it('fails missing frontmatter', () => {
    expect(check(BASE_SPEC.replace('spec_version: 1.0.0\n', '')).join('\n')).toMatch(/frontmatter/);
  });
});

// @req OPS-002, TST-008
describe('check-spec-traceability CLI', () => {
  it('passes on this repository', () => {
    const script = fileURLToPath(new URL('./check-spec-traceability.mjs', import.meta.url));
    const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });
});
