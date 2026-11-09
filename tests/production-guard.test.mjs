import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { productionGuard, formatGuardReport } from '../apps/api/production-guard.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const mainnet = (deployment = { programId: 'ELpida1111111111111111111111111111111111111', build: 'mainnet' }) => ({ key: 'solana-mainnet', mainnet: true, cluster: 'mainnet', deployment });
const goodEnv = () => ({
  SOLANA_RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=SECRET-RPC-KEY',
  ELPIDA_PUBLIC_URL: 'https://elpida.fun',
  PINATA_JWT: 'SECRET-PINATA-JWT',
  RAILWAY_VOLUME_MOUNT_PATH: '/data',
  ELPIDA_BACKUP_ENABLED: 'true',
  ELPIDA_BACKUP_MIRROR_S3_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
});
const codes = r => r.errors.map(e => e.code).sort();

test('testnet and local configurations are never blocked', () => {
  for (const solana of [null, { key: 'solana-devnet', mainnet: false, deployment: null }, { key: 'solana-localnet', cluster: 'localnet' }]) {
    const r = productionGuard({ env: { CIRCLE_API_KEY: 'TEST_API_KEY:x', ELPIDA_TOKENIZED_EQUITY: '1' }, solana });
    assert.deepEqual([r.mainnet, r.ok, r.errors.length], [false, true, 0]);
  }
  assert.match(formatGuardReport(productionGuard({ env: {}, solana: null })), /not a mainnet configuration/);
});

test('a complete mainnet configuration passes with only the simulation note', () => {
  const r = productionGuard({ env: goodEnv(), solana: mainnet() });
  assert.deepEqual([r.mainnet, r.ok, r.errors], [true, true, []]);
  assert.deepEqual(r.warnings.map(w => w.code), ['simulation_present']);
  assert.match(formatGuardReport(r), /PASS/);
});

test('each missing safety setting is its own error', () => {
  const cases = [
    ['SOLANA_RPC_URL', 'solana_rpc_missing'], ['ELPIDA_PUBLIC_URL', 'public_url_missing'], ['PINATA_JWT', 'pinning_missing'],
    ['RAILWAY_VOLUME_MOUNT_PATH', 'storage_ephemeral'], ['ELPIDA_BACKUP_ENABLED', 'backup_disabled'],
  ];
  for (const [name, code] of cases) {
    const env = goodEnv(); delete env[name];
    assert.deepEqual(codes(productionGuard({ env, solana: mainnet() })), [code], name);
  }
  assert.deepEqual(codes(productionGuard({ env: { ...goodEnv(), SOLANA_RPC_URL: 'http://127.0.0.1:8899' }, solana: mainnet() })), ['solana_rpc_local']);
  // The rotator: several endpoints are fine (in SOLANA_RPC_URL or SOLANA_RPC_URLS); an entry that is not one HTTPS URL is not.
  assert.deepEqual(codes(productionGuard({ env: { ...goodEnv(), SOLANA_RPC_URL: 'https://a.example, https://b.example' }, solana: mainnet() })), []);
  assert.deepEqual(codes(productionGuard({ env: { ...goodEnv(), SOLANA_RPC_URL: undefined, SOLANA_RPC_URLS: 'https://a.example/?api-key=1\nhttps://b.example/?api-key=2' }, solana: mainnet() })), []);
  const bad = productionGuard({ env: { ...goodEnv(), SOLANA_RPC_URLS: 'http://plain.example/?api-key=LEAK' }, solana: mainnet() });
  assert.deepEqual(codes(bad), ['solana_rpc_invalid']);
  assert.doesNotMatch(JSON.stringify(bad), /LEAK/, 'a rejected entry is never echoed');
  assert.deepEqual(codes(productionGuard({ env: { ...goodEnv(), ELPIDA_PUBLIC_URL: 'http://elpida.fun' }, solana: mainnet() })), ['public_url_invalid']);
  const dataDir = goodEnv(); delete dataDir.RAILWAY_VOLUME_MOUNT_PATH; dataDir.ELPIDA_DATA_DIR = '/srv/elpida';
  assert.equal(productionGuard({ env: dataDir, solana: mainnet() }).ok, true, 'an explicit data directory counts as durable');
});

test('the program must be a recorded mainnet build', () => {
  assert.deepEqual(codes(productionGuard({ env: goodEnv(), solana: mainnet(null) })), ['solana_deployment_missing']);
  assert.deepEqual(codes(productionGuard({ env: goodEnv(), solana: mainnet({ programId: 'ELpida1111111111111111111111111111111111111', build: 'testnet' }) })), ['solana_test_build']);
  assert.deepEqual(codes(productionGuard({ env: goodEnv(), solana: mainnet({ programId: 'ELpida1111111111111111111111111111111111111', shared: true }) })), ['solana_test_build'], 'a record without a build is not trusted');
});

test('test-only features are refused on mainnet', () => {
  assert.deepEqual(codes(productionGuard({ env: { ...goodEnv(), CIRCLE_API_KEY: 'TEST_API_KEY:abc' }, solana: mainnet() })), ['circle_test_funding']);
  assert.deepEqual(codes(productionGuard({ env: { ...goodEnv(), ELPIDA_CIRCLE_ADMIN_TOKEN: 'x'.repeat(40) }, solana: mainnet() })), ['circle_test_funding']);
  assert.deepEqual(codes(productionGuard({ env: { ...goodEnv(), ELPIDA_TOKENIZED_EQUITY: '1' }, solana: mainnet() })), ['tokenized_equity_on']);
  const flagged = productionGuard({ env: { ...goodEnv(), ELPIDA_TOKENIZED_EQUITY_COINBASE_SECONDARY_TRADING: '1' }, solana: mainnet() });
  assert.deepEqual(codes(flagged), ['tokenized_equity_flags']);
  assert.match(flagged.errors[0].message, /ELPIDA_TOKENIZED_EQUITY_COINBASE_SECONDARY_TRADING/);
});

test('reports name settings but never print their values', () => {
  const env = { ...goodEnv(), CIRCLE_API_KEY: 'TEST_API_KEY:SECRET-CIRCLE', ELPIDA_CIRCLE_ADMIN_TOKEN: 'SECRET-ADMIN-TOKEN-0123456789012345678901', ELPIDA_TOKENIZED_EQUITY: '1' };
  const text = formatGuardReport(productionGuard({ env, solana: mainnet({ programId: 'ELpida1111111111111111111111111111111111111', build: 'testnet' }) })) + JSON.stringify(productionGuard({ env, solana: mainnet() }));
  for (const secret of ['SECRET-RPC-KEY', 'SECRET-PINATA-JWT', 'SECRET-CIRCLE', 'SECRET-ADMIN-TOKEN', 'helius-rpc.com']) assert.ok(!text.includes(secret), secret);
});

const run = (args, env) => spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 60000, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });

test('check:production passes on a testnet configuration and fails when previewed as mainnet without settings', () => {
  const testnet = run(['scripts/check-production.mjs'], {});
  assert.equal(testnet.status, 0, testnet.stderr);
  assert.match(testnet.stdout, /not a mainnet configuration/);
  const preview = run(['scripts/check-production.mjs', '--as-mainnet'], {});
  assert.equal(preview.status, 1, preview.stderr);
  assert.match(preview.stdout, /Production guard: FAIL/);
  assert.match(preview.stdout, /ERROR solana_rpc_missing/);
});

test('the server refuses to start in a mainnet configuration that fails the guard', () => {
  const r = run(['apps/api/server.mjs'], { ELPIDA_SOLANA_CLUSTER: 'mainnet', PORT: '0', HOST: '127.0.0.1' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Production guard: FAIL/);
  assert.match(r.stderr, /Refusing to start/);
  assert.ok(!/Elpida is ready/.test(r.stdout));
});
