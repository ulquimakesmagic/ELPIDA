// Portfolio figures: holdings with values, positions merged in, USD totals over the rows that have a rate, fee sums.
import test from 'node:test';
import assert from 'node:assert/strict';
import { holdingRows, withPosition, summarize, sumFees } from '../apps/web/portfolio-model.mjs';

const tokens = [
  { address: '0xAAA', balance: '1000', supply: '1000000000', price: 0.002, rate: 2500 },   // ETH pair, $5,000
  { address: '0xBBB', balance: '0', price: 1, rate: 2500 },                                 // not held
  { address: '0xCCC', balance: '500', supply: '1000000000', price: 0.01, rate: 1 },         // USDC pair, $5
  { address: '0xDDD', balance: '200', price: 0.5, rate: null },                             // no USD rate
];
const opts = { price: t => t.price, rate: t => t.rate };

test('holdings keep held tokens only, value them in the pair asset and in USD, largest first', () => {
  const rows = holdingRows(tokens, opts);
  assert.deepEqual(rows.map(r => r.token.address), ['0xAAA', '0xCCC', '0xDDD'], 'rows with a USD value first, by value');
  assert.equal(rows[0].value, 2); assert.equal(rows[0].usd, 5000);
  assert.equal(rows[2].usd, null, 'no rate, no dollar figure');
  assert.equal(rows[0].share, 1000 / 1e9 * 100);
  assert.equal(rows[2].share, 200 / 1e9 * 100, 'missing supply falls back to the fixed 1B');
  assert.deepEqual(holdingRows(null, opts), []);
});

test('totals cover only rows with a rate and, for P&L, a known cost basis', () => {
  let rows = holdingRows(tokens, opts);
  let s = summarize(rows);
  assert.equal(s.count, 3); assert.equal(s.value, 5005); assert.equal(s.valueCovered, 2);
  assert.equal(s.pnl, null, 'no positions loaded yet'); assert.equal(s.realized, null);
  rows = withPosition(rows, '0xaaa', { basisKnown: true, unrealizedQuote: '0.5', costQuote: '1.5', realizedQuote: '0.1' });
  rows = withPosition(rows, '0xCCC', { basisKnown: false, unrealizedQuote: null, costQuote: null, realizedQuote: '2' });
  rows = withPosition(rows, '0xDDD', { basisKnown: true, unrealizedQuote: '9', costQuote: '1', realizedQuote: '0' });
  s = summarize(rows);
  assert.equal(s.pnl, 1250, '0.5 ETH at $2,500; the unknown basis and the unpriced row are left out');
  assert.equal(s.pnlCovered, 1);
  assert.ok(Math.abs(s.pnlPercent - 0.5 / 1.5 * 100) < 1e-9);
  assert.equal(s.realized, 0.1 * 2500 + 2 * 1, 'realized counts every priced row with a figure');
});

test('creator fees add up per asset and skip anything not ready', () => {
  assert.deepEqual(sumFees([
    { status: 'ready', assets: [{ symbol: 'ETH', amount: '0.01' }, { symbol: 'ITACHI', amount: '0' }] },
    { status: 'ready', assets: [{ symbol: 'ETH', amount: '0.02' }, { symbol: 'USDC', amount: '3' }] },
    { status: 'loading', assets: [{ symbol: 'ETH', amount: '5' }] },
    null,
  ]).map(a => [a.symbol, Number(a.amount.toFixed(6))]), [['USDC', 3], ['ETH', 0.03]]);
  assert.deepEqual(sumFees([]), []);
});

import { crossChainTokens, networkCounts } from '../apps/web/portfolio-model.mjs';

test('cross-chain holdings join indexed balances to the token list; the live network wins for its own tokens', () => {
  const all = [
    { network: 'base-sepolia', address: '0xA1', symbol: 'A', price: 1 },
    { network: 'bnb-testnet', address: '0xa1', symbol: 'SAMEADDR', price: 2 },
    { network: 'bnb-testnet', address: '0xB2', symbol: 'B', price: 3 },
  ];
  const balances = [
    { network: 'base-sepolia', address: '0xa1', balance: '10' },
    { network: 'bnb-testnet', address: '0xa1', balance: '20' },
    { network: 'bnb-testnet', address: '0xb2', balance: '5' },
    { network: 'bnb-testnet', address: '0xc3', balance: '7' },
  ];
  const live = { network: 'bnb-testnet', tokens: [{ address: '0xB2', balance: '0' }, { address: '0xa1', balance: '25', symbol: 'SAMEADDR' }] };
  const out = crossChainTokens(balances, all, live);
  const view = out.map(t => [t.network, t.symbol, t.balance]).sort();
  assert.deepEqual(view, [['base-sepolia', 'A', '10'], ['bnb-testnet', 'SAMEADDR', '25']],
    'same address on two chains stays two rows; a token sold since indexing drops out; an unknown token is not shown');
  assert.deepEqual(networkCounts(out), [{ network: 'base-sepolia', count: 1 }, { network: 'bnb-testnet', count: 1 }]);
});

test('positions attach per network when the same address exists on two chains', () => {
  const rows = [{ token: { network: 'n1', address: '0xA' }, position: null }, { token: { network: 'n2', address: '0xa' }, position: null }];
  const out = withPosition(rows, '0xa', { basisKnown: true }, 'n2');
  assert.equal(out[0].position, null); assert.deepEqual(out[1].position, { basisKnown: true });
});
