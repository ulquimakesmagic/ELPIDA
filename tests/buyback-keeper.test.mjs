// Automatic post-graduation buyback (apps/api/buyback-keeper.mjs, docs/AUTOMATIC_BUYBACK.md). After graduation a
// partner token's burn share sits in pool fees until someone harvests them; the keeper does it on a schedule, so the
// buyback no longer waits for a creator to press "Claim fees".
import test from 'node:test';
import assert from 'node:assert/strict';
import { Contract, ZeroAddress, parseEther } from 'ethers';
import { routerAbi } from '../packages/core/dex-router.mjs';
import { dexFixture, launch, complete, mined, art } from './helpers/dex-fixture.mjs';
import { BuybackKeeper, evmBuybackWorker, solanaBuybackWorker, withinBudget, configuredBuybackKeeper, BUYBACK_EVM_CHAINS } from '../apps/api/buyback-keeper.mjs';

const DEAD = '0x000000000000000000000000000000000000dEaD';

async function graduatedPartner(t) {
  const f = await dexFixture(t, { factoryName: 'ElpidaAtomicDexFactory' });
  await mined(f.factory.connect(f.signers[2]).setPartner(f.addresses[0], 2000, BigInt(await f.now()) + 30n * 86400n));
  const l = await launch(f, { native: true, firstBuy: parseEther('0.02') });
  await complete(f, l, { signer: f.signers[1] });
  const pool = await l.curve.pool();
  assert.notEqual(pool, ZeroAddress);
  const locker = await l.curve.locker(), splitter = new Contract(await l.curve.feeSplitter(), art('ElpidaFeeSplitter').abi, f.provider);
  const router = new Contract(f.dex.router.target, routerAbi(2), f.provider);
  const buy = async (signer, value) => {
    const deadline = (await f.now()) + 600, to = await signer.getAddress();
    await mined(router.connect(signer).multicall(deadline, [router.interface.encodeFunctionData('exactInputSingle', [{ tokenIn: f.dex.weth.target, tokenOut: l.token.target, fee: 10000, recipient: to, amountIn: value, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }])], { value }));
  };
  const tokenFirst = l.token.target.toLowerCase() < f.dex.weth.target.toLowerCase();
  // The record the public index serves for this token, as the keeper reads it.
  const listing = { address: l.token.target, symbol: 'PART', graduated: true, buybackBps: 2000, locker, feeSplitter: splitter.target, quoteAsset: f.dex.weth.target, tokenFirst, pair: 'native' };
  return { f, l, splitter, buy, listing };
}

test('EVM: one run collects the pool fees and spends the queued share on a buyback that is burned', async t => {
  const { f, l, splitter, buy, listing } = await graduatedPartner(t);
  // The local chain's gas price is far above the public testnets', so the caps here are raised.
  const worker = evmBuybackWorker({ chain: 'local', chainId: 31337, signer: f.signers[3], maxCost: parseEther('0.05'), dailyBudget: parseEther('1'), listings: async () => [listing, { ...listing, address: '0x1', graduated: false }, { ...listing, address: '0x2', buybackBps: 0 }] });
  assert.deepEqual((await worker.candidates()).map(t => t.address), [l.token.target], 'only graduated partner tokens');

  assert.equal(await worker.run(listing, { spent: 0n }), null, 'nothing to do before anyone trades on the pool');
  await buy(f.signers[1], parseEther('0.3'));
  const deadBefore = await l.token.balanceOf(DEAD), burnedBefore = await splitter.burned();
  const result = await worker.run(listing, { spent: 0n });
  assert.equal(result.hashes.length, 2, 'collectFees, then buyback');
  assert.ok(result.cost > 0n);
  assert.ok(BigInt(result.burned) > 0n, 'the buyback bought tokens');
  assert.ok(await splitter.burned() > burnedBefore);
  assert.equal(await l.token.balanceOf(DEAD) - deadBefore, await splitter.burned() - burnedBefore, 'everything it bought went to the dead address');
  assert.equal(await splitter.pendingBuyback(f.dex.weth.target), 0n, 'a small queue drains in one call');
  assert.equal(await worker.run(listing, { spent: 0n }), null, 'nothing left: no transaction');
});

test('EVM: the per-transaction cap and the daily budget stop the worker before it signs', async t => {
  const { f, buy, listing, splitter } = await graduatedPartner(t);
  await buy(f.signers[1], parseEther('0.3'));
  const capped = evmBuybackWorker({ chain: 'local', chainId: 31337, signer: f.signers[3], listings: async () => [listing], maxCost: 1n });
  await assert.rejects(capped.run(listing, { spent: 0n }), { code: 'transaction_cost' });
  const spentOut = evmBuybackWorker({ chain: 'local', chainId: 31337, signer: f.signers[3], listings: async () => [listing], maxCost: parseEther('0.05'), dailyBudget: parseEther('0.1') });
  await assert.rejects(spentOut.run(listing, { spent: parseEther('0.1') }), { code: 'daily_budget' });
  assert.equal(await splitter.pendingBuyback(f.dex.weth.target), 0n, 'nothing was collected or queued');
  assert.throws(() => evmBuybackWorker({ chain: 'base', chainId: 8453, signer: f.signers[3], listings: async () => [] }), /not an allowed testnet/, 'mainnets are refused');
  for (const id of [1, 56, 8453, 4663]) assert.equal(BUYBACK_EVM_CHAINS.has(id), false);
});

test('budget check: per-transaction cap, then what is left of the day', () => {
  assert.doesNotThrow(() => withinBudget(5n, { spent: 0n, maxCost: 5n, dailyBudget: 10n }));
  assert.throws(() => withinBudget(6n, { spent: 0n, maxCost: 5n, dailyBudget: 10n }), { code: 'transaction_cost' });
  assert.throws(() => withinBudget(5n, { spent: 6n, maxCost: 5n, dailyBudget: 10n }), { code: 'daily_budget' });
});

test('keeper: each token runs at most once per interval, spend is journaled per chain, and one failure does not block the rest', async () => {
  let clock = 1_000_000;
  const calls = [];
  const worker = {
    chain: 'test', unit: 'wei', format: v => String(v), address: async () => '0xkeeper',
    candidates: async () => [{ address: '0xA', symbol: 'A' }, { address: '0xB', symbol: 'B' }, { address: '0xC', symbol: 'C' }],
    run: async (token, { spent }) => {
      calls.push([token.symbol, spent]);
      if (token.symbol === 'B') throw Object.assign(new Error('rpc'), { code: 'SERVER_ERROR' });
      return token.symbol === 'A' ? { cost: 7n, hashes: ['0xa1'], burned: '42' } : null;
    },
  };
  const keeper = new BuybackKeeper({ workers: [worker], everyMs: 600_000, now: () => clock });
  await keeper.tick();
  assert.deepEqual(calls, [['A', 0n], ['B', 7n], ['C', 7n]], 'the budget already spent is passed on');
  let s = keeper.status().chains[0];
  assert.equal(s.address, '0xkeeper'); assert.equal(s.spentToday, '7');
  assert.deepEqual(s.last.hashes, ['0xa1']); assert.equal(s.lastError.code, 'SERVER_ERROR'); assert.equal(s.lastError.token, 'B');
  clock += 60_000; await keeper.tick();
  assert.equal(calls.length, 3, 'within the interval nothing reruns');
  clock += 600_000; await keeper.tick();
  assert.equal(calls.length, 6, 'after the interval each token is checked again');
  clock += 86_400_000; await keeper.tick();
  assert.equal(keeper.status().chains[0].spentToday, '7', 'only the last 24 hours count');
  await keeper.close();
});

test('keeper: a second keeper on the same journal waits for the lease', async t => {
  const dir = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'elpida-buyback-'));
  t.after(async () => (await import('node:fs')).rmSync(dir, { recursive: true, force: true }));
  const path = `${dir}/keeper.sqlite`, ran = [];
  const worker = name => ({ chain: 'test', unit: 'wei', format: String, address: async () => name, candidates: async () => [{ address: '0xA' }], run: async () => { ran.push(name); return null; } });
  const first = new BuybackKeeper({ workers: [worker('first')], path }), second = new BuybackKeeper({ workers: [worker('second')], path });
  await first.tick(); await second.tick();
  assert.deepEqual(ran, ['first']);
  await first.close(); await second.close();
});

// Solana: the instruction plan, against a fake connection and client (the instructions themselves are the ones the
// Rewards page sends, verified on devnet on 29 Oct 2026: docs/DESIGN_PARTNER_TIERS.md section 7).
function solanaFakes({ lpLocked = 1_000n, principal = 900n, pendingBuyback = 0n, quoteReserve = 2_000_000_000n, lpSupply = 1_000n, venue = 'Raydium', balance: start = 1_000_000_000n } = {}) {
  const sent = [];
  class PublicKey { constructor(v) { this.v = String(v); } toBase58() { return this.v; } equals(o) { return o.v === this.v; } }
  class Transaction { constructor() { this.instructions = []; } add(...i) { this.instructions.push(...i); return this; } compileMessage() { return {}; } }
  const web3 = { PublicKey, Transaction, sendAndConfirmTransaction: async (_c, tx) => { sent.push(tx.instructions.map(i => i.name)); return 'sig' + sent.length; } };
  let balance = start;
  const connection = {
    getAccountInfo: async () => ({ data: 'migration' }),
    getMultipleAccountsInfo: async keys => keys.map(() => ({ data: 'x' })),
    getLatestBlockhash: async () => ({ blockhash: 'h' }),
    getFeeForMessage: async () => ({ value: 5000 }),
    getBalance: async () => { const b = balance; balance -= 2500n; return Number(b); },
  };
  const client = {
    migrationPda: () => 'm', decodeMigration: () => ({ lpLocked, principal, pendingBuyback }),
    raydiumAccounts: () => ({ pool: 'p', vault0: 'v0', vault1: 'v1' }), pumpAccounts: () => ({ pool: 'p', poolBase: 'b', poolQuote: 'q' }),
    raydiumState: () => ({ lpSupply, base: 1_000_000n, quote: quoteReserve }), pumpState: () => ({ lpSupply, base: 1_000_000n, quote: quoteReserve }),
    harvestRaydiumFees: () => [{ name: 'ata' }, { name: 'harvestRaydium' }], harvestLpFees: () => [{ name: 'ata' }, { name: 'harvestPump' }],
    raydiumBuyback: () => ({ name: 'raydiumBuyback' }), computeBudget: () => ({ name: 'budget' }),
  };
  const helpers = {
    harvestNow: (lp, p) => lp - p, withdrawOut: (lp, s) => ({ base: s.base * lp / s.lpSupply, quote: s.quote * lp / s.lpSupply }),
    raydiumBuybackAmount: (pending, q) => (pending < q / 100n ? pending : q / 100n), HARVEST_COMPUTE_UNITS: 400_000,
  };
  const token = { address: 'MINT', symbol: 'MASHLE', config: 'CFG', reward: 'CREATOR', graduated: true, buybackBps: 2000, pumpPool: 'p', venue };
  const worker = opts => solanaBuybackWorker({ chain: 'solana-devnet', web3, connection, payer: { publicKey: new PublicKey('KEEPER') }, client, listings: async () => [token, { ...token, address: 'STD', buybackBps: 0 }, { ...token, address: 'CURVE', graduated: false }],
    configs: () => new Map([['CFG', { quoteMint: 'WSOL', treasury: 'TREASURY' }]]), quoteProgramOf: () => 'TOKEN', helpers, ...opts });
  return { worker, token, sent };
}

test('Solana: a Raydium partner pool with fees is harvested and bought back in one transaction', async () => {
  const { worker, token, sent } = solanaFakes();
  const w = worker();
  assert.deepEqual((await w.candidates()).map(t => t.address), ['MINT'], 'graduated partner tokens only');
  const result = await w.run(token, { spent: 0n });
  assert.deepEqual(sent, [['budget', 'ata', 'harvestRaydium', 'raydiumBuyback']]);
  assert.deepEqual(result.hashes, ['sig1']); assert.equal(result.cost, 2500n, 'cost is the payer\'s measured balance change');
});

test('Solana: below the harvest minimum only a queued buyback runs; with nothing queued nothing is sent', async () => {
  // 100 LP of 1000 over 2 SOL = 0.2 SOL of fees; a 1 SOL minimum skips the harvest.
  let f = solanaFakes({ pendingBuyback: 3_000_000n });
  assert.ok(await f.worker({ minHarvestLamports: 1_000_000_000n }).run(f.token, { spent: 0n }));
  assert.deepEqual(f.sent, [['budget', 'raydiumBuyback']]);
  f = solanaFakes();
  assert.equal(await f.worker({ minHarvestLamports: 1_000_000_000n }).run(f.token, { spent: 0n }), null);
  assert.deepEqual(f.sent, []);
  f = solanaFakes({ venue: 'PumpSwap' });
  await f.worker().run(f.token, { spent: 0n });
  assert.deepEqual(f.sent, [['budget', 'ata', 'harvestPump']], 'PumpSwap: harvest burns the token side; no PumpSwap buyback');
});

test('Solana: the daily budget stops the worker before it signs', async () => {
  const f = solanaFakes();
  await assert.rejects(f.worker({ dailyBudget: 1_000_000n }).run(f.token, { spent: 999_000n }), { code: 'daily_budget' });
  assert.deepEqual(f.sent, []);
  const poor = solanaFakes({ balance: 5_000_000n });
  await assert.rejects(poor.worker().run(poor.token, { spent: 0n }), { code: 'keeper_balance_low' }, 'the wallet must cover first-use account rent');
  assert.deepEqual(poor.sent, []);
});

test('configuration: off without keys, refuses Solana mainnet and a Railway service without a volume', async () => {
  const off = await configuredBuybackKeeper({ env: {}, publicIndex: { entries: new Map() } });
  assert.deepEqual(off.status(), { enabled: false, state: 'not_configured' });
  await assert.rejects(configuredBuybackKeeper({ env: { ELPIDA_BUYBACK_EVM_KEY: '0x' + '11'.repeat(32), RAILWAY_ENVIRONMENT_ID: 'x' }, publicIndex: { entries: new Map() }, path: '/tmp/x' }), /persistent Railway volume/);
  await assert.rejects(configuredBuybackKeeper({ env: { ELPIDA_BUYBACK_SOLANA_KEY: '[1]' }, publicIndex: { entries: new Map() }, solanaIndex: { network: { cluster: 'mainnet', mainnet: true } }, path: ':memory:' }), /Solana mainnet/);
  const mainnetOnly = await configuredBuybackKeeper({ env: { ELPIDA_BUYBACK_EVM_KEY: '0x' + '11'.repeat(32) }, publicIndex: { entries: new Map([['base', { net: { chainId: 8453 }, provider: null }]]) }, path: ':memory:' });
  assert.equal(mainnetOnly.status().state, 'no_eligible_network', 'an EVM mainnet entry gets no worker');
});
