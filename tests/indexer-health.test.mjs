// The Solana devnet index stalled for eight days (late Oct to 3 Nov 2026) showing only "Error" at network_identity:
// the configured RPC kept failing and nothing moved the index elsewhere. Failures now have a readable code, and the
// server rotates to the cluster's public RPC after three failed full passes (apps/api/server.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rpcErrorCode } from '../packages/indexer/solana-indexer.mjs';

test('RPC failures get a safe, readable code and never the URL', () => {
  assert.equal(rpcErrorCode(new Error('429 Too Many Requests: {"jsonrpc":"2.0"}')), 'RPC_RATE_LIMITED');
  assert.equal(rpcErrorCode(new Error('401 Unauthorized: invalid api key')), 'RPC_UNAUTHORIZED');
  assert.equal(rpcErrorCode(new Error('failed to get genesis hash: max usage reached, out of credits')), 'RPC_UNAUTHORIZED');
  assert.equal(rpcErrorCode(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })), 'RPC_UNREACHABLE');
  assert.equal(rpcErrorCode(new Error('503 Service Unavailable')), 'RPC_SERVER_ERROR');
  assert.equal(rpcErrorCode(Object.assign(new Error('x'), { code: 'RPC_CLUSTER_MISMATCH' })), 'RPC_CLUSTER_MISMATCH');
  assert.equal(rpcErrorCode(new Error('something odd')), 'Error');
  assert.ok(!/https?:|api-key/i.test(rpcErrorCode(new Error('429 at https://devnet.helius-rpc.com/?api-key=SECRET'))));
});

test('the server moves a failing Solana index to the next RPC and reports which host it uses', () => {
  const server = readFileSync(new URL('../apps/api/server.mjs', import.meta.url), 'utf8');
  assert.match(server, /rpcRotation\(solanaRpcs\.length\)/);
  assert.match(server, /solanaRotation\.failed\(solanaIndex\.lastError\)/);
  assert.match(server, /for\(const f of solanaFollowers\)f\.connection=next/, 'the V2 keeper and rewards reader follow the switch');
  assert.match(server, /public_indexer_rpc_switched/);
});

test('RPC rotation: three failures or one refusal move on, wraps around, returns to the preferred RPC after 30 minutes', async () => {
  const { rpcRotation } = await import('../packages/solana/rpc-config.mjs');
  let clock = 0;
  const r = rpcRotation(3, { now: () => clock });
  assert.equal(r.failed('RPC_UNREACHABLE'), null); assert.equal(r.failed('RPC_SERVER_ERROR'), null);
  assert.equal(r.failed('RPC_UNREACHABLE'), 1, 'third failure in a row moves on');
  assert.equal(r.failed('RPC_RATE_LIMITED'), 2, 'a rate limit moves on at once');
  assert.equal(r.failed('RPC_UNAUTHORIZED'), 0, 'out of credits moves on at once, wrapping around');
  assert.equal(r.failed('RPC_RATE_LIMITED'), 1);
  clock += 10 * 60_000; assert.equal(r.succeeded(), null, 'stays on a working backup for now');
  clock += 25 * 60_000; assert.equal(r.succeeded(), 0, 'then tries the preferred RPC again');
  assert.equal(r.succeeded(), null);
  const single = rpcRotation(1);
  for (let i = 0; i < 5; i++) assert.equal(single.failed('RPC_RATE_LIMITED'), null, 'one RPC: nowhere to move');
});

test('switching connection re-checks the cluster before indexing', async () => {
  const { SolanaIndexer } = await import('../packages/indexer/solana-indexer.mjs');
  const index = Object.create(SolanaIndexer.prototype);
  index.networkValidated = true;
  index.useConnection({ marker: 1 }, 'api.devnet.solana.com');
  assert.equal(index.networkValidated, false);
  assert.equal(index.rpcHost, 'api.devnet.solana.com');
});
