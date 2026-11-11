// Token page v2 helpers: who-filters, top traders, chart markers, safety checklist and quick amounts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { filterByWho, largeTradeThreshold, topTraders, tradeMarkers, safetyChecks, topTenShare, walletHolders, quickAmounts } from '../apps/web/token-insights.mjs';

const DEV = '0xDeV0000000000000000000000000000000000001';
const ME = '0xMe00000000000000000000000000000000000002';
const OTHER = '0xaB00000000000000000000000000000000000003';
const rows = [
  { id: 1, side: 'buy', account: DEV, quoteAmount: '0.002', tokenAmount: '86330000', timestamp: 1000 },
  { id: 2, side: 'buy', account: OTHER, quoteAmount: '0.5', tokenAmount: '1000', timestamp: 1010 },
  { id: 3, side: 'sell', account: DEV.toLowerCase(), quoteAmount: '0.000243', tokenAmount: '10000000', timestamp: 1075 },
  { id: 4, side: 'buy', account: ME, quoteAmount: '0.01', tokenAmount: '500', timestamp: 1130 },
  { id: 5, side: 'sell', account: ME, quoteAmount: '0.004', tokenAmount: '200', timestamp: 1150 },
];

test('who-filters match addresses case-insensitively and fail closed without an address', () => {
  assert.equal(filterByWho(rows, 'all'), rows);
  assert.deepEqual(filterByWho(rows, 'dev', { creator: DEV.toUpperCase() }).map(r => r.id), [1, 3]);
  assert.deepEqual(filterByWho(rows, 'mine', { me: ME.toLowerCase() }).map(r => r.id), [4, 5]);
  assert.deepEqual(filterByWho(rows, 'mine', {}), [], 'no wallet connected shows nothing, not everything');
  assert.deepEqual(filterByWho(rows, 'dev', {}), []);
  assert.throws(() => filterByWho(rows, 'whales'));
});

test('large trades are the largest tenth by quote size, at least one', () => {
  assert.equal(largeTradeThreshold(rows), 0.5);
  assert.deepEqual(filterByWho(rows, 'large').map(r => r.id), [2]);
  const many = Array.from({ length: 30 }, (_, i) => ({ id: i, side: 'buy', account: OTHER, quoteAmount: String(i + 1), timestamp: i }));
  assert.deepEqual(filterByWho(many, 'large').map(r => r.id), [27, 28, 29]);
  assert.equal(largeTradeThreshold([]), null);
  assert.deepEqual(filterByWho([{ side: 'buy', quoteAmount: 'x' }], 'large'), []);
});

test('top traders aggregate per wallet, sort by volume and report net taken out', () => {
  const top = topTraders(rows);
  assert.deepEqual(top.map(t => t.account), [OTHER, ME, DEV]);
  const me = top[1];
  assert.equal(me.buys, 1); assert.equal(me.sells, 1); assert.equal(me.trades, 2);
  assert.ok(Math.abs(me.net - (0.004 - 0.01)) < 1e-12);
  const dev = top[2];
  assert.equal(dev.account, DEV, 'keeps the first spelling of the address');
  assert.equal(dev.trades, 2);
  assert.equal(topTraders(rows, 1).length, 1);
  assert.deepEqual(topTraders([{ side: 'buy', quoteAmount: '1' }]), [], 'rows without an account are ignored');
});

test('chart markers snap to the candle bucket, dedupe per bucket and respect the toggles', () => {
  const markers = tradeMarkers(rows, { creator: DEV, me: ME, interval: 60 });
  assert.deepEqual(markers.map(m => [m.time, m.owner, m.side, m.position, m.text]), [
    [960, 'dev', 'buy', 'belowBar', 'D'],
    [1020, 'dev', 'sell', 'aboveBar', 'D'],
    [1080, 'mine', 'buy', 'belowBar', 'B'],
    [1140, 'mine', 'sell', 'aboveBar', 'S'],
  ]);
  const burst = [1, 2, 3].map(i => ({ side: 'buy', account: ME, timestamp: 1200 + i }));
  assert.equal(tradeMarkers(burst, { me: ME, interval: 60 }).length, 1);
  assert.deepEqual(tradeMarkers(rows, { creator: DEV, me: ME, interval: 60, showDev: false }).map(m => m.owner), ['mine', 'mine']);
  assert.deepEqual(tradeMarkers(rows, { creator: DEV, me: ME, interval: 60, showMine: false }).map(m => m.owner), ['dev', 'dev']);
  // The creator viewing their own token: one marker per trade, labelled as the dev's.
  assert.deepEqual(tradeMarkers(rows.slice(0, 1), { creator: DEV, me: DEV, interval: 60 }).map(m => m.owner), ['dev']);
  assert.deepEqual(tradeMarkers(rows, { interval: 60 }), [], 'nobody to mark');
});

const token = { curve: '0xCuRvE0000000000000000000000000000000000c', pool: '0xP00L000000000000000000000000000000000000' };
const holders = [
  { address: token.curve.toLowerCase(), supplyShare: '0.6' },
  { address: '0x000000000000000000000000000000000000dEaD', supplyShare: '0.05' },
  { address: DEV, supplyShare: '0.076' },
  ...Array.from({ length: 11 }, (_, i) => ({ address: `0x${String(i + 10).padStart(40, '0')}`, supplyShare: '0.02' })),
];

test('holder figures count wallets only', () => {
  assert.equal(walletHolders(holders, token).length, 12);
  assert.ok(Math.abs(topTenShare(holders, token) - (7.6 + 9 * 2)) < 1e-9);
  assert.equal(topTenShare(null, token), null);
});

test('the safety checklist states facts and flags large holdings', () => {
  const base = { ...token, devBoughtPct: 8.63, devHoldingPct: 7.63, metadataURI: 'ipfs://x' };
  const checks = safetyChecks(base, { holders, dex: 'Uniswap v3' });
  const text = checks.map(c => c.text).join('\n');
  assert.match(text, /Fixed supply of 1B/);
  assert.match(text, /locked permanently when it graduates to Uniswap v3/);
  assert.match(text, /No buy or sell tax\. The curve fee is 1\.25%/);
  assert.match(text, /cannot be edited/);
  assert.equal(checks.find(c => c.text.startsWith('Dev bought')).ok, false, '7.63% is above the 5% flag');
  assert.equal(checks.find(c => c.text.startsWith('Dev bought')).text, 'Dev bought 8.63% at launch and holds 7.63% now.');
  assert.equal(checks.find(c => c.text.startsWith('Top 10')).ok, true);

  const graduated = safetyChecks({ ...token, graduated: true, devBoughtPct: 0, devHoldingPct: 0 }, { dex: 'test' });
  assert.match(graduated.map(c => c.text).join('\n'), /Liquidity on the DEX pool is locked permanently\./);
  assert.ok(graduated.every(c => !c.text.startsWith('Top 10')), 'no holder data, no holder claim');
  assert.ok(graduated.find(c => c.text.startsWith('Dev bought')).ok);

  const taxed = safetyChecks({ tax: { buyBps: 300, sellBps: 500 } });
  assert.deepEqual(taxed.find(c => c.text.startsWith('Buy tax')), { ok: false, text: 'Buy tax 3%, sell tax 5%, fixed at launch.' });
  assert.ok(!taxed.some(c => c.text.startsWith('Dev')), 'no dev line when the launch did not record one');
});

test('quick buy amounts follow the trading pair', () => {
  assert.deepEqual(quickAmounts('ETH'), ['0.001', '0.005', '0.01']);
  assert.deepEqual(quickAmounts('bnb'), ['0.01', '0.05', '0.1']);
  assert.deepEqual(quickAmounts('SOL'), ['0.1', '0.5', '1']);
  assert.deepEqual(quickAmounts('USDC'), ['5', '10', '25']);
  assert.deepEqual(quickAmounts('XYZ'), []);
  assert.deepEqual(quickAmounts(undefined), []);
});

// Audit WEB-03 (11 November 2026): the Safety card printed "1.25%" for every token, including 4% V2 tokens.
test('the Safety card states the token’s own fee, never a fixed 1.25%', () => {
  for (const feeBps of [100, 125, 250, 400]) {
    const text = safetyChecks({ model: 'v2-hook', feeBps, graduated: false }).map(c => c.text).join(' ');
    assert.ok(text.includes(`${Number((feeBps / 100).toFixed(2))}% fee`), `${feeBps}: ${text}`);
    if (feeBps !== 125) assert.ok(!text.includes('1.25%'), text);
    assert.match(text, /locked from launch/);
  }
  assert.match(safetyChecks({ feeBps: 400, graduated: true, model: 'v2-hook' }).map(c => c.text).join(' '), /before and after graduation/);
});
