// Documentation and consistency claims, asserted instead of trusted.
//
// This repository's assurance rests on documents being true: the audit brief states a line count, the registry
// states which factories are live on which chain, the curve shape is duplicated in Solidity and JavaScript, and
// the CSP promise is written in two places. Every one of those drifted at least once. Each test below fails with
// a message that says what to change, so drift becomes a red build instead of an audit finding.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { SALE_CAP, VIRTUAL_TOKEN, TOKEN_SUPPLY, BASE_FEE_BPS, SNIPE_START_BPS, SNIPE_WINDOW_SECONDS, MODEL_VERSIONS } from '../packages/core/curve-model.mjs';
import { evmTestnets } from '../packages/core/networks.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFileSync(join(root, path), 'utf8');

// The audit brief counts "source lines" as non-blank lines that are not a `//` comment.
function sourceLines(path) {
  return read(path).split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('//')).length;
}

/** Reads `NAME = <number> [* 1e12 | ether];` from Solidity into a BigInt, ignoring comments. */
function solidityConstant(path, name) {
  // Comment lines carry prose such as "SALE_CAP = 1B x sqrt(10)...", so they must not be searched.
  const code = read(path).split(/\r?\n/)
    .filter(line => !line.trim().startsWith('//'))
    .map(line => line.replace(/\s\/\/.*$/, ''))
    .join('\n');
  const match = code.match(new RegExp(`${name}\\s*=\\s*([0-9_]+)\\s*(?:\\*\\s*1e12|ether)?`));
  assert.ok(match, `${name} not found in ${path}`);
  const whole = BigInt(match[1].replace(/_/g, ''));
  const scaled = /\*\s*1e12/.test(match[0]) ? 10n ** 12n : /ether/.test(match[0]) ? 10n ** 18n : 1n;
  return whole * scaled;
}

test('the audit brief lists exactly the in-scope files, at their real line counts', () => {
  const brief = read('docs/AUDIT_SCOPE.md');
  const rows = [...brief.matchAll(/^\|\s*`(contracts\/evm\/src\/[^`]+\.sol)`\s*\|\s*(\d+)\s*\|/gm)];
  assert.equal(rows.length, 9, 'AUDIT_SCOPE.md must list 9 in-scope files');

  let total = 0;
  const drift = [];
  for (const [, path, claimed] of rows) {
    assert.ok(existsSync(join(root, path)), `${path} is in the audit scope but does not exist`);
    const actual = sourceLines(path);
    if (actual !== Number(claimed)) drift.push(`${path}: brief says ${claimed}, file has ${actual}`);
    total += actual;
  }
  assert.deepEqual(drift, [], `source line counts drifted from docs/AUDIT_SCOPE.md:\n  ${drift.join('\n  ')}`);

  const headline = brief.match(/(\d+)\s+files,\s*(\d+)\s+source lines/);
  assert.ok(headline, 'the audit brief no longer states "<n> files, <n> source lines"');
  assert.equal(Number(headline[1]), rows.length, 'the headline file count disagrees with the table');
  assert.equal(Number(headline[2]), total, `the headline says ${headline[2]} source lines; the listed files total ${total}`);
});

test('Solidity and JavaScript agree on the curve shape', () => {
  const curve = 'contracts/evm/src/ElpidaDexCurve.sol';
  const factory = 'contracts/evm/src/ElpidaDexFactory.sol';

  assert.equal(solidityConstant(curve, 'SALE_CAP'), SALE_CAP, 'SALE_CAP differs between the EVM contract and packages/core');
  assert.equal(solidityConstant(curve, 'TOKEN_SUPPLY'), TOKEN_SUPPLY, 'TOKEN_SUPPLY differs between the EVM contract and packages/core');
  assert.equal(solidityConstant(factory, 'VIRTUAL_TOKEN'), VIRTUAL_TOKEN, 'VIRTUAL_TOKEN differs between the EVM contract and packages/core');

  assert.equal(solidityConstant(curve, 'FEE_BPS'), BigInt(BASE_FEE_BPS), 'the base fee differs between contract and packages/core');
  assert.equal(solidityConstant(curve, 'SNIPE_START_BPS'), BigInt(SNIPE_START_BPS), 'the anti-snipe start fee differs');
  assert.equal(solidityConstant(curve, 'SNIPE_WINDOW'), BigInt(SNIPE_WINDOW_SECONDS), 'the anti-snipe window differs');
});

test('the network registry cannot silently mis-describe a deployment', () => {
  const chainIds = new Set();
  for (const net of evmTestnets) {
    assert.ok(Number.isInteger(net.chainId) && net.chainId > 0, `${net.key} has no usable chainId`);
    assert.ok(!chainIds.has(net.chainId), `${net.key} reuses chainId ${net.chainId}`);
    chainIds.add(net.chainId);
    assert.ok(net.rpcUrl?.startsWith('https://'), `${net.key} needs an https rpcUrl`);
    assert.ok(net.nativeCurrency?.decimals > 0, `${net.key} needs nativeCurrency decimals`);

    if (!net.shared) continue;
    assert.match(net.shared.factory, /^0x[0-9a-fA-F]{40}$/, `${net.key} shared.factory is not an address`);
    assert.ok(Number.isInteger(net.shared.block) && net.shared.block > 0, `${net.key} shared.block is not a block number`);
    assert.ok(net.shared.model in MODEL_VERSIONS, `${net.key} names unknown model ${net.shared.model}`);

    for (const legacy of net.legacy ?? []) {
      assert.match(legacy.factory, /^0x[0-9a-fA-F]{40}$/, `${net.key} legacy factory is not an address`);
      assert.notEqual(legacy.factory.toLowerCase(), net.shared.factory.toLowerCase(), `${net.key} lists its shared factory as legacy too`);
      assert.ok(legacy.block < net.shared.block, `${net.key} legacy factory at block ${legacy.block} is not older than the shared factory at ${net.shared.block}`);
    }
  }
});

test('the CSP promise holds in the HTML and in the server header', () => {
  const html = read('apps/web/index.html');
  const inline = [...html.matchAll(/<script\b([^>]*)>/g)].filter(([, attributes]) => !/\bsrc=/.test(attributes));
  for (const [, attributes] of inline) {
    assert.match(attributes, /type="application\/ld\+json"/, `an executable inline <script${attributes}> breaks script-src 'self'`);
  }

  const server = read('apps/api/server.mjs');
  assert.match(server, /script-src 'self'/, "the server no longer sends script-src 'self'");
  assert.match(server, /style-src 'self'/, "the server no longer sends style-src 'self'");
});

test('every documentation link in the README resolves', () => {
  const readme = read('README.md');
  const links = [...readme.matchAll(/\]\((docs\/[^)\s]+)\)/g)].map(match => match[1]);
  const missing = links.filter(link => !existsSync(join(root, link)));
  assert.deepEqual(missing, [], `README links to missing files:\n  ${missing.join('\n  ')}`);
});

test('the test suite contains no skipped-by-default or vacuous tests', () => {
  const files = readdirSync(join(root, 'tests')).filter(name => name.endsWith('.test.mjs'));
  const problems = [];
  for (const file of files) {
    const source = read(`tests/${file}`);
    if (/\.only\s*\(/.test(source)) problems.push(`${file} uses .only, which silently reduces the suite`);
    if (/assert\.ok\(\s*true\s*\)/.test(source)) problems.push(`${file} asserts true`);
    if (!/\btest\s*\(/.test(source)) problems.push(`${file} declares no tests`);
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('every published fork report is complete, referenced and free of credentials', () => {
  const dir = join(root, 'docs', 'evidence');
  if (!existsSync(dir)) return;

  const prose = readdirSync(join(root, 'docs')).filter(name => name.endsWith('.md'))
    .map(name => read(`docs/${name}`)).join('\n') + read('README.md');
  const problems = [];

  for (const file of readdirSync(dir).filter(name => name.endsWith('.json'))) {
    const source = read(`docs/evidence/${file}`);
    let report;
    try { report = JSON.parse(source); } catch { problems.push(`${file}: not valid JSON`); continue; }

    if (report.kind === 'checklist-verification') {
      if (!Array.isArray(report.results) || report.results.length === 0) problems.push(`${file}: lists no results`);
      else {
        if (report.counts?.hashes !== report.results.length) problems.push(`${file}: counts.hashes disagrees with the results`);
        if (report.counts?.verified !== report.results.filter(entry => entry.verified).length) problems.push(`${file}: counts.verified disagrees with the results`);
        if (!report.results.every(entry => typeof entry.verified === 'boolean')) problems.push(`${file}: a result has no verified flag`);
      }
      if (!prose.includes(file)) problems.push(`${file}: no document mentions it, so nobody will find it`);
      continue;
    }

    if (!['PASS', 'FAIL'].includes(report.result)) problems.push(`${file}: result is ${report.result}`);
    if (!Number.isInteger(report.block) || report.block <= 0) problems.push(`${file}: no block number`);
    if (!Array.isArray(report.checks) || report.checks.length === 0) problems.push(`${file}: lists no checks`);
    if (!(report.network || report.chainId || report.upstreamChain)) problems.push(`${file}: no network identity`);
    if (!prose.includes(file)) problems.push(`${file}: no document mentions it, so nobody will find it`);

    // Committed evidence must not carry a provider URL with a key, or anything that looks like key material.
    if (/https?:\/\/[^\s"]*[?&](api[-_]?key|key|token)=/i.test(source)) problems.push(`${file}: contains a URL with a credential`);
    if (/private[_ ]?key|mnemonic/i.test(source)) problems.push(`${file}: mentions key material`);
    // A UTF-8 report read as Latin-1 shows up as mojibake; catch it before it lands in a review.
    if (/[Ã¢Ã¤Ã¶][\u0080-\u00bf\u2013\u2014\u20ac]/.test(source)) problems.push(`${file}: looks mis-encoded`);
  }

  assert.deepEqual(problems, [], problems.join('\n'));
});
test('the committed Slither report matches the counts the audit brief states', () => {
  const path = 'docs/security/slither-2026-10-25.json';
  if (!existsSync(join(root, path))) return;
  const text = read(path);
  const report = JSON.parse(text);
  const brief = read('docs/AUDIT_SCOPE.md');

  const claim = brief.match(/(\d+)\s+High,\s*(\d+)\s+Medium and\s*(\d+)\s+Low/);
  assert.ok(claim, 'the audit brief no longer states the finding counts');
  assert.deepEqual(
    [report.counts.High, report.counts.Medium, report.counts.Low],
    [Number(claim[1]), Number(claim[2]), Number(claim[3])],
    'the committed report and the audit brief disagree; rerun Slither or update the brief',
  );
  assert.equal(report.counts.total, report.results.length, 'the count summary disagrees with the listed findings');
  assert.match(report.compiler, /0\.8\.24/, 'the report must record the compiler that produced it');
  assert.ok(!/[A-Za-z]:\\/.test(text), 'the report leaks an absolute path');
});

test('the committed Solana binaries are the ones the human-actions note describes', () => {
  const note = read('docs/HUMAN_ACTIONS.md');
  const recorded = [...note.matchAll(/\b[0-9a-f]{64}\b/g)].map(match => match[0]);
  assert.ok(recorded.length > 0, 'the note no longer records a build hash');

  for (const path of ['contracts/solana/build/elpida_launchpad.so', 'contracts/solana/build/elpida_launchpad-mainnet.so']) {
    const actual = createHash('sha256').update(readFileSync(join(root, path))).digest('hex');
    assert.ok(recorded.includes(actual), `${path} does not match any hash in docs/HUMAN_ACTIONS.md (${actual.slice(0, 16)}…). Rebuild or update the note.`);
  }
});

test('every npm script the CI workflow calls exists', () => {
  const workflowDir = join(root, '.github', 'workflows');
  if (!existsSync(workflowDir)) return;
  const scripts = JSON.parse(read('package.json')).scripts ?? {};
  const missing = [];
  for (const file of readdirSync(workflowDir).filter(name => name.endsWith('.yml') || name.endsWith('.yaml'))) {
    const workflow = readFileSync(join(workflowDir, file), 'utf8');
    for (const match of workflow.matchAll(/npm run ([a-z][\w:-]*)/g)) {
      if (!(match[1] in scripts)) missing.push(`${file} calls "npm run ${match[1]}", which package.json does not define`);
    }
  }
  assert.deepEqual(missing, [], missing.join('\n'));
});
