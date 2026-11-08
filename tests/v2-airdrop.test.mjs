// V2.0 trader airdrop: 20% equal + 40% square root + 40% pro-rata, 1% cap per linked group (Malik, 8 November 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import { AIRDROP_RULES, qualifies, linkWallets, isqrt, allocateAirdrop, walletPayouts } from '../packages/core/v2-airdrop.mjs';

const USD = n => BigInt(Math.round(n * 1e6));
const sum = m => [...m.values()].reduce((a, b) => a + b, 0n);

test('the rules are the decided blend, and qualification needs real activity', () => {
  assert.equal(AIRDROP_RULES.equalBps + AIRDROP_RULES.sqrtBps + AIRDROP_RULES.proRataBps, 10_000);
  assert.deepEqual([AIRDROP_RULES.equalBps, AIRDROP_RULES.sqrtBps, AIRDROP_RULES.proRataBps, AIRDROP_RULES.traderCapBps], [2000, 4000, 4000, 100]);
  assert.equal(qualifies({ volumeUsd: 20, activeDays: 2, walletAgeDays: 7 }), true);
  assert.equal(qualifies({ volumeUsd: 19.99, activeDays: 2, walletAgeDays: 7 }), false);
  assert.equal(qualifies({ volumeUsd: 5000, activeDays: 1, walletAgeDays: 90 }), false, 'one day of trading is not enough');
  assert.equal(qualifies({ volumeUsd: 5000, activeDays: 9, walletAgeDays: 3 }), false, 'fresh wallets wait a week');
  assert.equal(qualifies({ volumeUsd: 5000, activeDays: 9, walletAgeDays: 90, creatorLinked: true }), false, 'creator-linked never qualifies');
});

test('the pool is split exactly, never over, and small traders get far more than pro-rata would give', () => {
  const traders = [{ id: 'whale', fees: USD(2000) }, { id: 'mid', fees: USD(125) }, { id: 'small', fees: USD(12.5) }, { id: 'tiny', fees: USD(0.25) }];
  for (let i = 0; i < 2996; i++) traders.push({ id: `t${String(i).padStart(4, '0')}`, fees: USD(0.3 + (i % 97) * 0.4) });
  const pool = USD(100_000);
  const { allocations, unallocated } = allocateAirdrop(pool, traders);
  assert.equal(sum(allocations) + unallocated, pool);
  assert.ok(unallocated < BigInt(traders.length) * 3n, 'only rounding dust is left over (a few base units per trader)');
  const totalFees = traders.reduce((a, t) => a + t.fees, 0n);
  const proRata = id => pool * traders.find(t => t.id === id).fees / totalFees;
  assert.ok(allocations.get('tiny') > proRata('tiny') * 20n, 'the smallest trader gets over 20× its pro-rata share');
  assert.ok(allocations.get('small') > proRata('small'));
  // Bigger traders still get more in total, in order.
  assert.ok(allocations.get('whale') > allocations.get('mid') && allocations.get('mid') > allocations.get('small') && allocations.get('small') > allocations.get('tiny'));
  // Cap: the whale is limited to 1% of the pool, and the rest is shared again.
  assert.equal(allocations.get('whale'), pool / 100n);
  for (const v of allocations.values()) assert.ok(v <= pool / 100n);
  // A young market (few traders): the cap is 20× the average share instead, so the formula still ranks people.
  const young = allocateAirdrop(pool, traders.slice(0, 4).concat(traders.slice(4, 40))).allocations;
  assert.ok(young.get('whale') > young.get('mid') && young.get('mid') > young.get('small'));
  assert.ok(young.get('whale') <= pool * 20n / 40n);
});

test('same input, same output (the keeper’s list can be recomputed by anyone)', () => {
  const traders = Array.from({ length: 50 }, (_, i) => ({ id: `w${i}`, fees: USD(0.3 + i * i) }));
  const a = allocateAirdrop(USD(777), traders), b = allocateAirdrop(USD(777), [...traders].reverse());
  assert.deepEqual([...a.allocations].sort(), [...b.allocations].sort());
  assert.equal(a.unallocated, b.unallocated);
  assert.throws(() => allocateAirdrop(USD(1), [{ id: 'x', fees: 1n }, { id: 'x', fees: 2n }]), /twice/);
  assert.equal(isqrt(10n ** 30n), 10n ** 15n); assert.equal(isqrt(99n), 9n);
});

test('linked wallets count as one trader, so splitting a wallet gains little', () => {
  const crowd = Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, fees: USD(2 + (i % 40)) }));
  const pool = USD(100_000);
  const whole = allocateAirdrop(pool, [...crowd, { id: 'big', fees: USD(500) }]).allocations.get('big');
  // The same trader as 50 unlinked wallets of $10 each:
  const split = allocateAirdrop(pool, [...crowd, ...Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, fees: USD(10) }))]).allocations;
  const splitTotal = Array.from({ length: 50 }, (_, i) => split.get(`s${i}`)).reduce((a, b) => a + b, 0n);
  assert.ok(splitTotal > whole, 'unlinked splitting does pay a little more');
  assert.ok(splitTotal < whole * 3n, 'but not much');
  // Linked by funding source, the 50 wallets are one trader again.
  const wallets = Array.from({ length: 50 }, (_, i) => `0x${(i + 16).toString(16).padStart(40, '0')}`);
  const groups = linkWallets(wallets, wallets.slice(1).map(w => [wallets[0], w]));
  assert.equal(new Set(groups.values()).size, 1);
  assert.equal(groups.get(wallets[49]), wallets[0]);
  assert.equal(linkWallets(['0xB', '0xa'], [['0xB', '0xa']]).get('0xb'), '0xa', 'group id is the lowest address');
});

test('a group’s allocation goes to its wallets by fees paid; payouts under the minimum carry to next month', () => {
  const allocations = new Map([['g1', 1_000n], ['g2', 7n]]);
  const wallets = [{ wallet: '0xA', group: 'g1', fees: 3n }, { wallet: '0xB', group: 'g1', fees: 1n }, { wallet: '0xC', group: 'g2', fees: 5n }];
  const first = walletPayouts(allocations, wallets, 10n);
  assert.equal(first.payouts.get('0xa'), 750n); assert.equal(first.payouts.get('0xb'), 250n);
  assert.equal(first.carried.get('0xc'), 7n, 'below the minimum: carried');
  const second = walletPayouts(new Map([['g2', 4n]]), [{ wallet: '0xC', group: 'g2', fees: 1n }], 10n, first.carried);
  assert.equal(second.payouts.get('0xc'), 11n, 'paid once it adds up');
  const idle = walletPayouts(new Map(), [], 10n, new Map([['0xd', 3n]]));
  assert.equal(idle.carried.get('0xd'), 3n, 'an earlier balance is never dropped');
});
