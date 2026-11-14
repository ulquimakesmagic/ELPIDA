// Fees and revenue for the analytics page (analytics step 2, 14 Nov 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import { feeAnalytics } from '../apps/api/fee-analytics.mjs';
import { PriceHistory } from '../apps/api/price-history.mjs';
import { V2_MODEL } from '../packages/core/v2-economics.mjs';

const now = 1_794_600_000, e18 = n => (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString();
const token = (address, extra = {}) => ({ address, model: V2_MODEL, pair: 'native', quoteDecimals: 18, accrued: '1.0', feeLedgers: { owed: { creator: '0.3', traderAirdrop: '0.3', flywheel: '0.1', holderRewards: '0.1', treasury: '0.2' }, paid: {} }, ...extra });
const source = (key, mainnet, extra = {}) => ({ key, name: key, mainnet, tokens: [token('0xa'), { address: '0xb', curveModel: 10 }],
  trades: [{ token: '0xa', feeRaw: e18(1), timestamp: now - 100 }, { token: '0xb', feeRaw: e18(5), timestamp: now - 100 }, { token: '0xa', feeRaw: e18(1), timestamp: now - 900_000 }],
  launchFees: { complete: true, rows: [{ token: '0xa', asset: '0x0000000000000000000000000000000000000000', amountRaw: e18(0.005), timestamp: now - 200 }, { token: null, asset: '0xusdc', amountRaw: '10000000', timestamp: now - 300 }] },
  feePayouts: [{ token: '0xa', recipient: 4, amountRaw: e18(0.2), timestamp: now - 50 }, { token: '0xa', recipient: 0, amountRaw: e18(0.3), failed: true, timestamp: now - 50 }], ...extra });
const prices = (usd) => ({ base: { status: 'fresh', usd, updatedAt: now }, 'base-sepolia': { status: 'fresh', usd, updatedAt: now } });

test('fees are split by the V2 shares, revenue is launch fees plus the treasury share, and mainnet stays apart from test networks', () => {
  const a = feeAnalytics({ sources: [source('base', true), source('base-sepolia', false)], prices: prices(3000), period: '7d', now });
  for (const g of [a.mainnet, a.testnet]) {
    assert.equal(g.trades, 1, 'only V2 trades inside the period');
    assert.equal(g.feesGeneratedUsd, 3000);
    assert.deepEqual(Object.fromEntries(Object.entries(g.shares).map(([k, s]) => [k, s.earnedUsd])), { creator: 900, traderAirdrop: 900, flywheel: 300, holderRewards: 300, treasury: 600 });
    assert.equal(g.launchFeesUsd, 15 + 10, 'native launch fee at the ETH price, USDC at face value');
    assert.equal(g.revenueUsd, 25 + 600); assert.equal(g.revenueCollectedUsd, 25 + 600);
    assert.equal(g.shares.creator.failedPayouts, 1); assert.equal(g.shares.creator.withdrawnUsd, 0);
    assert.equal(g.shares.creator.outstandingUsd, 900, 'outstanding is the ledger at today\'s price');
    assert.deepEqual(g.untracked.map(u => u.model), ['model-10']);
    assert.equal(g.valuation.atTradeTime, 0); assert.ok(g.valuation.revalued > 0, 'without history, today\'s price is used and said so');
  }
  assert.equal(a.networks[0].reconciliation[0].differenceRaw, '-1000000000000000000', 'two trades counted against a ledger of one: the gap shows');
  assert.equal(feeAnalytics({ sources: [source('base', true)], prices: prices(3000), period: 'all', now }).networks[0].reconciliation[0].fromTradesRaw, e18(2));
  assert.throws(() => feeAnalytics({ sources: [], period: '1y' }), /Choose/);
  assert.throws(() => feeAnalytics({ sources: [], network: 'nope' }), /Unknown/);
});

test('recorded hourly prices value each fee at the time it happened, unknown prices are counted, not guessed', () => {
  const h = new PriceHistory(); h.record([{ network: 'base', asset: 'native', usd: 2000 }], now - 100);
  const a = feeAnalytics({ sources: [source('base', true)], priceHistory: h, prices: prices(3000), period: '24h', now });
  assert.equal(a.mainnet.feesGeneratedUsd, 2000, 'the trade hour\'s price, not today\'s');
  assert.equal(a.mainnet.shares.treasury.withdrawnUsd, 400);
  assert.equal(a.pricesSince, Math.floor((now - 100) / 3600) * 3600);
  const none = feeAnalytics({ sources: [source('base', true)], prices: {}, period: '24h', now });
  assert.equal(none.mainnet.feesGeneratedUsd, 0); assert.ok(none.mainnet.valuation.unpriced > 0);
  assert.equal(none.mainnet.launchFeesUsd, 10, 'USDC launch fees need no price');
});
