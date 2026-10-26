// Cross-chain Portfolio: a wallet's balances in every listed token, from one pass over Transfer events, must agree
// with the per-token holder lists the token page already uses; the public indexer adds the network and skips
// deployments that are not validated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../apps/api/curve-runtime.mjs';
import { PublicIndexer } from '../apps/api/public-indexer.mjs';

test('balancesOf matches holders() for every token and wallet, and rejects a bad address', async t => {
  const runtime = await createRuntime({ seed: false });
  t.after(() => runtime.close());
  const a = await runtime.transact('launch', { name: 'Garden One', symbol: 'ONE', pair: 'native', firstBuy: '0.01' });
  const b = await runtime.transact('launch', { name: 'Garden Two', symbol: 'TWO', pair: 'native', firstBuy: '0' });
  const one = a.token.toLowerCase(), two = b.token.toLowerCase();
  await runtime.transact('buy', { token: two, amount: '0.02', account: '1' });
  await runtime.transact('buy', { token: one, amount: '0.03', account: '1' });
  await runtime.transact('sell', { token: one, amount: '1000', account: '1' });
  const i = runtime.indexer; await i.sync();
  const buyer = runtime.config.accounts[1].address;
  const mine = i.balancesOf(buyer.toUpperCase().replace('0X', '0x'));
  assert.deepEqual(mine.map(r => r.address).sort(), [one, two].sort(), 'both tokens, matched case-insensitively');
  for (const token of [one, two]) for (const holder of i.holders(token, Number.MAX_SAFE_INTEGER)) {
    const row = i.balancesOf(holder.address).find(r => r.address === token);
    assert.equal(row?.balance, holder.balance, `${holder.address} in ${token}`);
  }
  assert.deepEqual(i.balancesOf('0x' + '7'.repeat(40)), [], 'a wallet that never held anything');
  assert.throws(() => i.balancesOf('not-an-address'), /Invalid owner/);
});

test('the public indexer tags balances with the network and skips unvalidated deployments', () => {
  const entry = (validated, rows) => ({ validated, error: null, index: { balancesOf: () => rows } });
  const p = Object.create(PublicIndexer.prototype);
  p.entries = new Map([['base-sepolia', entry(true, [{ address: '0xaa', balance: '5' }])]]);
  p.legacy = new Map([['base-sepolia', [entry(false, [{ address: '0xbb', balance: '9' }]), entry(true, [{ address: '0xcc', balance: '1' }])]]]);
  assert.deepEqual(p.balancesOf('base-sepolia', '0x' + '1'.repeat(40)), [
    { address: '0xaa', balance: '5', network: 'base-sepolia' },
    { address: '0xcc', balance: '1', network: 'base-sepolia' },
  ]);
  assert.deepEqual(p.balancesOf('bnb-testnet', '0x' + '1'.repeat(40)), []);
});
