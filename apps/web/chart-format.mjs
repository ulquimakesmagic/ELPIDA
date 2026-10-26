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
