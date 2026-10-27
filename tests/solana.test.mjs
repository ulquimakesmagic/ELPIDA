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
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as web3 from '@solana/web3.js';
import {
  createElpidaSolana, quoteBuy, quoteSell, currentFeeBps, curveParams, poolStats, encodeCurveParams,
  DISCRIMINATORS, EVENTS, LEGACY_EVENTS, TOKEN_SUPPLY, STATUS_GRADUATED, STATUS_MIGRATED, BPS, explainError, decodeEvents,
  harvestableLp, harvestNow, MPL_TOKEN_METADATA, MAX_LAUNCH_URI, GRADUATION_GRACE_SECS, validMetadataUri, liquidityUnits, withdrawOut, isqrt, PUMP_AMM_PROGRAM, PUMP_GLOBAL_CONFIG, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, MIGRATE_COMPUTE_UNITS, HARVEST_COMPUTE_UNITS, TEST_FAUCET_MAX_WHOLE, WSOL_MINT, splTestMint, PYTH_RECEIVER, SOL_USD_FEED_ID, SOL_USD_PRICE_ACCOUNT, parsePriceUpdate, usdToQuote, virtualQuoteForFdv,
} from '../packages/solana/client.mjs';
import { solanaPairTemplates } from '../packages/core/pairs.mjs';
import { solanaPricing } from '../packages/core/pricing.mjs';
import { vaultUpgrade, vaultHandBack, closeProgram, readProgramData } from '../scripts/squads-devnet-trial.mjs';
import { deployProgram, upgradeProgram, ensurePairConfigs, pricingUpdates, ensurePricing, ensureBetaGate, rejectsTestInstructions, prepareUpgradeBuffer, transferUpgradeAuthority, send, airdrop } from '../packages/solana/deploy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const elfPath = `${root}contracts/solana/build/elpida_launchpad.so`;
const mainnetElfPath = `${root}contracts/solana/build/elpida_launchpad-mainnet.so`;
const keyPath = `${root}contracts/solana/keys/elpida_launchpad-keypair.json`;
const validatorBin = process.env.SOLANA_TEST_VALIDATOR ?? 'solana-test-validator';
let skip = false;
if (spawnSync(validatorBin, ['--version'], { stdio: 'ignore' }).status !== 0) skip = 'solana-test-validator not found (install the Solana CLI or set SOLANA_TEST_VALIDATOR).';
else if (!existsSync(elfPath)) skip = 'Compiled Solana program not found.';
else if (!existsSync(`${root}contracts/solana/fixtures/mpl_token_metadata.so`)) skip = 'Metaplex token-metadata fixture missing (contracts/solana/fixtures/mpl_token_metadata.so).';
// Without the private program keypair (git-ignored), the validator preloads the program at its fixed ID as an
// upgradeable program whose authority is the test authority, so the suite runs without the deploy key.
const PROGRAM_ID = 'ANkA5pytoVkiKQbjzd5NdPWKgmwfsihNJvSfg3vtKLNz';
const preload = !existsSync(keyPath);
const fixtures = `${root}contracts/solana/fixtures/`;
const pumpSkip = skip || (!existsSync(`${fixtures}pump_amm.so`) || !existsSync(`${fixtures}pumpswap_global_config.json`) ? 'PumpSwap fixtures missing (run solana-pumpswap-fixtures.cmd or node scripts/solana-pumpswap-fixtures.mjs).' : false);

const { Keypair, PublicKey } = web3;
const USDC = 1_000_000n; // one whole unit of the 6-decimal test quote token
const FEE_SOL = 10_000_000n; // 0.01 SOL creation fee
const PARAMS = curveParams({ startFdv: 5_000, endFdv: 50_000, quoteDecimals: 6, launchFee: '0.01', snipeWindowSecs: 4 });
const BASE = BigInt(PARAMS.baseFeeBps);
const TEST_URI = 'ipfs://bafkreih6ilp3u4ue7fmqjnxdnq4ejxn6s5edsxqy7y5c3x2tsnkacsm4zu';
const mplFixture = `${root}contracts/solana/fixtures/mpl_token_metadata.so`;
const f = {};
const sleep = ms => new Promise(r => setTimeout(r, ms));
/** A Full-verification Pyth PriceUpdateV2 account (133 bytes) as solana-test-validator --account JSON. */
function priceUpdate({ publishTime, price = 11_106_000_000n, conf = 5_000_000n, exponent = -8, feedId = SOL_USD_FEED_ID, owner = PYTH_RECEIVER }) {
  const data = Buffer.alloc(133); let o = 0;
  Buffer.from(DISCRIMINATORS.PriceUpdateV2).copy(data, o); o += 8 + 32; data[o++] = 1;
  Buffer.from(feedId, 'hex').copy(data, o); o += 32;
  data.writeBigInt64LE(price, o); o += 8; data.writeBigUInt64LE(conf, o); o += 8; data.writeInt32LE(exponent, o); o += 4;
  data.writeBigInt64LE(BigInt(publishTime), o); o += 8; data.writeBigInt64LE(BigInt(publishTime - 1), o); o += 8;
  data.writeBigInt64LE(price, o); o += 8; data.writeBigUInt64LE(conf, o); o += 8; data.writeBigUInt64LE(1n, o);
  return { lamports: 2_000_000, data: [data.toString('base64'), 'base64'], owner, executable: false, rentEpoch: 0, space: 133 };
}

test.before(async () => {
  if (skip) return;
  const port = 20000 + Math.floor(Math.random() * 20000);
  f.ledger = mkdtempSync(join(tmpdir(), 'elpida-ledger-'));
  // Crafted Pyth PriceUpdateV2 accounts (owned by the Pyth receiver): a fresh SOL/USD price at the sponsored
  // account address, and stale, wide-confidence, wrong-feed and wrong-owner variants.
  [f.authority, f.creator, f.trader, f.outsider, f.rewardWallet] = Array.from({ length: 5 }, () => Keypair.generate());
  f.oracleStart = Math.floor(Date.now() / 1000);
  f.oracleDir = mkdtempSync(join(tmpdir(), 'elpida-oracles-'));
  f.oracles = { fresh: new PublicKey(SOL_USD_PRICE_ACCOUNT), stale: Keypair.generate().publicKey, wide: Keypair.generate().publicKey, otherFeed: Keypair.generate().publicKey, notPyth: Keypair.generate().publicKey };
  const oracleArgs = Object.entries({
    fresh: priceUpdate({ publishTime: f.oracleStart }), stale: priceUpdate({ publishTime: f.oracleStart - 7200 }), wide: priceUpdate({ publishTime: f.oracleStart, conf: 555_300_000n }),
    otherFeed: priceUpdate({ publishTime: f.oracleStart, feedId: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43' }), notPyth: priceUpdate({ publishTime: f.oracleStart, owner: '11111111111111111111111111111111' }),
  }).flatMap(([name, account]) => { const file = join(f.oracleDir, `${name}.json`); writeFileSync(file, JSON.stringify({ pubkey: f.oracles[name].toBase58(), account })); return ['--account', f.oracles[name].toBase58(), file]; });
  f.validator = spawn(validatorBin, [...oracleArgs, '--reset', '--quiet', '--ledger', f.ledger, '--rpc-port', String(port), '--faucet-port', String(port + 2), '--dynamic-port-range', `${port + 10}-${port + 60}`, '--gossip-port', String(port + 3),
    ...(pumpSkip ? [] : ['--bpf-program', PUMP_AMM_PROGRAM, `${fixtures}pump_amm.so`, '--account', PUMP_GLOBAL_CONFIG, `${fixtures}pumpswap_global_config.json`]),
    '--bpf-program', MPL_TOKEN_METADATA, mplFixture,
    ...(preload ? ['--upgradeable-program', PROGRAM_ID, elfPath, f.authority.publicKey.toBase58()] : [])], { stdio: 'ignore' });
  f.connection = new web3.Connection(`http://127.0.0.1:${port}`, 'confirmed');
  for (let i = 0; ; i++) {
    try { await f.connection.getLatestBlockhash(); break; }
    catch { if (i > 120) throw new Error('solana-test-validator did not start'); await sleep(500); }
  }
  for (const kp of [f.authority, f.creator, f.trader, f.outsider]) await airdrop(f.connection, kp.publicKey, 20 * web3.LAMPORTS_PER_SOL);
  if (preload) f.programId = new PublicKey(PROGRAM_ID);
  else {
    const programKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, 'utf8'))));
    await deployProgram({ connection: f.connection, payer: f.authority, programKeypair, elf: readFileSync(elfPath), sendsPerSecond: 200 });
    f.programId = programKeypair.publicKey;
  }
  f.client = createElpidaSolana(web3, f.programId);
  // A 6-decimal test token as the main pair asset, minted to the creator and the trader.
  const spl = splTestMint(web3), quote = Keypair.generate();
  await send(f.connection, f.authority, await spl.createMintIxs(f.connection, f.authority.publicKey, quote.publicKey, 6, f.authority.publicKey), [quote]);
  for (const owner of [f.creator.publicKey, f.trader.publicKey]) await send(f.connection, f.authority, [f.client.createAtaIdempotent(f.authority.publicKey, owner, quote.publicKey), spl.mintTo(quote.publicKey, f.client.ata(owner, quote.publicKey), f.authority.publicKey, 100_000n * USDC)]);
  f.quoteMint = quote.publicKey;
  f.spl = spl;
  // The treasury signs partner registrations (set_partner), so the suite keeps its keypair.
  f.treasuryKeypair = Keypair.generate();
  f.treasury = f.treasuryKeypair.publicKey;
  f.config = { address: f.client.configFor(f.quoteMint), quoteMint: f.quoteMint, treasury: f.treasury };
});
test.after(() => {
  f.validator?.kill('SIGKILL');
  if (f.ledger) rmSync(f.ledger, { recursive: true, force: true });
  if (f.oracleDir) rmSync(f.oracleDir, { recursive: true, force: true });
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
  const signature = await send(f.connection, creator, [f.client.computeBudget(), f.client.launch({ uri: TEST_URI, creator: creator.publicKey, config: f.config, mint: mint.publicKey, name, symbol, firstBuy, minTokensOut: minOut ?? expected.tokens, reward: f.rewardWallet.publicKey })], [mint], 1);
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
  for (const [key, name] of [['updateCurveConfig', 'global:update_curve_config'], ['initializeCurve', 'global:initialize_curve'], ['launch', 'global:launch'], ['buy', 'global:buy'], ['sell', 'global:sell'], ['withdrawFees', 'global:withdraw_fees'], ['CurveConfig', 'account:CurveConfig'], ['CurvePool', 'account:CurvePool'], ['migrateToPumpswap', 'global:migrate_to_pumpswap'], ['harvestLpFees', 'global:harvest_lp_fees'], ['PumpMigration', 'account:PumpMigration'], ['setBetaGate', 'global:set_beta_gate'], ['allowBetaCreator', 'global:allow_beta_creator'], ['revokeBetaCreator', 'global:revoke_beta_creator'], ['BetaGate', 'account:BetaGate'], ['BetaCreator', 'account:BetaCreator'], ['testBuildCheck', 'global:test_build_check'], ['reopenCurve', 'global:reopen_curve']]) {
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
  // Worst-case supported launch (SPL-Token USDC fee on a SOL pair, 32-byte name, 10-byte symbol, longest
  // client URI) fits Solana's 1,232 bytes; a Token-2022 USDC fee on a SOL pair does not, and is caught by size.
  {
    const client = createElpidaSolana(web3, new PublicKey('ANkA5pytoVkiKQbjzd5NdPWKgmwfsihNJvSfg3vtKLNz')), k = () => Keypair.generate().publicKey;
    const creator = k(), config = { address: k(), quoteMint: new PublicKey(WSOL_MINT), treasury: k() };
    const uri = 'ipfs://' + 'b'.repeat(MAX_LAUNCH_URI - 7);
    const sizeWith = tokenProgram => {
      const tx = new web3.Transaction({ feePayer: creator, recentBlockhash: k().toBase58() }).add(client.computeBudget(), ...client.wrapSol(creator, 1n),
        client.launch({ creator, config, mint: k(), name: 'N'.repeat(32), symbol: 'SYMBOL1234', firstBuy: 1n, minTokensOut: 0n, reward: k(), uri, priceUpdate: k(), usdc: { mint: k(), tokenProgram: new PublicKey(tokenProgram) } }), client.unwrapSol(creator));
      return tx.serializeMessage().length + 1 + 64 * tx.compileMessage().header.numRequiredSignatures;
    };
    assert.equal(MAX_LAUNCH_URI, 'ipfs://'.length + 59, 'a CIDv1 (sha-256, base32) link');
    assert.ok(sizeWith(TOKEN_PROGRAM) <= 1232, `worst-case launch is ${sizeWith(TOKEN_PROGRAM)} bytes`);
    assert.ok(sizeWith(TOKEN_2022_PROGRAM) > 1232, 'documented limit: Token-2022 USDC fee on a SOL pair needs a v0 transaction');
    assert.throws(() => client.launch({ creator, config, mint: k(), name: 'N', symbol: 'S', firstBuy: 1n, minTokensOut: 0n, reward: k(), uri: uri + 'x' }), /IPFS/);
  }
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

/** Metaplex MetadataV1 fields Elpida writes (fixed offsets: name 32, symbol 10, uri 200, padded). */
function decodeMetadata(data) {
  const str = (o, max) => data.subarray(o + 4, o + 4 + Math.min(data.readUInt32LE(o), max)).toString('utf8').replace(/\0+$/, '');
  return { key: data[0], updateAuthority: new PublicKey(data.subarray(1, 33)).toBase58(), mint: new PublicKey(data.subarray(33, 65)).toBase58(),
    name: str(65, 32), symbol: str(101, 10), uri: str(115, 200), sellerFeeBps: data.readUInt16LE(319), hasCreators: data[321], isMutable: data[323] };
}

test('Solana launch writes immutable Metaplex metadata that nobody can change', { skip }, async () => {
  const { mint } = await launch({ symbol: 'META', name: 'Hope Meta' });
  const address = f.client.metadataPda(mint);
  const account = await f.connection.getAccountInfo(address);
  assert.equal(account.owner.toBase58(), MPL_TOKEN_METADATA, 'created by Metaplex');
  const m = decodeMetadata(account.data);
  assert.deepEqual({ key: m.key, mint: m.mint, name: m.name, symbol: m.symbol, uri: m.uri, sellerFeeBps: m.sellerFeeBps, hasCreators: m.hasCreators, isMutable: m.isMutable },
    { key: 4, mint: mint.toBase58(), name: 'Hope Meta', symbol: 'META', uri: TEST_URI, sellerFeeBps: 0, hasCreators: 0, isMutable: 0 });
  assert.equal(m.updateAuthority, f.client.poolPda(mint).toBase58(), 'update authority is the curve PDA, which never signs for Metaplex');
  // The creator (former mint authority) cannot rewrite it: UpdateMetadataAccountV2 with new data fails.
  const nameBytes = Buffer.from('Rug'), uriBytes = Buffer.from('ipfs://changed');
  const newData = Buffer.concat([Buffer.from([15, 1]), Buffer.from(new Uint32Array([nameBytes.length]).buffer), nameBytes, Buffer.from(new Uint32Array([3]).buffer), Buffer.from('RUG'),
    Buffer.from(new Uint32Array([uriBytes.length]).buffer), uriBytes, Buffer.from([0, 0, 0, 0, 0]), Buffer.from([0, 0, 0])]);
  const update = new web3.TransactionInstruction({ programId: new PublicKey(MPL_TOKEN_METADATA), data: newData, keys: [{ pubkey: address, isSigner: false, isWritable: true }, { pubkey: f.creator.publicKey, isSigner: true, isWritable: false }] });
  await failsWith(send(f.connection, f.creator, [update]), /custom program error|Update Authority|immutable|failed/i);
  assert.deepEqual(decodeMetadata((await f.connection.getAccountInfo(address)).data).name, 'Hope Meta', 'metadata unchanged');
  // The mint authority was revoked after the metadata was written.
  assert.equal((await f.connection.getAccountInfo(mint)).data.readUInt32LE(0), 0, 'no mint authority');
});

test('Solana launch with a vanity mint: the server pool co-signs only after the creator, then forgets the key', { skip }, async () => {
  const { VanityMintPool, grind } = await import('../apps/api/vanity-mints.mjs');
  const { randomBytes } = await import('node:crypto');
  const dir = mkdtempSync(join(tmpdir(), 'elpida-vanity-')), vanity = new VanityMintPool({ path: join(dir, 'v.json'), key: randomBytes(32), programId: f.programId.toBase58(), suffix: 'h', autoStart: false });
  try {
    const g = grind('h', 200_000); vanity.add(g.seed, g.pubkey);
    const r = vanity.reserve({ wallet: f.creator.publicKey.toBase58(), address: '127.0.0.1' });
    const mint = new PublicKey(r.mint);
    assert.ok(mint.toBase58().endsWith('h'));
    const { blockhash } = await f.connection.getLatestBlockhash('confirmed');
    const tx = new web3.Transaction({ feePayer: f.creator.publicKey, recentBlockhash: blockhash }).add(f.client.computeBudget(),
      f.client.launch({ uri: TEST_URI, creator: f.creator.publicKey, config: f.config, mint, name: 'Vanity', symbol: 'VAN', firstBuy: 10n * USDC, minTokensOut: 0n, reward: f.rewardWallet.publicKey }));
    tx.partialSign(f.creator);
    const { signature } = vanity.sign({ id: r.id, wallet: f.creator.publicKey.toBase58(), message: tx.serializeMessage().toString('base64') });
    tx.addSignature(mint, Buffer.from(signature, 'base64'));
    const sent = await f.connection.sendRawTransaction(tx.serialize());
    await f.connection.confirmTransaction(sent, 'confirmed');
    const p = await pool(mint);
    assert.equal(p.mint.toBase58(), mint.toBase58(), 'launched at the vanity address');
    assert.equal(vanity.status().available, 0);
    assert.throws(() => vanity.sign({ id: r.id, wallet: f.creator.publicKey.toBase58(), message: tx.serializeMessage().toString('base64') }), /expired/, 'key destroyed after signing');
  } finally { vanity.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('Solana launch rejects bad input and leaves no partial state', { skip }, async () => {
  const before = await balance(f.client.ata(f.creator.publicKey, f.quoteMint));
  const treasuryBefore = await f.connection.getBalance(f.treasury);
  await failsWith(launch({ firstBuy: 0n, minOut: 1n }), /0x1777/);
  await failsWith(launch({ symbol: 'bad!' }), /0x1773/);
  await failsWith(launch({ minOut: TOKEN_SUPPLY }), /0x1777/);
  // Metadata must be an ipfs:// URI. The client refuses first; the program refuses a patched instruction too.
  assert.equal(validMetadataUri('https://example.com/x.json'), false); assert.equal(validMetadataUri(TEST_URI), true);
  assert.throws(() => f.client.launch({ creator: f.creator.publicKey, config: f.config, mint: Keypair.generate().publicKey, name: 'Bad', symbol: 'BAD', firstBuy: USDC, minTokensOut: 0n, reward: f.rewardWallet.publicKey, uri: 'https://x.io/meta.json' }), /IPFS/);
  const bad = Keypair.generate();
  const patched = f.client.launch({ creator: f.creator.publicKey, config: f.config, mint: bad.publicKey, name: 'Bad', symbol: 'BAD', firstBuy: USDC, minTokensOut: 0n, reward: f.rewardWallet.publicKey, uri: TEST_URI });
  const at = patched.data.length - TEST_URI.length; patched.data.write('https:/', at, 'utf8');
  await failsWith(send(f.connection, f.creator, [f.client.computeBudget(), patched], [bad], 1), /0x178e/);
  assert.equal(await f.connection.getAccountInfo(bad.publicKey), null, 'no mint left behind');
  assert.equal(await f.connection.getAccountInfo(f.client.poolPda(bad.publicKey)), null, 'no pool left behind');
  assert.equal(await f.connection.getAccountInfo(f.client.metadataPda(bad.publicKey)), null, 'no metadata left behind');
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
  // D7: the escape hatch opens only 24 h after completion (the 24 h path runs in contracts/solana/host-tests).
  assert.equal(GRADUATION_GRACE_SECS, 86_400);
  await failsWith(send(f.connection, f.outsider, [f.client.reopenCurve({ mint })]), /0x178f/);
  assert.equal((await pool(mint)).status, STATUS_GRADUATED);
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

test('Solana reopen is refused for a curve that is still trading', { skip }, async () => {
  const { mint } = await launch({ symbol: 'OPEN' });
  await failsWith(send(f.connection, f.outsider, [f.client.reopenCurve({ mint })]), /0x1780/);
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
async function completedCurve(symbol, creator = f.creator) {
  const { mint } = await launch({ symbol, creator });
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

test('Solana completing buy and PumpSwap migration in ONE transaction: the curve is never left closed', { skip: pumpSkip }, async () => {
  const { mint } = await launch({ symbol: 'ATOM' });
  await buy(f.trader, mint, 1_000n * USDC, 1n);
  await afterSnipeWindow(mint);
  const finalBuy = (units) => [f.client.computeBudget(units), f.client.buy({ buyer: f.trader.publicKey, config: f.config, mint, grossIn: 20_000n * USDC, minTokensOut: 1n }), f.client.migrateToPumpswap({ payer: f.trader.publicKey, config: f.config, mint })];
  // Size: one legacy transaction must fit Solana's 1,232-byte limit.
  const { blockhash } = await f.connection.getLatestBlockhash('confirmed');
  const tx = new web3.Transaction({ feePayer: f.trader.publicKey, recentBlockhash: blockhash }).add(...finalBuy(MIGRATE_COMPUTE_UNITS + 200_000));
  const bytes = tx.serializeMessage().length + 1 + 64 * tx.compileMessage().header.numRequiredSignatures;
  assert.ok(bytes <= 1232, `fits one transaction (${bytes} bytes)`);
  // If anything in the migration fails, the buy fails with it and the curve keeps trading.
  const before = await pool(mint);
  await failsWith(send(f.connection, f.trader, finalBuy(150_000), [], 1), /exceeded|compute|ComputationalBudgetExceeded|0x/i);
  const unchanged = await pool(mint);
  assert.equal(unchanged.status, before.status, 'still trading'); assert.equal(unchanged.sold, before.sold, 'the buy was rolled back too');
  // With enough compute: complete and migrate together.
  await send(f.connection, f.trader, finalBuy(MIGRATE_COMPUTE_UNITS + 200_000), [], 1);
  assert.equal((await pool(mint)).status, STATUS_MIGRATED, 'completed and on PumpSwap in the same transaction');
});

// After migration the token page trades through PumpSwap's official SDK, bundled for the browser
// (apps/web/vendor/pumpswap.mjs, built with the page's own web3.js). The local validator has the real PumpSwap program
// but not pump's fee program, so this checks everything up to the swap's fee step: the bundle loads with the page's
// web3.js, reads an Elpida-created pool, quotes it by the constant-product formula, and builds the transaction
// (wrap SOL / token account / swap) with the 23 accounts the swap expects. The swap itself runs on devnet.
test('PumpSwap trading after migration: the bundled SDK quotes and builds trades for an Elpida pool', { skip: pumpSkip }, async () => {
  globalThis.solanaWeb3 = web3;
  const pumpswap = await import('../apps/web/vendor/pumpswap.mjs');
  const mint = await completedCurve('PSWP');
  await migrate(f.outsider, mint);
  const p = f.client.pumpAccounts(mint, f.quoteMint);
  const state = await pumpState(mint);
  const spend = 100n * USDC;
  const quote = await pumpswap.pumpSwapQuote({ connection: f.connection, pool: p.pool, user: f.trader.publicKey, side: 'buy', amount: spend, slippageBps: 100 });
  // Constant product on the pool's reserves after fees (flat PumpSwap fees without the fee program: 0.25% LP + 0.05%).
  const ideal = state.base * spend / (state.quote + spend);
  assert.ok(quote.out > 0n && quote.out <= ideal && quote.out >= ideal * 99n / 100n, `buy quote ${quote.out} vs ${ideal}`);
  assert.equal(quote.limit, spend * 101n / 100n, 'a buy may charge at most the amount plus 1% slippage');
  assert.ok(quote.fee > 0n && quote.fee < spend / 100n, `fee ${quote.fee}`);
  const tokens = 1_000_000n * 10n ** 6n;
  const sellQuote = await pumpswap.pumpSwapQuote({ connection: f.connection, pool: p.pool, user: f.trader.publicKey, side: 'sell', amount: tokens, slippageBps: 100 });
  const idealOut = state.quote * tokens / (state.base + tokens);
  assert.ok(sellQuote.out > 0n && sellQuote.out <= idealOut && sellQuote.out >= idealOut * 99n / 100n, `sell quote ${sellQuote.out} vs ${idealOut}`);
  assert.equal(sellQuote.limit, sellQuote.out * 99n / 100n, 'a sell accepts at least 99% of the quote');
  for (const side of ['buy', 'sell']) {
    const trade = await pumpswap.pumpSwapTrade({ connection: f.connection, pool: p.pool, user: f.trader.publicKey, side, amount: side === 'buy' ? spend : tokens, slippageBps: 100 });
    const code = side === 'buy' ? [102, 6, 61, 18, 1, 218, 235, 234] : [51, 230, 133, 164, 1, 127, 131, 173];
    const pumpIxs = trade.instructions.filter(ix => ix.programId.toBase58() === PUMP_AMM_PROGRAM);
    const swap = pumpIxs.find(ix => code.every((b, i) => ix.data[i] === b));
    assert.ok(swap, `${side}: a PumpSwap ${side} instruction`);
    assert.ok(swap.programId instanceof PublicKey, 'the page\'s own web3.js classes, not a second copy');
    // Pools created before PumpSwap grew its pool account (287 → 300 bytes) are extended first, by the SDK.
    for (const other of pumpIxs.filter(ix => ix !== swap)) assert.deepEqual([...other.data.subarray(0, 8)], [234, 102, 194, 203, 150, 72, 62, 229], 'only extend_account besides the swap');
    assert.equal(swap.keys[0].pubkey.toBase58(), p.pool.toBase58()); assert.equal(swap.keys[1].pubkey.toBase58(), f.trader.publicKey.toBase58()); assert.ok(swap.keys[1].isSigner);
    assert.equal(swap.keys[3].pubkey.toBase58(), mint.toBase58()); assert.equal(swap.keys[4].pubkey.toBase58(), f.quoteMint.toBase58());
    assert.equal(swap.keys[7].pubkey.toBase58(), p.poolBase.toBase58()); assert.equal(swap.keys[8].pubkey.toBase58(), p.poolQuote.toBase58());
    assert.ok(swap.keys.length >= 21, `${side}: ${swap.keys.length} accounts`);
    // The transaction is accepted up to the swap: PumpSwap runs and only stops at pump's fee program (absent here).
    const { blockhash } = await f.connection.getLatestBlockhash('confirmed');
    const tx = new web3.Transaction({ feePayer: f.trader.publicKey, recentBlockhash: blockhash }).add(f.client.computeBudget(300_000), ...trade.instructions);
    const bytes = tx.serializeMessage().length + 1 + 64 * tx.compileMessage().header.numRequiredSignatures;
    assert.ok(bytes <= 1232, `${side} fits one transaction (${bytes} bytes)`);
    const sim = await f.connection.simulateTransaction(tx);
    assert.ok((sim.value.logs ?? []).some(l => l.startsWith(`Program ${PUMP_AMM_PROGRAM} invoke`)), `${side}: PumpSwap was reached\n${(sim.value.logs ?? []).join('\n')}`);
  }
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
  await send(f.connection, f.creator, [f.client.computeBudget(), f.client.launch({ uri: TEST_URI, creator: f.creator.publicKey, config: f.config, mint: mint.publicKey, name: 'New Price', symbol: 'NEWP', firstBuy: USDC, minTokensOut: 1n, reward: f.rewardWallet.publicKey })], [mint], 1);
  assert.equal((await pool(mint.publicKey)).virtualQuote, repriced.virtualQuote);
  assert.equal(await f.connection.getBalance(f.treasury) - treasuryBefore, 20_000_000);
  await afterSnipeWindow(before);
  await buy(f.trader, before, USDC, 1n);
  // Back to the suite's prices.
  await update(f.authority, PARAMS);
  assert.equal(f.client.decodeConfig((await f.connection.getAccountInfo(f.config.address)).data).virtualQuote, PARAMS.virtualQuote);
});

test('Solana pairs: SOL, a paired token and a Token-2022 token each launch, trade, complete, migrate and harvest', { skip: pumpSkip }, async () => {
  const programId = f.programId;
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
    await send(f.connection, user, [f.client.computeBudget(), f.client.launch({ uri: TEST_URI, creator: user.publicKey, config: cfg, mint: mint.publicKey, name: `Pair ${pair.symbol}`, symbol: pair.key.replace(/[^a-z]/g, '').slice(0, 8).toUpperCase(), firstBuy, minTokensOut: 1n, reward: user.publicKey })], [mint], 1);
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

test('Solana USD pricing: Pyth-verified $10 fee in SOL or USDC and a $5,000 starting FDV', { skip: pumpSkip }, async () => {
  const programId = f.programId, sol = new PublicKey(WSOL_MINT), solConfig = f.client.configFor(sol);
  assert.ok(await f.connection.getAccountInfo(solConfig), 'the SOL pair config exists (created by the pairs test)');
  const parsed = parsePriceUpdate((await f.connection.getAccountInfo(f.oracles.fresh)).data);
  assert.equal(parsed.feedId, SOL_USD_FEED_ID); assert.equal(parsed.price, 11_106_000_000n); assert.equal(parsed.exponent, -8);
  const set = (who, oracle, extra = {}) => send(f.connection, who, [f.client.setPricing({ authority: who.publicKey, config: solConfig, priceUpdate: oracle, maxAgeSecs: 3600, maxConfBps: 300, ...extra })], [], 1);
  await failsWith(set(f.outsider, f.oracles.fresh), /0x1770/);
  await failsWith(set(f.authority, f.oracles.stale), /0x178a/);
  await failsWith(set(f.authority, f.oracles.wide), /0x178b/);
  await failsWith(set(f.authority, f.oracles.otherFeed), /0x1789/);
  await failsWith(set(f.authority, f.oracles.notPyth), /0x1789/);
  await failsWith(send(f.connection, f.authority, [f.client.setPricing({ authority: f.authority.publicKey, config: f.config.address, priceUpdate: f.oracles.fresh, maxAgeSecs: 3600, maxConfBps: 300 })], [], 1), /0x1774/, 'a USD starting FDV only applies to SOL pairs');
  assert.match(explainError(new Error('custom program error: 0x178c')), /refresh the quote/i);

  // A six-decimal USDC stand-in for the USDC fee, minted to the creator.
  const spl = splTestMint(web3), usdc = Keypair.generate(), user = Keypair.generate();
  await airdrop(f.connection, user.publicKey, 20 * web3.LAMPORTS_PER_SOL);
  await send(f.connection, f.authority, await spl.createMintIxs(f.connection, f.authority.publicKey, usdc.publicKey, 6, f.authority.publicKey), [usdc]);
  await send(f.connection, f.authority, [f.client.createAtaIdempotent(f.authority.publicKey, user.publicKey, usdc.publicKey), spl.mintTo(usdc.publicKey, f.client.ata(user.publicKey, usdc.publicKey), f.authority.publicKey, 50_000_000n)]);
  const oracle = { priceAccount: f.oracles.fresh.toBase58(), feedId: SOL_USD_FEED_ID, maxAgeSecs: 3600, maxConfBps: 300, feeUsdE6: '10000000', startFdvUsdE6: '5000000000', usdcMint: usdc.publicKey.toBase58() };
  const enabled = await ensurePricing({ connection: f.connection, payer: f.authority, programId, config: solConfig.toBase58(), oracle });
  assert.equal(enabled.created, true); assert.equal(enabled.pricing.priceFeed.toBase58(), SOL_USD_PRICE_ACCOUNT); assert.equal(enabled.pricing.feeUsdE6, 10_000_000n);
  assert.equal((await ensurePricing({ connection: f.connection, payer: f.authority, programId, config: solConfig.toBase58(), oracle })).updated, false, 'idempotent');

  const cfg = { address: solConfig, quoteMint: sol, treasury: f.treasury, quoteTokenProgram: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') };
  const onchain = f.client.decodeConfig((await f.connection.getAccountInfo(solConfig)).data);
  const fee = usdToQuote(10_000_000n, parsed, 9), vq = virtualQuoteForFdv(5_000_000_000n, parsed, onchain.virtualToken);
  assert.equal(fee, 90_041_419n + 1n, '$10 at $111.06 = 0.090041420 SOL, rounded up');
  const firstBuy = 100_000_000n;
  const launchIx = (mint, extra = {}) => [f.client.computeBudget(), ...f.client.wrapSol(user.publicKey, firstBuy), f.client.launch({ uri: TEST_URI, creator: user.publicKey, config: cfg, mint: mint.publicKey, name: 'Priced', symbol: 'USD', firstBuy, minTokensOut: 1n, reward: user.publicKey, priceUpdate: f.oracles.fresh, maxFee: fee, ...extra }), f.client.unwrapSol(user.publicKey)];
  // The fee cap protects the creator from price moves between quote and confirmation.
  const capped = Keypair.generate();
  await failsWith(send(f.connection, user, launchIx(capped, { maxFee: fee - 1n }), [capped], 1), /0x178c/);
  // Only the bound price account is accepted.
  const wrong = Keypair.generate();
  await failsWith(send(f.connection, user, launchIx(wrong, { priceUpdate: f.oracles.otherFeed }), [wrong], 1), /0x1789/);
  // SOL fee: exactly the oracle conversion goes to the treasury; the curve starts at $5,000 FDV.
  const treasuryBefore = await f.connection.getBalance(f.treasury), mint = Keypair.generate();
  const signature = await send(f.connection, user, launchIx(mint), [mint], 1);
  assert.equal(BigInt(await f.connection.getBalance(f.treasury) - treasuryBefore), fee);
  const pool = await (async () => f.client.decodePool((await f.connection.getAccountInfo(f.client.poolPda(mint.publicKey))).data))();
  assert.equal(pool.virtualQuote, vq, 'virtual SOL reserve sized from the oracle');
  const startFdvSol = poolStats({ ...pool, sold: 0n, realQuote: 0n, liquidityBonus: 0n }, 9).marketCap;
  assert.ok(Math.abs(startFdvSol * 111.06 - 5000) < 0.01, `starts at $5,000 FDV (${startFdvSol} SOL)`);
  const [paid] = (await eventsOf(signature)).filter(e => e.name === 'LaunchFeePaid');
  assert.equal(paid.amount, fee); assert.equal(paid.asset, PublicKey.default.toBase58()); assert.equal(paid.oraclePrice, 11_106_000_000n);
  // USDC fee: exactly 10 USDC to the treasury's USDC account and no SOL fee.
  const treasuryUsdc = f.client.ata(f.treasury, usdc.publicKey), usdcBefore = await balance(treasuryUsdc), lamportsBefore = await f.connection.getBalance(f.treasury), mint2 = Keypair.generate();
  await send(f.connection, user, launchIx(mint2, { maxFee: 0n, usdc: { mint: usdc.publicKey } }), [mint2], 1);
  assert.equal(await balance(treasuryUsdc) - usdcBefore, 10_000_000n);
  assert.equal(await f.connection.getBalance(f.treasury), lamportsBefore);
  // USDC fee on a pair without pricing is refused.
  const plain = Keypair.generate();
  await failsWith(send(f.connection, f.creator, [f.client.computeBudget(), f.client.launch({ uri: TEST_URI, creator: f.creator.publicKey, config: f.config, mint: plain.publicKey, name: 'Plain', symbol: 'PLN', firstBuy: USDC, minTokensOut: 1n, reward: f.rewardWallet.publicKey, usdc: { mint: usdc.publicKey } })], [plain], 1), /0x178d/);
  // A price older than the configured age is rejected at launch time.
  const age = Math.floor(Date.now() / 1000) - f.oracleStart + 6;
  await set(f.authority, f.oracles.fresh, { maxAgeSecs: age, usdcMint: usdc.publicKey });
  await sleep(9000);
  const late = Keypair.generate();
  await failsWith(send(f.connection, user, launchIx(late), [late], 1), /0x178a/);
  await set(f.authority, f.oracles.fresh, { usdcMint: usdc.publicKey });
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
  const programId = f.programId;
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
  const programId = f.programId;
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

// The Squads devnet rehearsal (scripts/squads-devnet-trial.mjs) signs these loader instructions from a Squads vault. Here
// a plain key stands in for the vault, so the upgrade, hand-back and four-account close are checked against the real
// upgradeable loader. The Squads approval itself (2 of 2) runs against the real Squads program on devnet.
test('Squads rehearsal: a vault upgrades a throwaway program, hands authority back, and the program closes with its rent', { skip }, async () => {
  const { loaderV3 } = await import('../packages/solana/client.mjs');
  const loader = loaderV3(web3), programKeypair = Keypair.generate(), vault = Keypair.generate(), elf = readFileSync(elfPath);
  await airdrop(f.connection, vault.publicKey, web3.LAMPORTS_PER_SOL);
  await deployProgram({ connection: f.connection, payer: f.authority, programKeypair, elf, sendsPerSecond: 200 });
  const programId = programKeypair.publicKey, programData = createElpidaSolana(web3, programId).programDataAddress;
  const state = async () => readProgramData((await f.connection.getAccountInfo(programData)).data);
  await send(f.connection, f.authority, [loader.setAuthority({ account: programData, authority: f.authority.publicKey, newAuthority: vault.publicKey })]);
  assert.deepEqual([...(await state()).authority], [...vault.publicKey.toBytes()], 'the vault holds the upgrade authority');
  await failsWith(send(f.connection, f.authority, [loader.setAuthority({ account: programData, authority: f.authority.publicKey, newAuthority: f.authority.publicKey })], [], 1), /incorrect authority|IncorrectAuthority|0x|custom/i);
  const { prepareUpgradeBuffer } = await import('../packages/solana/deploy.mjs');
  const buffer = await prepareUpgradeBuffer({ connection: f.connection, payer: f.authority, elf, multisig: vault.publicKey.toBase58(), sendsPerSecond: 200 });
  const before = (await state()).slot;
  await send(f.connection, vault, vaultUpgrade({ loader, programId, programData, buffer, spill: f.authority.publicKey, vault: vault.publicKey }));
  assert.ok((await state()).slot > before, 'upgraded: the last-deployed slot moved');
  assert.equal(await f.connection.getAccountInfo(buffer), null, 'the buffer is consumed and its rent refunded');
  await send(f.connection, vault, vaultHandBack({ loader, programData, vault: vault.publicKey, to: f.authority.publicKey }));
  assert.deepEqual([...(await state()).authority], [...f.authority.publicKey.toBytes()], 'authority handed back');
  const rent = (await f.connection.getAccountInfo(programData)).lamports, held = await f.connection.getBalance(f.authority.publicKey);
  await send(f.connection, f.authority, [closeProgram({ web3, programData, recipient: f.authority.publicKey, authority: f.authority.publicKey, programId })]);
  assert.equal(await f.connection.getAccountInfo(programData), null, 'program data closed');
  assert.ok(await f.connection.getBalance(f.authority.publicKey) - held > rent - 100_000, 'its rent came back');
});

test('Solana compatibility: clients detect a program without metadata support and launch with the earlier layout', { skip }, async () => {
  // The devnet program before this upgrade (build 319e2ffe…, committed as a fixture) stays usable until it is upgraded.
  const previous = readFileSync(`${root}contracts/solana/fixtures/elpida_launchpad-pre-metadata.so`);
  assert.equal(await f.client.supportsMetadata(f.connection, f.creator.publicKey), true, 'current build supports metadata');
  await upgradeProgram({ connection: f.connection, payer: f.authority, programId: f.programId, elf: previous, sendsPerSecond: 200 });
  try {
    await sleep(1500); // the upgraded program becomes visible from the next slot
    assert.equal(await f.client.supportsMetadata(f.connection, f.creator.publicKey), false, 'previous build detected');
    const mint = Keypair.generate();
    await send(f.connection, f.creator, [f.client.computeBudget(), f.client.launch({ legacy: true, creator: f.creator.publicKey, config: f.config, mint: mint.publicKey, name: 'Legacy', symbol: 'OLD', firstBuy: 5n * USDC, minTokensOut: 0n, reward: f.rewardWallet.publicKey })], [mint], 1);
    assert.equal((await pool(mint.publicKey)).symbol, 'OLD', 'earlier layout launches on the previous program');
    assert.equal(await f.connection.getAccountInfo(f.client.metadataPda(mint.publicKey)), null, 'no metadata on the previous program');
  } finally {
    await upgradeProgram({ connection: f.connection, payer: f.authority, programId: f.programId, elf: readFileSync(elfPath), sendsPerSecond: 200 });
    await sleep(1500);
  }
  assert.equal(await f.client.supportsMetadata(f.connection, f.creator.publicKey), true, 'back on the current build');
});

test('Solana upgrade is a no-op when the deployed program already matches the build', { skip }, async () => {
  const result = await upgradeProgram({ connection: f.connection, payer: f.authority, programId: f.programId, elf: readFileSync(elfPath) });
  assert.equal(result.upgraded, false);
  await assert.rejects(upgradeProgram({ connection: f.connection, payer: f.outsider, programId: f.programId, elf: readFileSync(elfPath) }), /upgrade authority/);
});

test('Solana public indexer: pools, launch/buy/sell trades, candles and holders from chain', { skip }, async () => {
  const { SolanaIndexer } = await import('../packages/indexer/solana-indexer.mjs');
  const retained = [];
  const index = new SolanaIndexer({ web3, connection: f.connection, deployment: { programId: f.programId.toBase58(), pairs: [] }, network: { key: 'solana-localnet', cluster: 'localnet', explorer: 'https://explorer.solana.com' }, metadataStore: { retainPublished: uri => retained.push(uri), resolve: async uri => ({ name: 'resolved', uri }) }, spacingMs: 0, backfill: 5000 });
  try {
    await index.sync();
    const listings = index.listings();
    assert.ok(listings.length >= 5, `indexed ${listings.length} pools`);
    const token = listings.find(t => t.symbol === 'SOLG');
    assert.ok(token, 'the first launch is listed');
    assert.equal(Number(token.supply), 1e9); assert.equal(Number(token.circulatingSupply), 1e9, 'circulating = full minted supply');
    const trades = index.trades(token.address);
    assert.ok(trades.some(t => t.launch && t.side === 'buy' && t.account === f.creator.publicKey.toBase58()), 'launch buy by the creator');
    const all = listings.flatMap(t => index.trades(t.address));
    assert.ok(all.some(t => t.side === 'sell'), 'sells are indexed');
    assert.ok(index.candles(token.address, 60).length >= 1);
    const holders = await index.holders(token.address);
    assert.ok(holders.some(h => h.address === f.creator.publicKey.toBase58()), 'creator holds tokens');
    assert.ok(!holders.some(h => h.address === token.pool), 'curve vault excluded');
    // Full holder list from getProgramAccounts, largest first, paged.
    const count = await index.holderCount(token.address);
    assert.ok(count >= 1 && (await index.holders(token.address, { offset: 0, limit: 1 })).length === 1);
    const shares = holders.map(h => Number(h.supplyShare));
    assert.deepEqual(shares, [...shares].sort((x, y) => y - x), 'sorted by balance');
    // Dev badge (D6): launch buy and live creator holding, % of supply.
    const launchBuy = trades.find(t => t.launch);
    assert.equal(token.devBoughtRaw, String(launchBuy.tokenRaw));
    assert.equal(token.devBoughtPct, Number(BigInt(launchBuy.tokenRaw) * 1_000_000n / TOKEN_SUPPLY) / 10_000);
    assert.equal(typeof token.devHoldingPct, 'number');
    // Immutable Metaplex metadata (D11): the URI is read from chain and resolved through the store.
    assert.equal(token.metadataURI, TEST_URI);
    const meta = listings.find(t => t.symbol === 'META');
    assert.equal(meta.metadataURI, TEST_URI);
    // A graduated, unmigrated curve advertises when it can be reopened (D7).
    const waiting = listings.find(t => t.complete && !t.graduated);
    if (waiting) assert.equal(waiting.reopenableAt, waiting.completedAt + GRADUATION_GRACE_SECS);
    // Migrated tokens are priced from the PumpSwap pool, not the emptied curve.
    for (const migrated of listings.filter(t => t.graduated)) {
      assert.ok(migrated.pumpPool && Number(migrated.liquidity) > 0 && migrated.spotPrice > 0, `${migrated.symbol} priced from PumpSwap`);
    }
    assert.ok(retained.includes(TEST_URI), 'published metadata retained once seen on chain');
    assert.equal(index.listings().find(t => t.symbol === 'META').metadata.name, 'resolved');
    // Idempotent: a second sync adds nothing new.
    const before = index.status().trades;
    await index.sync();
    assert.equal(index.status().trades, before);
    assert.equal(index.status().error, null);
  } finally { index.close(); }
});

// Early-partner tiers (docs/DESIGN_PARTNER_TIERS.md): the SOL pair's treasury registers a creator wallet; its pools
// fix the share at launch, keep the creator's half, burn the share of every base fee through a curve buyback, and
// after migration burn the token side of each harvest share and queue the quote side.
test('Solana partner tiers: treasury-only registry, burn on every trade, creator keeps half, tier fixed at launch', { skip: pumpSkip }, async () => {
  const sol = new PublicKey(WSOL_MINT);
  assert.ok(await f.connection.getAccountInfo(f.client.configFor(sol)), 'the SOL pair config exists (its treasury is the partner authority)');
  const partner = Keypair.generate(), now = async () => f.connection.getBlockTime(await f.connection.getSlot('confirmed'));
  await airdrop(f.connection, partner.publicKey, 5 * web3.LAMPORTS_PER_SOL);
  await airdrop(f.connection, f.treasury, 2 * web3.LAMPORTS_PER_SOL);
  await send(f.connection, f.authority, [f.client.createAtaIdempotent(f.authority.publicKey, partner.publicKey, f.quoteMint), f.spl.mintTo(f.quoteMint, f.client.ata(partner.publicKey, f.quoteMint), f.authority.publicKey, 50_000n * USDC)]);
  const setPartner = (who, bps, expiresAt) => send(f.connection, who, [f.client.setPartner({ authority: who.publicKey, creator: partner.publicKey, buybackBps: bps, expiresAt })], [], 1);
  const record = async () => f.client.decodePartner((await f.connection.getAccountInfo(f.client.partnerPda(partner.publicKey)))?.data, await now());

  // Only the SOL pair's treasury, only 10% or 20%, only up to 180 days ahead; (0, 0) ends a tier.
  await failsWith(setPartner(f.outsider, 2000, (await now()) + 86_400), /0x1770/);
  for (const [bps, ahead] of [[1500, 86_400], [3000, 86_400], [2000, -10], [2000, 181 * 86_400]]) await failsWith(setPartner(f.treasuryKeypair, bps, (await now()) + ahead), /0x1790/);
  await failsWith(setPartner(f.treasuryKeypair, 0, 5), /0x1790/);
  const expiresAt = (await now()) + 30 * 86_400;
  const set = await setPartner(f.treasuryKeypair, 2000, expiresAt);
  assert.deepEqual({ ...(await record()), creator: undefined }, { creator: undefined, buybackBps: 2000, expiresAt, live: true });
  const setEvent = (await eventsOf(set)).find(e => e.name === 'PartnerSet');
  assert.equal(setEvent.buybackBps, 2000); assert.equal(setEvent.expiresAt, BigInt(expiresAt));

  // The partner's pool fixes 20% at launch; anyone else is standard.
  const elite = await launch({ symbol: 'ELITE', creator: partner });
  const standard = await launch({ symbol: 'STDRD' });
  assert.equal((await pool(elite.mint)).buybackBps, 2000);
  assert.equal((await pool(standard.mint)).buybackBps, 0);
  assert.equal((await f.connection.getAccountInfo(f.client.poolPda(elite.mint))).data.length, 292, 'partner-era pools carry the extension');
  const launched = await eventsOf(elite.signature);
  assert.equal(launched.find(e => e.name === 'PartnerPoolLaunched')?.buybackBps, 2000);
  // Its creator buy burns too: tokens sold to the creator plus tokens burned equal the pool's sold amount.
  const burnedAtLaunch = launched.find(e => e.name === 'PartnerBuyback')?.tokensBurned ?? 0n;
  assert.ok(burnedAtLaunch > 0n, 'the launch buy burned tokens');
  assert.equal((await pool(elite.mint)).sold, elite.expected.tokens + burnedAtLaunch);
  // Ending the tier does not change the pool already launched.
  await setPartner(f.treasuryKeypair, 0, 0);
  assert.equal((await record()).live, false);
  assert.equal((await pool(elite.mint)).buybackBps, 2000);

  await afterSnipeWindow(elite.mint);
  const supply = async () => BigInt((await f.connection.getTokenSupply(elite.mint)).value.amount);
  for (const [side, amount] of [['buy', 300n * USDC], ['buy', 1_200n * USDC], ['sell', 2_000_000n * 1_000_000n], ['buy', 50n * USDC]]) {
    const before = await pool(elite.mint), supplyBefore = await supply();
    const signature = side === 'buy' ? await buy(f.trader, elite.mint, amount, 1n) : await sell(f.trader, elite.mint, amount, 1n);
    const after = await pool(elite.mint), events = await eventsOf(signature);
    const trade = events.find(e => e.name === (side === 'buy' ? 'CurveBought' : 'CurveSold'));
    const base = trade.fee, burnQuote = base * 2000n / 10_000n, buyback = events.find(e => e.name === 'PartnerBuyback');
    assert.equal(trade.antiSnipeFee, 0n, 'after the window the whole fee is the base fee');
    assert.equal(after.creatorFees - before.creatorFees, base - base / 2n, `${side}: the creator keeps half`);
    assert.equal(after.protocolFees - before.protocolFees, base / 2n - burnQuote, `${side}: the burn share comes out of the protocol half`);
    assert.ok(buyback, `${side}: a buyback happened`);
    assert.equal(buyback.quoteIn, burnQuote);
    assert.equal(supplyBefore - await supply(), buyback.tokensBurned, `${side}: bought tokens are burned`);
    assert.equal(after.buybackBurned - before.buybackBurned, buyback.tokensBurned);
    assert.equal(after.buybackQuoteSpent - before.buybackQuoteSpent, burnQuote);
    await invariant(elite.mint);
  }
  assert.equal(TOKEN_SUPPLY - await supply(), (await pool(elite.mint)).buybackBurned, 'every burned token is gone from the supply');

  // A standard pool is unchanged: 50/50, no burn, no extension writes.
  await afterSnipeWindow(standard.mint);
  const s0 = await pool(standard.mint), plain = await eventsOf(await buy(f.trader, standard.mint, 300n * USDC, 1n));
  const s1 = await pool(standard.mint), fee = plain.find(e => e.name === 'CurveBought').fee;
  assert.equal(s1.protocolFees - s0.protocolFees, fee / 2n); assert.equal(s1.creatorFees - s0.creatorFees, fee - fee / 2n);
  assert.equal(plain.some(e => e.name === 'PartnerBuyback'), false);

  // An expired tier is standard at launch.
  await setPartner(f.treasuryKeypair, 1000, (await now()) + 2);
  await sleep(4000);
  assert.equal((await pool((await launch({ symbol: 'LATE', creator: partner })).mint)).buybackBps, 0, 'expired before the launch');
});

test('Solana partner tiers: a buyback never completes the curve, and after migration the harvest share is burned or queued', { skip: pumpSkip }, async () => {
  const partner = Keypair.generate(), now = async () => f.connection.getBlockTime(await f.connection.getSlot('confirmed'));
  await airdrop(f.connection, partner.publicKey, 5 * web3.LAMPORTS_PER_SOL);
  await send(f.connection, f.authority, [f.client.createAtaIdempotent(f.authority.publicKey, partner.publicKey, f.quoteMint), f.spl.mintTo(f.quoteMint, f.client.ata(partner.publicKey, f.quoteMint), f.authority.publicKey, 50_000n * USDC)]);
  await send(f.connection, f.treasuryKeypair, [f.client.setPartner({ authority: f.treasury, creator: partner.publicKey, buybackBps: 1000, expiresAt: (await now()) + 86_400 })], [], 1);
  // Completing buy: the curve sells exactly its supply, and that trade's burn share is locked as liquidity instead.
  const mint = await completedCurve('PCOMP', partner);
  const done = await pool(mint);
  assert.equal(done.buybackBps, 1000);
  assert.equal(done.status, STATUS_GRADUATED);
  assert.equal(done.sold, done.curveSupply, 'exactly the curve supply: the buyback did not complete it');
  assert.equal(TOKEN_SUPPLY - BigInt((await f.connection.getTokenSupply(mint)).value.amount), done.buybackBurned);
  await invariant(mint);

  await migrate(f.outsider, mint);
  const m0 = await migration(mint);
  assert.equal(m0.pendingBuyback, 0n);
  const p = f.client.pumpAccounts(mint, f.quoteMint);
  const transferIx = (from, to, amount) => new web3.TransactionInstruction({ programId: f.client.tokenProgram, keys: [{ pubkey: from, isSigner: false, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }, { pubkey: f.trader.publicKey, isSigner: true, isWritable: false }], data: Buffer.from([3, ...new Uint8Array(new BigUint64Array([amount]).buffer)]) });
  await send(f.connection, f.trader, [transferIx(f.client.ata(f.trader.publicKey, f.quoteMint), p.poolQuote, 1_200n * USDC)]);
  const state = await pumpState(mint), lp = harvestNow(m0.lpLocked, m0.principal, state), out = withdrawOut(lp, state);
  const burnBase = out.base * 1000n / 10_000n, queueQuote = out.quote * 1000n / 10_000n;
  const balances = async () => Promise.all([f.client.ata(f.treasury, mint), f.client.ata(f.treasury, f.quoteMint), f.client.ata(f.rewardWallet.publicKey, mint), f.client.ata(f.rewardWallet.publicKey, f.quoteMint), p.authorityQuote].map(balance));
  const [tb0, tq0, rb0, rq0, aq0] = await balances(), supply0 = BigInt((await f.connection.getTokenSupply(mint)).value.amount);
  const signature = await harvest(f.outsider, mint);
  const [tb1, tq1, rb1, rq1, aq1] = await balances();
  assert.equal(rb1 - rb0, out.base - out.base / 2n, 'creator half of the token side');
  assert.equal(rq1 - rq0, out.quote - out.quote / 2n, 'creator half of the quote side');
  assert.equal(tb1 - tb0, out.base / 2n - burnBase); assert.equal(tq1 - tq0, out.quote / 2n - queueQuote);
  assert.equal(supply0 - BigInt((await f.connection.getTokenSupply(mint)).value.amount), burnBase, 'the token-side share is burned');
  assert.equal(aq1 - aq0, queueQuote, 'the quote-side share stays with the LP authority');
  const m1 = await migration(mint);
  assert.equal(m1.pendingBuyback, queueQuote); assert.equal(m1.baseBurned, burnBase);
  const ev = (await eventsOf(signature)).find(e => e.name === 'PartnerHarvest');
  assert.equal(ev.baseBurned, burnBase); assert.equal(ev.quoteQueued, queueQuote); assert.equal(ev.pendingBuyback, queueQuote);
  assert.ok(liquidityUnits(m1.lpLocked, await pumpState(mint)) >= m0.principal, 'principal liquidity stays locked');
});

