// The launch form's model choice (6 November 2026): Model 11 is chosen before the pair, pairs it cannot take are shown
// as unavailable with the reason, and a saved stock or token pair falls back to the native coin instead of blocking
// the step with an error.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const flow = readFileSync(new URL('../apps/web/launch-flow.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('the launch model comes before the trading pair, and Model 11 limits the pairs it offers', () => {
  assert.ok(flow.indexOf("h('h3', 'Launch model')") < flow.indexOf("h('h3', 'Trading pair')"), 'model first, then pair');
  assert.match(flow, /v4Chosen\(\) && !V4_PAIRS\.includes\(kind\) \? 'Model 11 test launches pair with the native coin, USDC or a test stock/);
  assert.match(flow, /const V4_PAIRS = \['native', 'usdc', 'xstock'\]/);
  assert.match(flow, /function networkStep\(\) \{\n    fitPairToModel\(\);/, 'a saved pair is fitted before the step draws');
});

test('Model 10 is gone from the launch page: V2 is the only model, and its first buy can be paid in the native coin', () => {
  assert.match(flow, /const v2Chosen = \(\) => v2Offered\(\);/, 'V2 wherever its launchpad exists, with no model choice');
  assert.doesNotMatch(flow, /Model 10 · bonding curve|name: 'launch-model'/, 'no Model 10 option or model radio');
  assert.match(flow, /if \(v2Missing\(\)\) \{ error\.textContent = `ELPIDA V2 is not on/, 'a network without V2 cannot launch');
  assert.doesNotMatch(flow, /draft\.launchModel === 'v20' && v2Offered\(\)\) &&/, 'native first buy is offered for V2');
  assert.match(flow, /firstBuyConversionQuote\(\{ quoteAsset: selectedAsset\(\)\.address \?\? selectedAsset\(\)\.id, nativeAmount: draft\.nativeBuy, v2: v2Chosen\(\) \}\)/);
  assert.match(flow, /if \(v2Chosen\(\)\) \{ body\.model = V2_MODEL; body\.feeBps = draft\.feeBps \?\? V2\.defaultFeeBps; delete body\.tax; \}/, 'the native first buy is sent with a V2 launch');
});

test('the success screen describes a Model 11 launch as a Uniswap v4 pool, not a bonding curve', () => {
  assert.match(flow, /v4Chosen\(\) \? `\$\{draft\.name\} is trading in its Uniswap v4 pool on/);
});

test('the launch summary and the review name the launch model wherever Model 11 or V2 is offered', () => {
  assert.match(flow, /const modelsOffered = \(\) => v4Offered\(\) \|\| v2Offered\(\);/);
  assert.match(flow, /modelsOffered\(\) \? \[h\('dt', 'Launch model'\), h\('dd', modelName\(\)\)\]/);
  assert.match(flow, /modelsOffered\(\) \? \[row\('Launch model', modelName\(\)\)\]/);
  // V2: the creator's fee is chosen in the form, reviewed, and sent with the launch.
  assert.match(flow, /v2Chosen\(\) \? feeSelector\(\) : null/);
  assert.match(flow, /row\('Trading fee', `\$\{feePercent\(\)\}% on every trade, fixed for good`\)/);
  assert.match(flow, /if \(v2Chosen\(\)\) \{ body\.model = V2_MODEL; body\.feeBps = draft\.feeBps \?\? V2\.defaultFeeBps;/);
});
