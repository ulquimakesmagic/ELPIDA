// The fees job must report what happened. On 20 November five share claims failed on Base and the run still recorded
// `ok`, because fees() recorded success unconditionally and collect() swallowed every error. These tests pin the
// status to the outcome, with a stub hook so no chain is needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { V2Keeper } from '../apps/api/v2-keeper.mjs';

const dir = mkdtempSync(join(tmpdir(), 'v2k-fees-'));
const keepers = [];
let n = 0;
test.after(async () => { for (const k of keepers) await k.close(); rmSync(dir, { recursive: true, force: true }); });

const TOKEN = '0x' + 'aa'.repeat(20);
const OWED = [1n, 2n, 3n, 4n, 5n];

/** A keeper whose send() runs the thunk and returns a receipt, so no transaction is built. */
function keeper() {
  const k = new V2Keeper({ workers: [], path: join(dir, `k${n++}.db`), now: () => 1_700_000_000 });
  k.send = async (w, build) => { const tx = await build(); return tx.wait(); };
  keepers.push(k);
  return k;
}

const worker = () => ({ chain: 'base-mainnet', net: { chainId: 8453 }, deployment: { hook: '0x' + 'ff'.repeat(20) }, index: () => ({ listings: () => [{ address: TOKEN }] }) });

/** withdrawFees fails or not; per-share claims fail for the shares in `badShares`. */
function hook({ withdraw = 'ok', badShares = [] } = {}) {
  const receipt = { wait: async () => ({ status: 1 }) };
  const fail = msg => async () => { throw Object.assign(new Error(msg), { shortMessage: msg }); };
  return {
    ledgers: async () => ({ owed: OWED, paid: [0n, 0n, 0n, 0n, 0n] }),
    withdrawFees: withdraw === 'ok' ? async () => receipt : fail(withdraw),
    claim: async (token, i) => (badShares.includes(i) ? fail('recipient reverted')() : receipt),
  };
}

const lastRun = k => k.db.prepare("SELECT status, detail FROM v2k_runs WHERE job='fees' ORDER BY id DESC LIMIT 1").get();

test('every collection succeeding is the only thing that reports ok', async () => {
  const k = keeper();
  await k.fees(worker(), { force: true, hook: hook() });
  const run = lastRun(k);
  assert.equal(run.status, 'ok');
  assert.equal(JSON.parse(run.detail).tokens, 1);
});

test('a rejected batch with every share failing reports failed, not ok', async () => {
  const k = keeper();
  await k.fees(worker(), { force: true, hook: hook({ withdraw: 'withdrawFees reverted', badShares: [0, 1, 2, 3, 4] }) });
  const run = lastRun(k);
  assert.equal(run.status, 'failed', 'the 20 November case: five failed claims must not read ok');
  const detail = JSON.parse(run.detail);
  assert.equal(detail.tokens, 0);
  assert.equal(detail.failed, 1);
  assert.equal(detail.failures[0].failures.length, 5, 'the reason for each share is kept');
  assert.match(detail.failures[0].failures[0].reason, /recipient reverted/);
});

test('some paid and some not reports partial and keeps the reasons', async () => {
  const k = keeper();
  await k.fees(worker(), { force: true, hook: hook({ withdraw: 'batch reverted', badShares: [0, 1, 2, 3, 4] }) });
  // One token failed; a second token that pays cleanly makes the job partial rather than failed.
  const twoTokens = {
    chain: 'base-mainnet', net: { chainId: 8453 }, deployment: { hook: '0x' + 'ff'.repeat(20) },
    index: () => ({ listings: () => [{ address: TOKEN }, { address: '0x' + 'bb'.repeat(20) }] }),
  };
  let call = 0;
  const good = hook();
  const mixed = {
    ledgers: async () => ({ owed: OWED, paid: [0n, 0n, 0n, 0n, 0n] }),
    withdrawFees: async () => { call++; if (call === 1) throw Object.assign(new Error('first token reverted'), { shortMessage: 'first token reverted' }); return { wait: async () => ({ status: 1 }) }; },
    claim: async () => { throw Object.assign(new Error('share reverted'), { shortMessage: 'share reverted' }); },
  };
  await k.fees(twoTokens, { force: true, hook: mixed });
  const run = lastRun(k);
  assert.equal(run.status, 'partial');
  const detail = JSON.parse(run.detail);
  assert.equal(detail.tokens, 1, 'the token that paid is counted');
  assert.equal(detail.failed, 1);
  assert.ok(good);
});

test('nothing owed is a clean ok', async () => {
  const k = keeper();
  const nothing = { ledgers: async () => ({ owed: [9n, 0n, 0n, 0n, 0n], paid: [0n, 0n, 0n, 0n, 0n] }) };
  await k.fees(worker(), { force: true, hook: nothing });
  assert.equal(lastRun(k).status, 'ok');
  assert.equal(JSON.parse(lastRun(k).detail).tokens, 0, 'a token with no share owed is skipped, not counted as paid');
});

test('a lost lease still aborts the job instead of being recorded as a failure', async () => {
  const k = keeper();
  k.send = async () => { throw Object.assign(new Error('lease_lost'), { code: 'lease_lost' }); };
  await assert.rejects(() => k.fees(worker(), { force: true, hook: hook() }), /lease_lost/);
});
