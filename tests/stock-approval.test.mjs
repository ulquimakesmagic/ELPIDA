// Per-stock approval lives only in the operator panel and passes the registry gates first (apps/web/stock-approval.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './helpers/browser-modules.mjs';
const { stockApprovalGate, stockVirtualQuote, freshFeedPrice } = await import('../apps/web/stock-approval.mjs');
const { usdQuoteTemplate } = await import('../packages/core/curve-model.mjs');
const { createTokenizedEquity } = await import('../packages/core/tokenized-equity.mjs');

const on = { enabled: true }, off = reason => ({ enabled: false, reason });
const ready = { symbol: 'TSLAon', address: '0x' + '1'.repeat(40), feed: '0x' + '2'.repeat(40), capabilities: { launchQuote: on, graduatedPool: on } };

test('a stock is approvable only on mainnet, from the verified registry, with both capabilities and a feed', () => {
  assert.match(stockApprovalGate(ready), /only on mainnet/);
  assert.equal(stockApprovalGate(ready, { mainnet: true }), null);
  assert.match(stockApprovalGate(null, { mainnet: true }), /not in the verified registry/);
  assert.equal(stockApprovalGate({ ...ready, capabilities: { launchQuote: off('Launch quote reserve is unverified.'), graduatedPool: on } }, { mainnet: true }), 'Launch quote reserve is unverified.');
  assert.match(stockApprovalGate({ ...ready, capabilities: { launchQuote: on } }, { mainnet: true }), /graduatedPool/);
  assert.match(stockApprovalGate({ ...ready, feed: null }, { mainnet: true }), /No production price feed/);
});

test('the registry exposes each stock as blocked today: no verification record, no feed', () => {
  const registry = createTokenizedEquity(JSON.parse(readFileSync(new URL('../config/tokenized-equity-registry.json', import.meta.url), 'utf8')), { env: {} });
  const view = registry.describeNetwork('ethereum', 'ondo');
  assert.ok(view.assets.length >= 3);
  for (const a of view.assets) { assert.ok('feed' in a); assert.ok(stockApprovalGate(a, { mainnet: true })); }
});

test('the starting valuation is the $1 template divided by the feed price, and implausible prices are refused', () => {
  const start = 5000n, template = usdQuoteTemplate(start, 18);
  assert.equal(stockVirtualQuote({ startFdvUsd: start, decimals: 18, priceUsd8: 400n * 10n ** 8n }), template / 400n);
  assert.throws(() => stockVirtualQuote({ startFdvUsd: start, decimals: 18, priceUsd8: 1n }), /outside/);
  assert.throws(() => stockVirtualQuote({ startFdvUsd: start, decimals: 18, priceUsd8: 10n ** 15n }), /outside/);
});

test('feed reads must be fresh and complete; decimals are normalised to 8', () => {
  const now = 1_000_000;
  assert.equal(freshFeedPrice([5n, 4_000_000_000n, 0n, BigInt(now - 60), 5n], 8, { now, maxAge: 3600 }), 4_000_000_000n);
  assert.equal(freshFeedPrice([5n, 400n * 10n ** 18n, 0n, BigInt(now - 60), 5n], 18, { now, maxAge: 3600 }), 400n * 10n ** 8n);
  for (const round of [[5n, 0n, 0n, BigInt(now), 5n], [5n, 1n, 0n, BigInt(now - 7200), 5n], [5n, 1n, 0n, BigInt(now), 4n], [0n, 1n, 0n, BigInt(now), 0n]])
    assert.throws(() => freshFeedPrice(round, 8, { now, maxAge: 3600 }), /stale or incomplete/);
});

test('pair approvals and test stock tools are only in the operator panel', () => {
  const app = readFileSync(new URL('../apps/web/app.mjs', import.meta.url), 'utf8'), flow = readFileSync(new URL('../apps/web/launch-flow.mjs', import.meta.url), 'utf8');
  const admin = readFileSync(new URL('../apps/web/admin-pairs.mjs', import.meta.url), 'utf8');
  for (const action of ['setup-pairs', 'setup-usdc-pair', 'approve-stock', 'test-stock', 'deploy-native-router', 'setup-test-liquidity']) {
    assert.ok(!app.includes(`'${action}'`), `${action} is not in the public account panel`);
    assert.ok(!flow.includes(`'${action}'`), `${action} is not in the launch flow`);
  }
  for (const action of ['setup-pairs', 'setup-usdc-pair', 'approve-stock', 'test-stock', 'deploy-native-router']) assert.ok(admin.includes(`'${action}'`), `${action} is in the Pairs tab`);
});
