// Token page first view (Malik, 20 November 2026): on a ~1280 × 600 CSS px desktop view the chart and the swap panel's
// buy button fit without scrolling. Checked by measuring elpida.fun with these rules; this pins the rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('desktop first-view rules size the chart from the viewport and compact the swap panel', () => {
  const css = readFileSync(new URL('../apps/web/token.css', import.meta.url), 'utf8');
  const block = css.slice(css.indexOf('First view: chart and swap panel fully visible'));
  assert.match(block, /@media \(min-width: 1001px\)/);
  assert.match(block, /\.tk-dexscreener \{ height: clamp\(320px, calc\(100vh - 232px\), 640px\); \}/);
  assert.match(block, /\.tk-layout \.tk-trade \.pay-box, \.tk-layout \.tk-trade \.receive \{ min-height: 0;/);
  assert.match(block, /\.tk-layout \.tk-trade \.swap-route \{ display: none; \}/);
});
