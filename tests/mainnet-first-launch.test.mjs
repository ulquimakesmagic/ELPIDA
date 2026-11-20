// What the first Base mainnet launch (EBD, 20 November 2026) showed: a stray "null" on Analytics, testnet wording on the
// mainnet site, and "Token not found" when the token page opened before the index had it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('analytics headline drops empty parts and has no testnet note on the mainnet site', () => {
  const s = read('apps/web/analytics-headline.mjs');
  assert.match(s, /root\.replaceChildren\(\.\.\.\[/);
  assert.match(s, /\]\.filter\(Boolean\)\);/);
  assert.match(s, /mainnetSite \? '' : 'Test networks: test coins have no monetary value\. '/);
  assert.match(read('apps/web/analytics-view.mjs'), /analyticsHeadline\(\{mainnetSite\}\)/);
});

test('launch success wording and the token page retry for a just-launched token', () => {
  assert.doesNotMatch(read('apps/web/launch-flow.mjs'), /\(ELPIDA V2 test, not audited\)/);
  const page = read('apps/web/token-page.mjs');
  assert.match(page, /'Looking for this token…'/);
  assert.match(page, /n <= 6 && !state\.disconnected && ctx\.mode !== 'local'\) setTimeout/);
});
