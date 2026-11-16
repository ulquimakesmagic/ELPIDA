// Base mainnet launches pair with ETH or USDC only (Malik, 16 November 2026): no tokenized-stock provider issues on Base.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './helpers/browser-modules.mjs';
const { stockPairsOff, STOCK_PAIRS_OFF } = await import('../packages/core/pairs.mjs');
const { stockApprovalGate } = await import('../apps/web/stock-approval.mjs');

const ready = { symbol: 'NVDAc', address: '0x' + '1'.repeat(40), feed: '0x' + '2'.repeat(40), capabilities: { launchQuote: { enabled: true }, graduatedPool: { enabled: true } } };

test('stock pairs are off on Base mainnet only', () => {
  assert.match(stockPairsOff(8453), /not offered on Base/);
  assert.match(stockPairsOff('8453'), /ETH or USDC/);
  for (const id of [1, 56, 84532, 11155111, 97, null, undefined]) assert.equal(stockPairsOff(id), null);
  assert.ok(Object.isFrozen(STOCK_PAIRS_OFF));
});

test('the operator panel cannot approve a stock on Base, even a fully verified one', () => {
  assert.match(stockApprovalGate(ready, { mainnet: true, chainId: 8453 }), /not offered on Base/);
  assert.equal(stockApprovalGate(ready, { mainnet: true, chainId: 1 }), null);
});

test('the launch flow, the EVM wallet and the stock-list script all consult the gate', () => {
  const flow = readFileSync(new URL('../apps/web/launch-flow.mjs', import.meta.url), 'utf8');
  assert.match(flow, /V2_PAIRS\.filter\(k => k !== 'xstock' \|\| !stockPairsOff/);
  assert.match(flow, /draft\.pair === 'xstock' && !solana\(\) && stockPairsOff/);
  assert.match(flow, /approvedQuotes \?\? \[\]\)\.filter\(a => a\.kind !== 'xstock' \|\| !stockPairsOff/);
  const wallet = readFileSync(new URL('../apps/web/wallet.mjs', import.meta.url), 'utf8');
  assert.match(wallet, /xstock: stockPairsOff\(this\.net\.chainId\) \?/);
  assert.match(wallet, /kind === 'xstock' && stockPairsOff\(this\.net\.chainId\)\) throw/);
  assert.match(readFileSync(new URL('../scripts/stock-list.mjs', import.meta.url), 'utf8'), /stockPairsOff\(net\.chainId\)/);
});

test('Coinbase stocks on Base: ticker matching and the rehearsal candidates', async () => {
  const { underlying } = await import('../packages/core/stock-list.mjs');
  assert.equal(underlying('NVDAc'), 'NVDA'); assert.equal(underlying('TSLAon'), 'TSLA'); assert.equal(underlying('BAC'), 'BAC'); assert.equal(underlying('SPCXc'), 'SPCX');
  const list = JSON.parse(readFileSync(new URL('../config/stocks/candidates/base-coinbase.json', import.meta.url), 'utf8'));
  const registry = JSON.parse(readFileSync(new URL('../config/tokenized-equity-registry.json', import.meta.url), 'utf8'));
  const known = new Map(registry.assets.filter(a => a.network === 'base' && a.provider === 'coinbase').map(a => [a.symbol, a]));
  assert.equal(list.length, 10);
  for (const s of list) {
    assert.match(s.symbol, /^[A-Z]{2,5}c$/);
    assert.equal(s.address, known.get(s.symbol).address); assert.equal(s.feed, known.get(s.symbol).feed);
    assert.equal(s.maxAge, 345600);
  }
});

test('a Base fork rehearsal runs before the Safe exists, but the real deploy still needs every role', async () => {
  const { readPlan } = await import('../scripts/v2-mainnet-deploy.mjs');
  const plan = new URL('../deployments/plans/base-mainnet.json', import.meta.url);
  assert.equal(readPlan(plan, { forkRehearsal: true }).plan.explorerApi, 'https://base.blockscout.com');
  assert.throws(() => readPlan(plan), /no treasury/);
  const src = readFileSync(new URL('../scripts/v2-mainnet-deploy.mjs', import.meta.url), 'utf8');
  assert.match(src, /forkRehearsal \? \['treasury', 'keeper', 'guardian'\]/);
});
