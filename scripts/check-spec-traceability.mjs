#!/usr/bin/env node
// Validates the SDD (docs/SPEC.md) and requirement annotations in code. Rules: SPEC §0.3 and §0.5.
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQ_ID = /^(?:FR|UX|SEC|NFR|OPS|PKG|TST)-\d{3}$/;
const REQ_REF = /\b(?:FR|UX|SEC|NFR|OPS|PKG|TST)-\d+\b/g;
const TASK_REF = /\bS\d-T\d+\b/g;
const TASK_LINE =
  /^- \[( |x)\] (?:(⏳ IN PROGRESS|⛔ BLOCKED) \([^)]+\) )?\*\*(S\d-T\d{2}) — .*\*\*Evidence:\*\*(.*)$/;
// An annotation is a comment line whose text starts with the tag, e.g. `// @req FR-001, SEC-002`.
const ANNOTATION = /^\s*(?:\/\/+|\/\*+|\*|#)\s*@req\b(.*)$/;
// Evidence types a test runner can prove; purely manual/audit/review evidence is exempt.
const AUTOMATABLE =
  /unit|integration|e2e|\bui\b|\bci\b|test|benchmark|traceability|adversarial|screenshot|a11y|perf|smoke|matrix/i;

const cells = (line) =>
  line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());

/**
 * @param {{ spec: string, specPath: string, sources: { path: string, text: string }[] }} input
 * @returns {string[]} error messages, empty when the spec and annotations are consistent
 */
export function checkTraceability({ spec, specPath, sources }) {
  const errors = [];
  const at = (line, message) => errors.push(`${specPath}:${line}: ${message}`);
  const lines = spec.split('\n');

  if (!/^---\n[\s\S]*?^spec_version: \d+\.\d+\.\d+$[\s\S]*?^status: .+$[\s\S]*?^---$/m.test(spec)) {
    at(1, 'frontmatter must start the file and declare spec_version (x.y.z) and status');
  }

  const requirements = new Map();
  const tasks = new Map();
  const gates = new Set();
  let section = 0;

  lines.forEach((line, index) => {
    const n = index + 1;
    const heading = /^## (\d+)\./.exec(line);
    if (heading) section = Number(heading[1]);

    for (const gate of line.matchAll(/\*\*Gate `(G\d)`/g)) gates.add(gate[1]);

    if (section === 2 && line.startsWith('|')) {
      const [id, , text = '', evidence = ''] = cells(line);
      if (id === 'ID' || /^-+$/.test(id)) return;
      if (!REQ_ID.test(id)) return at(n, `malformed requirement ID "${id}"`);
      if (requirements.has(id)) return at(n, `duplicate requirement ID ${id}`);
      requirements.set(id, { evidence, deprecated: text.startsWith('DEPRECATED:') });
    }

    if (section === 7 && line.startsWith('- [')) {
      const task = TASK_LINE.exec(line);
      if (!task || (task[1] === 'x' && task[2])) {
        return at(n, 'invalid task status line (see SPEC §0.2 task states)');
      }
      const [, mark, , id, evidence] = task;
      if (tasks.has(id)) return at(n, `duplicate task ID ${id}`);
      tasks.set(id, { line: n, done: mark === 'x', evidence: evidence.match(REQ_REF) ?? [] });
    }
  });

  lines.forEach((line, index) => {
    const n = index + 1;
    for (const [id] of line.matchAll(REQ_REF)) {
      if (REQ_ID.test(id) && !requirements.has(id)) at(n, `reference to unknown requirement ${id}`);
    }
    for (const [id] of line.matchAll(TASK_REF)) {
      if (!tasks.has(id)) at(n, `reference to unknown task ${id}`);
    }
    for (const [, id] of line.matchAll(/`(G\d)`/g)) {
      if (!gates.has(id)) at(n, `reference to unknown gate ${id}`);
    }
  });

  // shortcut: any annotated code line counts as a linked test; review still judges assertion quality (§0.3 rule 2).
  const annotated = new Set();
  for (const { path, text } of sources) {
    text.split('\n').forEach((line, index) => {
      const match = ANNOTATION.exec(line);
      if (!match) return;
      const where = `${path}:${index + 1}`;
      const ids = match[1]
        .replace(/\*\/.*$/, '')
        .split(/[\s,]+/)
        .filter(Boolean);
      if (ids.length === 0) errors.push(`${where}: annotation names no requirement`);
      for (const id of ids) {
        const requirement = requirements.get(id);
        if (!REQ_ID.test(id)) errors.push(`${where}: malformed requirement ID "${id}"`);
        else if (!requirement) errors.push(`${where}: annotation of unknown requirement ${id}`);
        else if (requirement.deprecated)
          errors.push(`${where}: annotation of deprecated requirement ${id}`);
        else annotated.add(id);
      }
    });
  }

  for (const [id, task] of tasks) {
    if (!task.done) continue;
    const automatable = task.evidence.filter((req) =>
      AUTOMATABLE.test(requirements.get(req)?.evidence ?? ''),
    );
    if (automatable.length > 0 && !automatable.some((req) => annotated.has(req))) {
      at(task.line, `${id} is checked but no test is annotated with ${automatable.join(', ')}`);
    }
  }

  return errors;
}

const CODE_DIRS = ['src', 'src-tauri/src', 'src-tauri/tests', 'tests', 'scripts'];
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.rs']);

function readSources(root) {
  return CODE_DIRS.flatMap((dir) => {
    let entries;
    try {
      entries = readdirSync(join(root, dir), { recursive: true, withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.isFile() && CODE_EXTENSIONS.has(extname(entry.name)))
      .map((entry) => join(entry.parentPath, entry.name))
      .filter((file) => !/[\\/](node_modules|target)[\\/]/.test(file))
      .map((file) => ({ path: relative(root, file), text: readFileSync(file, 'utf8') }));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const specPath = 'docs/SPEC.md';
  const errors = checkTraceability({
    spec: readFileSync(join(root, specPath), 'utf8'),
    specPath,
    sources: readSources(root),
  });
  if (errors.length > 0) {
    console.error(errors.join('\n'));
    console.error(`spec traceability: ${errors.length} error(s)`);
    process.exit(1);
  }
  console.log('spec traceability: OK');
}
