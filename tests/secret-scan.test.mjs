import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { scanLine, runScan } from '../scripts/secret-scan.mjs';

// Fake values are assembled at runtime so this file never matches its own patterns.
const fakeHex = '0x' + '7'.repeat(64), fakeArray = '[' + Array(64).fill('12').join(',') + ']';

test('each secret pattern is detected and reported by name only', () => {
  const cases = {
    pem_private_key: '-----BEGIN ' + 'PRIVATE KEY-----',
    assigned_hex_key: `PRIVATE_KEY=${fakeHex}`,
    solana_keypair_array: fakeArray,
    api_key_in_url: 'https://rpc.example/?api-' + 'key=' + 'abcdefghijklmnopqrstuvwxyz123',
    jwt: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'abcdefghijklmnop'].join('.'),
    aws_access_key: 'AKIA' + 'ABCDEFGHIJKLMNOP',
    github_token: 'ghp' + '_abcdefghijklmnopqrstuvwxyz0123',
    circle_api_key: 'TEST_API_KEY' + ':abcdefgh1234:ijklmnop5678',
  };
  for (const [kind, line] of Object.entries(cases)) assert.deepEqual(scanLine(line), [kind], kind);
});

test('ordinary hashes, addresses and public test keys are not findings', () => {
  assert.deepEqual(scanLine('tx 0x284ca031a4fd714a984a491d485776940c8d9261564729657f9c4a86a09d5535 at block 48364694'), []);
  assert.deepEqual(scanLine('factory 0x98a0E75dbBe9EdA5D228319C72D496b814bA7145'), []);
  assert.deepEqual(scanLine('privateKey: 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'), ['public_test_key']);
});

test('working-tree and history scans find a planted secret, including one deleted in a later commit', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'elpida-scan-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 'a@b'); git('config', 'user.name', 't');
  writeFileSync(join(dir, 'clean.txt'), 'nothing here\n'); git('add', '.'); git('commit', '-qm', 'clean');
  assert.equal((await runScan({ cwd: dir })).findings.length, 0);
  writeFileSync(join(dir, 'oops.env'), `DEPLOYER_KEY=${fakeHex}\n`); git('add', '.'); git('commit', '-qm', 'leak');
  const tree = await runScan({ cwd: dir });
  assert.deepEqual(tree.findings.map(f => [f.file, f.line, f.kind]), [['oops.env', 1, 'assigned_hex_key']]);
  git('rm', '-q', 'oops.env'); git('commit', '-qm', 'remove');
  assert.equal((await runScan({ cwd: dir })).findings.length, 0, 'the tree is clean after deletion');
  const history = await runScan({ cwd: dir, history: true });
  assert.equal(history.findings.length, 1, 'history still shows the leaked key, so it must be rotated');
  assert.ok(!JSON.stringify(history).includes('7777777777'), 'the secret value is never in the report');
});

test('this repository is clean', async () => {
  const { findings } = await runScan();
  assert.deepEqual(findings, [], findings.map(f => `${f.kind} ${f.file}:${f.line}`).join('\n'));
});
