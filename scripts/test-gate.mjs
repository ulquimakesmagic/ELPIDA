// Test gate: runs the Node test runner and refuses to report success when tests did not run.
//
// `node --test` exits 0 when every test it could run passed, even if half of them were skipped because a
// toolchain was missing. That is how the Solana program could ship with 28 of 29 tests skipped and a green
// dashboard. This wrapper reads the TAP stream instead of the exit code:
//
//   - any `not ok` or a non-zero `# fail` count            -> exit 1
//   - any skip whose reason is not a known missing tool     -> exit 2
//   - environmental skips (no Solana CLI / no cargo)        -> exit 2 only with --strict, otherwise warned
//   - a run that produced no summary (crash, hang, kill)    -> exit 4
//
// Usage:
//   node scripts/test-gate.mjs [files or directories...] [--strict] [--verbose]
// With no arguments it runs every tests/*.test.mjs.

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const argv = process.argv.slice(2);
const strict = argv.includes('--strict');
const verbose = argv.includes('--verbose');
const targets = argv.filter(arg => !arg.startsWith('--'));

// A skip is environmental only when a specific tool is absent. Anything else is a real gap and fails the gate.
const ENVIRONMENTAL = [
  /solana-test-validator not found/i,
  /solana cli not found/i,
  /cargo not found/i,
  /no solana validator/i,
];

function collect(paths) {
  const files = [];
  for (const target of paths) {
    const full = resolve(root, target);
    if (statSync(full).isDirectory()) {
      for (const name of readdirSync(full).filter(name => name.endsWith('.test.mjs')).sort()) files.push(join(full, name));
    } else files.push(full);
  }
  return files;
}

// The TAP reporter does not say which file a test belongs to, so map test names back to their file. A name that
// cannot be resolved is reported as (unknown) rather than guessed.
function indexTestNames(files) {
  const index = new Map();
  for (const file of files) {
    let source = '';
    try { source = readFileSync(file, 'utf8'); } catch { continue; }
    for (const match of source.matchAll(/\btest\(\s*(['"`])(.+?)\1/g)) {
      if (!index.has(match[2])) index.set(match[2], file);
    }
  }
  return index;
}

const files = collect(targets.length ? targets : ['tests']);
const nameIndex = indexTestNames(files);

if (!files.length) {
  console.error('test gate: no test files found');
  process.exit(3);
}

const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...files], {
  cwd: root,
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let buffer = '';
child.stdout.on('data', chunk => { buffer += chunk.toString('utf8'); });
child.stderr.on('data', chunk => { if (verbose) process.stderr.write(chunk); });

child.on('close', code => {
  const lines = buffer.split(/\r?\n/);
  if (verbose) process.stdout.write(buffer);

  const summary = { tests: 0, pass: 0, fail: 0, skipped: 0, found: false };
  const skips = [];
  const failures = [];
  let currentFile = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fileHeader = line.match(/^# Subtest: (.+\.test\.mjs)\s*$/);
    if (fileHeader) currentFile = fileHeader[1];

    const counts = line.match(/^# (tests|pass|fail|skipped)\s+(\d+)\s*$/);
    if (counts) { summary[counts[1]] = Number(counts[2]); summary.found = true; }

    if (/^\s*not ok \d+/.test(line)) {
      // TAP writes `not ok <n> - <name>`, but the separator is optional in the wild; strip whatever is there so the
      // report always shows the test name and never the raw status line.
      const name = line.replace(/^\s*not ok\s+\d+\s*[-–]?\s*/, '').replace(/\s*#.*$/, '').trim();
      failures.push({ file: nameIndex.get(name) ?? currentFile, name: name || line.trim(), line, at: index });
    }

    const skip = line.match(/^\s*ok \d+ - (.*?) # SKIP(?: (.*))?$/);
    if (skip) {
      const reason = (skip[2] ?? '').trim();
      const name = skip[1].trim();
      skips.push({ file: nameIndex.get(name) ?? currentFile, name, reason, environmental: ENVIRONMENTAL.some(pattern => pattern.test(reason)) });
    }
  }

  const unexpected = skips.filter(skip => !skip.environmental);
  const environmental = skips.filter(skip => skip.environmental);
  const failed = summary.fail > 0 || failures.length > 0;

  const report = [
    '',
    `test gate: ${summary.tests} tests, ${summary.pass} passed, ${summary.fail} failed, ${skips.length} skipped`,
    `           ${files.length} file(s)${strict ? ' (strict)' : ''}`,
  ];

  if (environmental.length) {
    report.push(`WARNING: ${environmental.length} test(s) skipped because a tool is missing:`);
    for (const skip of environmental.slice(0, 5)) report.push(`  - ${short(skip.file)} ${skip.name}: ${skip.reason}`);
    if (environmental.length > 5) report.push(`  ... and ${environmental.length - 5} more`);
    report.push('  Install the Solana CLI and cargo, then run with --strict to require them.');
  }

  if (unexpected.length) {
    report.push(`FAIL: ${unexpected.length} unexpected skip(s) - these tests did not run for no recorded toolchain reason:`);
    for (const skip of unexpected.slice(0, 10)) report.push(`  - ${short(skip.file)} ${skip.name}: ${skip.reason || 'no reason given'}`);
  }

  if (failed) {
    report.push(`FAIL: ${summary.fail || failures.length} failing test(s):`);
    for (const failure of failures.slice(0, 5)) {
      report.push(`  - ${short(failure.file)} ${failure.name || failure.line.trim()}`);
      for (const detail of lines.slice(failure.at + 1, failure.at + 25)) {
        if (/^\s*(not ok|ok) \d+/.test(detail)) break;
        if (detail.trim()) report.push(`      ${detail.trim()}`);
      }
    }
  }

  if (!summary.found) {
    report.push('FAIL: the run produced no TAP summary - the suite crashed or was killed before finishing.');
  }

  console.log(report.join('\n'));

  if (failed) process.exit(1);
  if (!summary.found) process.exit(4);
  if (unexpected.length) process.exit(2);
  if (strict && environmental.length) process.exit(2);
  if (code !== 0) process.exit(code ?? 1);
  process.exit(0);
});

function short(file) {
  if (!file) return '(unknown)';
  return file.replace(/\\/g, '/').replace(root.replace(/\\/g, '/'), '');
}
