// Fees and revenue for the analytics page (analytics step 2, 14 Nov 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import { feeAnalytics, timeline } from '../apps/api/fee-analytics.mjs';
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
    assert.deepEqual(Object.fromEntries(Object.entries(g.shares).map(([k, s]) => [k, s.earnedUsd])), { creator: 900, traderAirdrop: 900, flywheel: 300, holderRewards: 300, treasury: 600, buybackBurn: 0 });
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

test('Model 10 curve fees are recomputed per trade exactly as the curve charges them, including anti-snipe sells', async t => {
  const { createRuntime } = await import('../apps/api/curve-runtime.mjs');
  const { Contract } = await import('ethers');
  const r = await createRuntime({ seed: false, dex: true }); t.after(() => r.close());
  const { token } = await r.transact('launch', { name: 'Fee count', symbol: 'FEEC', pair: 'native', firstBuy: '0.025' });
  // Inside the first minute the rate is above the base: the sell's gross is rebuilt at that rate.
  await r.transact('buy', { token, amount: '0.01' }); await r.transact('sell', { token, amount: '777777' });
  await r.transact('buy', { token, amount: '0.003' }); await r.transact('sell', { token, amount: '1234' });
  const curveOf = () => new Contract(r.indexer.listings().find(x => x.address === token).curve, r.config.contracts.dexCurve.abi, r.provider);
  const analyse = () => feeAnalytics({ sources: [{ key: 'local', name: 'Local', mainnet: false, tokens: r.indexer.listings(), trades: r.indexer.db.prepare('SELECT data FROM trades').all().map(x => JSON.parse(x.data)),
    launchFees: { complete: true, rows: [] }, feePayouts: r.indexer.feePayouts() }], prices: { local: { status: 'fresh', usd: 1000, updatedAt: Math.floor(Date.now() / 1000) } }, period: 'all', now: 4_000_000_000 });
  let a = analyse(), [rec] = a.networks[0].reconciliation;
  assert.equal(rec.model, 'model10'); assert.equal(a.networks[0].model10Tokens, 1);
  const owed = (await curveOf().creatorFees()) + (await curveOf().protocolFees());
  assert.equal(BigInt(rec.ledgerRaw), owed);
  assert.ok(Math.abs(Number(rec.differenceRaw)) <= 4, `counted from trades matches the curve to the wei (difference ${rec.differenceRaw})`);
  assert.equal(a.testnet.byModel.model10.trades, 5, 'the first buy, two buys and two sells');
  assert.ok(Math.abs(a.testnet.shares.creator.earnedUsd - a.testnet.shares.treasury.earnedUsd) < 1e-9, 'half each');
  // After paying out, the curve owes nothing and what it paid closes the gap.
  await r.transact('withdraw', { token });
  a = analyse(); [rec] = a.networks[0].reconciliation;
  assert.equal(await curveOf().creatorFees(), 0n);
  assert.ok(Math.abs(Number(rec.differenceRaw)) <= 4);
  assert.ok(a.testnet.shares.creator.withdrawnUsd > 0 && a.testnet.shares.treasury.withdrawnUsd > 0);
  assert.equal(a.testnet.shares.creator.outstandingUsd, 0);
});

test('fees, revenue and payouts are bucketed for the chart and by calendar month', () => {
  const t0 = Date.UTC(2026, 9, 31, 22) / 1000; // 31 Oct 2026 22:00 UTC
  const out = timeline([{ timestamp: t0, feesUsd: 10, revenueUsd: 2, creatorUsd: 3 }, { timestamp: t0 + 7200, feesUsd: 5, revenueUsd: 1 }, { timestamp: t0 + 7300, withdrawnUsd: 4 }, { timestamp: t0 + 9000, revenueUsd: 10, launchFeesUsd: 10 }], '7d', t0 + 86400 * 6 - 604800, t0 + 86400 * 6);
  assert.equal(out.series.length, 8, 'one bar a day, the first and last partial');
  assert.equal(out.series.reduce((s, b) => s + b.feesUsd, 0), 15);
  assert.deepEqual(out.months.map(m => [m.month, m.feesUsd, m.revenueUsd, m.withdrawnUsd, m.launchFeesUsd]), [['2026-11', 5, 11, 4, 10], ['2026-10', 10, 2, 0, 0]]);
  assert.equal(timeline([], '24h', 1000 - 86400, 1000).series.length, 25);
});
