// Fewer wallet confirmations (21 Oct 2026). Trades and fee claims used to ask for one signature per step: an approval
// plus the trade, and up to four for a claim. Wallets that support atomic batches (EIP-5792) now get one confirmation;
// others get only the steps that move money. These tests cover the batch request, the step sender and the on-chain
// property that makes batching safe: every claim step succeeds even when nothing is owed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Contract } from 'ethers';
import { waitAtomicBatch, atomicBatchRequest } from '../apps/web/wallet-batch.mjs';
import './helpers/browser-modules.mjs';
import { dexFixture, launch, complete, mined, art } from './helpers/dex-fixture.mjs';
// Imported after the browser-path hook is registered.
const { TestnetWallet } = await import('../apps/web/wallet.mjs');

test('a batch request is wallet_sendCalls v2, atomic, with hex chain and values', () => {
  const r = atomicBatchRequest({ from: '0xabc', chainId: 84532, id: 'x', calls: [{ to: '0x1', data: '0xaa' }, { to: '0x2', data: '0xbb', value: 10n }] });
  assert.equal(r.method, 'wallet_sendCalls');
  assert.deepEqual(r.params[0], { version: '2.0.0', id: 'x', from: '0xabc', chainId: '0x14a34', atomicRequired: true, calls: [{ to: '0x1', data: '0xaa', value: '0x0' }, { to: '0x2', data: '0xbb', value: '0xa' }] });
  assert.throws(() => atomicBatchRequest({ from: '0xabc', chainId: 1, id: 'x', calls: [] }), /Nothing to send/);
});

test('batch completion requires the same request, chain, atomic execution and successful receipts', async () => {
  const base = { id: 'b', chainId: '0x14a34', status: 200, atomic: true, receipts: [{ status: '0x1', transactionHash: '0xh' }] }, options = { attempts: 1, sleep: async () => {} };
  assert.deepEqual(await waitAtomicBatch(async () => base, 'b', 84532, options), base.receipts);
  for (const change of [{ id: 'other' }, { chainId: '0x1' }, { atomic: false }, { receipts: [] }, { receipts: [{ status: '0x0' }] }, { status: 100 }, { status: 500 }]) await assert.rejects(waitAtomicBatch(async () => ({ ...base, ...change }), 'b', 84532, options));
});

function stubWallet({ batch }) {
  const log = { requests: [], sent: [], progress: [] };
  const w = Object.create(TestnetWallet.prototype);
  Object.assign(w, {
    address: '0x00000000000000000000000000000000000000aa', net: { chainId: 84532, key: 'base-sepolia' },
    onProgress: m => log.progress.push(m), checkNetwork: async () => {},
    _eth: { request: async ({ method, params }) => {
      log.requests.push(method);
      if (method === 'wallet_getCapabilities') return { '0x14a34': { atomic: { status: batch ? 'supported' : 'unsupported' } } };
      if (method === 'wallet_sendCalls') { log.batch = params[0]; return { id: 'batch-1' }; }
      if (method === 'wallet_getCallsStatus') return { id: 'batch-1', chainId: '0x14a34', status: 200, atomic: true, receipts: [{ status: '0x1', transactionHash: '0xfinal' }] };
      throw new Error('unexpected ' + method);
    } },
    provider: { getTransactionReceipt: async hash => ({ hash, status: 1 }) },
    signer: { sendTransaction: async tx => { log.sent.push(tx); return { hash: '0xtx' + log.sent.length, wait: async () => ({ status: 1 }) }; } },
  });
  return { w, log };
}
const steps = [{ to: '0x1', data: '0xa1', label: 'Approve exactly this trade amount…' }, { to: '0x2', data: '0xb2', value: 5n, label: 'Confirm the trade…' }];

test('a batching wallet gets ONE confirmation for an approval plus a trade', async () => {
  const { w, log } = stubWallet({ batch: true });
  const result = await w.sendCalls(steps, 'Confirm the trade.');
  assert.equal(log.sent.length, 0, 'no separate transactions');
  assert.deepEqual(log.requests, ['wallet_getCapabilities', 'wallet_sendCalls', 'wallet_getCallsStatus']);
  assert.equal(log.batch.atomicRequired, true); assert.equal(log.batch.calls.length, 2); assert.equal(log.batch.calls[1].value, '0x5');
  assert.equal(result.tx.hash, '0xfinal');
  assert.ok(log.progress.some(m => /One confirmation covers all 2 steps/.test(m)));
  await w.sendCalls(steps, 'Again.');
  assert.equal(log.requests.filter(m => m === 'wallet_getCapabilities').length, 1, 'capabilities are checked once per network');
});

test('a wallet without batches gets the steps in order, labelled, and a single step never probes capabilities', async () => {
  const { w, log } = stubWallet({ batch: false });
  await w.sendCalls(steps, 'Confirm the trade.');
  assert.deepEqual(log.sent.map(t => [t.to, t.data, t.value]), [['0x1', '0xa1', 0n], ['0x2', '0xb2', 5n]]);
  assert.ok(log.progress.includes('Step 1 of 2: Approve exactly this trade amount…'));
  const single = stubWallet({ batch: true });
  await single.w.sendCalls([steps[1]], 'Confirm.');
  assert.equal(single.log.requests.length, 0, 'one step needs no batch and no capability request');
  assert.equal(single.log.sent.length, 1);
  await assert.rejects(w.sendCalls([], 'x'), /Nothing to send/);
});

test('on-chain: every fee-claim step succeeds with nothing owed, so a claim batch can never fail on an empty step', async t => {
  const f = await dexFixture(t), l = await launch(f), anyone = f.signers[3];
  await complete(f, l); await mined(l.curve.graduate());
  const curve = l.curve.connect(anyone);
  const locker = new Contract(await l.curve.locker(), art('ElpidaV3FeeLocker').abi, anyone);
  const splitter = new Contract(await l.curve.feeSplitter(), art('ElpidaFeeSplitter').abi, anyone);
  await mined(curve.withdrawFees());
  assert.equal(await l.curve.protocolFees() + await l.curve.creatorFees(), 0n);
  // Graduation pays its leftover quote into the splitter (review finding E-3); claim that once first.
  for (const asset of [l.token.target, l.quote]) for (const recipient of [f.addresses[2], f.addresses[0]]) await mined(splitter.claim(asset, recipient));
  for (let round = 0; round < 2; round++) {
    await mined(curve.withdrawFees());                       // nothing owed on the curve
    const [a0, a1] = await locker.collectFees.staticCall();   // the dry run used to skip an empty collect
    assert.deepEqual([a0, a1], [0n, 0n], 'no pool trades yet, so nothing to collect');
    await mined(locker.collectFees());                        // empty collect still succeeds
    for (const asset of [l.token.target, l.quote]) for (const recipient of [f.addresses[2], f.addresses[0]]) {
      assert.equal(await splitter.claimable(asset, recipient), 0n);
      await mined(splitter.claim(asset, recipient));          // empty claim returns quietly
    }
  }
});
