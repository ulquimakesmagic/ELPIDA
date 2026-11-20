// Token page swap panel (Malik, 20 November 2026). The first-view sizing (#327) was undone at his request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('EVM V2 token pages show no fee note under the swap panel', () => {
  const page = readFileSync(new URL('../apps/web/token-page.mjs', import.meta.url), 'utf8');
  assert.match(page, /isV2Token\(token\) && !token\.solanaV2 \? null : h\('p\.small\.muted\.tk-trade-note'/);
});
