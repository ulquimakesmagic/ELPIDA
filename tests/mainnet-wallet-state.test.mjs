// 20 November 2026: with a wallet connected on elpida.fun, the EBD token page said "Token not found" because wallet
// state read tokens from the curve launchpad, which mainnet does not have. Mainnet state now lists the V2 index's tokens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('wallet state on a V2-only network lists the public index tokens with this wallet\'s balance', () => {
  const s = readFileSync(new URL('../apps/web/wallet.mjs', import.meta.url), 'utf8');
  assert.match(s, /if \(!v2Deployment\(this\.net\)\) return \{ \.\.\.base, tokens: \[\] \};/);
  assert.match(s, /const entries = await this\.publicTokens\(\);/);
  assert.match(s, /return await v4TokenState\(this, item\)/);
  assert.match(s, /v4RouterFor, v2Deployment \} from '\.\/v4-launchpad\.mjs';/);
});

test('mainnet quotes and trades find V2 tokens: wallet state fills this.launches from the index', () => {
  const s = readFileSync(new URL('../apps/web/wallet.mjs', import.meta.url), 'utf8');
  assert.match(s, /this\.launches\.clear\(\); for \(const item of entries\) this\.launches\.set\(item\.address\.toLowerCase\(\), \{ \.\.\.item \}\);/);
  const page = readFileSync(new URL('../apps/web/token-page.mjs', import.meta.url), 'utf8');
  assert.match(page, /`V2 \$\{ctx\.wallet\?\.net\?\.mainnet \? 'beta' : 'test'\}/);
});
