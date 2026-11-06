// The launch form's model choice (6 November 2026): Model 11 is chosen before the pair, pairs it cannot take are shown
// as unavailable with the reason, and a saved stock or token pair falls back to the native coin instead of blocking
// the step with an error.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const flow = readFileSync(new URL('../apps/web/launch-flow.mjs', import.meta.url), 'utf8');

test('the launch model comes before the trading pair, and Model 11 limits the pairs it offers', () => {
  assert.ok(flow.indexOf("h('h3', 'Launch model')") < flow.indexOf("h('h3', 'Trading pair')"), 'model first, then pair');
  assert.match(flow, /v4Chosen\(\) && !V4_PAIRS\.includes\(kind\) \? 'Model 11 test launches pair with the native coin or USDC/);
  assert.match(flow, /const V4_PAIRS = \['native', 'usdc'\]/);
  assert.match(flow, /function networkStep\(\) \{\n    fitPairToModel\(\);/, 'a saved pair is fitted before the step draws');
  assert.match(flow, /draft\.launchModel = key; fitPairToModel\(\);/, 'and again when the model changes');
});
