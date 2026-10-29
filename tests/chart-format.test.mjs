// Chart formatting and tooltip placement, plus the check that every module the app imports is actually served.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { priceText, pctText, tipPosition, tipFields, INTERVALS, fillGaps, defaultInterval, tradeMarkers, spacedLabels } from '../apps/web/chart-format.mjs';
import { startServer } from '../apps/api/server.mjs';

test('prices keep enough digits to tell a sub-cent token from zero', () => {
  assert.equal(priceText(0), '0');
  assert.equal(priceText(0.000005637), '0.000005637', 'four significant digits, no exponent');
  assert.equal(priceText(0.00056), '0.00056');
  assert.equal(priceText(0.5), '0.5');
  assert.equal(priceText(1.2345), '1.234');
  assert.equal(priceText(56.35), '56.35');
  assert.equal(priceText(1234), '1.23K');
  assert.equal(priceText(160640), '160.64K');
  assert.equal(priceText(3200000), '3.2M');
  assert.equal(priceText(Number.NaN), '—');
  assert.equal(priceText(undefined), '—');
});

test('price text never renders an exponent', () => {
  for (const value of [1e-9, 5.6e-7, 0.000000123, 1e-8]) {
    assert.equal(/e/i.test(priceText(value)), false, `${value} -> ${priceText(value)}`);
  }
});

test('percentage change is signed and empty without a reference', () => {
  assert.equal(pctText(100, 110), '+10.0%');
  assert.equal(pctText(100, 90), '-10.0%');
  assert.equal(pctText(100, 101), '+1.00%');
  assert.equal(pctText(0, 10), '');
  assert.equal(pctText(10, Number.NaN), '');
});

test('the tooltip stays inside the chart', () => {
  const box = { width: 400, height: 300 };
  const size = { width: 170, height: 84 };

  const middle = tipPosition({ x: 100, y: 150 }, size, box);
  assert.ok(middle.x >= 8 && middle.y >= 8);
  assert.ok(middle.x + size.width <= box.width - 8);
  assert.ok(middle.y + size.height <= box.height - 8);

  const bottomRight = tipPosition({ x: 399, y: 299 }, size, box);
  assert.equal(bottomRight.x, box.width - size.width - 8, 'clamped at the right edge');
  assert.ok(bottomRight.y >= 8 && bottomRight.y + size.height <= box.height - 8, 'the box stays inside');

  // At the top-left the tooltip follows the cursor to the right and down, and is pushed off the top edge.
  const topLeft = tipPosition({ x: 0, y: 0 }, size, box);
  assert.equal(topLeft.x, 16, 'beside the cursor');
  assert.equal(topLeft.y, 8, 'never above the top edge');
});

test('tooltip fields describe one bucket', () => {
  const bar = { timestamp: 1700000000, open: 10, high: 12, low: 9, close: 11 };
  const fields = tipFields(bar, 250, '$');
  assert.equal(fields.change, '+10.0%');
  assert.equal(fields.up, true);
  assert.equal(fields.volume, 250);
  assert.equal(fields.unit, '$');

  const falling = tipFields({ ...bar, close: 9 }, null, '');
  assert.equal(falling.up, false);
  assert.equal(falling.volume, null);
  assert.equal(tipFields(null), null);
});

test('every module the app imports is served, so the app cannot 404 its own import', async t => {
  const app = await startServer({ port: 0, seed: false, publicUrl: 'https://elpida-preview.up.railway.app' });
  t.after(() => app.close());

  const appSource = readFileSync(new URL('../apps/web/app.mjs', import.meta.url), 'utf8');
  const imports = [...appSource.matchAll(/from '\.\/([a-z0-9-]+\.mjs)'/g)].map(m => m[1]);
  assert.ok(imports.length > 10, 'the app imports its views as modules');

  for (const file of imports) {
    const response = await fetch(`${app.url}/${file}`);
    assert.equal(response.status, 200, `${file} is served`);
    assert.match(response.headers.get('content-type'), /javascript/, `${file} has a script type`);
  }

  // chart-format.mjs is imported by terminal-chart.mjs rather than by app.mjs directly.
  const chart = await fetch(`${app.url}/chart-format.mjs`);
  assert.equal(chart.status, 200);
});

test('the chart offers 1s to 1D candles and opens on the finest size that fits the history in ~300 candles', () => {
  assert.deepEqual(INTERVALS.map(([s]) => s), [1, 15, 60, 300, 900, 3600, 14400, 86400]);
  assert.equal(defaultInterval(1000, 1000), 60, 'a single trade');
  assert.equal(defaultInterval(0, 200), 1, 'a token minutes old shows seconds');
  assert.equal(defaultInterval(0, 3 * 3600), 60, 'three hours at 1m');
  assert.equal(defaultInterval(0, 2 * 86400), 900, 'two days at 15m');
  assert.equal(defaultInterval(0, 10 * 365 * 86400), 86400, 'anything longer falls back to 1D');
});

test('quiet buckets become flat candles at the previous close, unless that would add too many', () => {
  const bar = (timestamp, open, close) => ({ timestamp, open, high: Math.max(open, close), low: Math.min(open, close), close, quoteVolumeRaw: '5', trades: 1 });
  const filled = fillGaps([bar(0, 1, 2), bar(180, 2, 3)], 60);
  assert.deepEqual(filled.map(b => b.timestamp), [0, 60, 120, 180]);
  assert.deepEqual(filled[1], { timestamp: 60, open: 2, high: 2, low: 2, close: 2, quoteVolumeRaw: '0', trades: 0, filled: true });
  assert.equal(fillGaps([bar(0, 1, 2), bar(10_000, 2, 3)], 1, 1500).length, 2, 'a long-idle token at 1s is left as is');
  assert.equal(fillGaps([bar(0, 1, 2)], 60).length, 1);
});

test('markers show the creator\'s and the reader\'s trades, one per candle, side and wallet, in time order', () => {
  const trades = [
    { timestamp: 130, side: 'sell', account: '0xDEV' },
    { timestamp: 61, side: 'buy', account: '0xdev' },
    { timestamp: 75, side: 'buy', account: '0xDev' },
    { timestamp: 90, side: 'buy', account: '0xME' },
    { timestamp: 95, side: 'buy', account: '0xother' },
  ];
  const marks = tradeMarkers(trades, 60, { creator: '0xdev', me: '0xme' });
  assert.deepEqual(marks.map(m => [m.time, m.side, m.who, m.position, m.shape]), [
    [60, 'buy', 'Dev', 'belowBar', 'arrowUp'],
    [60, 'buy', 'You', 'belowBar', 'arrowUp'],
    [120, 'sell', 'Dev', 'aboveBar', 'arrowDown'],
  ]);
  assert.deepEqual(tradeMarkers(trades, 60, {}), [], 'no wallet, no markers');
  assert.equal(tradeMarkers([{ timestamp: 1, side: 'buy', account: '0xdev' }], 60, { creator: '0xdev', me: '0xdev' })[0].who, 'You', 'a creator viewing their own token sees "You"');
});

test('creator labels are spaced so zoomed-out charts do not stack them', () => {
  const times = [0, 60, 120, 180, 240, 300, 360];
  const marks = [
    { time: 0, position: 'belowBar' }, { time: 60, position: 'belowBar' }, { time: 120, position: 'aboveBar' },
    { time: 180, position: 'belowBar' }, { time: 360, position: 'belowBar' }, { time: 999, position: 'belowBar' },
  ];
  const at = gap => spacedLabels(marks, times, gap).map(m => m.labelled);
  assert.deepEqual(at(1), [true, true, true, true, true, false], 'room for every label; an unknown candle is never labelled');
  assert.deepEqual(at(3), [true, false, true, true, true, false], 'above and below the candles are spaced separately');
  assert.deepEqual(at(5), [true, false, true, false, true, false]);
  assert.deepEqual(at(Infinity), [true, false, true, false, false, false], 'only the first on each side');
});
