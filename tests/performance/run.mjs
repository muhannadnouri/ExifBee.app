#!/usr/bin/env node
// Performance baseline (S3-T06, SPEC §6.4): runs every scenario, records the environment, writes
// bench-results/metadata-<time>.json and compares medians with a baseline from the same machine.
// Usage: npm run bench:metadata [-- --update-baseline] [--fail-on-regression] [--baseline <file>]
// Alerts are for a person to investigate; only --fail-on-regression turns them into an exit code.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBusy, metrics, regressions, sameMachine } from '../../scripts/bench-report.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const RUST_SCENARIOS = ['scan_1k', 'scan_10k', 'read_1k', 'read_10k'];
const CARGO_TEST = [
  'test',
  '--release',
  '--manifest-path',
  'src-tauri/Cargo.toml',
  '--test',
  'bench_metadata',
];

const args = process.argv.slice(2);
const baselineAt = args.indexOf('--baseline');
const baselinePath =
  baselineAt >= 0 ? args[baselineAt + 1] : join(ROOT, 'tests/performance/baseline.json');

function run(command, commandArgs, env = {}) {
  console.log(`\n$ ${command} ${commandArgs.join(' ')}`);
  const { status } = spawnSync(command, commandArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (status !== 0) {
    console.error(`benchmark step failed with status ${status}`);
    process.exit(1);
  }
}

const output = (command, commandArgs) =>
  spawnSync(command, commandArgs, { cwd: ROOT, encoding: 'utf8' }).stdout?.trim() ?? '';

function environment() {
  const [load1] = os.loadavg();
  const distro = readFileSync('/etc/os-release', 'utf8').match(/^PRETTY_NAME="?([^"\n]*)/m)?.[1];
  return {
    cpu: os.cpus()[0]?.model.trim(),
    cores: os.cpus().length,
    memoryGiB: Math.round(os.totalmem() / 1024 ** 3),
    os: `${distro} (${os.release()})`,
    load1: Math.round(load1 * 10) / 10,
    node: process.version,
    rust: output('rustc', ['-V']),
    commit: output('git', ['rev-parse', 'HEAD']),
    dirty: output('git', ['status', '--porcelain']) !== '',
    fixturesSha256: createHash('sha256')
      .update(readFileSync(join(ROOT, 'tests/fixtures/SHA256SUMS')))
      .digest('hex'),
  };
}

const env = environment();
const raw = mkdtempSync(join(os.tmpdir(), 'exifbee-bench-'));
const benchEnv = { EXIFBEE_BENCH_OUT: raw };

run('cargo', [...CARGO_TEST, '--no-run']);
for (const scenario of RUST_SCENARIOS)
  run('cargo', [...CARGO_TEST, '--', '--ignored', '--exact', scenario], benchEnv);
run('node', ['tests/performance/filter.bench.mjs', raw]);
run(
  'npx',
  ['playwright', 'test', '--config', 'tests/performance/playwright.bench.config.ts'],
  benchEnv,
);

const scenarios = readdirSync(raw).map((name) => JSON.parse(readFileSync(join(raw, name), 'utf8')));
const read = scenarios.find(({ scenario }) => scenario === 'read_1k')?.extra;
const report = {
  environment: { ...env, exiftool: read?.exiftool, exiftoolPath: read?.exiftoolPath },
  metrics: metrics(scenarios),
  scenarios,
};

mkdirSync(join(ROOT, 'bench-results'), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = join(ROOT, 'bench-results', `metadata-${stamp}.json`);
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log('\nmetric                                      median       p95  unit');
for (const [name, { median, p95, unit }] of Object.entries(report.metrics))
  console.log(
    `${name.padEnd(42)} ${String(median).padStart(8)} ${String(p95).padStart(9)}  ${unit}`,
  );
console.log(`\nMachine: ${JSON.stringify(report.environment)}`);
if (isBusy(env))
  console.log(
    `NOTE: load average ${env.load1} on ${env.cores} cores at the start: timings are likely inflated.`,
  );
console.log(`Report: ${reportPath}`);

let alerts = [];
if (existsSync(baselinePath)) {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  if (sameMachine(env, baseline.environment)) {
    alerts = regressions(report.metrics, baseline.metrics);
    for (const { name, unit, baseline: before, current } of alerts)
      console.log(
        `ALERT: ${name} median ${before} → ${current} ${unit}: investigate (machine or code?)`,
      );
    console.log(`${alerts.length} alert(s) against ${baselinePath}`);
  } else {
    console.log(`Baseline is from another machine (${baseline.environment.cpu}): not compared.`);
  }
}
if (args.includes('--update-baseline')) {
  writeFileSync(
    baselinePath,
    `${JSON.stringify({ environment: report.environment, metrics: report.metrics }, null, 2)}\n`,
  );
  console.log(`Baseline written: ${baselinePath}`);
}
if (args.includes('--fail-on-regression') && alerts.length > 0) process.exit(1);
