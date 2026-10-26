// Shared client for the Elpida Solana program (contracts/solana), model 3: bonding curve over virtual
// reserves with a decaying anti-snipe fee, one config per trading pair (wrapped SOL by default, or another
// approved token; classic SPL or Token-2022). The creation fee is always paid in SOL. Works in Node and the browser: pass in the
// @solana/web3.js v1 module (Node) or `globalThis.solanaWeb3` (browser bundle).
// Byte layouts and Anchor discriminators must match contracts/solana/programs/elpida_launchpad/src/lib.rs;
// tests/solana.test.mjs checks them against the compiled program.

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const LOADER_V3 = 'BPFLoaderUpgradeab1e11111111111111111111111';
export const TOKEN_DECIMALS = 6;
export const TOKEN_SUPPLY = 1_000_000_000_000_000n; // 1B tokens, 6 decimals
export const BPS = 10_000n;
export const MODEL_VERSION = 3;
export const CONFIG_SIZE = 117;
export const POOL_SIZE = 260;
/** Pools launched by the partner-tier program carry POOL_EXT_LEN more bytes (buyback share and burn totals). */
export const POOL_EXT_LEN = 32;
export const POOL_SIZE_PARTNER = POOL_SIZE + POOL_EXT_LEN;
export const POOL_SIZES = [POOL_SIZE, POOL_SIZE_PARTNER];
/** Early-partner burn shares of the base fee (docs/DESIGN_PARTNER_TIERS.md): Partner 10%, Elite 20%. */
export const PARTNER_BPS = [1000, 2000];
export const MAX_PARTNER_WINDOW_SECS = 180 * 86_400;
export const STATUS_TRADING = 0;
export const STATUS_GRADUATED = 1; // curve complete, waiting for migration
export const STATUS_MIGRATED = 2; // liquidity moved into a locked PumpSwap pool
export const MIGRATION_SIZE = 210;
export const MIGRATION_EXT_LEN = 48;
/** Test networks only: default tUSDC faucet mint (25,000 tUSDC, 6 decimals). */
export const TEST_USDC_FAUCET_MAX = 25_000_000_000n;
/** Test networks only: the program's per-call faucet limit, in whole units of any test asset. */
export const TEST_FAUCET_MAX_WHOLE = 10_000_000n;
/** Wrapped SOL: the quote mint of native-SOL pairs. The client wraps and unwraps around each trade. */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
// Pyth: verified PriceUpdateV2 accounts are owned by the Solana Receiver. The sponsored SOL/USD account is
// the shard-0 PDA of the push-oracle program for the SOL/USD feed (same address on mainnet and devnet).
export const PYTH_RECEIVER = 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ';
export const PYTH_PUSH_ORACLE = 'pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT';
export const SOL_USD_FEED_ID = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
export const SOL_USD_PRICE_ACCOUNT = '7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE';
export const PRICE_UPDATE_SIZE = 134;
/** USD launch economics: $10 fee (SOL or USDC) and a $5,000 starting FDV for SOL pairs, 6-decimal USD. */
export const USD_PRICING = { feeUsdE6: 10_000_000n, startFdvUsdE6: 5_000_000_000n, maxAgeSecs: 120, maxConfBps: 200 };
export const MIGRATE_COMPUTE_UNITS = 600_000;
export const HARVEST_COMPUTE_UNITS = 400_000;
/** A PumpSwap buy or sell with SOL wrapping, token-account creation and fee-program calls. */
export const PUMPSWAP_COMPUTE_UNITS = 300_000;

// PumpSwap (pump AMM), same addresses on mainnet and devnet.
export const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const PUMP_GLOBAL_CONFIG = 'ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw';
export const PUMP_EVENT_AUTHORITY = 'GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
/** Fees PumpSwap charges on pools it did not create itself: 0.25% to LP holders, 0.05% to pump. */
export const PUMPSWAP_FEES = { lpFeeBps: 25, protocolFeeBps: 5, creatorFeeBps: 0 };
export const LAUNCH_COMPUTE_UNITS = 400_000;
/** Metaplex Token Metadata; `launch` writes immutable metadata (name, symbol, IPFS URI) through it. */
export const MPL_TOKEN_METADATA = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
export const SYSVAR_RENT = 'SysvarRent111111111111111111111111111111111';
/** D7: a completed curve that has not migrated this long after completion can be reopened for trading. */
export const GRADUATION_GRACE_SECS = 86_400;
/** Same rule as the program: an ipfs:// URI of printable ASCII, at most 200 bytes. */
/** Longest URI the client sends. The metadata store returns bare `ipfs://<CIDv1>` links, which are
 *  66 characters; with that cap the largest supported launch (SOL pair, SPL-Token USDC fee, 32-byte
 *  name) is 1,227 of Solana's 1,232 bytes. A Token-2022 USDC fee on a SOL pair does not fit (1,259)
 *  and is refused by the wallet's size check before signing. */
export const MAX_LAUNCH_URI = 66;
export const validMetadataUri = uri => typeof uri === 'string' && uri.length > 7 && uri.length <= 200 && uri.startsWith('ipfs://') && /^[\x21-\x7e]+$/.test(uri);

/** Default curve shape (FDVs are in whole units of the pair asset, SOL for native pairs; real
 *  deployments take their values from config/native-pricing.json), 1.25% base fee,
 *  anti-snipe fee decaying linearly from 90% to the base fee over the first 60 seconds. */
export const DEFAULT_CURVE = { startFdv: 30, endFdv: 300, launchFee: '0.05', baseFeeBps: 125, snipeStartBps: 9_000, snipeWindowSecs: 60, maxCreatorBuyBps: 0 };

// sha256("global:<name>")[0..8] and sha256("account:<Name>")[0..8]
export const DISCRIMINATORS = {
  initializeCurve: [170, 84, 186, 253, 131, 149, 95, 213],
  launch: [153, 241, 93, 225, 22, 69, 74, 61],
  buy: [102, 6, 61, 18, 1, 218, 235, 234],
  sell: [51, 230, 133, 164, 1, 127, 131, 173],
  withdrawFees: [198, 212, 171, 109, 144, 215, 174, 89],
  CurveConfig: [96, 75, 211, 144, 193, 36, 243, 41],
  CurvePool: [213, 210, 227, 191, 48, 170, 222, 114],
  migrateToPumpswap: [42, 67, 45, 80, 226, 24, 204, 54],
  addCurveConfig: [181, 172, 221, 19, 78, 65, 146, 65],
  createTestUsdc: [53, 80, 84, 185, 93, 132, 194, 31],
  testUsdcFaucet: [56, 199, 170, 120, 34, 36, 125, 29],
  harvestLpFees: [153, 236, 19, 193, 135, 211, 138, 173],
  PumpMigration: [234, 227, 47, 135, 5, 201, 199, 146],
  testBuildCheck: [135,  170,  99,  137,  166,  97,  12,  254],
  setBetaGate: [173, 164, 104, 88, 207, 75, 214, 143],
  allowBetaCreator: [85, 38, 209, 94, 146, 252, 6, 98],
  revokeBetaCreator: [225, 1, 249, 74, 23, 63, 36, 199],
  BetaGate: [157, 14, 100, 165, 88, 97, 119, 83],
  BetaCreator: [196, 152, 244, 127, 100, 59, 189, 139],
  updateCurveConfig: [23, 123, 231, 253, 103, 196, 100, 218],
  setPricing: [52, 200, 157, 192, 18, 134, 57, 123],
  PricingConfig: [126, 131, 53, 131, 89, 154, 123, 85],
  PriceUpdateV2: [34, 241, 35, 99, 157, 126, 244, 205],
  reopenCurve: [133, 7, 138, 0, 67, 115, 150, 12],
  setPartner: [177, 250, 113, 16, 75, 175, 141, 136],
  partnerTiersVersion: [189, 128, 102, 138, 53, 239, 157, 14],
  PartnerConfig: [212, 110, 106, 253, 66, 131, 77, 96],
};

// sha256("event:<Name>")[0..8] and field layouts (32-byte keys or little-endian u64s after the
// discriminator). Trade events carry post-trade state: `virtualQuote` is virtual + real quote and
// `tokenReserve` is virtual token reserve, so price = virtualQuote / tokenReserve.
export const EVENTS = {
  CurveLaunched: { discriminator: [202, 20, 128, 231, 162, 180, 61, 53], fields: [['creator', 'key'], ['mint', 'key'], ['pool', 'key'], ['quoteIn', 'u64'], ['tokensOut', 'u64'], ['fee', 'u64'], ['realQuote', 'u64'], ['virtualQuote', 'u64'], ['tokenReserve', 'u64'], ['sold', 'u64']] },
  CurveBought: { discriminator: [129, 151, 113, 106, 27, 8, 15, 125], fields: [['pool', 'key'], ['buyer', 'key'], ['quoteIn', 'u64'], ['tokensOut', 'u64'], ['fee', 'u64'], ['antiSnipeFee', 'u64'], ['realQuote', 'u64'], ['virtualQuote', 'u64'], ['tokenReserve', 'u64'], ['sold', 'u64']] },
  CurveSold: { discriminator: [212, 236, 101, 124, 18, 87, 130, 47], fields: [['pool', 'key'], ['seller', 'key'], ['tokensIn', 'u64'], ['quoteOut', 'u64'], ['fee', 'u64'], ['antiSnipeFee', 'u64'], ['realQuote', 'u64'], ['virtualQuote', 'u64'], ['tokenReserve', 'u64'], ['sold', 'u64']] },
  CurveGraduated: { discriminator: [3, 228, 116, 195, 148, 182, 240, 104], fields: [['pool', 'key'], ['mint', 'key'], ['realQuote', 'u64'], ['liquidityBonus', 'u64'], ['lpTokens', 'u64']] },
  FeesWithdrawn: { discriminator: [234, 15, 0, 119, 148, 241, 40, 21], fields: [['pool', 'key'], ['recipient', 'key'], ['amount', 'u64']] },
  CurveMigrated: { discriminator: [73, 99, 54, 46, 71, 35, 47, 242], fields: [['pool', 'key'], ['mint', 'key'], ['pumpPool', 'key'], ['lpMint', 'key'], ['baseAmount', 'u64'], ['quoteAmount', 'u64'], ['lpLocked', 'u64']] },
  // Native repricing by the upgrade authority (the trailing u16 max_creator_buy_bps is not decoded).
  // Leading key/u64 fields only (price is a positive i64, so it decodes as u64; exponent is not decoded).
  PricingConfigSet: { discriminator: [119, 27, 79, 254, 28, 84, 0, 183], fields: [['config', 'key'], ['priceFeed', 'key'], ['feeUsdE6', 'u64'], ['startFdvUsdE6', 'u64'], ['usdcMint', 'key'], ['oraclePrice', 'u64']] },
  LaunchFeePaid: { discriminator: [64, 129, 156, 243, 251, 34, 72, 120], fields: [['mint', 'key'], ['payer', 'key'], ['asset', 'key'], ['amount', 'u64'], ['oraclePrice', 'u64']] },
  CurveConfigUpdated: { discriminator: [15, 223, 121, 188, 171, 123, 126, 224], fields: [['config', 'key'], ['quoteMint', 'key'], ['virtualQuote', 'u64'], ['virtualToken', 'u64'], ['curveSupply', 'u64'], ['launchFee', 'u64']] },
  // D7 escape hatch. graduatedAt / reopenedAt are positive i64 timestamps, decoded as u64.
  CurveReopened: { discriminator: [134, 18, 70, 177, 37, 255, 73, 7], fields: [['pool', 'key'], ['mint', 'key'], ['graduatedAt', 'u64'], ['reopenedAt', 'u64'], ['realQuote', 'u64'], ['liquidityBonus', 'u64']] },
  // protocolBase / protocolQuote are what the treasury received; on partner pools the burn share is in PartnerHarvest.
  LpFeesHarvested: { discriminator: [230, 156, 123, 178, 68, 124, 167, 67], fields: [['pool', 'key'], ['pumpPool', 'key'], ['lpBurned', 'u64'], ['baseOut', 'u64'], ['quoteOut', 'u64'], ['protocolBase', 'u64'], ['protocolQuote', 'u64'], ['lpLocked', 'u64']] },
  // Early-partner tiers. expiresAt is a positive i64 (0 when a tier is ended), decoded as u64.
  PartnerSet: { discriminator: [153, 179, 203, 80, 133, 150, 149, 194], fields: [['creator', 'key'], ['buybackBps', 'u16'], ['expiresAt', 'u64']] },
  PartnerPoolLaunched: { discriminator: [33, 177, 188, 7, 46, 3, 61, 253], fields: [['pool', 'key'], ['mint', 'key'], ['creator', 'key'], ['buybackBps', 'u16']] },
  PartnerBuyback: { discriminator: [74, 130, 136, 217, 209, 39, 171, 220], fields: [['pool', 'key'], ['quoteIn', 'u64'], ['tokensBurned', 'u64'], ['totalBurned', 'u64']] },
  PartnerHarvest: { discriminator: [115, 237, 236, 148, 151, 13, 153, 2], fields: [['pool', 'key'], ['baseBurned', 'u64'], ['quoteQueued', 'u64'], ['pendingBuyback', 'u64']] },
};

// Events of the first deployed program version (locked-pool model), still present in devnet history.
// Decoded with `legacy: true`; fields beyond what an old event carries are left undefined.
export const LEGACY_EVENTS = {
  Launched: { discriminator: [209, 127, 29, 152, 129, 212, 189, 183], fields: [['creator', 'key'], ['mint', 'key'], ['pool', 'key'], ['seedQuote', 'u64'], ['firstBuy', 'u64'], ['tokensOut', 'u64'], ['fee', 'u64'], ['quoteReserve', 'u64'], ['tokenReserve', 'u64']] },
  Bought: { discriminator: [193, 56, 215, 24, 156, 76, 42, 104], fields: [['pool', 'key'], ['buyer', 'key'], ['quoteIn', 'u64'], ['tokensOut', 'u64'], ['fee', 'u64'], ['quoteReserve', 'u64'], ['tokenReserve', 'u64'], ['sold', 'u64']] },
  Sold: { discriminator: [205, 203, 210, 202, 96, 11, 192, 10], fields: [['pool', 'key'], ['seller', 'key'], ['tokensIn', 'u64'], ['quoteOut', 'u64'], ['fee', 'u64'], ['quoteReserve', 'u64'], ['tokenReserve', 'u64'], ['sold', 'u64']] },
  LiquidityLocked: { discriminator: [150, 201, 204, 183, 217, 13, 119, 185], fields: [['pool', 'key'], ['quoteAmount', 'u64'], ['tokenAmount', 'u64']] },
};

const base64Bytes = text => (globalThis.Buffer ? new Uint8Array(globalThis.Buffer.from(text, 'base64')) : Uint8Array.from(atob(text), c => c.charCodeAt(0)));

/**
 * Decodes Elpida events from a transaction's log messages ("Program data: <base64>" lines).
 * Keys are returned as base58 strings (pass web3's PublicKey), amounts as BigInt. Trade events get
 * `price` in quote base units per token base unit (equal to whole USDC per whole token at 6/6 decimals).
 */
export function decodeEvents(logs, PublicKey) {
  const events = [];
  const all = [...Object.entries(EVENTS).map(([name, spec]) => [name, spec, false]), ...Object.entries(LEGACY_EVENTS).map(([name, spec]) => [name, spec, true])];
  for (const line of logs ?? []) {
    if (!line.startsWith('Program data: ')) continue;
    const bytes = base64Bytes(line.slice('Program data: '.length));
    for (const [name, { discriminator, fields }, legacy] of all) {
      if (!discriminator.every((byte, i) => bytes[i] === byte)) continue;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const event = { name };
      if (legacy) event.legacy = true;
      let offset = 8;
      for (const [field, type] of fields) {
        const size = type === 'key' ? 32 : type === 'u16' ? 2 : 8;
        if (offset + size > bytes.length) { event.legacy = true; break; }
        if (type === 'key') event[field] = new PublicKey(bytes.subarray(offset, offset + 32)).toBase58();
        else if (type === 'u16') event[field] = view.getUint16(offset, true);
        else event[field] = view.getBigUint64(offset, true);
        offset += size;
      }
      const quoteSide = event.virtualQuote ?? event.quoteReserve;
      if (quoteSide !== undefined && event.tokenReserve > 0n) event.price = Number(quoteSide) / Number(event.tokenReserve);
      events.push(event);
    }
  }
  return events;
}

// Anchor custom errors start at 6000, in the order of `ElpidaError`.
export const PROGRAM_ERRORS = [
  'Only the program upgrade authority can initialize.',
  'Quote token must have 6 to 9 decimals.',
  'Name must be 1–32 bytes.',
  'Symbol must be 1–10 uppercase letters or digits.',
  'Invalid curve parameters.',
  'A positive buy is required.',
  'A creator reward wallet is required.',
  'Price moved beyond your slippage limit.',
  'Buy is too small.',
  'Invalid sell amount.',
  'Sell is too small.',
  'Sell exceeds what the curve holds.',
  'This curve is complete. Trading continues on PumpSwap after migration.',
  'The creator first buy exceeds the allowed share of supply.',
  'This pool belongs to a different config.',
  'Math overflow.',
  'The curve is not complete yet.',
  'This token has not migrated to PumpSwap yet.',
  'No trading fees to harvest yet.',
  'Unexpected PumpSwap account.',
  'Harvest would reduce the locked liquidity.',
  'This token cannot be a trading pair: PumpSwap or the curve cannot handle its token extensions (for example a transfer fee or an issuer permanent delegate, as xStocks have).',
  'This instruction exists only on test networks.',
  'Launches are invite-only during the beta. Ask the Elpida team to add your wallet.',
  'The fee schedule of an existing pair cannot change, because live pools read it on every trade.',
  'The SOL/USD price is unavailable right now, or the wrong price account was used. Try again shortly.',
  'The SOL/USD price is too old to price the $10 fee. Try again in a moment.',
  'The SOL/USD price is too uncertain right now (market moving fast). Try again shortly.',
  'The $10 fee in SOL rose above the amount you approved because the price moved. Refresh the quote and confirm again.',
  'Paying the fee in USDC is not available for this pair.',
  'Token details must be published to IPFS first (an ipfs:// link of at most 200 characters). No launch was submitted.',
  'This curve can be reopened only 24 hours after it completed without migrating.',
  'Partner tiers are 10% or 20% with an expiry at most 180 days ahead, or (0, 0) to end one.',
];

/** Turns a Solana/Anchor error into a readable message. */
export function explainError(error) {
  const text = `${error?.message ?? error ?? ''} ${(error?.logs ?? []).join(' ')}`;
  const hex = text.match(/custom program error: 0x([0-9a-f]+)/i);
  const code = hex ? parseInt(hex[1], 16) : Number(text.match(/"Custom":(\d+)/)?.[1]);
  if (code >= 6000 && PROGRAM_ERRORS[code - 6000]) return PROGRAM_ERRORS[code - 6000];
  if (/insufficient (funds|lamports)|0x1\b/i.test(text)) return 'Not enough balance for this transaction (the pair asset or SOL for network fees).';
  if (/0x43\b|paused/i.test(text)) return 'The issuer of this pair asset has paused transfers. Try again later.';
  if (/User rejected|rejected the request/i.test(text)) return 'You cancelled the wallet request. Nothing was submitted.';
  return error?.message ?? String(error);
}

/** Parses a decimal string into base units, truncating digits beyond `decimals`. */
export function parseAmount(value, decimals, allowZero = false) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,18}(\.\d*)?$/.test(text)) throw new Error('Enter a valid positive amount.');
  const [whole, fraction = ''] = text.split('.');
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction.slice(0, decimals) || '0').padEnd(decimals, '0'));
  if (units < 0n || (!allowZero && units === 0n)) throw new Error('Amount must be greater than zero.');
  return units;
}

export function formatAmount(units, decimals) {
  const value = BigInt(units);
  const base = 10n ** BigInt(decimals);
  const fraction = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${value / base}.${fraction || '0'}`;
}


/**
 * On-chain `CurveParams` for a launch that starts at `startFdv` and graduates at `endFdv` (whole quote
 * units, decimals allowed, e.g. "0.5" SOL). With m = endFdv/startFdv the virtual token reserve is
 * S·m/(m−1), so the tokens left after the curve sells out exactly pair with the raised quote at the
 * graduation price on the DEX. `launchFee` is the creation fee in whole quote units (default 10).
 */
export function curveParams({ startFdv = DEFAULT_CURVE.startFdv, endFdv = DEFAULT_CURVE.endFdv, quoteDecimals = 9, launchFee = DEFAULT_CURVE.launchFee, baseFeeBps = DEFAULT_CURVE.baseFeeBps, snipeStartBps = DEFAULT_CURVE.snipeStartBps, snipeWindowSecs = DEFAULT_CURVE.snipeWindowSecs, maxCreatorBuyBps = DEFAULT_CURVE.maxCreatorBuyBps } = {}) {
  const start = parseAmount(startFdv, quoteDecimals);
  const end = parseAmount(endFdv, quoteDecimals);
  if (start <= 0n || end <= start) throw new Error('endFdv must be greater than startFdv > 0.');
  const virtualToken = TOKEN_SUPPLY * end / (end - start);
  const remainingAtEnd = isqrt(virtualToken * virtualToken * start / end); // Vt / √m
  const curveSupply = virtualToken - remainingAtEnd;
  const virtualQuote = (start * virtualToken + TOKEN_SUPPLY - 1n) / TOKEN_SUPPLY;
  // The creation fee is always charged in SOL, so it is encoded in lamports whatever the pair.
  const fee = Number(launchFee) === 0 ? 0n : parseAmount(launchFee, 9);
  return { virtualQuote, virtualToken, curveSupply, baseFeeBps, snipeStartBps, snipeWindowSecs, maxCreatorBuyBps, launchFee: fee };
}

/**
 * Parses a Pyth PriceUpdateV2 account (verification must be Full). Returns null when it is not one.
 * Mirrors `read_price`, so the browser can show the conversion the program will apply.
 */
export function parsePriceUpdate(raw) {
  const bytes = raw ? new Uint8Array(raw) : null;
  if (!bytes || bytes.length < 101 || !DISCRIMINATORS.PriceUpdateV2.every((b, i) => bytes[i] === b) || bytes[40] !== 1) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hex = [...bytes.subarray(41, 73)].map(b => b.toString(16).padStart(2, '0')).join('');
  return { feedId: hex, price: view.getBigInt64(73, true), conf: view.getBigUint64(81, true), exponent: view.getInt32(89, true), publishTime: Number(view.getBigInt64(93, true)) };
}
/** USD (6 decimals) to quote base units at an oracle price, rounded up like the program's `usd_to_quote`. */
export function usdToQuote(usdE6, { price, exponent }, decimals = 9) {
  const num = BigInt(usdE6) * 10n ** BigInt(decimals - exponent), den = BigInt(price) * 1_000_000n;
  return (num + den - 1n) / den;
}
/** Oracle-sized virtual SOL reserve for a $startFdv curve: ceil(fdvLamports x virtualToken / supply). */
export function virtualQuoteForFdv(startFdvUsdE6, oracle, virtualToken) {
  const fdv = usdToQuote(startFdvUsdE6, oracle, 9);
  return (fdv * BigInt(virtualToken) + TOKEN_SUPPLY - 1n) / TOKEN_SUPPLY;
}

/** Mirrors `current_fee_bps`: linear decay from the snipe fee at launch to the base fee. Times in seconds. */
export function currentFeeBps(config, createdAt, now) {
  const base = BigInt(config.baseFeeBps);
  const window = BigInt(config.snipeWindowSecs);
  let elapsed = BigInt(now) - BigInt(createdAt);
  if (elapsed < 0n) elapsed = 0n;
  if (window === 0n || elapsed >= window) return base;
  return base + (BigInt(config.snipeStartBps) - base) * (window - elapsed) / window;
}

function fees(gross, feeBps, baseFeeBps) {
  const fee = gross * feeBps / BPS;
  let base = gross * baseFeeBps / BPS;
  if (base > fee) base = fee;
  return { fee, baseFee: base, surplus: fee - base };
}

/**
 * Mirrors `quote_buy`. `pool` is a decoded CurvePool. The final buy is partially filled: `gross` may
 * be less than `grossIn`, and `graduates` is true when it takes the rest of the curve supply.
 */
export function quoteBuy(pool, grossIn, feeBps, baseFeeBps = feeBps) {
  grossIn = BigInt(grossIn); feeBps = BigInt(feeBps); baseFeeBps = BigInt(baseFeeBps);
  if (grossIn <= 0n) throw new Error('A positive buy is required.');
  if (pool.status !== undefined && pool.status !== STATUS_TRADING) throw new Error(PROGRAM_ERRORS[12]);
  const avail = pool.virtualToken - pool.sold;
  const quoteSide = pool.virtualQuote + pool.realQuote;
  const remaining = pool.curveSupply - pool.sold;
  let gross = grossIn;
  let f = fees(gross, feeBps, baseFeeBps);
  let net = gross - f.fee;
  let tokens = avail * net / (quoteSide + net);
  let graduates = false;
  if (tokens >= remaining) {
    const netNeeded = (remaining * quoteSide + (avail - remaining) - 1n) / (avail - remaining);
    const grossNeeded = (netNeeded * BPS + (BPS - feeBps) - 1n) / (BPS - feeBps);
    gross = grossNeeded < grossIn ? grossNeeded : grossIn;
    f = fees(gross, feeBps, baseFeeBps);
    net = gross - f.fee;
    tokens = remaining;
    graduates = true;
  }
  if (tokens <= 0n) throw new Error('Buy is too small.');
  return { gross, net, out: tokens, tokens, fee: f.fee, baseFee: f.baseFee, antiSnipeFee: f.surplus, graduates };
}

/** Mirrors `quote_sell`. */
export function quoteSell(pool, tokensIn, feeBps, baseFeeBps = feeBps) {
  tokensIn = BigInt(tokensIn); feeBps = BigInt(feeBps); baseFeeBps = BigInt(baseFeeBps);
  if (pool.status !== undefined && pool.status !== STATUS_TRADING) throw new Error(PROGRAM_ERRORS[12]);
  if (tokensIn <= 0n || tokensIn > pool.sold) throw new Error('Invalid sell amount.');
  const avail = pool.virtualToken - pool.sold;
  const quoteSide = pool.virtualQuote + pool.realQuote;
  const gross = quoteSide * tokensIn / (avail + tokensIn);
  if (gross > pool.realQuote) throw new Error('Sell exceeds what the curve holds.');
  const f = fees(gross, feeBps, baseFeeBps);
  const net = gross - f.fee;
  if (net <= 0n) throw new Error('Sell is too small.');
  return { gross, net, out: net, tokens: tokensIn, fee: f.fee, baseFee: f.baseFee, antiSnipeFee: f.surplus, graduates: false };
}

/** Market data derived from a decoded pool (amounts in base units; price and FDV as Numbers in quote units). */
export function poolStats(pool, quoteDecimals = 6) {
  const tokenReserve = pool.virtualToken - pool.sold;
  const quoteSide = pool.virtualQuote + pool.realQuote;
  const scale = 10 ** (TOKEN_DECIMALS - quoteDecimals);
  const price = Number(quoteSide) / Number(tokenReserve) * scale; // quote per whole token
  return {
    price,
    marketCap: price * Number(TOKEN_SUPPLY) / 10 ** TOKEN_DECIMALS,
    progress: Number(pool.sold) / Number(pool.curveSupply),
    graduated: pool.status === STATUS_GRADUATED,
    tokensLeftOnCurve: pool.curveSupply - pool.sold,
    lockedLiquidity: pool.realQuote + pool.liquidityBonus,
  };
}

export const isqrt = n => {
  n = BigInt(n);
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) { const y = (x + n / x) / 2n; if (y >= x) return x; x = y; }
};
/** Mirrors `liquidity_units`: lp / lpSupply * sqrt(base * quote). */
export const liquidityUnits = (lp, { lpSupply, base, quote }) => BigInt(lp) * isqrt(BigInt(base) * BigInt(quote)) / BigInt(lpSupply);
/** Mirrors `harvestable_lp`: LP above what keeps `principal` liquidity units locked. */
export function harvestableLp(lp, principal, { lpSupply, base, quote }) {
  const root = isqrt(BigInt(base) * BigInt(quote));
  if (root === 0n) return 0n;
  const keep = (BigInt(principal) * BigInt(lpSupply) + root - 1n) / root + 2n; // HARVEST_MARGIN_LP
  return BigInt(lp) > keep ? BigInt(lp) - keep : 0n;
}
/** LP a `harvest_lp_fees` call would withdraw now: 0 below the program's 0.01%-of-position minimum. */
export function harvestNow(lp, principal, state) {
  const h = harvestableLp(lp, principal, state);
  return h > 0n && h * 10_000n >= BigInt(lp) ? h : 0n;
}
/** Base and quote a harvest of `lp` LP tokens pays out (PumpSwap withdraw rounding). */
export const withdrawOut = (lp, { lpSupply, base, quote }) => ({ base: BigInt(base) * BigInt(lp) / BigInt(lpSupply), quote: BigInt(quote) * BigInt(lp) / BigInt(lpSupply) });

const u16 = value => { const bytes = new Uint8Array(2); new DataView(bytes.buffer).setUint16(0, Number(value), true); return bytes; };
const u32 = value => { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, Number(value), true); return bytes; };
const u64 = value => { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true); return bytes; };
const str = value => { const bytes = new TextEncoder().encode(value); return concat(u32(bytes.length), bytes); };
const view = data => new DataView(data.buffer, data.byteOffset, data.byteLength);
const readU64 = (data, offset) => view(data).getBigUint64(offset, true);
const readI64 = (data, offset) => view(data).getBigInt64(offset, true);
const readU16 = (data, offset) => view(data).getUint16(offset, true);
const readU32 = (data, offset) => view(data).getUint32(offset, true);
const readU128 = (data, offset) => readU64(data, offset) + (readU64(data, offset + 8) << 64n);
const readOptU64 = (data, offset) => (data.length >= offset + 8 ? readU64(data, offset) : 0n);
const text = bytes => new TextDecoder().decode(bytes.subarray(0, bytes.indexOf(0) === -1 ? bytes.length : bytes.indexOf(0)));
export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
const sameBytes = (data, expected) => expected.every((byte, i) => data[i] === byte);
export const encodeCurveParams = p => concat(u64(p.virtualQuote), u64(p.virtualToken), u64(p.curveSupply), u16(p.baseFeeBps), u16(p.snipeStartBps), u32(p.snipeWindowSecs), u16(p.maxCreatorBuyBps), u64(p.launchFee ?? 0n));

export function createElpidaSolana(web3, programIdInput) {
  const { PublicKey, TransactionInstruction, SystemProgram, ComputeBudgetProgram, Transaction, Keypair } = web3;
  const programId = new PublicKey(programIdInput);
  const tokenProgram = new PublicKey(TOKEN_PROGRAM);
  const ataProgram = new PublicKey(ATA_PROGRAM);
  const loader = new PublicKey(LOADER_V3);
  // web3.js v1 expects Buffer instruction data in Node; the browser bundle accepts Uint8Array.
  const data = bytes => (globalThis.Buffer ? globalThis.Buffer.from(bytes) : bytes);
  const key = value => (value instanceof PublicKey ? value : new PublicKey(value));
  const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey: key(pubkey), isWritable, isSigner });
  const ix = (keys, bytes) => new TransactionInstruction({ programId, keys, data: data(bytes) });
  const enc = value => new TextEncoder().encode(value);

  // `configPda` is the default config; extra configs (one per quote mint) live at ["curve-config", quote_mint].
  // Builders take `config.address` (falls back to the default) plus its quoteMint / treasury.
  const configPda = PublicKey.findProgramAddressSync([enc('curve-config')], programId)[0];
  const configFor = quoteMint => PublicKey.findProgramAddressSync([enc('curve-config'), key(quoteMint).toBytes()], programId)[0];
  const testUsdcMint = PublicKey.findProgramAddressSync([enc('test-usdc')], programId)[0];
  const faucetAuthority = PublicKey.findProgramAddressSync([enc('test-usdc-authority')], programId)[0];
  const poolPda = mint => PublicKey.findProgramAddressSync([enc('curve'), key(mint).toBytes()], programId)[0];
  const ata = (owner, mint, program = tokenProgram) => PublicKey.findProgramAddressSync([key(owner).toBytes(), key(program).toBytes(), key(mint).toBytes()], ataProgram)[0];
  /** The quote mint's token program for a config (`quoteTokenProgram`, default SPL Token). */
  const qp = config => key(config.quoteTokenProgram ?? tokenProgram);
  const qata = (owner, config) => ata(owner, config.quoteMint, qp(config));
  const wsol = new PublicKey(WSOL_MINT);
  const programDataAddress = PublicKey.findProgramAddressSync([programId.toBytes()], loader)[0];
  const programs = [meta(tokenProgram), meta(ataProgram), meta(SystemProgram.programId)];
  const pumpProgram = new PublicKey(PUMP_AMM_PROGRAM);
  const token2022 = new PublicKey(TOKEN_2022_PROGRAM);
  const lpAuthorityPda = mint => PublicKey.findProgramAddressSync([enc('pump-lp'), key(mint).toBytes()], programId)[0];
  const betaGatePda = PublicKey.findProgramAddressSync([enc('beta-gate')], programId)[0];
  const mplProgram = new PublicKey(MPL_TOKEN_METADATA);
  const metadataPda = mint => PublicKey.findProgramAddressSync([enc('metadata'), mplProgram.toBytes(), key(mint).toBytes()], mplProgram)[0];
  const betaCreatorPda = creator => PublicKey.findProgramAddressSync([enc('beta-creator'), key(creator).toBytes()], programId)[0];
  const pricingPda = config => PublicKey.findProgramAddressSync([enc('pricing'), key(config).toBytes()], programId)[0];
  const migrationPda = mint => PublicKey.findProgramAddressSync([enc('pump-migration'), key(mint).toBytes()], programId)[0];
  const partnerPda = creator => PublicKey.findProgramAddressSync([enc('partner'), key(creator).toBytes()], programId)[0];
  const ataWith = (owner, mint, program) => PublicKey.findProgramAddressSync([key(owner).toBytes(), key(program).toBytes(), key(mint).toBytes()], ataProgram)[0];
  /** PumpSwap accounts for the pool Elpida creates for `mint` (index 0, creator = LP-authority PDA). */
  const pumpAccounts = (mint, quoteMint, quoteProgram = tokenProgram) => {
    const authority = lpAuthorityPda(mint);
    const pool = PublicKey.findProgramAddressSync([enc('pool'), new Uint8Array([0, 0]), authority.toBytes(), key(mint).toBytes(), key(quoteMint).toBytes()], pumpProgram)[0];
    const lpMint = PublicKey.findProgramAddressSync([enc('pool_lp_mint'), pool.toBytes()], pumpProgram)[0];
    return {
      lpAuthority: authority, pool, lpMint, poolBase: ata(pool, mint), poolQuote: ata(pool, quoteMint, quoteProgram),
      authorityBase: ata(authority, mint), authorityQuote: ata(authority, quoteMint, quoteProgram), authorityLp: ataWith(authority, lpMint, token2022),
    };
  };
  const pumpFixed = [meta(PUMP_EVENT_AUTHORITY), meta(pumpProgram)];
  const trade = (trader, config, mint, bytes) => {
    const pool = poolPda(mint);
    // The mint is writable so partner pools can burn their buyback (older programs accept it too).
    return ix([meta(trader, true, true), meta(config.address ?? configPda), meta(config.quoteMint), meta(mint, true), meta(pool, true), meta(ata(pool, mint), true), meta(qata(pool, config), true), meta(qata(trader, config), true), meta(ata(trader, mint), true), meta(tokenProgram), meta(qp(config)), meta(ataProgram), meta(SystemProgram.programId)], bytes);
  };

  return {
    programId, configPda, configFor, partnerPda, betaGatePda, metadataPda, betaCreatorPda, pricingPda, testUsdcMint, faucetAuthority, poolPda, ata, quoteAta: qata, programDataAddress, tokenProgram, token2022, ataProgram, lpAuthorityPda, migrationPda, pumpAccounts, wsol,
    computeBudget: (units = LAUNCH_COMPUTE_UNITS) => ComputeBudgetProgram.setComputeUnitLimit({ units }),
    createAtaIdempotent(payer, owner, mint, program = tokenProgram) {
      return new TransactionInstruction({ programId: ataProgram, data: data([1]), keys: [meta(payer, true, true), meta(ata(owner, mint, program), true), meta(owner), meta(mint), meta(SystemProgram.programId), meta(program)] });
    },
    /** Wraps `lamports` SOL into the owner's wrapped-SOL account (created if missing). */
    wrapSol(owner, lamports) {
      const account = ata(owner, wsol);
      return [this.createAtaIdempotent(owner, owner, wsol), SystemProgram.transfer({ fromPubkey: key(owner), toPubkey: account, lamports: BigInt(lamports) }),
        new TransactionInstruction({ programId: tokenProgram, data: data([17]), keys: [meta(account, true)] })];
    },
    /** Closes the owner's wrapped-SOL account, returning all of it to the wallet as SOL. */
    unwrapSol(owner) {
      return new TransactionInstruction({ programId: tokenProgram, data: data([9]), keys: [meta(ata(owner, wsol), true), meta(owner, true), meta(owner, false, true)] });
    },
    initializeCurve({ authority, quoteMint, treasury, params = curveParams(), quoteTokenProgram = tokenProgram }) {
      return ix([meta(authority, true, true), meta(configPda, true), meta(quoteMint), meta(treasury), meta(ata(treasury, quoteMint, quoteTokenProgram), true), meta(programId), meta(programDataAddress), meta(quoteTokenProgram), meta(ataProgram), meta(SystemProgram.programId)],
        concat(DISCRIMINATORS.initializeCurve, encodeCurveParams(params)));
    },
    addCurveConfig({ authority, quoteMint, treasury, params = curveParams(), quoteTokenProgram = tokenProgram }) {
      return ix([meta(authority, true, true), meta(configFor(quoteMint), true), meta(quoteMint), meta(treasury), meta(ata(treasury, quoteMint, quoteTokenProgram), true), meta(programId), meta(programDataAddress), meta(quoteTokenProgram), meta(ataProgram), meta(SystemProgram.programId)],
        concat(DISCRIMINATORS.addCurveConfig, encodeCurveParams(params)));
    },
    /** Test networks only: creates the Elpida tUSDC mint (upgrade authority). */
    createTestUsdc({ authority }) {
      return ix([meta(authority, true, true), meta(testUsdcMint, true), meta(faucetAuthority), meta(programId), meta(programDataAddress), meta(tokenProgram), meta(SystemProgram.programId)], DISCRIMINATORS.createTestUsdc);
    },
    /** Test networks only: mints a test asset whose mint authority is the faucet PDA (default: 25,000 tUSDC). */
    testUsdcFaucet({ user, amount = TEST_USDC_FAUCET_MAX, mint = testUsdcMint, tokenProgram: program = tokenProgram }) {
      return ix([meta(user, true, true), meta(mint, true), meta(faucetAuthority), meta(ata(user, mint, program), true), meta(program), meta(ataProgram), meta(SystemProgram.programId)], concat(DISCRIMINATORS.testUsdcFaucet, u64(amount)));
    },
    /**
     * `priceUpdate`: the Pyth account bound in the config's pricing (omit when pricing is off).
     * `maxFee`: lamport cap for the SOL fee (quote plus a margin). `usdc`: { mint, tokenProgram } to pay the
     * USD fee in USDC from the creator's associated account to the treasury's.
     */
    /**
     * `uri`: the IPFS metadata document, written into immutable Metaplex metadata by the current program.
     * `legacy: true` builds the pre-metadata layout (no uri, no Metaplex accounts) for programs that have
     * not been upgraded yet; see `supportsMetadata` in the browser wallet.
     */
    /** `partnerTiers` (default: any non-legacy launch): the program has partner tiers (see `supportsPartnerTiers`); adds the creator's `partner` account. */
    launch({ creator, config, mint, name, symbol, firstBuy, minTokensOut, reward, uri, legacy = false, priceUpdate = null, maxFee = (1n << 64n) - 1n, usdc = null, partnerTiers = !legacy }) {
      if (legacy && partnerTiers) throw new Error('A program with partner tiers always takes token metadata.');
      if (!legacy && (!validMetadataUri(uri) || uri.length > MAX_LAUNCH_URI)) throw new Error(PROGRAM_ERRORS[30]);
      const pool = poolPda(mint), cfg = config.address ?? configPda;
      const usdcMetas = usdc ? [meta(usdc.mint), meta(ata(creator, usdc.mint, usdc.tokenProgram ?? tokenProgram), true), meta(ata(config.treasury, usdc.mint, usdc.tokenProgram ?? tokenProgram), true), meta(usdc.tokenProgram ?? tokenProgram)] : [];
      return ix([
        meta(creator, true, true), meta(config.address ?? configPda), meta(config.quoteMint), meta(config.treasury, true),
        meta(mint, true, true), meta(pool, true), meta(ata(pool, mint), true), meta(qata(pool, config), true),
        meta(qata(creator, config), true), meta(ata(creator, mint), true), meta(tokenProgram), meta(qp(config)), meta(ataProgram), meta(SystemProgram.programId),
        meta(betaGatePda), meta(betaCreatorPda(creator)), meta(pricingPda(cfg)), meta(priceUpdate ?? SystemProgram.programId),
        // Partner-tier programs take the creator's partner record where earlier ones took the rent sysvar.
        ...(legacy ? [] : [meta(metadataPda(mint), true), meta(mplProgram), partnerTiers ? meta(partnerPda(creator)) : meta(SYSVAR_RENT)]), ...usdcMetas,
      ], concat(DISCRIMINATORS.launch, str(name), str(symbol), u64(firstBuy), u64(minTokensOut), key(reward).toBytes(), u64(maxFee), [usdc ? 1 : 0], ...(legacy ? [] : [str(uri)])));
    },
    /**
     * Whether the deployed program has the D7/D11 upgrade (reopen_curve, Metaplex metadata at launch).
     * Simulates reopen_curve on an empty pool address: an upgraded program fails on the missing account,
     * an older one with InstructionFallbackNotFound (Anchor error 101).
     */
    async supportsMetadata(connection, feePayer) {
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      const probe = new Transaction({ feePayer: key(feePayer), recentBlockhash: blockhash }).add(this.reopenCurve({ mint: Keypair.generate().publicKey }));
      const { value } = await connection.simulateTransaction(probe);
      const logs = (value.logs ?? []).join(' ');
      // Positive evidence either way; anything else (for example an unfunded fee payer) is not an answer.
      if (/Instruction: ReopenCurve/.test(logs)) return true;
      if (value.err?.InstructionError?.[1]?.Custom === 101 || /InstructionFallbackNotFound|Fallback functions are not supported/i.test(logs)) return false;
      throw new Error('Could not check this network\'s Elpida program version (your wallet may need SOL for network fees). Nothing was submitted.');
    },
    async supportsOptionalBuy(connection, feePayer) {
      const {blockhash}=await connection.getLatestBlockhash('confirmed');
      const probe=new Transaction({feePayer:key(feePayer),recentBlockhash:blockhash}).add(ix([],new Uint8Array([63,214,46,20,82,115,180,91])));
      const {value}=await connection.simulateTransaction(probe);
      if(value.err===null)return true;
      if(value.err?.InstructionError?.[1]?.Custom===101)return false;
      throw new Error('Could not check optional creator buy support. Nothing was submitted.');
    },
    /** Whether the deployed program has early-partner tiers (simulates the empty `partner_tiers_version`). */
    async supportsPartnerTiers(connection, feePayer) {
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      const probe = new Transaction({ feePayer: key(feePayer), recentBlockhash: blockhash }).add(ix([], DISCRIMINATORS.partnerTiersVersion));
      const { value } = await connection.simulateTransaction(probe);
      if (value.err === null) return true;
      if (value.err?.InstructionError?.[1]?.Custom === 101) return false;
      throw new Error('Could not check this network\'s Elpida program version (your wallet may need SOL for network fees). Nothing was submitted.');
    },
    /**
     * The SOL pair's treasury registers `creator` for a tier: `buybackBps` 1000 (Partner) or 2000 (Elite) until
     * `expiresAt` (unix seconds, at most 180 days ahead), or (0, 0) to end it. Future launches only.
     */
    setPartner({ authority, creator, buybackBps, expiresAt }) {
      const i64 = value => { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigInt64(0, BigInt(value), true); return bytes; };
      return ix([meta(authority, true, true), meta(configFor(wsol)), meta(partnerPda(creator), true), meta(SystemProgram.programId)],
        concat(DISCRIMINATORS.setPartner, key(creator).toBytes(), u16(buybackBps), i64(expiresAt)));
    },
    /** A partner record, or null when the bytes are not one. `live` is true while it holds a tier that has not expired at `now`. */
    decodePartner(raw, now = Math.floor(Date.now() / 1000)) {
      const bytes = raw ? new Uint8Array(raw) : null;
      if (!bytes || bytes.length < 8 + 32 + 2 + 8 + 1 || !sameBytes(bytes, DISCRIMINATORS.PartnerConfig)) return null;
      const buybackBps = readU16(bytes, 40), expiresAt = Number(readI64(bytes, 42));
      return { creator: new PublicKey(bytes.subarray(8, 40)), buybackBps, expiresAt, live: PARTNER_BPS.includes(buybackBps) && expiresAt > now };
    },
    /** Permissionless D7 escape hatch: reopens a curve that completed GRADUATION_GRACE_SECS ago without migrating. */
    reopenCurve: ({ mint }) => ix([meta(poolPda(mint), true)], DISCRIMINATORS.reopenCurve),
    /** Upgrade authority: reprices a config for future launches. The fee schedule must stay the same. */
    /** Upgrade authority: oracle pricing for a config, bound to `priceUpdate` (a Pyth PriceUpdateV2 account). */
    setPricing({ authority, config, priceUpdate, feedId = SOL_USD_FEED_ID, maxAgeSecs = USD_PRICING.maxAgeSecs, maxConfBps = USD_PRICING.maxConfBps, feeUsdE6 = USD_PRICING.feeUsdE6, startFdvUsdE6 = USD_PRICING.startFdvUsdE6, usdcMint = null }) {
      const feed = Uint8Array.from(String(feedId).replace(/^0x/, '').match(/../g).map(b => parseInt(b, 16)));
      if (feed.length !== 32) throw new Error('feedId must be 32 bytes of hex.');
      return ix([meta(authority, true, true), meta(config), meta(pricingPda(config), true), meta(priceUpdate), meta(programId), meta(programDataAddress), meta(SystemProgram.programId)],
        concat(DISCRIMINATORS.setPricing, feed, u32(maxAgeSecs), u16(maxConfBps), u64(feeUsdE6), u64(startFdvUsdE6), key(usdcMint ?? PublicKey.default).toBytes()));
    },
    /** Decodes a PricingConfig account, or null when the bytes are not one. */
    decodePricing(raw) {
      const bytes = raw ? new Uint8Array(raw) : null;
      if (!bytes || bytes.length < 8 + 32 + 32 + 32 + 4 + 2 + 8 + 8 + 32 + 1 || !sameBytes(bytes, DISCRIMINATORS.PricingConfig)) return null;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return { config: new PublicKey(bytes.subarray(8, 40)), priceFeed: new PublicKey(bytes.subarray(40, 72)), feedId: [...bytes.subarray(72, 104)].map(b => b.toString(16).padStart(2, '0')).join(''),
        maxAgeSecs: view.getUint32(104, true), maxConfBps: view.getUint16(108, true), feeUsdE6: view.getBigUint64(110, true), startFdvUsdE6: view.getBigUint64(118, true), usdcMint: new PublicKey(bytes.subarray(126, 158)) };
    },
    updateCurveConfig({ authority, config = configPda, params }) {
      return ix([meta(authority, false, true), meta(config, true), meta(programId), meta(programDataAddress)], concat(DISCRIMINATORS.updateCurveConfig, encodeCurveParams(params)));
    },
    /** Succeeds only on the test build; the mainnet build fails with TestNetworksOnly (6022). */
    testBuildCheck: () => ix([], DISCRIMINATORS.testBuildCheck),
    /** Upgrade authority: creates or updates the beta gate; `gateAuthority` then manages the allowlist. */
    setBetaGate({ authority, gateAuthority, enabled }) {
      return ix([meta(authority, true, true), meta(betaGatePda, true), meta(programId), meta(programDataAddress), meta(SystemProgram.programId)],
        concat(DISCRIMINATORS.setBetaGate, key(gateAuthority).toBytes(), [enabled ? 1 : 0]));
    },
    allowBetaCreator({ authority, creator }) {
      return ix([meta(authority, true, true), meta(betaGatePda), meta(betaCreatorPda(creator), true), meta(SystemProgram.programId)], concat(DISCRIMINATORS.allowBetaCreator, key(creator).toBytes()));
    },
    revokeBetaCreator({ authority, creator }) {
      return ix([meta(authority, true, true), meta(betaGatePda), meta(betaCreatorPda(creator), true)], DISCRIMINATORS.revokeBetaCreator);
    },
    /** Beta gate state, or null when no gate exists (launches open). */
    decodeBetaGate(raw) {
      if (!raw) return null;
      const bytes = new Uint8Array(raw);
      if (bytes.length < 42 || !sameBytes(bytes, DISCRIMINATORS.BetaGate)) return null;
      return { authority: new PublicKey(bytes.subarray(8, 40)), enabled: bytes[40] === 1 };
    },
    buy: ({ buyer, config, mint, grossIn, minTokensOut }) => trade(buyer, config, mint, concat(DISCRIMINATORS.buy, u64(grossIn), u64(minTokensOut))),
    sell: ({ seller, config, mint, tokensIn, minQuoteOut }) => trade(seller, config, mint, concat(DISCRIMINATORS.sell, u64(tokensIn), u64(minQuoteOut))),
    withdrawFees({ payer, config, mint, reward }) {
      const pool = poolPda(mint);
      return ix([meta(payer, true, true), meta(config.address ?? configPda), meta(config.quoteMint), meta(mint), meta(pool, true), meta(config.treasury), meta(reward), meta(qata(config.treasury, config), true), meta(qata(reward, config), true), meta(qata(pool, config), true), meta(qp(config)), meta(ataProgram), meta(SystemProgram.programId)],
        DISCRIMINATORS.withdrawFees);
    },
    /** Permissionless once the curve is complete; the payer advances ~0.05 SOL rent (most is refunded). */
    migrateToPumpswap({ payer, config, mint }) {
      const pool = poolPda(mint);
      const p = pumpAccounts(mint, config.quoteMint, qp(config));
      return ix([
        meta(payer, true, true), meta(config.address ?? configPda), meta(config.quoteMint), meta(mint), meta(pool, true), meta(ata(pool, mint), true), meta(qata(pool, config), true),
        meta(p.lpAuthority, true), meta(p.authorityBase, true), meta(p.authorityQuote, true), meta(p.authorityLp, true), meta(migrationPda(mint), true),
        meta(p.pool, true), meta(PUMP_GLOBAL_CONFIG), meta(p.lpMint, true), meta(p.poolBase, true), meta(p.poolQuote, true), ...pumpFixed,
        meta(tokenProgram), meta(token2022), meta(qp(config)), meta(ataProgram), meta(SystemProgram.programId),
      ], DISCRIMINATORS.migrateToPumpswap);
    },
    /** Instructions to harvest LP trading fees: idempotent ATA creation for the four destinations, then the harvest. */
    harvestLpFees({ payer, config, mint, reward }) {
      const pool = poolPda(mint);
      const p = pumpAccounts(mint, config.quoteMint, qp(config));
      return [
        this.createAtaIdempotent(payer, config.treasury, mint), this.createAtaIdempotent(payer, reward, mint), this.createAtaIdempotent(payer, reward, config.quoteMint, qp(config)),
        ix([
          meta(payer, true, true), meta(config.address ?? configPda), meta(config.quoteMint), meta(mint, true), meta(pool), meta(migrationPda(mint), true), meta(p.lpAuthority),
          meta(p.authorityBase, true), meta(p.authorityQuote, true), meta(p.authorityLp, true), meta(p.pool, true), meta(PUMP_GLOBAL_CONFIG), meta(p.lpMint, true),
          meta(p.poolBase, true), meta(p.poolQuote, true), meta(config.treasury), meta(reward),
          meta(ata(config.treasury, mint), true), meta(qata(config.treasury, config), true), meta(ata(reward, mint), true), meta(qata(reward, config), true),
          ...pumpFixed, meta(tokenProgram), meta(token2022),
        ], DISCRIMINATORS.harvestLpFees),
      ];
    },
    decodeMigration(raw) {
      const bytes = new Uint8Array(raw);
      if (bytes.length < MIGRATION_SIZE || !sameBytes(bytes, DISCRIMINATORS.PumpMigration)) throw new Error('Not an Elpida migration account.');
      return {
        curvePool: new PublicKey(bytes.subarray(8, 40)), mint: new PublicKey(bytes.subarray(40, 72)), pumpPool: new PublicKey(bytes.subarray(72, 104)), lpMint: new PublicKey(bytes.subarray(104, 136)),
        lpLocked: readU64(bytes, 136), principal: readU128(bytes, 144), baseMigrated: readU64(bytes, 160), quoteMigrated: readU64(bytes, 168),
        harvestedLp: readU64(bytes, 176), harvestedBase: readU64(bytes, 184), harvestedQuote: readU64(bytes, 192), migratedAt: readI64(bytes, 200),
        // Migrations by the partner-tier program: quote queued for buyback and partner burns (0 otherwise).
        ...(bytes.length >= MIGRATION_SIZE + MIGRATION_EXT_LEN && bytes[MIGRATION_SIZE] === 1
          ? { pendingBuyback: readU64(bytes, MIGRATION_SIZE + 1), baseBurned: readU64(bytes, MIGRATION_SIZE + 9), buybackQuoteSpent: readU64(bytes, MIGRATION_SIZE + 17), buybackBurned: readU64(bytes, MIGRATION_SIZE + 25) }
          : { pendingBuyback: 0n, baseBurned: 0n, buybackQuoteSpent: 0n, buybackBurned: 0n }),
      };
    },
    /** PumpSwap `Pool` fields Elpida needs (trailing fields read as 0 when absent). */
    decodePumpPool(raw) {
      const bytes = new Uint8Array(raw);
      return {
        creator: new PublicKey(bytes.subarray(11, 43)), baseMint: new PublicKey(bytes.subarray(43, 75)), quoteMint: new PublicKey(bytes.subarray(75, 107)), lpMint: new PublicKey(bytes.subarray(107, 139)),
        poolBase: new PublicKey(bytes.subarray(139, 171)), poolQuote: new PublicKey(bytes.subarray(171, 203)), lpSupply: readU64(bytes, 203),
        protocolFees: readOptU64(bytes, 271), creatorFees: readOptU64(bytes, 279),
      };
    },
    /** Pool state for harvest math from the PumpSwap pool and its two vault accounts (raw account data). */
    pumpState(poolRaw, baseVaultRaw, quoteVaultRaw) {
      const pool = this.decodePumpPool(poolRaw);
      return { lpSupply: pool.lpSupply, base: this.tokenAmount(baseVaultRaw), quote: this.tokenAmount(quoteVaultRaw) - pool.protocolFees - pool.creatorFees };
    },
    decodeConfig(raw) {
      const bytes = new Uint8Array(raw);
      if (bytes.length < CONFIG_SIZE || !sameBytes(bytes, DISCRIMINATORS.CurveConfig)) throw new Error('Not an Elpida curve config account.');
      return {
        quoteMint: new PublicKey(bytes.subarray(8, 40)), treasury: new PublicKey(bytes.subarray(40, 72)), launchFee: readU64(bytes, 72),
        virtualQuote: readU64(bytes, 80), virtualToken: readU64(bytes, 88), curveSupply: readU64(bytes, 96),
        baseFeeBps: readU16(bytes, 104), snipeStartBps: readU16(bytes, 106), snipeWindowSecs: readU32(bytes, 108), maxCreatorBuyBps: readU16(bytes, 112),
        quoteDecimals: bytes[114], modelVersion: bytes[115],
      };
    },
    isPool: raw => POOL_SIZES.includes(raw.length) && sameBytes(new Uint8Array(raw), DISCRIMINATORS.CurvePool),
    /** Every curve pool of this program, older 260-byte and partner-era 292-byte layouts alike. */
    async poolAccounts(connection, options = {}) {
      const sizes = await Promise.all(POOL_SIZES.map(dataSize => connection.getProgramAccounts(programId, { ...options, filters: [{ dataSize }] })));
      return sizes.flat();
    },
    decodePool(raw) {
      const bytes = new Uint8Array(raw);
      if (!POOL_SIZES.includes(bytes.length) || !sameBytes(bytes, DISCRIMINATORS.CurvePool)) throw new Error('Not an Elpida curve pool account.');
      // Partner-era pools: version byte 1, buyback share, tokens burned and quote spent on buybacks.
      const ext = bytes.length === POOL_SIZE_PARTNER && bytes[POOL_SIZE] === 1;
      return {
        config: new PublicKey(bytes.subarray(8, 40)), mint: new PublicKey(bytes.subarray(40, 72)), creator: new PublicKey(bytes.subarray(72, 104)), reward: new PublicKey(bytes.subarray(104, 136)),
        name: text(bytes.subarray(136, 168)), symbol: text(bytes.subarray(168, 178)),
        virtualQuote: readU64(bytes, 178), virtualToken: readU64(bytes, 186), curveSupply: readU64(bytes, 194), realQuote: readU64(bytes, 202),
        sold: readU64(bytes, 210), liquidityBonus: readU64(bytes, 218), protocolFees: readU64(bytes, 226), creatorFees: readU64(bytes, 234),
        createdAt: readI64(bytes, 242), graduatedAt: readI64(bytes, 250), status: bytes[258],
        buybackBps: ext ? readU16(bytes, POOL_SIZE + 1) : 0, buybackBurned: ext ? readU64(bytes, POOL_SIZE + 3) : 0n, buybackQuoteSpent: ext ? readU64(bytes, POOL_SIZE + 11) : 0n,
      };
    },
    /** Raw SPL token-account amount (offset 64), or 0 when the account does not exist. */
    tokenAmount: raw => (raw && raw.length >= 72 ? readU64(new Uint8Array(raw), 64) : 0n),
  };
}

/**
 * Upgradeable-loader (v3) deployment helpers, used by scripts/solana-deploy.mjs and the tests.
 * Returns the instruction groups; the caller signs and sends them in order.
 */
export function loaderV3(web3) {
  const { PublicKey, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY } = web3;
  const loader = new PublicKey(LOADER_V3);
  const data = bytes => (globalThis.Buffer ? globalThis.Buffer.from(bytes) : bytes);
  return {
    loader,
    BUFFER_HEADER: 37,
    PROGRAM_SIZE: 36,
    PROGRAMDATA_HEADER: 45,
    initializeBuffer: (buffer, authority) => new TransactionInstruction({ programId: loader, data: data(u32(0)), keys: [{ pubkey: buffer, isSigner: false, isWritable: true }, { pubkey: authority, isSigner: false, isWritable: false }] }),
    write: (buffer, authority, offset, bytes) => new TransactionInstruction({ programId: loader, data: data(concat(u32(1), u32(offset), u64(bytes.length), bytes)), keys: [{ pubkey: buffer, isSigner: false, isWritable: true }, { pubkey: authority, isSigner: true, isWritable: false }] }),
    upgrade: ({ programData, program, buffer, spill, authority }) => new TransactionInstruction({
      programId: loader, data: data(u32(3)),
      keys: [
        { pubkey: programData, isSigner: false, isWritable: true }, { pubkey: program, isSigner: false, isWritable: true }, { pubkey: buffer, isSigner: false, isWritable: true },
        { pubkey: spill, isSigner: false, isWritable: true }, { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }, { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: authority, isSigner: true, isWritable: false },
      ],
    }),
    // SetAuthority (4): hands a buffer (account = buffer) or a program (account = its programdata) to
    // `newAuthority`, for example a Squads multisig vault. Omitting `newAuthority` makes a program immutable.
    setAuthority: ({ account, authority, newAuthority }) => new TransactionInstruction({
      programId: loader, data: data(u32(4)),
      keys: [{ pubkey: account, isSigner: false, isWritable: true }, { pubkey: authority, isSigner: true, isWritable: false }, ...(newAuthority ? [{ pubkey: newAuthority, isSigner: false, isWritable: false }] : [])],
    }),
    // Close (5): returns a buffer's lamports to `recipient`. Used to reclaim stale buffers.
    close: ({ account, recipient, authority }) => new TransactionInstruction({
      programId: loader, data: data(u32(5)),
      keys: [{ pubkey: account, isSigner: false, isWritable: true }, { pubkey: recipient, isSigner: false, isWritable: true }, { pubkey: authority, isSigner: true, isWritable: false }],
    }),
    // ExtendProgramChecked (9) supersedes ExtendProgram (6) on current clusters and needs the upgrade authority.
    extendProgramChecked: ({ programData, program, authority, payer, additionalBytes }) => new TransactionInstruction({
      programId: loader, data: data(concat(u32(9), u32(additionalBytes))),
      keys: [
        { pubkey: programData, isSigner: false, isWritable: true }, { pubkey: program, isSigner: false, isWritable: true },
        { pubkey: authority, isSigner: true, isWritable: false }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: payer, isSigner: true, isWritable: true },
      ],
    }),
    extendProgram: ({ programData, program, payer, additionalBytes }) => new TransactionInstruction({
      programId: loader, data: data(concat(u32(6), u32(additionalBytes))),
      keys: [
        { pubkey: programData, isSigner: false, isWritable: true }, { pubkey: program, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: payer, isSigner: true, isWritable: true },
      ],
    }),
    deploy: ({ payer, programData, program, buffer, authority, maxDataLen }) => new TransactionInstruction({
      programId: loader, data: data(concat(u32(2), u64(maxDataLen))),
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true }, { pubkey: programData, isSigner: false, isWritable: true }, { pubkey: program, isSigner: false, isWritable: true },
        { pubkey: buffer, isSigner: false, isWritable: true }, { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }, { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: authority, isSigner: true, isWritable: false },
      ],
    }),
  };
}

/** Test-only helpers: SPL and Token-2022 mints standing in for USDC, xStocks and other pair assets. */
export function splTestMint(web3) {
  const { TransactionInstruction, SystemProgram } = web3;
  const tokenProgram = new web3.PublicKey(TOKEN_PROGRAM);
  const token2022 = new web3.PublicKey(TOKEN_2022_PROGRAM);
  const data = bytes => (globalThis.Buffer ? globalThis.Buffer.from(bytes) : bytes);
  // Token-2022 mint with one PermanentDelegate extension: 165 padded base + account type + TLV(4 + 32).
  const MINT_2022_DELEGATE_SIZE = 165 + 1 + 4 + 32;
  return {
    MINT_SIZE: 82, MINT_2022_DELEGATE_SIZE,
    /** A Token-2022 mint shaped like an xStock: issuer permanent delegate, no freeze authority. */
    createMint2022Ixs: async (connection, payer, mint, decimals, authority, permanentDelegate) => {
      if (!permanentDelegate) {
        const plain = await connection.getMinimumBalanceForRentExemption(82);
        return [SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: mint, lamports: plain, space: 82, programId: token2022 }),
          new TransactionInstruction({ programId: token2022, data: data(concat([20, decimals], authority.toBytes(), [0])), keys: [{ pubkey: mint, isSigner: false, isWritable: true }] })];
      }
      const lamports = await connection.getMinimumBalanceForRentExemption(MINT_2022_DELEGATE_SIZE);
      return [
        SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: mint, lamports, space: MINT_2022_DELEGATE_SIZE, programId: token2022 }),
        new TransactionInstruction({ programId: token2022, data: data(concat([35], permanentDelegate.toBytes())), keys: [{ pubkey: mint, isSigner: false, isWritable: true }] }),
        new TransactionInstruction({ programId: token2022, data: data(concat([20, decimals], authority.toBytes(), [0])), keys: [{ pubkey: mint, isSigner: false, isWritable: true }] }),
      ];
    },
    /** A Token-2022 mint with a transfer fee (rejected as a trading pair; used in tests). */
    createFeeMint2022Ixs: async (connection, payer, mint, decimals, authority) => {
      const size = 165 + 1 + 4 + 108;
      const lamports = await connection.getMinimumBalanceForRentExemption(size);
      // TransferFeeExtension(26) / InitializeTransferFeeConfig(0): two COption<Pubkey> authorities, bps u16, max u64.
      return [
        SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: mint, lamports, space: size, programId: token2022 }),
        new TransactionInstruction({ programId: token2022, data: data(concat([26, 0, 1], authority.toBytes(), [1], authority.toBytes(), u16(100), u64(1_000_000n))), keys: [{ pubkey: mint, isSigner: false, isWritable: true }] }),
        new TransactionInstruction({ programId: token2022, data: data(concat([20, decimals], authority.toBytes(), [0])), keys: [{ pubkey: mint, isSigner: false, isWritable: true }] }),
      ];
    },
    createMintIxs: async (connectionOrRent, payer, mint, decimals, authority) => {
      const lamports = typeof connectionOrRent === 'bigint' || typeof connectionOrRent === 'number' ? Number(connectionOrRent) : await connectionOrRent.getMinimumBalanceForRentExemption(82);
      return [
        SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: mint, lamports, space: 82, programId: tokenProgram }),
        new TransactionInstruction({ programId: tokenProgram, data: data(concat([20, decimals], authority.toBytes(), [0])), keys: [{ pubkey: mint, isSigner: false, isWritable: true }] }),
      ];
    },
    mintTo: (mint, destination, authority, amount) => new TransactionInstruction({ programId: tokenProgram, data: data(concat([7], u64(amount))), keys: [{ pubkey: mint, isSigner: false, isWritable: true }, { pubkey: destination, isSigner: false, isWritable: true }, { pubkey: authority, isSigner: true, isWritable: false }] }),
  };
}
