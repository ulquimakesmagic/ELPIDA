import test from 'node:test';
import assert from 'node:assert/strict';
import { FAQ, HOW_STEPS, FEE_ROWS } from '../packages/core/seo.mjs';
import { V2, V2_FEE_SPLIT } from '../packages/core/v2-economics.mjs';
import { safetyChecks } from '../apps/web/token-insights.mjs';

// The crawlable pages are the only description of the product a search engine can read (the app is hash-routed).
// They must describe the approved V2 economics, not the legacy model, and they must be generated from the constants
// so they cannot drift again.

const all = text => [...FAQ, ...HOW_STEPS, ...FEE_ROWS].map(row => row.join(' ')).join('\n');

test('the public copy states the approved start and graduation values', () => {
  const text = all();
  assert.match(text, /\$20,000/, 'the $20,000 start is stated');
  assert.match(text, /\$100,000/, 'the $100,000 end of the sale range is stated');
  assert.equal(/starts? at a \$5,000/.test(text), false, 'the legacy $5,000 start is gone');
  assert.equal(/finishes at \$50,000|\$50,000 fully/.test(text), false, 'the legacy $50,000 end is gone');
});

test('the public copy states the five-way split and the fee range', () => {
  const text = all();
  for (const share of [V2_FEE_SPLIT.creator, V2_FEE_SPLIT.traderAirdrop, V2_FEE_SPLIT.flywheel, V2_FEE_SPLIT.holderRewards, V2_FEE_SPLIT.treasury]) {
    assert.match(text, new RegExp(`${Number((share / 100).toFixed(2))}%`), `the split states ${share / 100}%`);
  }
  assert.equal(/split evenly between the protocol and the creator/.test(text), false, 'the old 50/50 wording is gone');
  assert.match(text, /1% to 4%|1\.25%/, 'the fee range or the default is stated');
});

test('the copy no longer promises Uniswap v3 for V2 launches', () => {
  const text = all();
  assert.match(text, /Uniswap v4/, 'V2 is described as a v4 pool');
  // v3 may only appear when describing tokens launched on the earlier model.
  for (const row of [...FAQ, ...HOW_STEPS]) {
    const line = row.join(' ');
    if (/Uniswap v3/.test(line)) assert.match(line, /earlier model|before the V2|legacy/i, `v3 is only mentioned for legacy tokens: ${row[0]}`);
  }
});

test('the safety card states the token\'s own fee, not a fixed 1.25%', () => {
  const four = safetyChecks({ address: '0x1', symbol: 'FOUR', feeBps: 400, model: 'v2-hook' }, {});
  const feeLine = four.find(c => c.text.startsWith('No buy or sell tax'));
  assert.ok(feeLine, 'the tax line is present');
  assert.match(feeLine.text, /4% per trade/, 'a 4% token is described as 4%');
  assert.equal(/1\.25%/.test(feeLine.text), false, 'the default is not imposed on it');

  const unknown = safetyChecks({ address: '0x2', symbol: 'NONE' }, {});
  assert.equal(unknown.some(c => /per trade/.test(c.text)), false, 'no fee claim when the token has no fee');
});

test('the safety card does not promise graduation for a V2 token', () => {
  const v2 = safetyChecks({ address: '0x3', symbol: 'V2T', feeBps: 125, model: 'v2-hook' }, {});
  assert.equal(v2.some(c => /when it graduates/.test(c.text)), false, 'V2 liquidity is locked from launch');
  const legacy = safetyChecks({ address: '0x4', symbol: 'OLD', feeBps: 125 }, {});
  assert.ok(legacy.some(c => /when it graduates/.test(c.text)), 'legacy tokens still graduate');
});
