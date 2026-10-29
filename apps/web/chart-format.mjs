// Formatting and placement rules for the chart, kept free of DOM and of the chart library so they can be tested.

/** Axis and tooltip prices: enough significant digits for a sub-cent token, short above a dollar. */
export function priceText(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs === 0) return '0';
  if (abs >= 1000000) return `${(v / 1000000).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (abs >= 1000) return `${(v / 1000).toFixed(2).replace(/\.?0+$/, '')}K`;
  if (abs >= 1) return v.toFixed(abs >= 100 ? 1 : abs >= 10 ? 2 : 3).replace(/\.?0+$/, '');
  // 0.0000056 needs nine decimals; 0.56 needs three. Two significant digits past the first non-zero.
  const digits = Math.min(10, Math.max(2, 2 - Math.floor(Math.log10(abs)) + 1));
  return v.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}

const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉';

/**
 * Axis labels. A sub-cent token produces ticks like 0.000004636, and six of those stacked on the price scale are
 * unreadable; the exchange notation used elsewhere in the app (0.0₅4636) is shorter and matches the header.
 */
export function axisLabel(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs > 0 && abs < 0.0001) {
    const [mantissa, exponent] = v.toExponential(3).split('e');
    const zeros = -Number(exponent) - 1;
    if (zeros >= 3) {
      const digits = mantissa.replace('.', '').replace(/0+$/, '');
      return `0.0${[...String(zeros)].map(d => SUBSCRIPT[d]).join('')}${digits}`;
    }
  }
  return priceText(v);
}

/** Signed percentage between two prices, empty when the reference is unusable. */
export function pctText(from, to) {
  if (!(from > 0) || !Number.isFinite(to)) return '';
  const p = (to - from) / from * 100;
  return `${p >= 0 ? '+' : ''}${p.toFixed(Math.abs(p) < 10 ? 2 : 1)}%`;
}

/**
 * Tooltip placement: next to the cursor, flipped or clamped so it never leaves the chart box.
 * Coordinates are relative to the chart container.
 */
export function tipPosition(point, size, box, gap = 16, margin = 8) {
  const width = Math.max(0, Number(size?.width) || 0);
  const height = Math.max(0, Number(size?.height) || 0);
  const maxX = Math.max(margin, (Number(box?.width) || 0) - width - margin);
  const maxY = Math.max(margin, (Number(box?.height) || 0) - height - margin);
  const x = Math.min(Math.max(margin, point.x + gap), maxX);
  const y = Math.min(Math.max(margin, point.y - height - gap / 2), maxY);
  return { x: Math.round(x), y: Math.round(y) };
}

/** The values a tooltip shows for one bucket. */
export function tipFields(bar, volume, unit) {
  if (!bar) return null;
  return {
    time: bar.timestamp,
    open: bar.open, high: bar.high, low: bar.low, close: bar.close,
    up: bar.close >= bar.open,
    change: pctText(bar.open, bar.close),
    volume: volume === null || volume === undefined ? null : volume,
    unit: unit ?? '',
  };
}

/** Candle sizes the chart offers, in seconds, with their toolbar labels. */
export const INTERVALS = [[1, '1s'], [15, '15s'], [60, '1m'], [300, '5m'], [900, '15m'], [3600, '1h'], [14400, '4h'], [86400, '1D']];

/**
 * Buckets without trades are filled with a flat candle at the previous close and no volume, the way trading terminals
 * draw a quiet market. Skipped when it would add more than `maxBars` candles (a long-idle token at 1s).
 */
export function fillGaps(bars, interval, maxBars = 1500) {
  if (bars.length < 2) return bars;
  const span = (bars.at(-1).timestamp - bars[0].timestamp) / interval + 1;
  if (span > maxBars) return bars;
  const out = [];
  for (const bar of bars) {
    const prev = out.at(-1);
    if (prev) for (let t = prev.timestamp + interval; t < bar.timestamp; t += interval) out.push({ timestamp: t, open: prev.close, high: prev.close, low: prev.close, close: prev.close, quoteVolumeRaw: '0', trades: 0, filled: true });
    out.push(bar);
  }
  return out;
}

/** The candle size to open with when the reader has not picked one: the finest that fits the history in ~300 candles. */
export function defaultInterval(firstTimestamp, lastTimestamp) {
  const span = Math.max(0, Number(lastTimestamp) - Number(firstTimestamp));
  if (!(span > 0)) return 60;
  return INTERVALS.find(([seconds]) => span / seconds <= 300)?.[0] ?? 86400;
}

/**
 * Chart markers for the creator's and the reader's own trades (every trade would bury the candles), placed on the candle
 * that holds them. `trades` are indexed rows (timestamp, side, account).
 */
export function tradeMarkers(trades, interval, { creator, me } = {}) {
  const lower = v => String(v ?? '').toLowerCase();
  const out = [];
  for (const t of trades ?? []) {
    const dev = creator && lower(t.account) === lower(creator), mine = me && lower(t.account) === lower(me);
    if (!dev && !mine) continue;
    const buy = t.side === 'buy';
    out.push({ time: Math.floor(Number(t.timestamp) / interval) * interval, position: buy ? 'belowBar' : 'aboveBar', shape: buy ? 'arrowUp' : 'arrowDown', side: t.side, who: mine ? 'You' : 'Dev', text: `${mine ? 'You' : 'Dev'} ${buy ? 'B' : 'S'}` });
  }
  // One marker per candle, side and wallet; the library wants them in time order.
  const seen = new Set();
  return out.filter(m => { const k = `${m.time}:${m.side}:${m.who}`; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.time - b.time);
}

/**
 * Which markers keep their text label: a label is dropped when another label on the same side of the candles sits
 * fewer than `minBars` candles earlier, so zoomed-out charts don't stack "Dev buy" on "Dev buy". `barTimes` is the
 * time of every candle in order; markers on a time not in it are left unlabelled.
 */
export function spacedLabels(marks, barTimes, minBars) {
  const index = new Map(barTimes.map((t, i) => [t, i]));
  const last = new Map();
  return marks.map(m => {
    const i = index.get(m.time);
    if (i === undefined) return { ...m, labelled: false };
    const prev = last.get(m.position);
    const labelled = prev === undefined || i - prev >= minBars;
    if (labelled) last.set(m.position, i);
    return { ...m, labelled };
  });
}
