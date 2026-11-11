// ELPIDA V2 creator holder strategies (contracts/evm/v2/ElpidaV2CreatorRewards.sol, apps/api/v2-keeper.mjs `creator`):
// a creator vault fixed at launch for one of three strategies, run by the keeper. On a local cancun chain with Uniswap's
// own v4 PoolManager and a real local Uniswap v3 USDC/WETH pool:
//  - share fees with holders: native fees paid to holders by balance, minimum holding applied, pools excluded;
//  - buy a reward token: native fees swapped into USDC on v3, paid in USDC;
//  - buy back and vest: native fees buy the token through the V2 router, and the tokens vest to holders over time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, ZeroAddress, Wallet, parseEther } from 'ethers';
import { v2Fixture, v4Art, mined, launchV2, trade } from './helpers/v2-fixture.mjs';
import { V2Indexer } from '../packages/indexer/v2-indexer.mjs';
import { V2Keeper } from '../apps/api/v2-keeper.mjs';

const DAY = 86_400;
const ERRORS = new Interface(v4Art('ElpidaV2CreatorRewards').abi);
/** Rejects with the vault's custom error `name` (by name when ethers decodes it, else by selector). */
const reverts = (promise, ...names) => assert.rejects(promise, e => names.some(n => e.revert?.name === n || JSON.stringify(e.data ?? e.info ?? e.message ?? '').includes(ERRORS.getError(n).selector.slice(2)) || String(e.message).includes(n)));

test('creator holder strategies: share with holders, buy a reward token, buy back and vest; the keeper runs them and can do nothing else', async t => {
  const f = await v2Fixture(t, { vaults: true, convert: true }), keeperAddr = f.addresses[4], art = v4Art('ElpidaV2CreatorRewards');
  const vaultOf = (...args) => f.deploy(art, keeperAddr, f.hook.target, f.router.target, f.contracts.v3.router.target, f.contracts.v3.weth.target, ...args, ...(args.length === 6 ? [0n, 0n] : []));
  // Settings are checked at deployment.
  await reverts(vaultOf(0, 2, ZeroAddress, parseEther('0.001'), 0n, 0n), 'BadTerms');
  await reverts(vaultOf(0, 0, ZeroAddress, 0n, 0n, 0n), 'BadTerms');
  await reverts(vaultOf(3000, 0, ZeroAddress, parseEther('0.001'), 0n, 10n), 'BadTerms');
  const holders = await vaultOf(0, 0, ZeroAddress, parseEther('0.002'), parseEther('100000'), 0n);
  const paired = await vaultOf(3000, 1, f.usdc.target, parseEther('0.002'), 0n, 0n);
  const buyback = await vaultOf(0, 2, ZeroAddress, parseEther('0.002'), 0n, BigInt(10 * DAY));
  // A USD minimum holding of $100 (version 2): applied by the keeper at the token's last trade price.
  const usdMin = await vaultOf(0, 0, ZeroAddress, parseEther('0.002'), 0n, 0n, 20_000_000n, 100_000_000n);
  assert.equal(await usdMin.CREATOR_REWARDS_VERSION(), 2n); assert.equal(await usdMin.thresholdUsdE6(), 20_000_000n);
  const tokens = {};
  for (const [name, vault] of [['HOLD', holders], ['PAIR', paired], ['BACK', buyback], ['USDM', usdMin]]) tokens[name] = await launchV2(f, { feeBps: 300, symbol: name, reward: vault.target });

  // Only the token whose creator vault it is can be bound, once; only the keeper can swap or post.
  await reverts(holders.bind(tokens.PAIR.token.target), 'BadTerms');
  await reverts(holders.connect(f.signers[1]).postRound('0x' + '11'.repeat(32), 1n, 1, ''), 'OnlyOperator', 'NotBound');

  const index = new V2Indexer({ provider: f.provider, factory: f.factory.target, hook: f.hook.target, poolManager: f.manager.target, router: f.router.target });
  t.after(() => index.close());
  let chainTime = (await f.provider.getBlock('latest')).timestamp;
  const keeper = new V2Keeper({ workers: [{ chain: 'local', net: { chainId: 31337, key: 'local' }, provider: f.provider, signer: f.signers[4],
    deployment: { hook: f.hook.target, airdrop: f.contracts.airdrop.target, holder: f.contracts.holder.target, flywheel: f.contracts.flywheel.target, poolManager: f.manager.target, router: f.router.target, factory: f.factory.target },
    index: () => index, usdPerUnit: a => (a === ZeroAddress.toLowerCase() ? 2500 : null) }], now: () => chainTime, publicUrl: 'https://elpida.test' });
  const w = keeper.workers[0];
  const run = async () => { chainTime = (await f.provider.getBlock('latest')).timestamp; await index.sync(); keeper.set('local:creator:last', 0); await keeper.creator(w); };

  // Two real holders buy each token; a third buys a dust amount (below the HOLD vault's minimum holding).
  await f.advance(61);
  for (const l of Object.values(tokens)) {
    await trade(f, l, { signer: f.signers[1], buy: true, amount: parseEther('0.3') });
    await trade(f, l, { signer: f.signers[2], buy: true, amount: parseEther('0.1') });
    await trade(f, l, { signer: f.signers[3], buy: true, amount: parseEther('0.00001') });
  }
  const eth = async () => Promise.all([1, 2, 3].map(i => f.provider.getBalance(f.addresses[i])));
  const before = await eth(), usdcBefore = await Promise.all([1, 2].map(i => f.usdc.balanceOf(f.addresses[i])));
  await run();
  assert.ok(keeper.db.prepare("SELECT status FROM v2k_runs WHERE job='creator'").all().every(r => r.status === 'ok'), JSON.stringify(keeper.db.prepare("SELECT detail FROM v2k_runs WHERE job='creator'").all()));

  // HOLD: one round in ETH, paid by balance; the dust holder is below the minimum; nothing is left promised.
  assert.equal(await holders.token(), tokens.HOLD.token.target, 'the keeper bound the vault');
  assert.equal(await holders.roundCount(), 1n);
  const [hRound] = [await holders.rounds(0)];
  assert.equal(hRound.asset, ZeroAddress); assert.equal(hRound.claimed, hRound.total, 'every payout pushed');
  const after = await eth(), got = after.map((v, i) => v - before[i]);
  const b1 = await tokens.HOLD.token.balanceOf(f.addresses[1]), b2 = await tokens.HOLD.token.balanceOf(f.addresses[2]);
  assert.ok(got[0] > 0n && got[1] > 0n && got[2] === 0n, `holders paid, the dust wallet not (${got})`);
  const share1 = hRound.total * b1 / (b1 + b2 + await tokens.HOLD.token.balanceOf(f.addresses[0]));
  assert.ok(got[0] >= share1 - 2n, 'by balance');
  assert.equal(await holders.reserved(ZeroAddress), 0n);

  // USDM: the dust holder (~$0.02 of tokens) is below the $100 minimum; the two real holders are paid.
  assert.equal(await usdMin.roundCount(), 1n);
  const uRound = await usdMin.rounds(0);
  assert.ok(uRound.total > 0n && uRound.recipients === 2n, `two holders above $100 (${uRound.recipients})`);

  // PAIR: the native fees became USDC on Uniswap v3; holders were paid in USDC.
  const [pRound] = [await paired.rounds(0)];
  assert.equal(pRound.asset, f.usdc.target);
  assert.ok((await f.usdc.balanceOf(f.addresses[1])) > usdcBefore[0] && (await f.usdc.balanceOf(f.addresses[2])) > usdcBefore[1]);

  // BACK: the fees bought the token back; holders receive it as it vests.
  const [bRound] = [await buyback.rounds(0)];
  assert.equal(bRound.asset, tokens.BACK.token.target); assert.equal(bRound.vesting, BigInt(10 * DAY));
  const vestedAt = async () => Promise.all([1, 2].map(i => tokens.BACK.token.balanceOf(f.addresses[i])));
  const start = await vestedAt();
  await f.advance(5 * DAY); await run();
  const half = await vestedAt();
  assert.ok(half[0] > start[0] && half[1] > start[1], 'vested tokens pushed');
  assert.ok((await buyback.rounds(0)).claimed * 100n / bRound.total >= 49n && (await buyback.rounds(0)).claimed * 100n / bRound.total <= 52n, 'about half after half the vesting');
  await f.advance(6 * DAY); await run();
  assert.equal((await buyback.rounds(0)).claimed, bRound.total, 'fully vested and paid');

  // Below the threshold nothing happens; the keeper cannot post a round larger than what the vault holds.
  await run();
  assert.equal(await holders.roundCount(), 1n, 'no new round without new fees');
  await reverts(holders.connect(f.signers[4]).postRound('0x' + '11'.repeat(32), parseEther('100'), 1, ''), 'NotFunded');
  await reverts(paired.connect(f.signers[4]).swap(1n, 1n), 'BelowThreshold');
  // A wallet that is not in a round cannot claim from it.
  await reverts(holders.claim(0, Wallet.createRandom().address, 1n, []), 'BadProof');
  // The round lists are published for anyone to check.
  assert.ok(keeper.manifest(31337, holders.target, 0, ZeroAddress)?.entries.length >= 2);
});
