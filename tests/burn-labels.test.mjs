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
  assert.deepEqual(flywheelChip({ symbol: 'HOPE', flywheelBurned: '12500000' }), { text: '1.25%', title: 'Flywheel: 12.50M $HOPE bought and burned, 1.25% of the 1B supply.' });
  assert.equal(flywheelChip({ symbol: 'A', flywheelBurned: '50000.5' }).text, '0.005%');
  assert.equal(flywheelChip({ symbol: 'A', flywheelBurned: '3' }).text, '<0.001%');
  assert.equal(flywheelChip({ symbol: 'A', flywheelBurned: '2000000000' }).text, '100%', 'never above the supply');
  for (const [share, text] of [[0.5, '0.50%'], [0.01, '0.01%'], [0.0099, '0.010%'], [0.0001, '<0.001%'], [42.123, '42.12%']]) assert.equal(percentText(share), text);
});

test('the token page safety list has no flywheel line (no flywheel since 23 Nov 2026)', () => {
  const lines = token => safetyChecks(token).map(c => c.text);
  assert.ok(!lines({ symbol: 'X', flywheelBurned: '10' }).some(t => /flywheel/i.test(t)));
});

test('V2 launch protection never shows the first-minute fee as the token fee', async () => {
  const { ownFeeBps } = await import('../apps/web/token-insights.mjs');
  const live = { model: 'v2-hook', feeBps: 3527, tokenFeeBps: 125, antiSnipeActive: true, feeSchedule: { base: 125 } };
  assert.equal(ownFeeBps(live), 125);
  assert.equal(ownFeeBps({ feeBps: 200 }), 200);
  assert.equal(ownFeeBps({}), 125);
  assert.ok(!safetyChecks(live).some(c => /35\.27/.test(c.text)), 'safety copy uses the own fee');
  assert.ok(!safetyChecks({ ...live, model: 'v4' }).some(c => /35\.27/.test(c.text)), 'other models too');
});

test('V2.3 fees split 50% traders / 30% creator / 20% Elpida in the rewards index', async () => {
  const { splitAccrued, V23_FEE_SPLIT, feeSplitOf } = await import('../packages/core/v2-economics.mjs');
  const s = splitAccrued(10_000n, 0n, feeSplitOf('v2.3-hook'));
  assert.deepEqual([s.traderAirdrop, s.creator, s.treasury, s.reserve], [5_000n, 3_000n, 2_000n, 0n]);
  assert.equal(feeSplitOf('v2.3-hook'), V23_FEE_SPLIT);
  assert.equal(splitAccrued(10_000n).traderAirdrop, 3_000n, 'the V2.0 hook keeps its split');
  const { V2RewardsIndexer } = await import('../packages/indexer/v2-rewards.mjs');
  const a = new V2RewardsIndexer({ provider: null, contracts: { hook: '0x0000000000000000000000000000000000000001' }, split: V23_FEE_SPLIT });
  const b = new V2RewardsIndexer({ provider: null, contracts: { hook: '0x0000000000000000000000000000000000000001' } });
  assert.equal(b.restore(a.snapshot()), false, 'a snapshot built with another split is re-read, not reused');
  assert.equal(a.restore(a.snapshot()), true);
});
