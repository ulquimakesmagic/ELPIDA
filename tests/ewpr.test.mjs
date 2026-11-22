// EWPR trader rewards (packages/core/ewpr.mjs; Malik, 22 November 2026): eligibility thresholds, S = F^0.8 × C with
// C = 0.8 + 0.2 × min(D, 12) / 12, exact integer maths, R = V × S / ΣS never over the vault, zero-eligible rollover,
// linked wallets scored once, creator-linked groups excluded, and the keeper's round plan using it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EWPR_RULES, iroot, consistencyScaled, ewprScore, groupActivity, eligibility, allocateEwpr, ewprScores } from '../packages/core/ewpr.mjs';
import { ewprAirdropRound, airdropPlanFor } from '../packages/core/v2-keeper-plan.mjs';

const DAY = 86_400;
// 2 November 2026 (a Monday) 12:00 UTC.
const MON = Date.UTC(2026, 10, 2, 12) / 1000;

test('integer roots are exact floors', () => {
  for (const [v, n, r] of [[0n, 5, 0n], [1n, 5, 1n], [31n, 5, 1n], [32n, 5, 2n], [243n, 5, 3n], [10n ** 40n, 5, 10n ** 8n], [10n ** 40n - 1n, 5, 10n ** 8n - 1n]]) assert.equal(iroot(v, n), r, `${v}^(1/${n})`);
  for (let i = 0; i < 200; i++) { const v = BigInt(Math.floor(Math.random() * 1e15)) ** 4n, r = iroot(v, 5); assert.ok(r ** 5n <= v && (r + 1n) ** 5n > v); }
});

test('the consistency multiplier: 0.8 at none, 0.8667 at 4 days, 1.0 at 12 and capped after', () => {
  assert.equal(consistencyScaled(0), 9_600n);
  assert.equal(Number(consistencyScaled(4)) / 12_000, 0.8 + 0.2 * 4 / 12);
  assert.equal(consistencyScaled(12), 12_000n);
  assert.equal(consistencyScaled(30), 12_000n);
});

test('score: F^0.8 gives diminishing returns, ten times the fees is about 6.3 times the score', () => {
  const a = ewprScore(10_000_000n, 12), b = ewprScore(100_000_000n, 12);
  assert.equal(a, iroot(10_000_000n ** 4n, 5) * 12_000n);
  const ratio = Number(b) / Number(a);
  assert.ok(Math.abs(ratio - 10 ** 0.8) < 1e-4, `ratio ${ratio}`);
  assert.ok(Number(ewprScore(10_000_000n, 12)) / Number(ewprScore(10_000_000n, 4)) - 12 / 10.4 < 1e-9, 'consistency scales the score');
  assert.equal(ewprScore(0n, 12), 0n);
});

// A trader active on `days` days, every `gap` days (so 4 days span two weeks), `perDay` trades a day of $`value` each at 1.25%.
const activity = (account, { days = 4, perDay = 2, value = 20, startDay = 0, gap = 3 } = {}) => {
  const out = [];
  for (let d = 0; d < days; d++) for (let i = 0; i < perDay; i++) out.push({ account, timestamp: MON + (startDay + d * gap) * DAY + i * 60, feeUsd: value * 0.0125, valueUsd: value });
  return out;
};

test('eligibility: $100 volume, 8 trades, 4 days, 2 weeks, $1 fees, and not creator-linked', () => {
  const g = groupActivity([...activity('a', { days: 4, perDay: 2, value: 20 })]).get('a');
  assert.deepEqual([g.volumeUsd, g.trades, g.days, g.weeks], [160, 8, 4, 2]);
  assert.equal(eligibility(g).eligible, true, 'the minimum: $160 over 8 trades on 4 days in 2 weeks, $2 of fees');
  const small = groupActivity(activity('s', { days: 4, perDay: 2, value: 10 })).get('s');
  assert.equal(eligibility(small).checks.volume.ok, false, '$80 is under $100');
});

test('eligibility reports each requirement', () => {
  const ok = groupActivity(activity('a', { days: 4, perDay: 2, value: 60 })).get('a');
  assert.equal(eligibility(ok).eligible, true);
  const few = groupActivity(activity('b', { days: 4, perDay: 1, value: 60 })).get('b');
  const e = eligibility(few);
  assert.equal(e.eligible, false); assert.equal(e.checks.trades.ok, false); assert.equal(e.checks.trades.have, 4);
  const oneWeek = groupActivity(activity('c', { days: 4, perDay: 2, value: 60 }).map((t, i) => ({ ...t, timestamp: MON + Math.floor(i / 2) * DAY }))).get('c');
  assert.equal(oneWeek.weeks, 1); assert.equal(eligibility(oneWeek).checks.weeks.ok, false);
  const dust = groupActivity([...activity('d', { days: 4, perDay: 2, value: 60 }), ...Array.from({ length: 10 }, (_, i) => ({ account: 'd', timestamp: MON + 20 * DAY + i * DAY, feeUsd: 0.001, valueUsd: 0.08 }))]).get('d');
  assert.equal(dust.days, 4, 'dust days do not count'); assert.equal(dust.trades, 8, 'dust trades do not count');
  assert.equal(eligibility(undefined).eligible, false);
});

test('allocation: R = V × S / ΣS, never more than the vault, zero eligible keeps everything', () => {
  const { allocations, unallocated } = allocateEwpr(1_000_000n, [{ id: 'a', score: 3n }, { id: 'b', score: 1n }, { id: 'c', score: 0n }]);
  assert.equal(allocations.get('a'), 750_000n); assert.equal(allocations.get('b'), 250_000n); assert.equal(allocations.has('c'), false); assert.equal(unallocated, 0n);
  const odd = allocateEwpr(100n, [{ id: 'a', score: 1n }, { id: 'b', score: 1n }, { id: 'c', score: 1n }]);
  assert.equal([...odd.allocations.values()].reduce((x, y) => x + y, 0n) + odd.unallocated, 100n); assert.equal(odd.unallocated, 1n);
  const none = allocateEwpr(5_000n, []);
  assert.equal(none.allocations.size, 0); assert.equal(none.unallocated, 5_000n);
  assert.throws(() => allocateEwpr(1n, [{ id: 'a', score: 1n }, { id: 'a', score: 2n }]), /twice/);
});

const indexed = (account, opts) => activity(account, opts).map(t => ({ account: t.account, timestamp: t.timestamp, feeRaw: String(BigInt(Math.round(t.feeUsd * 1e6))), quoteDecimals: 6, asset: '0xusdc', quoteUsd: t.valueUsd }));
const usd = () => 1;
const start = Date.UTC(2026, 10, 1) / 1000, end = Date.UTC(2026, 11, 1) / 1000;

test('linked wallets score once, so splitting does not pay; creator-linked groups get nothing', () => {
  const solo = ewprScores({ trades: indexed('0xa', { days: 6, perDay: 4, value: 100 }), start, end, usdPerUnit: usd });
  const split = ewprScores({ trades: [...indexed('0xb1', { days: 6, perDay: 2, value: 100 }), ...indexed('0xb2', { days: 6, perDay: 2, value: 100 })], start, end, usdPerUnit: usd, links: [['0xb1', '0xb2']] });
  assert.equal(split.scored.length, 1); assert.equal(split.scored[0].score, solo.scored[0].score, 'two linked wallets score as one');
  const unlinked = ewprScores({ trades: [...indexed('0xb1', { days: 6, perDay: 2, value: 100 }), ...indexed('0xb2', { days: 6, perDay: 2, value: 100 })], start, end, usdPerUnit: usd });
  assert.ok(unlinked.scored.reduce((a, s) => a + s.score, 0n) > solo.scored[0].score, 'which is why linking matters');
  const creator = ewprScores({ trades: [...indexed('0xc', { days: 6, perDay: 2, value: 100 }), ...indexed('0xd', { days: 6, perDay: 2, value: 100 })], start, end, usdPerUnit: usd, creatorLinked: ['0xc'] });
  assert.deepEqual(creator.scored.map(s => s.id), ['0xd']);
});

test('the keeper round: EWPR from round 0, wallets of a group paid by their fees, small payouts carried', () => {
  assert.equal(EWPR_RULES.version, 'ewpr-1');
  const trades = [...indexed('0xa', { days: 12, perDay: 2, value: 200, gap: 2 }), ...indexed('0xb', { days: 4, perDay: 2, value: 60 }), ...indexed('0xc', { days: 2, perDay: 1, value: 60 })];
  const plan = airdropPlanFor(0, { trades, start, end, usdPerUnit: usd, pools: { '0xusdc': 100_000_000n }, decimals: { '0xusdc': 6 } });
  assert.equal(plan.model, 'ewpr-1');
  assert.deepEqual(plan.qualified.sort(), ['0xa', '0xb']);
  const p = plan.byAsset['0xusdc'], paid = [...p.payouts.values()].reduce((a, b) => a + b, 0n);
  assert.ok(paid + p.unallocated <= 100_000_000n);
  assert.ok(p.payouts.get('0xa') > p.payouts.get('0xb'));
  assert.equal(plan.scores['0xa'].days, 12);
  const tiny = ewprAirdropRound({ trades, start, end, usdPerUnit: usd, pools: { '0xusdc': 1_500_000n }, decimals: { '0xusdc': 6 } });
  assert.ok(tiny.byAsset['0xusdc'].carried.size >= 1, 'a share under $1 waits for next month');
});
