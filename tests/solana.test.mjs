// Solana program tests (model 3 bonding curve) against a throwaway solana-test-validator. They deploy
// contracts/solana/build/elpida_launchpad.so with the same code as `npm run solana:deploy`, then
// exercise launch, the anti-snipe fee, trading, fee payout and graduation at the target FDV.
// The main config is a 6-decimal paired test token sized 5k → 50k FDV in that token, with a SOL creation
// fee and a short 4-second anti-snipe window so the decay can be observed quickly. Migration tests load the real PumpSwap program from
// contracts/solana/fixtures (solana-pumpswap-fixtures.cmd). Skipped when solana-test-validator is
// not installed (for example on plain Windows); set SOLANA_TEST_VALIDATOR to its path to run them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as web3 from '@solana/web3.js';
import {
  createElpidaSolana, quoteBuy, quoteSell, currentFeeBps, curveParams, poolStats, encodeCurveParams,
  DISCRIMINATORS, EVENTS, LEGACY_EVENTS, TOKEN_SUPPLY, STATUS_GRADUATED, STATUS_MIGRATED, BPS, explainError, decodeEvents,
  harvestableLp, harvestNow, liquidityUnits, withdrawOut, isqrt, PUMP_AMM_PROGRAM, PUMP_GLOBAL_CONFIG, TOKEN_2022_PROGRAM, MIGRATE_COMPUTE_UNITS, HARVEST_COMPUTE_UNITS, TEST_FAUCET_MAX_WHOLE, WSOL_MINT, splTestMint,
} from '../packages/solana/client.mjs';
import { solanaPairTemplates } from '../packages/core/pairs.mjs';
import { solanaPricing } from '../packages/core/pricing.mjs';
import { deployProgram, upgradeProgram, ensurePairConfigs, pricingUpdates, ensureBetaGate, rejectsTestInstructions, prepareUpgradeBuffer, transferUpgradeAuthority, send, airdrop } from '../packages/solana/deploy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const elfPath = `${root}contracts/solana/build/elpida_launchpad.so`;
const mainnetElfPath = `${root}contracts/solana/build/elpida_launchpad-mainnet.so`;
const keyPath = `${root}contracts/solana/keys/elpida_launchpad-keypair.json`;
const validatorBin = process.env.SOLANA_TEST_VALIDATOR ?? 'solana-test-validator';
let skip = false;
if (spawnSync(validatorBin, ['--version'], { stdio: 'ignore' }).status !== 0) skip = 'solana-test-validator not found (install the Solana CLI or set SOLANA_TEST_VALIDATOR).';
else if (!existsSync(elfPath) || !existsSync(keyPath)) skip = 'Compiled Solana program or program keypair not found.';
const fixtures = `${root}contracts/solana/fixtures/`;
const pumpSkip = skip || (!existsSync(`${fixtures}pump_amm.so`) || !existsSync(`${fixtures}pumpswap_global_config.json`) ? 'PumpSwap fixtures missing (run solana-pumpswap-fixtures.cmd or node scripts/solana-pumpswap-fixtures.mjs).' : false);

const { Keypair, PublicKey } = web3;
const USDC = 1_000_000n; // one whole unit of the 6-decimal test quote token
const FEE_SOL = 10_000_000n; // 0.01 SOL creation fee
const PARAMS = curveParams({ startFdv: 5_000, endFdv: 50_000, quoteDecimals: 6, launchFee: '0.01', snipeWindowSecs: 4 });
const BASE = BigInt(PARAMS.baseFeeBps);
const f = {};
const sleep = ms => new Promise(r => setTimeout(r, ms));

test.before(async () => {
  if (skip) return;
  const port = 20000 + Math.floor(Math.random() * 20000);
  f.ledger = mkdtempSync(join(tmpdir(), 'elpida-ledger-'));
  f.validator = spawn(validatorBin, ['--reset', '--quiet', '--ledger', f.ledger, '--rpc-port', String(port), '--faucet-port', String(port + 2), '--dynamic-port-range', `${port + 10}-${port + 60}`, '--gossip-port', String(port + 3),
    ...(pumpSkip ? [] : ['--bpf-program', PUMP_AMM_PROGRAM, `${fixtures}pump_amm.so`, '--account', PUMP_GLOBAL_CONFIG, `${fixtures}pumpswap_global_config.json`])], { stdio: 'ignore' });
  f.connection = new web3.Connection(`http://127.0.0.1:${port}`, 'confirmed');
  for (let i = 0; ; i++) {
    try { await f.connection.getLatestBlockhash(); break; }
    catch { if (i > 120) throw new Error('solana-test-validator did not start'); await sleep(500); }
  }
  [f.authority, f.creator, f.trader, f.outsider, f.rewardWallet] = Array.from({ length: 5 }, () => Keypair.generate());
  for (const kp of [f.authority, f.creator, f.trader, f.outsider]) await airdrop(f.connection, kp.publicKey, 20 * web3.LAMPORTS_PER_SOL);
  f.programKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, 'utf8'))));
  await deployProgram({ connection: f.connection, payer: f.authority, programKeypair: f.programKeypair, elf: readFileSync(elfPath), sendsPerSecond: 200 });
  f.client = createElpidaSolana(web3, f.programKeypair.publicKey);
  // A 6-decimal test token as the main pair asset, minted to the creator and the trader.
  const spl = splTestMint(web3), quote = Keypair.generate();
  await send(f.connection, f.authority, await spl.createMintIxs(f.connection, f.authority.publicKey, quote.publicKey, 6, f.authority.publicKey), [quote]);
  for (const owner of [f.creator.publicKey, f.trader.publicKey]) await send(f.connection, f.authority, [f.client.createAtaIdempotent(f.authority.publicKey, owner, quote.publicKey), spl.mintTo(quote.publicKey, f.client.ata(owner, quote.publicKey), f.authority.publicKey, 100_000n * USDC)]);
  f.quoteMint = quote.publicKey;
  f.treasury = Keypair.generate().publicKey;
  f.config = { address: f.client.configFor(f.quoteMint), quoteMint: f.quoteMint, treasury: f.treasury };
});
test.after(() => {
  f.validator?.kill('SIGKILL');
  if (f.ledger) rmSync(f.ledger, { recursive: true, force: true });
});

const balance = async address => f.client.tokenAmount((await f.connection.getAccountInfo(address))?.data);
const pool = async mint => f.client.decodePool((await f.connection.getAccountInfo(f.client.poolPda(mint))).data);
const failsWith = async (promise, pattern) => {
  try { await promise; } catch (error) { assert.match(`${error.message} ${(error.logs ?? []).join(' ')}`, pattern); return; }
  assert.fail(`expected failure matching ${pattern}`);
};
const txOf = signature => f.connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
const eventsOf = async signature => decodeEvents((await txOf(signature)).meta.logMessages, PublicKey);
/** Waits until the cluster clock is past the pool's anti-snipe window, so trades pay the base fee. */
async function afterSnipeWindow(mint) {
  const { createdAt } = await pool(mint);
  for (;;) {
    const now = await f.connection.getBlockTime(await f.connection.getSlot('confirmed'));
    if (BigInt(now ?? 0) >= createdAt + BigInt(PARAMS.snipeWindowSecs) + 1n) return;
    await sleep(500);
  }
}
const buy = (who, mint, grossIn, minTokensOut) => send(f.connection, who, [f.client.buy({ buyer: who.publicKey, config: f.config, mint, grossIn, minTokensOut })], [], 1);
const sell = (who, mint, tokensIn, minQuoteOut) => send(f.connection, who, [f.client.sell({ seller: who.publicKey, config: f.config, mint, tokensIn, minQuoteOut })], [], 1);
const withdraw = mint => send(f.connection, f.outsider, [f.client.withdrawFees({ payer: f.outsider.publicKey, config: f.config, mint, reward: f.rewardWallet.publicKey })]);
const parseAmountWhole = (whole, unit) => { const [i, d = ''] = String(whole).split('.'); const digits = unit.toString().length - 1; return BigInt(i) * unit + BigInt((d + '0'.repeat(digits)).slice(0, digits) || '0'); };
const freshPool = () => ({ virtualQuote: PARAMS.virtualQuote, virtualToken: PARAMS.virtualToken, curveSupply: PARAMS.curveSupply, realQuote: 0n, sold: 0n, liquidityBonus: 0n, status: 0 });

async function launch({ firstBuy = 25n * USDC, minOut, symbol = 'SOLG', name = 'Solana Garden', creator = f.creator } = {}) {
  const mint = Keypair.generate();
  const expected = firstBuy > 0n ? quoteBuy(freshPool(), firstBuy, BASE) : { tokens: 1n };
  const signature = await send(f.connection, creator, [f.client.computeBudget(), f.client.launch({ creator: creator.publicKey, config: f.config, mint: mint.publicKey, name, symbol, firstBuy, minTokensOut: minOut ?? expected.tokens, reward: f.rewardWallet.publicKey })], [mint], 1);
  return { mint: mint.publicKey, expected, signature };
}
async function invariant(mint) {
  const p = await pool(mint);
  const poolKey = f.client.poolPda(mint);
  assert.equal(await balance(f.client.ata(poolKey, f.quoteMint)), p.realQuote + p.liquidityBonus + p.protocolFees + p.creatorFees, 'quote vault = curve reserve + locked bonus + owed fees');
  assert.equal(await balance(f.client.ata(poolKey, mint)), TOKEN_SUPPLY - p.sold, 'token vault = supply - sold');
  assert.ok(p.sold <= p.curveSupply, 'never sells past the curve supply');
  return p;
}

test('Solana client discriminators, curve parameters and error decoding', () => {
  const disc = name => [...createHash('sha256').update(name).digest().subarray(0, 8)];
  for (const [key, name] of [['updateCurveConfig', 'global:update_curve_config'], ['initializeCurve', 'global:initialize_curve'], ['launch', 'global:launch'], ['buy', 'global:buy'], ['sell', 'global:sell'], ['withdrawFees', 'global:withdraw_fees'], ['CurveConfig', 'account:CurveConfig'], ['CurvePool', 'account:CurvePool'], ['migrateToPumpswap', 'global:migrate_to_pumpswap'], ['harvestLpFees', 'global:harvest_lp_fees'], ['PumpMigration', 'account:PumpMigration'], ['setBetaGate', 'global:set_beta_gate'], ['allowBetaCreator', 'global:allow_beta_creator'], ['revokeBetaCreator', 'global:revoke_beta_creator'], ['BetaGate', 'account:BetaGate'], ['BetaCreator', 'account:BetaCreator'], ['testBuildCheck', 'global:test_build_check']]) {
    assert.deepEqual(DISCRIMINATORS[key], disc(name), key);
  }
  for (const [name, { discriminator }] of [...Object.entries(EVENTS), ...Object.entries(LEGACY_EVENTS)]) assert.deepEqual(discriminator, disc(`event:${name}`), name);
  // Events emitted by the first deployed program version must still decode, flagged as legacy.
  const legacy = Buffer.concat([Buffer.from(LEGACY_EVENTS.Bought.discriminator), Buffer.alloc(64, 1), Buffer.from(new BigUint64Array([7n, 9n]).buffer)]);
  const [old] = decodeEvents([`Program data: ${legacy.toString('base64')}`], web3.PublicKey);
  assert.equal(old.name, 'Bought'); assert.equal(old.legacy, true);
  assert.equal(old.quoteIn, 7n); assert.equal(old.tokensOut, 9n); assert.equal(old.price, undefined);
  assert.equal(explainError(new Error('failed: custom program error: 0x1777')), 'Price moved beyond your slippage limit.');
  assert.match(explainError(new Error('failed: custom program error: 0x177c')), /complete/);

  // A 5k → 50k FDV curve; the DEX opens at the graduation price. The creation fee is always lamports.
  const p = curveParams({ startFdv: 5_000, endFdv: 50_000, quoteDecimals: 6, launchFee: 10 });
  assert.equal(p.virtualToken, 1_111_111_111_111_111n);
  assert.equal(p.virtualQuote, 5_555_555_556n);
  assert.equal(encodeCurveParams(p).length, 42);
  assert.equal(p.launchFee, 10n * 1_000_000_000n, 'fee in lamports whatever the quote decimals');
  assert.equal(curveParams({ startFdv: '0.5', endFdv: '5', quoteDecimals: 9, launchFee: '0.01' }).launchFee, 10_000_000n);
  // Native pricing file: SOL pair templates carry the configured values.
  const dev = solanaPricing('devnet');
  const [solPair, testToken] = solanaPairTemplates(dev, { test: true });
  assert.equal(solPair.wsol, true); assert.equal(solPair.launchFee, dev.launchFee); assert.equal(solPair.startFdv, dev.startFdv);
  assert.equal(testToken.launchFee, dev.launchFee, 'paired-token launches pay the same SOL fee');
  assert.equal(solanaPairTemplates(solanaPricing('mainnet')).length, 1, 'mainnet: native SOL only');
  assert.ok(Math.abs(poolStats(freshPool()).marketCap - 5_000) < 0.01);
  const last = quoteBuy(freshPool(), 1_000_000n * USDC, 125n);
  assert.equal(last.graduates, true); assert.equal(last.tokens, p.curveSupply);
  const end = { ...freshPool(), realQuote: last.net, sold: last.tokens };
  assert.ok(Math.abs(poolStats(end).marketCap - 50_000) < 0.01, 'graduates at $50k FDV');
  const dexPrice = Number(last.net) / Number(TOKEN_SUPPLY - last.tokens);
  assert.ok(Math.abs(dexPrice / poolStats(end).price - 1) < 1e-9, 'DEX pool (raised quote : remaining tokens) opens at the final curve price');
  // Anti-snipe schedule: 90% at launch, linear to 1.25% at 60s.
  // Harvest math: no fee growth → nothing to harvest; 21% more quote at constant LP → sqrt grows 10% → ~9.1% of LP.
  const state = { lpSupply: 1_000_000n, base: 4_000_000n, quote: 1_000_000n };
  const principal = liquidityUnits(1_000_000n - 100n, state);
  assert.equal(harvestableLp(1_000_000n - 100n, principal, state), 0n);
  const grown = { ...state, quote: 1_210_000n };
  const h = harvestableLp(1_000_000n - 100n, principal, grown);
  assert.ok(h > 90_000n && h < 91_000n, `harvest ${h}`);
  assert.ok(liquidityUnits(1_000_000n - 100n - h, { lpSupply: grown.lpSupply - h, base: grown.base - withdrawOut(h, grown).base, quote: grown.quote - withdrawOut(h, grown).quote }) >= principal);
  assert.equal(isqrt(10n ** 30n), 10n ** 15n);
  const cfg = { baseFeeBps: 125, snipeStartBps: 9000, snipeWindowSecs: 60 };
  assert.deepEqual([0, 30, 59, 60, 600].map(t => currentFeeBps(cfg, 1000, 1000 + t)), [9000n, 4562n, 272n, 125n, 125n]);
});

test('Solana: only the upgrade authority can create a pair config, with valid parameters, once', { skip }, async () => {
  const add = (payer, params = PARAMS) => send(f.connection, payer, [f.client.addCurveConfig({ authority: payer.publicKey, quoteMint: f.quoteMint, treasury: f.treasury, params })], [], 1);
  await failsWith(add(f.outsider), /0x1770/);
  await failsWith(add(f.authority, { ...PARAMS, curveSupply: 0n }), /0x1774/);
  await failsWith(add(f.authority, { ...PARAMS, snipeStartBps: 9_950 }), /0x1774/);
  await add(f.authority);
  const config = f.client.decodeConfig((await f.connection.getAccountInfo(f.config.address)).data);
  assert.equal(config.quoteMint.toBase58(), f.quoteMint.toBase58());
  assert.equal(config.treasury.toBase58(), f.treasury.toBase58());
  assert.equal(config.launchFee, FEE_SOL);
  assert.equal(config.quoteDecimals, 6);
  assert.equal(config.modelVersion, 3);
  assert.equal(config.virtualQuote, PARAMS.virtualQuote); assert.equal(config.virtualToken, PARAMS.virtualToken); assert.equal(config.curveSupply, PARAMS.curveSupply);
  assert.equal(config.baseFeeBps, 125); assert.equal(config.snipeStartBps, 9000); assert.equal(config.snipeWindowSecs, 4); assert.equal(config.maxCreatorBuyBps, 0);
  await failsWith(add(f.authority), /already in use|0x0/);
});

test('Solana launch charges the fee, fixes supply and does the creator buy at the base fee', { skip }, async () => {
  const before = await balance(f.client.ata(f.creator.publicKey, f.quoteMint));
  const { mint, expected, signature } = await launch();
  assert.equal(await f.connection.getBalance(f.treasury), Number(FEE_SOL), 'treasury received the 0.01 SOL creation fee');
  const p = await invariant(mint);
  assert.equal(p.name, 'Solana Garden'); assert.equal(p.symbol, 'SOLG');
  assert.equal(p.creator.toBase58(), f.creator.publicKey.toBase58());
  assert.equal(p.reward.toBase58(), f.rewardWallet.publicKey.toBase58());
  assert.equal(p.sold, expected.tokens, 'creator buy is exempt from the anti-snipe fee');
  assert.equal(p.realQuote, expected.net);
  assert.equal(p.liquidityBonus, 0n);
  assert.equal(p.protocolFees + p.creatorFees, expected.fee);
  assert.equal(p.status, 0); assert.equal(p.graduatedAt, 0n);
  assert.equal(await balance(f.client.ata(f.treasury, f.quoteMint)), 0n, 'no creation fee in the pair asset');
  assert.equal(await balance(f.client.ata(f.creator.publicKey, f.quoteMint)), before - 25n * USDC, 'the creator spent only the first buy in the pair asset');
  assert.equal(await balance(f.client.ata(f.creator.publicKey, mint)), expected.tokens);
  const mintData = (await f.connection.getAccountInfo(mint)).data;
  assert.equal(mintData[0], 0, 'mint authority revoked');
  assert.equal(mintData.readBigUInt64LE(36), TOKEN_SUPPLY, 'supply is exactly 1B');
  assert.equal(mintData[44], 6, 'token decimals');
  assert.equal(mintData[46], 0, 'no freeze authority');
  const [launched] = (await eventsOf(signature)).filter(e => e.name === 'CurveLaunched');
  assert.equal(launched.quoteIn, 25n * USDC); assert.equal(launched.tokensOut, expected.tokens); assert.equal(launched.fee, expected.fee);
  assert.equal(launched.virtualQuote, p.virtualQuote + p.realQuote); assert.equal(launched.tokenReserve, p.virtualToken - p.sold);
});

test('Solana launch rejects bad input and leaves no partial state', { skip }, async () => {
  const before = await balance(f.client.ata(f.creator.publicKey, f.quoteMint));
  const treasuryBefore = await f.connection.getBalance(f.treasury);
  await failsWith(launch({ firstBuy: 0n }), /0x1775/);
  await failsWith(launch({ symbol: 'bad!' }), /0x1773/);
  await failsWith(launch({ minOut: TOKEN_SUPPLY }), /0x1777/);
  // A creator without the pair asset cannot launch (a buy larger than the curve is capped, not rejected).
  await failsWith(launch({ creator: f.outsider }), /AccountNotInitialized|0xbc4|insufficient funds|0x1\b/);
  assert.equal(await balance(f.client.ata(f.creator.publicKey, f.quoteMint)), before);
  assert.equal(await f.connection.getBalance(f.treasury), treasuryBefore);
});

test('Solana anti-snipe fee decays over the window and its surplus stays locked as liquidity', { skip }, async () => {
  const { mint } = await launch({ symbol: 'SNIPE' });
  const before = await pool(mint);
  const gross = 50n * USDC;
  const signature = await buy(f.trader, mint, gross, 1n);
  const [bought] = (await eventsOf(signature)).filter(e => e.name === 'CurveBought');
  const now = (await txOf(signature)).blockTime;
  // The cluster clock and the transaction's block time can differ by a second; accept a neighbour.
  const candidates = [-1, 0, 1].map(d => quoteBuy(before, gross, currentFeeBps(PARAMS, before.createdAt, now + d), BASE));
  const q = candidates.find(c => c.fee === bought.fee);
  assert.ok(q, `fee ${bought.fee} matches the decay schedule near block time ${now}`);
  assert.ok(q.antiSnipeFee > 0n, 'sniper pays above the base fee');
  assert.ok(bought.fee * BPS / gross > BASE, 'effective fee above 1.25%');
  assert.equal(bought.antiSnipeFee, q.antiSnipeFee); assert.equal(bought.tokensOut, q.tokens);
  const p = await invariant(mint);
  assert.equal(p.liquidityBonus, q.antiSnipeFee, 'surplus goes to locked liquidity');
  assert.equal(p.protocolFees + p.creatorFees - (before.protocolFees + before.creatorFees), q.baseFee, 'only the base fee is shared');

  await afterSnipeWindow(mint);
  const q2 = quoteBuy(await pool(mint), gross, BASE);
  const [later] = (await eventsOf(await buy(f.trader, mint, gross, q2.tokens))).filter(e => e.name === 'CurveBought');
  assert.equal(later.fee, q2.fee); assert.equal(later.antiSnipeFee, 0n);
  assert.equal((await invariant(mint)).liquidityBonus, p.liquidityBonus);
});

test('Solana buy and sell match the shared client math and enforce slippage', { skip }, async () => {
  const { mint } = await launch({ symbol: 'TRADE' });
  await afterSnipeWindow(mint);
  const gross = 75n * USDC + 19n;
  const q = quoteBuy(await pool(mint), gross, BASE);
  await failsWith(buy(f.trader, mint, gross, q.tokens + 1n), /0x1777/);
  await buy(f.trader, mint, gross, q.tokens);
  assert.equal(await balance(f.client.ata(f.trader.publicKey, mint)), q.tokens);
  await invariant(mint);
  const s = quoteSell(await pool(mint), q.tokens, BASE);
  await failsWith(sell(f.trader, mint, q.tokens, s.net + 1n), /0x1777/);
  const before = await balance(f.client.ata(f.trader.publicKey, f.quoteMint));
  await sell(f.trader, mint, q.tokens, s.net);
  assert.equal(await balance(f.client.ata(f.trader.publicKey, f.quoteMint)), before + s.net);
  assert.equal(await balance(f.client.ata(f.trader.publicKey, mint)), 0n);
  await failsWith(sell(f.trader, mint, 1_000_000_000n, 0n), /insufficient funds|0x1\b/, 'cannot sell tokens it does not hold');
  await invariant(mint);
});

test('Solana fee payout is permissionless, fixed-destination and never touches liquidity', { skip }, async () => {
  const { mint } = await launch({ firstBuy: 100n * USDC + 80n, symbol: 'FEES' });
  await buy(f.trader, mint, 40n * USDC, 1n); // inside the snipe window: also creates a locked bonus
  const p = await pool(mint);
  assert.ok(p.creatorFees >= p.protocolFees);
  await failsWith(send(f.connection, f.outsider, [f.client.withdrawFees({ payer: f.outsider.publicKey, config: f.config, mint, reward: f.outsider.publicKey })], [], 1), /0x7d1|2001/);
  const treasuryBefore = await balance(f.client.ata(f.treasury, f.quoteMint));
  const rewardBefore = await balance(f.client.ata(f.rewardWallet.publicKey, f.quoteMint));
  await withdraw(mint);
  const after = await invariant(mint);
  assert.equal(after.protocolFees, 0n); assert.equal(after.creatorFees, 0n);
  assert.equal(after.realQuote, p.realQuote, 'curve reserve untouched');
  assert.equal(after.liquidityBonus, p.liquidityBonus, 'locked bonus untouched');
  assert.equal(await balance(f.client.ata(f.treasury, f.quoteMint)), treasuryBefore + p.protocolFees);
  assert.equal(await balance(f.client.ata(f.rewardWallet.publicKey, f.quoteMint)), rewardBefore + p.creatorFees);
});

test('Solana curve graduates exactly at the curve supply ($50k FDV) and then stops trading', { skip }, async () => {
  const { mint } = await launch({ symbol: 'GRAD' });
  await afterSnipeWindow(mint);
  const q = quoteBuy(await pool(mint), 20_000n * USDC, BASE);
  assert.equal(q.graduates, true); assert.ok(q.gross < 20_000n * USDC, 'final buy is partially filled');
  const before = await balance(f.client.ata(f.trader.publicKey, f.quoteMint));
  const events = await eventsOf(await buy(f.trader, mint, 20_000n * USDC, q.tokens));
  assert.equal(await balance(f.client.ata(f.trader.publicKey, f.quoteMint)), before - q.gross, 'only the quote needed is charged');
  const g = await invariant(mint);
  assert.equal(g.sold, g.curveSupply); assert.equal(g.status, STATUS_GRADUATED); assert.ok(g.graduatedAt > 0n);
  assert.ok(Math.abs(poolStats(g).marketCap - 50_000) < 0.01, `FDV at graduation ${poolStats(g).marketCap}`);
  const graduated = events.find(e => e.name === 'CurveGraduated');
  assert.equal(graduated.lpTokens, TOKEN_SUPPLY - g.sold); assert.equal(graduated.realQuote, g.realQuote); assert.equal(graduated.liquidityBonus, g.liquidityBonus);
  assert.ok(Math.abs(Number(g.realQuote) / Number(graduated.lpTokens) / poolStats(g).price - 1) < 1e-6, 'DEX opens at the graduation price');
  await failsWith(buy(f.trader, mint, 1n * USDC, 1n), /0x177c/);
  await failsWith(sell(f.trader, mint, 1_000_000n, 0n), /0x177c/);
  // Fees stay claimable after graduation; liquidity does not move.
  await withdraw(mint);
  const after = await invariant(mint);
  assert.equal(after.realQuote, g.realQuote); assert.equal(after.liquidityBonus, g.liquidityBonus);
});

test('Solana creator first buy larger than the curve is capped and graduates at launch', { skip }, async () => {
  const before = await balance(f.client.ata(f.creator.publicKey, f.quoteMint));
  const { mint, expected, signature } = await launch({ firstBuy: 50_000n * USDC, minOut: 1n, symbol: 'WHALE' });
  assert.equal(expected.graduates, true);
  assert.equal(await balance(f.client.ata(f.creator.publicKey, f.quoteMint)), before - expected.gross);
  const p = await invariant(mint);
  assert.equal(p.status, STATUS_GRADUATED); assert.equal(p.sold, p.curveSupply);
  assert.ok((await eventsOf(signature)).some(e => e.name === 'CurveGraduated'));
});

test('Solana reserve and inventory invariants hold across mixed trades and payouts', { skip }, async () => {
  const { mint } = await launch({ symbol: 'MIX' });
  for (let i = 1n; i <= 6n; i++) {
    await buy(f.trader, mint, (i * 7n + 1n) * USDC + i, 1n);
    await invariant(mint);
    const tokensIn = await balance(f.client.ata(f.trader.publicKey, mint)) / 3n;
    await sell(f.trader, mint, tokensIn, 1n);
    await invariant(mint);
    if (i % 3n === 0n) { await withdraw(mint); await invariant(mint); }
  }
});

test('Solana trade events carry post-trade state for indexers', { skip }, async () => {
  const { mint } = await launch({ symbol: 'EVT' });
  await afterSnipeWindow(mint);
  const gross = 12n * USDC;
  const q = quoteBuy(await pool(mint), gross, BASE);
  const [bought] = (await eventsOf(await buy(f.trader, mint, gross, q.tokens))).filter(e => e.name === 'CurveBought');
  let p = await pool(mint);
  assert.equal(bought.buyer, f.trader.publicKey.toBase58());
  assert.equal(bought.quoteIn, gross); assert.equal(bought.tokensOut, q.tokens); assert.equal(bought.fee, q.fee);
  assert.equal(bought.realQuote, p.realQuote); assert.equal(bought.virtualQuote, p.virtualQuote + p.realQuote);
  assert.equal(bought.tokenReserve, p.virtualToken - p.sold); assert.equal(bought.sold, p.sold);
  assert.equal(bought.price, poolStats(p).price);
  const s = quoteSell(p, q.tokens / 2n, BASE);
  const [sold] = (await eventsOf(await sell(f.trader, mint, q.tokens / 2n, s.net))).filter(e => e.name === 'CurveSold');
  p = await pool(mint);
  assert.equal(sold.quoteOut, s.net); assert.equal(sold.fee, s.fee);
  assert.equal(sold.realQuote, p.realQuote); assert.equal(sold.tokenReserve, p.virtualToken - p.sold); assert.equal(sold.sold, p.sold);
});

// ---- PumpSwap migration ----------------------------------------------------------------------
const T22 = new PublicKey(TOKEN_2022_PROGRAM);
const pumpState = async (mint) => {
  const p = f.client.pumpAccounts(mint, f.quoteMint);
  const [poolInfo, baseInfo, quoteInfo] = await f.connection.getMultipleAccountsInfo([p.pool, p.poolBase, p.poolQuote]);
  return f.client.pumpState(poolInfo.data, baseInfo.data, quoteInfo.data);
};
const migration = async mint => f.client.decodeMigration((await f.connection.getAccountInfo(f.client.migrationPda(mint))).data);
const migrate = (who, mint) => send(f.connection, who, [f.client.computeBudget(MIGRATE_COMPUTE_UNITS), f.client.migrateToPumpswap({ payer: who.publicKey, config: f.config, mint })], [], 1);
const harvest = (who, mint) => send(f.connection, who, [f.client.computeBudget(HARVEST_COMPUTE_UNITS), ...f.client.harvestLpFees({ payer: who.publicKey, config: f.config, mint, reward: f.rewardWallet.publicKey })], [], 1);
async function completedCurve(symbol) {
  const { mint } = await launch({ symbol });
  await buy(f.trader, mint, 1_000n * USDC, 1n); // inside the snipe window: adds a locked bonus
  await afterSnipeWindow(mint);
  await buy(f.trader, mint, 20_000n * USDC, 1n);
  return mint;
}

test('Solana migration to PumpSwap moves all liquidity into a pool whose LP stays locked', { skip: pumpSkip }, async () => {
  const { mint: early } = await launch({ symbol: 'EARLY' });
  await failsWith(migrate(f.outsider, early), /0x1780/);
  const mint = await completedCurve('MIG');
  const before = await invariant(mint);
  assert.equal(before.status, STATUS_GRADUATED);
  await failsWith(harvest(f.outsider, mint), /0x1781|AccountNotInitialized|0xbc4/);
  const solBefore = await f.connection.getBalance(f.outsider.publicKey);
  const signature = await migrate(f.outsider, mint);
  const p = f.client.pumpAccounts(mint, f.quoteMint);
  const after = await pool(mint);
  assert.equal(after.status, STATUS_MIGRATED); assert.equal(after.realQuote, 0n); assert.equal(after.liquidityBonus, 0n);
  // The curve keeps only the fees owed to protocol and creator.
  assert.equal(await balance(f.client.ata(f.client.poolPda(mint), f.quoteMint)), after.protocolFees + after.creatorFees);
  assert.equal(await balance(f.client.ata(f.client.poolPda(mint), mint)), 0n);
  const m = await migration(mint);
  assert.equal(m.pumpPool.toBase58(), p.pool.toBase58());
  assert.equal(m.baseMigrated, TOKEN_SUPPLY - before.sold);
  assert.equal(m.quoteMigrated, before.realQuote + before.liquidityBonus);
  const pumpPool = f.client.decodePumpPool((await f.connection.getAccountInfo(p.pool)).data);
  assert.equal(pumpPool.creator.toBase58(), p.lpAuthority.toBase58());
  assert.equal(pumpPool.baseMint.toBase58(), mint.toBase58()); assert.equal(pumpPool.quoteMint.toBase58(), f.quoteMint.toBase58());
  assert.equal(await balance(p.poolBase), m.baseMigrated); assert.equal(await balance(p.poolQuote), m.quoteMigrated);
  const lp = f.client.tokenAmount((await f.connection.getAccountInfo(p.authorityLp)).data);
  assert.equal(lp, m.lpLocked); assert.equal(lp, pumpPool.lpSupply - 100n, 'all LP except PumpSwap\'s 100-unit minimum is locked by Elpida');
  assert.equal(m.principal, liquidityUnits(lp, await pumpState(mint)));
  // Opening price = graduation price, plus the locked anti-snipe bonus.
  const curvePrice = Number(before.virtualQuote + before.realQuote) / Number(before.virtualToken - before.sold);
  const pumpPrice = Number(m.quoteMigrated) / Number(m.baseMigrated);
  assert.ok(pumpPrice >= curvePrice * 0.999999 && pumpPrice <= curvePrice * (1 + Number(before.liquidityBonus) / Number(before.realQuote) + 1e-6), `${pumpPrice} vs ${curvePrice}`);
  assert.equal(await f.connection.getBalance(p.lpAuthority), 0, 'unused rent advance refunded');
  assert.ok(solBefore - await f.connection.getBalance(f.outsider.publicKey) < 0.03 * web3.LAMPORTS_PER_SOL, 'caller pays only rent and fees');
  const migrated = (await eventsOf(signature)).find(e => e.name === 'CurveMigrated');
  assert.equal(migrated.pumpPool, p.pool.toBase58()); assert.equal(migrated.lpLocked, lp);
  // No second migration, no more curve trading, nothing to harvest yet; curve fees still payable.
  await failsWith(migrate(f.outsider, mint), /0x177c|0x1780|already in use/);
  await failsWith(buy(f.trader, mint, 1n * USDC, 1n), /0x177c/);
  await failsWith(harvest(f.outsider, mint), /0x1782/);
  await withdraw(mint);
  assert.equal(await balance(f.client.ata(f.client.poolPda(mint), f.quoteMint)), 0n);
});

test('Solana harvest withdraws only LP fee growth, splits it 50/50 and never touches the principal', { skip: pumpSkip }, async () => {
  const mint = await completedCurve('HARV');
  const p = f.client.pumpAccounts(mint, f.quoteMint);
  // Griefing attempt: pre-creating the PumpSwap vaults and pre-funding the LP authority must not block migration.
  await send(f.connection, f.outsider, [f.client.createAtaIdempotent(f.outsider.publicKey, p.pool, mint), f.client.createAtaIdempotent(f.outsider.publicKey, p.pool, f.quoteMint),
    web3.SystemProgram.transfer({ fromPubkey: f.outsider.publicKey, toPubkey: p.lpAuthority, lamports: 1_000_000 })]);
  await migrate(f.outsider, mint);
  const m0 = await migration(mint);
  // Simulate trading-fee growth: PumpSwap LP fees stay in the vaults, so a donation is equivalent.
  const transferIx = (from, to, amount) => new web3.TransactionInstruction({ programId: f.client.tokenProgram, keys: [{ pubkey: from, isSigner: false, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }, { pubkey: f.trader.publicKey, isSigner: true, isWritable: false }], data: Buffer.concat([Buffer.from([3]), Buffer.from(new BigUint64Array([BigInt(amount)]).buffer)]) });
  await send(f.connection, f.trader, [transferIx(f.client.ata(f.trader.publicKey, f.quoteMint), p.poolQuote, 1_200n * USDC)]);
  const state = await pumpState(mint);
  const expected = harvestNow(m0.lpLocked, m0.principal, state);
  const out = withdrawOut(expected, state);
  assert.ok(expected > 0n);
  const balances = async () => Promise.all([f.client.ata(f.treasury, mint), f.client.ata(f.treasury, f.quoteMint), f.client.ata(f.rewardWallet.publicKey, mint), f.client.ata(f.rewardWallet.publicKey, f.quoteMint)].map(balance));
  const [tb0, tq0, rb0, rq0] = await balances();
  const signature = await harvest(f.outsider, mint);
  const [tb1, tq1, rb1, rq1] = await balances();
  assert.equal(tb1 - tb0, out.base / 2n); assert.equal(rb1 - rb0, out.base - out.base / 2n);
  assert.equal(tq1 - tq0, out.quote / 2n); assert.equal(rq1 - rq0, out.quote - out.quote / 2n);
  const m1 = await migration(mint);
  assert.equal(m1.lpLocked, m0.lpLocked - expected); assert.equal(m1.harvestedLp, expected);
  assert.equal(m1.harvestedBase, out.base); assert.equal(m1.harvestedQuote, out.quote);
  assert.ok(liquidityUnits(m1.lpLocked, await pumpState(mint)) >= m0.principal, 'principal liquidity stays locked');
  const harvested = (await eventsOf(signature)).find(e => e.name === 'LpFeesHarvested');
  assert.equal(harvested.lpBurned, expected); assert.equal(harvested.baseOut, out.base); assert.equal(harvested.quoteOut, out.quote);
  // A 1,200 USDC fee accrual is worth ~600 USDC of quote plus ~600 USDC of tokens once split by the pool.
  assert.ok(out.quote > 550n * USDC && out.quote < 650n * USDC, `quote harvested ${out.quote}`);
  await failsWith(harvest(f.outsider, mint), /0x1782/);
  // A wrong reward wallet cannot receive the creator half.
  await failsWith(send(f.connection, f.outsider, [f.client.computeBudget(HARVEST_COMPUTE_UNITS), ...f.client.harvestLpFees({ payer: f.outsider.publicKey, config: f.config, mint, reward: f.outsider.publicKey })], [], 1), /0x7d1|2001/);
});

test('Solana harvest ignores liquidity other people deposit into the PumpSwap pool', { skip: pumpSkip }, async () => {
  const mint = await completedCurve('DEPO');
  await migrate(f.outsider, mint);
  const p = f.client.pumpAccounts(mint, f.quoteMint);
  const m0 = await migration(mint);
  // The trader deposits into the same pool with tokens bought on the curve.
  const state = await pumpState(mint);
  const lpOut = state.lpSupply / 20n;
  const traderLp = PublicKey.findProgramAddressSync([f.trader.publicKey.toBytes(), T22.toBytes(), p.lpMint.toBytes()], f.client.ataProgram)[0];
  const meta = (pubkey, w = false, s = false) => ({ pubkey, isWritable: w, isSigner: s });
  const deposit = new web3.TransactionInstruction({
    programId: new PublicKey(PUMP_AMM_PROGRAM),
    data: Buffer.concat([Buffer.from([242, 35, 198, 137, 82, 225, 242, 182]), Buffer.from(new BigUint64Array([lpOut, TOKEN_SUPPLY, 100_000n * USDC]).buffer)]),
    keys: [meta(p.pool, true), meta(new PublicKey(PUMP_GLOBAL_CONFIG)), meta(f.trader.publicKey, false, true), meta(mint), meta(f.quoteMint), meta(p.lpMint, true),
      meta(f.client.ata(f.trader.publicKey, mint), true), meta(f.client.ata(f.trader.publicKey, f.quoteMint), true), meta(traderLp, true), meta(p.poolBase, true), meta(p.poolQuote, true),
      meta(f.client.tokenProgram), meta(T22), meta(new PublicKey('GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR')), meta(new PublicKey(PUMP_AMM_PROGRAM))],
  });
  const createLpAta = new web3.TransactionInstruction({ programId: f.client.ataProgram, data: Buffer.from([1]), keys: [meta(f.trader.publicKey, true, true), meta(traderLp, true), meta(f.trader.publicKey), meta(p.lpMint), meta(web3.SystemProgram.programId), meta(T22)] });
  await send(f.connection, f.trader, [createLpAta, deposit]);
  assert.equal(f.client.tokenAmount((await f.connection.getAccountInfo(traderLp)).data), lpOut);
  const grown = await pumpState(mint);
  assert.ok(grown.lpSupply > state.lpSupply);
  // Deposits round in the pool's favour, which leaves only dust; it is below the harvest minimum.
  assert.ok(harvestableLp(m0.lpLocked, m0.principal, grown) < m0.lpLocked / 1_000_000n, 'a deposit is not fee growth');
  assert.equal(harvestNow(m0.lpLocked, m0.principal, grown), 0n);
  await failsWith(harvest(f.outsider, mint), /0x1782/);
});

test('Solana native repricing: only the upgrade authority, fee schedule fixed, live pools unchanged', { skip }, async () => {
  const { mint: before } = await launch({ symbol: 'OLDP' });
  const repriced = { ...curveParams({ startFdv: 10_000, endFdv: 80_000, quoteDecimals: 6, launchFee: '0.02', snipeWindowSecs: 4 }) };
  const update = (who, params) => send(f.connection, who, [f.client.updateCurveConfig({ authority: who.publicKey, config: f.config.address, params })], [], 1);
  await failsWith(update(f.outsider, repriced), /0x1770/);
  await failsWith(update(f.authority, { ...repriced, baseFeeBps: 200 }), /0x1788/);
  await failsWith(update(f.authority, { ...repriced, snipeWindowSecs: 30 }), /0x1788/);
  assert.match(explainError(new Error('custom program error: 0x1788')), /fee schedule/);
  await failsWith(update(f.authority, { ...repriced, curveSupply: 0n }), /0x1774/);
  const signature = await update(f.authority, repriced);
  const [event] = (await eventsOf(signature)).filter(e => e.name === 'CurveConfigUpdated');
  assert.equal(event.launchFee, 20_000_000n); assert.equal(event.virtualQuote, repriced.virtualQuote);
  const cfg = f.client.decodeConfig((await f.connection.getAccountInfo(f.config.address)).data);
  assert.equal(cfg.launchFee, 20_000_000n); assert.equal(cfg.virtualQuote, repriced.virtualQuote); assert.equal(cfg.curveSupply, repriced.curveSupply);
  assert.equal(cfg.quoteMint.toBase58(), f.quoteMint.toBase58()); assert.equal(cfg.treasury.toBase58(), f.treasury.toBase58());
  // Live pools keep the curve they launched with; new launches use the new one and pay the new fee.
  assert.equal((await pool(before)).virtualQuote, PARAMS.virtualQuote);
  const treasuryBefore = await f.connection.getBalance(f.treasury);
  const mint = Keypair.generate();
  await send(f.connection, f.creator, [f.client.computeBudget(), f.client.launch({ creator: f.creator.publicKey, config: f.config, mint: mint.publicKey, name: 'New Price', symbol: 'NEWP', firstBuy: USDC, minTokensOut: 1n, reward: f.rewardWallet.publicKey })], [mint], 1);
  assert.equal((await pool(mint.publicKey)).virtualQuote, repriced.virtualQuote);
  assert.equal(await f.connection.getBalance(f.treasury) - treasuryBefore, 20_000_000);
  await afterSnipeWindow(before);
  await buy(f.trader, before, USDC, 1n);
  // Back to the suite's prices.
  await update(f.authority, PARAMS);
  assert.equal(f.client.decodeConfig((await f.connection.getAccountInfo(f.config.address)).data).virtualQuote, PARAMS.virtualQuote);
});

test('Solana pairs: SOL, a paired token and a Token-2022 token each launch, trade, complete, migrate and harvest', { skip: pumpSkip }, async () => {
  const programId = f.programKeypair.publicKey;
  // Token-2022 pair assets without blocked extensions work end to end (PumpSwap included).
  const native = solanaPricing('localnet');
  const templates = [...solanaPairTemplates(native, { test: true }), { kind: 'token', key: 'test-t22', symbol: 'TEST-T22', name: 'Token-2022 test pair', decimals: 6, token2022: true, permanentDelegate: false, startFdv: '1000', endFdv: '10000', launchFee: native.launchFee, faucet: '20000' }];
  const pairs = await ensurePairConfigs({ connection: f.connection, payer: f.authority, programId, treasury: f.treasury, templates, overrides: { snipeWindowSecs: 4 } });
  assert.deepEqual(pairs.map(p => p.kind), ['native', 'token', 'token']);
  assert.equal(pairs[0].mint, WSOL_MINT);
  assert.equal(pairs[2].tokenProgram, TOKEN_2022_PROGRAM);
  // Re-running reuses the mints and configs.
  const again = await ensurePairConfigs({ connection: f.connection, payer: f.authority, programId, treasury: f.treasury, templates, saved: Object.fromEntries(pairs.map(p => [p.key, p.mint])) });
  assert.deepEqual(again.map(p => [p.mint, p.created]), pairs.map(p => [p.mint, false]));
  const saved = Object.fromEntries(pairs.map(p => [p.key, p.mint]));
  assert.equal((await pricingUpdates({ connection: f.connection, programId, authority: f.authority.publicKey, templates, saved })).length, 0, 'configs match the pricing file');
  // Repricing to a new SOL fee from the pricing file updates every pair; the fee schedule is kept.
  const pricier = templates.map(t => ({ ...t, launchFee: '0.03' }));
  const pending = await pricingUpdates({ connection: f.connection, programId, authority: f.authority.publicKey, templates: pricier, saved });
  assert.equal(pending.length, templates.length);
  const repriced = await ensurePairConfigs({ connection: f.connection, payer: f.authority, programId, treasury: f.treasury, templates: pricier, saved, reprice: true });
  assert.ok(repriced.every(p => p.repriced));
  for (const p of repriced) {
    const c = f.client.decodeConfig((await f.connection.getAccountInfo(new PublicKey(p.config))).data);
    assert.equal(c.launchFee, 30_000_000n); assert.equal(c.snipeWindowSecs, 4, 'fee schedule kept');
  }
  await ensurePairConfigs({ connection: f.connection, payer: f.authority, programId, treasury: f.treasury, templates, saved, reprice: true });
  // The test-asset faucet is capped per call.
  const capUser = Keypair.generate(); await airdrop(f.connection, capUser.publicKey, web3.LAMPORTS_PER_SOL);
  await failsWith(send(f.connection, capUser, [f.client.testUsdcFaucet({ user: capUser.publicKey, mint: new PublicKey(pairs[1].mint), amount: TEST_FAUCET_MAX_WHOLE * USDC + 1n })], [], 1), /0x1774/);
  const user = Keypair.generate();
  await airdrop(f.connection, user.publicKey, 20 * web3.LAMPORTS_PER_SOL);
  const amountOf = async (owner, cfg) => balance(f.client.quoteAta(owner, cfg));
  f.faucetMint = new PublicKey(pairs[1].mint);
  for (const pair of pairs) {
    const cfg = { address: new PublicKey(pair.config), quoteMint: new PublicKey(pair.mint), treasury: f.treasury, quoteTokenProgram: new PublicKey(pair.tokenProgram) };
    const onchain = f.client.decodeConfig((await f.connection.getAccountInfo(cfg.address)).data);
    const unit = 10n ** BigInt(pair.decimals);
    const template = templates.find(t => t.key === pair.key);
    assert.equal(onchain.quoteDecimals, pair.decimals);
    assert.equal(onchain.launchFee, curveParams({ startFdv: template.startFdv, endFdv: template.endFdv, quoteDecimals: pair.decimals, launchFee: template.launchFee }).launchFee);
    const fund = async amount => pair.wsol ? send(f.connection, user, f.client.wrapSol(user.publicKey, amount))
      : send(f.connection, user, [f.client.testUsdcFaucet({ user: user.publicKey, mint: cfg.quoteMint, tokenProgram: cfg.quoteTokenProgram, amount })]);
    // Enough to pay the fee and complete the curve (end FDV in the pair asset is an upper bound).
    const budget = parseAmountWhole(template.endFdv, unit);
    await fund(budget);
    const treasuryBefore = await f.connection.getBalance(f.treasury);
    const mint = Keypair.generate();
    const firstBuy = parseAmountWhole(template.startFdv, unit) / 50n;
    await send(f.connection, user, [f.client.computeBudget(), f.client.launch({ creator: user.publicKey, config: cfg, mint: mint.publicKey, name: `Pair ${pair.symbol}`, symbol: pair.key.replace(/[^a-z]/g, '').slice(0, 8).toUpperCase(), firstBuy, minTokensOut: 1n, reward: user.publicKey })], [mint], 1);
    assert.equal(BigInt(await f.connection.getBalance(f.treasury) - treasuryBefore), onchain.launchFee, `${pair.symbol} launch pays the creation fee in SOL`);
    const launched = await pool(mint.publicKey);
    assert.equal(launched.config.toBase58(), cfg.address.toBase58());
    assert.ok(Math.abs(poolStats({ ...launched, sold: 0n, realQuote: 0n }, pair.decimals).marketCap / Number(template.startFdv) - 1) < 1e-6, `${pair.symbol} starts at ${template.startFdv} ${pair.symbol} FDV`);
    // Sell part of the first buy back; for SOL the wrapped account is closed so the proceeds return as SOL.
    await afterSnipeWindow(mint.publicKey);
    const held = await balance(f.client.ata(user.publicKey, mint.publicKey));
    const lamportsBefore = await f.connection.getBalance(user.publicKey);
    await send(f.connection, user, [f.client.sell({ seller: user.publicKey, config: cfg, mint: mint.publicKey, tokensIn: held / 2n, minQuoteOut: 1n }), ...(pair.wsol ? [f.client.unwrapSol(user.publicKey)] : [])]);
    if (pair.wsol) {
      assert.equal(await f.connection.getAccountInfo(f.client.quoteAta(user.publicKey, cfg)), null, 'wrapped SOL account closed');
      assert.ok(await f.connection.getBalance(user.publicKey) > lamportsBefore, 'sale proceeds and leftover wrapped SOL returned as SOL');
      await fund(budget);
    }
    // Complete the curve with one oversized buy; it is partially filled.
    await send(f.connection, user, [f.client.buy({ buyer: user.publicKey, config: cfg, mint: mint.publicKey, grossIn: await amountOf(user.publicKey, cfg), minTokensOut: 1n })]);
    const done = await pool(mint.publicKey);
    assert.equal(done.status, STATUS_GRADUATED, `${pair.symbol} curve completes`);
    assert.ok(Math.abs(poolStats(done, pair.decimals).marketCap / Number(template.endFdv) - 1) < 1e-6, `${pair.symbol} graduates at ${template.endFdv} ${pair.symbol} FDV`);
    await send(f.connection, user, [f.client.computeBudget(MIGRATE_COMPUTE_UNITS), f.client.migrateToPumpswap({ payer: user.publicKey, config: cfg, mint: mint.publicKey })], [], 1);
    assert.equal((await pool(mint.publicKey)).status, STATUS_MIGRATED);
    const pp = f.client.pumpAccounts(mint.publicKey, cfg.quoteMint, cfg.quoteTokenProgram);
    const pumpPool = f.client.decodePumpPool((await f.connection.getAccountInfo(pp.pool)).data);
    assert.equal(pumpPool.quoteMint.toBase58(), pair.mint);
    assert.equal((await f.connection.getAccountInfo(pp.poolQuote)).owner.toBase58(), pair.tokenProgram, `${pair.symbol} PumpSwap vault uses the pair asset's token program`);
    const m0 = await migration(mint.publicKey);
    assert.equal(await balance(pp.poolQuote), m0.quoteMigrated);
    // Fee growth (a donation stands in for PumpSwap LP fees), then a harvest split 50/50.
    const extra = m0.quoteMigrated / 5n;
    await fund(extra);
    const transfer = new web3.TransactionInstruction({ programId: cfg.quoteTokenProgram, data: Buffer.concat([Buffer.from([12]), Buffer.from(new BigUint64Array([extra]).buffer), Buffer.from([pair.decimals])]),
      keys: [{ pubkey: f.client.quoteAta(user.publicKey, cfg), isSigner: false, isWritable: true }, { pubkey: cfg.quoteMint, isSigner: false, isWritable: false }, { pubkey: pp.poolQuote, isSigner: false, isWritable: true }, { pubkey: user.publicKey, isSigner: true, isWritable: false }] });
    await send(f.connection, user, [transfer]);
    const rewardBefore = await amountOf(user.publicKey, cfg);
    await send(f.connection, user, [f.client.computeBudget(HARVEST_COMPUTE_UNITS), ...f.client.harvestLpFees({ payer: user.publicKey, config: cfg, mint: mint.publicKey, reward: user.publicKey })], [], 1);
    const m1 = await migration(mint.publicKey);
    assert.ok(m1.harvestedQuote > 0n && m1.lpLocked < m0.lpLocked, `${pair.symbol} harvest`);
    assert.equal(await amountOf(user.publicKey, cfg) - rewardBefore, m1.harvestedQuote - m1.harvestedQuote / 2n, 'creator half of the quote');
  }
});

test('Solana pairs reject quote tokens that would break the curve or never graduate (transfer fee, permanent delegate as on xStocks)', { skip }, async () => {
  const spl = splTestMint(web3);
  const t22 = new PublicKey(TOKEN_2022_PROGRAM);
  const feeMint = Keypair.generate(), stockLike = Keypair.generate();
  await send(f.connection, f.authority, await spl.createFeeMint2022Ixs(f.connection, f.authority.publicKey, feeMint.publicKey, 6, f.authority.publicKey), [feeMint]);
  await send(f.connection, f.authority, await spl.createMint2022Ixs(f.connection, f.authority.publicKey, stockLike.publicKey, 8, f.authority.publicKey, f.authority.publicKey), [stockLike]);
  for (const mint of [feeMint, stockLike]) {
    await failsWith(send(f.connection, f.authority, [f.client.addCurveConfig({ authority: f.authority.publicKey, quoteMint: mint.publicKey, treasury: f.treasury, quoteTokenProgram: t22, params: PARAMS })], [], 1), /0x1785/);
  }
  assert.match(explainError(new Error('custom program error: 0x1785')), /permanent delegate/);
});

test('Solana beta gate: invite-only launches, allowlist managed by the beta admin, then open again', { skip }, async () => {
  const programId = f.programKeypair.publicKey;
  const admin = Keypair.generate(), outsider = Keypair.generate();
  for (const kp of [admin, outsider]) await airdrop(f.connection, kp.publicKey, 2 * web3.LAMPORTS_PER_SOL);
  // Only the upgrade authority creates or changes the gate.
  await failsWith(send(f.connection, f.outsider, [f.client.setBetaGate({ authority: f.outsider.publicKey, gateAuthority: f.outsider.publicKey, enabled: true })], [], 1), /0x1770/);
  const gate = await ensureBetaGate({ connection: f.connection, payer: f.authority, programId, gateAuthority: admin.publicKey, enabled: true });
  assert.equal(gate.enabled, true); assert.equal(gate.authority.toBase58(), admin.publicKey.toBase58());
  await failsWith(launch({ symbol: 'GATED' }), /0x1787/);
  assert.match(explainError(new Error('custom program error: 0x1787')), /invite-only/);
  // Only the beta admin manages the allowlist.
  await failsWith(send(f.connection, outsider, [f.client.allowBetaCreator({ authority: outsider.publicKey, creator: f.creator.publicKey })], [], 1), /0x1770/);
  await send(f.connection, admin, [f.client.allowBetaCreator({ authority: admin.publicKey, creator: f.creator.publicKey })]);
  const { mint } = await launch({ symbol: 'INVITED' });
  assert.equal((await pool(mint)).creator.toBase58(), f.creator.publicKey.toBase58());
  // Trading stays open to everyone during the beta.
  await afterSnipeWindow(mint);
  await buy(f.trader, mint, 5n * USDC, 1n);
  const before = await f.connection.getBalance(admin.publicKey);
  await send(f.connection, admin, [f.client.revokeBetaCreator({ authority: admin.publicKey, creator: f.creator.publicKey })]);
  assert.ok(await f.connection.getBalance(admin.publicKey) > before, 'allowlist rent returns to the admin');
  await failsWith(launch({ symbol: 'REVOKED' }), /0x1787/);
  // Opening launches again needs only the gate switch.
  await ensureBetaGate({ connection: f.connection, payer: f.authority, programId, gateAuthority: admin.publicKey, enabled: false });
  await launch({ symbol: 'OPEN' });
});

test('Solana mainnet build rejects test instructions; the upgrade authority can move to a multisig', { skip }, async () => {
  if (!existsSync(mainnetElfPath)) return;
  const programId = f.programKeypair.publicKey;
  assert.equal(await rejectsTestInstructions({ connection: f.connection, payer: f.authority, programId }), false, 'the test build accepts them');
  await upgradeProgram({ connection: f.connection, payer: f.authority, programId, elf: readFileSync(mainnetElfPath), sendsPerSecond: 200 });
  assert.equal(await rejectsTestInstructions({ connection: f.connection, payer: f.authority, programId }), true, 'the mainnet build rejects them');
  const user = Keypair.generate(); await airdrop(f.connection, user.publicKey, web3.LAMPORTS_PER_SOL);
  await failsWith(send(f.connection, user, [f.client.testUsdcFaucet({ user: user.publicKey, mint: f.faucetMint })], [], 1), /0x1786/);
  // Normal trading still works on the mainnet build.
  const { mint } = await launch({ symbol: 'MAINB' });
  await afterSnipeWindow(mint);
  await buy(f.trader, mint, 2n * USDC, 1n);
  // Multisig flow: a buffer handed to the multisig, then the program's upgrade authority itself.
  const multisig = Keypair.generate();
  await airdrop(f.connection, multisig.publicKey, 10 * web3.LAMPORTS_PER_SOL);
  const testElf = readFileSync(elfPath);
  const buffer = await prepareUpgradeBuffer({ connection: f.connection, payer: f.authority, elf: testElf, multisig: multisig.publicKey, sendsPerSecond: 200 });
  const bufferInfo = await f.connection.getAccountInfo(buffer);
  assert.equal(new PublicKey(bufferInfo.data.subarray(5, 37)).toBase58(), multisig.publicKey.toBase58(), 'buffer belongs to the multisig');
  await transferUpgradeAuthority({ connection: f.connection, payer: f.authority, programId, newAuthority: multisig.publicKey });
  await assert.rejects(upgradeProgram({ connection: f.connection, payer: f.authority, programId, elf: testElf }), /upgrade authority/);
  // The multisig approves the upgrade with the prepared buffer (Squads does this on mainnet).
  const { loaderV3 } = await import('../packages/solana/client.mjs');
  await send(f.connection, multisig, [loaderV3(web3).upgrade({ programData: f.client.programDataAddress, program: programId, buffer, spill: multisig.publicKey, authority: multisig.publicKey })]);
  await f.connection.getSlot(); await sleep(1000);
  assert.equal(await rejectsTestInstructions({ connection: f.connection, payer: f.authority, programId }), false, 'back on the test build');
  // Hand authority back so the remaining tests can upgrade.
  await transferUpgradeAuthority({ connection: f.connection, payer: multisig, programId, newAuthority: f.authority.publicKey });
});

test('Solana upgrade is a no-op when the deployed program already matches the build', { skip }, async () => {
  const result = await upgradeProgram({ connection: f.connection, payer: f.authority, programId: f.programKeypair.publicKey, elf: readFileSync(elfPath) });
  assert.equal(result.upgraded, false);
  await assert.rejects(upgradeProgram({ connection: f.connection, payer: f.outsider, programId: f.programKeypair.publicKey, elf: readFileSync(elfPath) }), /upgrade authority/);
});
