// Solana upgrades (B1, 23 Oct 2026). The program keypair is never committed, so an upgrade must work from the program
// address alone; and an upgrade must never create a new deployer, because only the original one can sign it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { declaredProgramId } from '../packages/solana/program-id.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

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

test('a run without local deploy state reuses the published test mints instead of creating new ones', async () => {
  const { savedTestAssets, publishedTestAssets } = await import('../packages/solana/deploy-record.mjs');
  const record = JSON.parse(readFileSync(join(root, 'deployments/solana-devnet.json'), 'utf8'));
  const published = publishedTestAssets(record);
  assert.ok(Object.keys(published).length > 0 && Object.values(published).every(m => typeof m === 'string'));
  assert.ok(!('sol' in published) && !('usdc' in published), 'only test assets, never SOL or USDC');
  assert.deepEqual(savedTestAssets({}, record, record.programId), published, 'fresh checkout: published mints');
  assert.deepEqual(savedTestAssets({ testAssets: { 'test-meme': 'Local111' } }, record, record.programId), { 'test-meme': 'Local111' }, 'local state wins');
  assert.deepEqual(savedTestAssets({}, record, 'AnotherProgram1111111111111111111111111111'), {}, 'never another program\'s mints');
});
