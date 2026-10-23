// Solana upgrades (B1, 23 Oct 2026). The program keypair is never committed, so an upgrade must work from the program
// address alone; and an upgrade must never create a new deployer, because only the original one can sign it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { declaredProgramId } from '../packages/solana/program-id.mjs';

const root = new URL('../', import.meta.url).pathname;

test('the program address comes from declare_id! in the program source', () => {
  const source = readFileSync(join(root, 'contracts/solana/programs/elpida_launchpad/src/lib.rs'), 'utf8');
  assert.equal(declaredProgramId(source), 'ANkA5pytoVkiKQbjzd5NdPWKgmwfsihNJvSfg3vtKLNz');
  assert.throws(() => declaredProgramId('fn main() {}'), /does not declare its address/);
});

test('--upgrade without the original deployer stops before creating a keypair or touching the network', () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'elpida-upgrade-')), 'solana-deployer.json');
  const run = spawnSync(process.execPath, ['scripts/solana-deploy.mjs', '--upgrade', '--keypair', missing, '--rpc', 'http://127.0.0.1:9'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /No deployer keypair.*upgrade authority.*elpida-v1/s);
  assert.equal(existsSync(missing), false, 'no new deployer is created for an upgrade');
});
