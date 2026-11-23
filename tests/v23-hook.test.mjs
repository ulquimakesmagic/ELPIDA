// ELPIDA V2.3 hook (contracts/evm/v2/ElpidaV23Hook.sol; Malik, 22-23 November 2026): every fee is split 50% traders /
// 30% creator / 20% treasury, with no flywheel or holder-reward vault. Everything else is the V2.0 hook: the same
// launch price, milestone, first-buy cap, anti-snipe and liquidity lock, so this checks the split, the books, the
// constructor's rule on the two removed vaults, and that the hook differs from V2.0 in the split constants only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseEther, ZeroAddress, Wallet, AbiCoder, concat } from 'ethers';
import { v2Fixture, launchV2, trade, parse, mined, v4Art, NATIVE_VIRTUAL_QUOTE } from './helpers/v2-fixture.mjs';

const KEYS = ['creator', 'traderAirdrop', 'flywheel', 'holderRewards', 'treasury'];

test('V2.3 splits every fee 30% creator / 50% traders / 20% treasury, pays nothing to a flywheel or holder vault', async t => {
  const f = await v2Fixture(t, { v23: true });
  assert.equal(await f.hook.MODEL_VERSION(), 23n);
  assert.deepEqual(await Promise.all(['CREATOR_BPS', 'AIRDROP_BPS', 'FLYWHEEL_BPS', 'HOLDER_BPS', 'TREASURY_BPS'].map(k => f.hook[k]())), [3000n, 5000n, 0n, 0n, 2000n]);
  assert.equal(await f.hook.flywheelVault(), ZeroAddress); assert.equal(await f.hook.holderRewardVault(), ZeroAddress);
  assert.equal(await f.factory.nativeVirtualQuote(), NATIVE_VIRTUAL_QUOTE, 'same $20,000 start');
  const l = await launchV2(f, { firstBuy: parseEther('0.2') });
  await f.advance(61);
  for (let i = 0; i < 4; i++) { await trade(f, l, { buy: true, amount: parseEther('0.7') }); await trade(f, l, { buy: false, amount: (await l.token.balanceOf(f.addresses[1])) / 3n }); }
  const [owedR] = await f.hook.ledgers(l.token.target), owed = [...owedR], info = await f.hook.launchOf(l.token.target), accrued = info.accrued;
  assert.ok(accrued > 0n);
  assert.equal(owed[0], accrued * 3000n / 10000n); assert.equal(owed[1], accrued * 5000n / 10000n); assert.equal(owed[4], accrued * 2000n / 10000n);
  assert.deepEqual([owed[2], owed[3]], [0n, 0n], 'no flywheel, no holder share');
  assert.ok(accrued - owed.reduce((a, b) => a + b, 0n) <= 2n, 'the split is exact up to rounding');
  assert.equal(await f.hook.totalOwed(ZeroAddress), await f.claims(ZeroAddress), 'the hook holds exactly what it owes');
  const before = await Promise.all(KEYS.map(k => (f.recipient(l, k) === ZeroAddress ? 0n : f.provider.getBalance(f.recipient(l, k)))));
  const w = await mined(f.hook.connect(f.signers[3]).withdrawFees(l.token.target));
  assert.equal(parse(f.hook, w, 'FeesWithdrawn').length, 3, 'three payouts: creator, traders, treasury');
  assert.equal(parse(f.hook, w, 'FeePayoutFailed').length, 0);
  const after = await Promise.all(KEYS.map(k => (f.recipient(l, k) === ZeroAddress ? 0n : f.provider.getBalance(f.recipient(l, k)))));
  for (const i of [0, 1, 4]) assert.equal(after[i] - before[i], owed[i], `${KEYS[i]} paid exactly what it was owed`);
});

test('V2.3 refuses a flywheel or holder vault, and needs the rest', async t => {
  const f = await v2Fixture(t, { v23: true }), art = v4Art('ElpidaV23Hook'), a = () => Wallet.createRandom().address;
  const deployWith = (fly, hold, airdrop = a()) => {
    const args = AbiCoder.defaultAbiCoder().encode(['address', 'address', 'address', 'address', 'address', 'address', 'uint256'], [f.manager.target, f.factory.target, f.treasury, airdrop, fly, hold, 100]);
    return f.signers[0].sendTransaction({ data: concat(['0x' + art.evm.bytecode.object.replace(/^0x/, ''), args]) });
  };
  // Plain CREATE reverts in the constructor (bad terms) or on the hook-address permission check; either way no hook.
  for (const [fly, hold, air] of [[a(), ZeroAddress], [ZeroAddress, a()], [ZeroAddress, ZeroAddress, ZeroAddress]]) await assert.rejects(deployWith(fly, hold, air));
});

test('V2.3 differs from the V2.0 hook only in the split, its version and the removed vaults', () => {
  const v2 = readFileSync(new URL('../contracts/evm/v2/ElpidaV2Hook.sol', import.meta.url), 'utf8');
  const v23 = readFileSync(new URL('../contracts/evm/v2/ElpidaV23Hook.sol', import.meta.url), 'utf8');
  const code = s => s.split('\n').filter(x => !/^\s*\/\//.test(x)).join('\n');
  const a = code(v2).split('\n'), b = code(v23).split('\n');
  const changed = b.filter(x => !a.includes(x)).map(x => x.trim()).filter(Boolean);
  assert.match(changed[0], /^contract ElpidaV23Hook /);
  assert.deepEqual(changed.slice(1), [
    'uint256 public constant AIRDROP_BPS = 5000;',
    'uint256 public constant FLYWHEEL_BPS = 0;',
    'uint256 public constant HOLDER_BPS = 0;',
    'uint256 public constant MODEL_VERSION = 23;',
    'if (factory_ == address(0) || treasury_ == address(0) || airdrop_ == address(0) || flywheel_ != address(0) || holder_ != address(0)) revert BadTerms();',
  ]);
});
