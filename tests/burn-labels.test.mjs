// Flywheel burn tag: Explore cards, the token page and its safety line show how much of a token's 1B supply the
// flywheels bought and burned (`flywheelBurned`, whole tokens, added by the API). Tokens with no burns get no tag.
import test from 'node:test';
import assert from 'node:assert/strict';
import { flywheelBurnOf, flywheelChip, flywheelCheck, percentText } from '../apps/web/burn-labels.mjs';
import { safetyChecks } from '../apps/web/token-insights.mjs';

test('no burns, no tag', () => {
  for (const v of [undefined, null, '', '0', 0, '-5', 'abc']) {
    assert.equal(flywheelBurnOf({ flywheelBurned: v }), null, String(v));
    assert.equal(flywheelChip({ symbol: 'X', flywheelBurned: v }), null);
    assert.equal(flywheelCheck({ symbol: 'X', flywheelBurned: v }), null);
  }
  // The partner fields are no longer shown.
  assert.equal(flywheelChip({ symbol: 'OLD', buybackBps: 2000, burned: '1000000' }), null);
});

test('the tag is the share of the original 1B supply bought and burned', () => {
  assert.deepEqual(flywheelChip({ symbol: 'HOPE', flywheelBurned: '12500000' }), { text: '1.25% burned', title: 'Flywheel: 12.50M $HOPE bought and burned, 1.25% of the 1B supply.' });
  assert.equal(flywheelChip({ symbol: 'A', flywheelBurned: '50000.5' }).text, '0.005% burned');
  assert.equal(flywheelChip({ symbol: 'A', flywheelBurned: '3' }).text, '<0.001% burned');
  assert.equal(flywheelChip({ symbol: 'A', flywheelBurned: '2000000000' }).text, '100% burned', 'never above the supply');
  for (const [share, text] of [[0.5, '0.50%'], [0.01, '0.01%'], [0.0099, '0.010%'], [0.0001, '<0.001%'], [42.123, '42.12%']]) assert.equal(percentText(share), text);
});

test('the token page safety list says what the flywheel burned', () => {
  assert.deepEqual(flywheelCheck({ symbol: 'X', flywheelBurned: '2500000' }), { ok: true, text: 'The Elpida flywheel has bought and burned 2.50M $X (0.25% of supply).' });
  const lines = token => safetyChecks(token).map(c => c.text);
  assert.ok(lines({ symbol: 'X', flywheelBurned: '10' }).some(t => t.startsWith('The Elpida flywheel has bought and burned')));
  assert.ok(!lines({ symbol: 'Y' }).some(t => /flywheel/.test(t)));
});
