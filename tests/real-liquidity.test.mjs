// Real liquidity on V2 token pages and the FAQ (20 November 2026, after the first Base mainnet token).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('real liquidity: V2 token pages show the pair asset in the pool as Liquidity, and the FAQ explains scanner figures', async () => {
  const page = read('apps/web/token-page.mjs');
  assert.match(page, /tile2\('Liquidity', h\('strong', fmtValue\(Number\(token\.reserve \?\? 0\), token\)\), '', liquidityNote\)/);
  assert.match(page, /some scanners count the token side too and show about the market cap as liquidity/);
  const { FAQ } = await import('../packages/core/seo.mjs');
  const entry = FAQ.find(([q]) => /scanners show more liquidity/.test(q));
  assert.ok(entry); assert.match(entry[1], /There is no LP token/);
});
