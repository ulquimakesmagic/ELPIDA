// Read-only public indexer for the Elpida Solana program. It never holds keys.
//
// Every tick: pool accounts are read with getProgramAccounts (current curve state), and new program
// transactions are read through getSignaturesForAddress with a durable cursor. Launch, buy and sell
// events become trades and candles. After migration, each token's PumpSwap pool gets its own cursor:
// swaps are read from the pool vaults' token-balance changes (independent of PumpSwap's event layout),
// and the price comes from the pool reserves. The creator's launch buy and live holding feed the dev
// badge. Immutable Metaplex metadata (name, symbol, IPFS URI) is read once per token. Holders come from
// getProgramAccounts on the mint (all holders, cached; getTokenLargestAccounts as a fallback).
// SQLite in WAL mode keeps everything on the data volume, so history survives restarts.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SOLANA_GENESIS } from '../solana/rpc-config.mjs';
import { createElpidaSolana, decodeEvents, poolStats, quoteBuy, formatAmount, TOKEN_DECIMALS, TOKEN_SUPPLY, POOL_SIZE, STATUS_GRADUATED, STATUS_MIGRATED, STATUS_LOCKED, WSOL_MINT, TOKEN_PROGRAM, GRADUATION_GRACE_SECS, VENUE_RAYDIUM, RAYDIUM } from '../solana/client.mjs';
import { supplyPercent } from '../core/curve-model.mjs';

const MAX_U64 = (1n << 64n) - 1n;
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CURVE_TRADES = ['CurveLaunched', 'CurveBought', 'CurveSold'];

// Only trust events emitted by our program, including when invoked through a router.
// Other instructions in the same transaction can emit identical event bytes.
export function programEventLogs(logs, programId) {
  const stack = [], result = [];
  for (const line of logs ?? []) {
    const invoke = /^Program (\S+) invoke \[(\d+)\]$/.exec(line);
    if (invoke) { stack.length = Number(invoke[2]) - 1; stack.push(invoke[1]); continue; }
    const exit = /^Program (\S+) (?:success|failed:.*)$/.exec(line);
    if (exit) { if (stack.at(-1) === exit[1]) stack.pop(); else stack.length = 0; continue; }
    if (line.startsWith('Program data: ') && stack.at(-1) === programId) result.push(line);
  }
  return result;
}

/** URI from a Metaplex MetadataV1 account (key 4; name 32, symbol 10, uri 200, length-prefixed and padded). */
export function metadataUri(data) {
  if (!data || data.length < 319 || data[0] !== 4) return '';
  const len = Math.min(data.readUInt32LE?.(115) ?? new DataView(data.buffer, data.byteOffset).getUint32(115, true), 200);
  return Buffer.from(data.subarray(119, 119 + len)).toString('utf8').replace(/\0+$/, '');
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Bytes(text) {
  if (typeof text !== 'string') return Uint8Array.from(text ?? []);
  let n = 0n; for (const c of text) { const i = B58.indexOf(c); if (i < 0) return new Uint8Array(); n = n * 58n + BigInt(i); }
  const bytes = []; while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of text) { if (c !== '1') break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}
// PumpSwap instructions that swap through a pool (public IDL, pump-fun/pump-public-docs): the trader is
// the account at the given index. multi_hop_swap lists the pool among its accounts.
const PUMP_SWAPS = [
  [[102, 6, 61, 18, 1, 218, 235, 234], 1], [[198, 46, 21, 82, 180, 217, 232, 112], 1], [[194, 171, 28, 70, 104, 77, 91, 47], 1],
  [[184, 23, 238, 97, 103, 197, 211, 61], 1], [[51, 230, 133, 164, 1, 127, 131, 173], 1], [[93, 246, 130, 60, 231, 233, 64, 178], 1],
  [[43, 100, 73, 19, 233, 246, 111, 148], 0], [[105, 68, 6, 175, 0, 7, 35, 162], 1],
];
const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
// Raydium CPMM swaps (swap_base_input, swap_base_output); the trader is account 0 (payer), the pool account 3.
const RAYDIUM_SWAPS = [[[143, 190, 90, 218, 196, 30, 51, 222], 0], [[55, 217, 98, 86, 163, 74, 180, 173], 0]];
const RAYDIUM_PROGRAMS = [RAYDIUM.devnet.program, RAYDIUM.mainnet.program];

/**
 * A PumpSwap swap on one Elpida pool from a confirmed transaction, or null. Amounts come from the pool
 * vaults' token-balance changes, accepted only when:
 * - the transaction holds exactly one PumpSwap swap instruction (top level or inner) that uses this pool,
 *   so several swaps netted in one transaction (buy X, sell X-1) cannot fake a price;
 * - base and quote moved in opposite directions (liquidity moves are not trades);
 * - the execution price lies within the pool's price before and after (±3% for fees), and the reserve
 *   product grew by at most 3% (more means a donation to a vault was mixed in).
 * The trader is the swap instruction's user account.
 */
export function pumpSwapTrade(tx, { pool, poolBase, poolQuote }) {
  return dexSwapTrade(tx, { pool, poolBase, poolQuote, programs: [PUMP_AMM], kinds: PUMP_SWAPS });
}
/** The same checks for a Raydium CPMM swap on an Elpida pool (`poolBase` / `poolQuote` are its token and SOL vaults). */
export function raydiumSwapTrade(tx, { pool, poolBase, poolQuote }) {
  return dexSwapTrade(tx, { pool, poolBase, poolQuote, programs: RAYDIUM_PROGRAMS, kinds: RAYDIUM_SWAPS });
}
function dexSwapTrade(tx, { pool, poolBase, poolQuote, programs, kinds }) {
  const message = tx?.transaction?.message ?? {};
  const keys = (message.staticAccountKeys ?? message.accountKeys ?? []).map(k => (k.pubkey ?? k).toBase58?.() ?? String(k.pubkey ?? k));
  const loaded = [...(tx?.meta?.loadedAddresses?.writable ?? []), ...(tx?.meta?.loadedAddresses?.readonly ?? [])].map(k => k.toBase58?.() ?? String(k));
  const all = [...keys, ...loaded];
  const top = (message.compiledInstructions ?? message.instructions ?? []).map(ix => ({ program: all[ix.programIdIndex], accounts: (ix.accountKeyIndexes ?? ix.accounts ?? []).map(i => all[i]), data: base58Bytes(ix.data) }));
  const inner = (tx?.meta?.innerInstructions ?? []).flatMap(group => group.instructions.map(ix => ({ program: all[ix.programIdIndex], accounts: (ix.accounts ?? []).map(i => all[i]), data: base58Bytes(ix.data) })));
  const swaps = [...top, ...inner].filter(ix => programs.includes(ix.program) && ix.accounts.includes(pool)).flatMap(ix => {
    const kind = kinds.find(([disc]) => disc.every((b, i) => ix.data[i] === b));
    return kind ? [{ trader: ix.accounts[kind[1]] }] : [];
  });
  if (swaps.length !== 1) return null;
  const amount = (list, index) => BigInt(list?.find(b => b.accountIndex === index)?.uiTokenAmount?.amount ?? 0);
  const balances = address => { const i = all.indexOf(address); return i < 0 ? null : [amount(tx.meta.preTokenBalances, i), amount(tx.meta.postTokenBalances, i)]; };
  const base = balances(poolBase), quote = balances(poolQuote);
  if (!base || !quote || base[0] <= 0n || quote[0] <= 0n || base[1] <= 0n || quote[1] <= 0n) return null;
  const dBase = base[1] - base[0], dQuote = quote[1] - quote[0];
  const buy = dBase < 0n && dQuote > 0n, sell = dBase > 0n && dQuote < 0n;
  if (!buy && !sell) return null;
  const tokenRaw = buy ? -dBase : dBase, quoteRaw = buy ? dQuote : -dQuote;
  const price = Number(quoteRaw) / Number(tokenRaw), before = Number(quote[0]) / Number(base[0]), after = Number(quote[1]) / Number(base[1]);
  if (!(price >= Math.min(before, after) * 0.97 && price <= Math.max(before, after) * 1.03)) return null;
  const k0 = base[0] * quote[0], k1 = base[1] * quote[1];
  if (k1 * 100n > k0 * 103n || k1 * 100n < k0 * 99n) return null;
  return { side: buy ? 'buy' : 'sell', tokenRaw, quoteRaw, account: swaps[0].trader ?? all[0] };
}

/**
 * A short, safe code for an RPC failure (3 November 2026: the devnet index stalled for eight days showing only
 * "Error"). Never includes the URL or its key.
 */
export function rpcErrorCode(error) {
  if (error?.code && /^[A-Z][A-Z0-9_]+$/.test(String(error.code))) return String(error.code).slice(0, 64);
  const text = `${error?.message ?? ''} ${error?.cause?.code ?? ''} ${error?.cause?.message ?? ''}`;
  if (/\b429\b|too many requests|rate.?limit/i.test(text)) return 'RPC_RATE_LIMITED';
  if (/\b40[13]\b|unauthori[sz]ed|forbidden|api.?key|credits?/i.test(text)) return 'RPC_UNAUTHORIZED';
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|timed? ?out|socket hang up|network/i.test(text)) return 'RPC_UNREACHABLE';
  if (/\b5\d\d\b|bad gateway|service unavailable|internal error/i.test(text)) return 'RPC_SERVER_ERROR';
  return String(error?.code ?? error?.name ?? 'INDEX_ERROR').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 64);
}

export class SolanaIndexer {
  /**
   * `web3`: @solana/web3.js; `connection`: a Connection; `deployment`: { programId, pairs }; `network`: net registry entry.
   * `backfill`: how many past program transactions to read on first start; `spacingMs`: delay between transaction reads.
   */
  constructor({ web3, connection, deployment, network, path = ':memory:', backfill = 1500, spacingMs = 120, metadataStore = null, pumpPerTick = 200 }) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.web3 = web3; this.connection = connection; this.network = network; this.deployment = deployment;
    this.client = createElpidaSolana(web3, new web3.PublicKey(deployment.programId), { cluster: network?.mainnet ? 'mainnet' : 'devnet' });
    this.pairs = new Map((deployment.pairs ?? []).map(p => [p.config, p]));
    this.backfill = backfill; this.spacingMs = spacingMs; this.holderCache = new Map(); this.lastError = null; this.lastSuccess = null; this.metadataStore = metadataStore; this.pumpPerTick = pumpPerTick; this.holderLookups = new Map();
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cursor (id INTEGER PRIMARY KEY CHECK(id=1), signature TEXT NOT NULL, slot INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens (mint TEXT PRIMARY KEY, created INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trades (signature TEXT NOT NULL, idx INTEGER NOT NULL, mint TEXT NOT NULL, slot INTEGER NOT NULL, timestamp INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(signature, idx));
      CREATE INDEX IF NOT EXISTS trades_mint ON trades(mint, slot);
      CREATE TABLE IF NOT EXISTS pump_cursor (pool TEXT PRIMARY KEY, signature TEXT NOT NULL, slot INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS token_meta (mint TEXT PRIMARY KEY, uri TEXT NOT NULL, data TEXT);`);
    const identity = json({ cluster: network.cluster, programId: deployment.programId });
    const prior = this.db.prepare('SELECT value FROM identity WHERE id=1').get();
    if (prior && prior.value !== identity) { this.db.close(); throw new Error('Solana index belongs to a different deployment.'); }
    this.db.prepare('INSERT OR IGNORE INTO identity VALUES(1,?)').run(identity);
  }

  quoteOf(configKey, configs) {
    const pair = this.pairs.get(configKey), cfg = configs.get(configKey);
    return { symbol: pair?.symbol ?? (cfg?.quoteMint.toBase58() === WSOL_MINT ? 'SOL' : 'TOKEN'), decimals: cfg?.quoteDecimals ?? pair?.decimals ?? 9, kind: pair?.kind ?? (cfg?.quoteMint.toBase58() === WSOL_MINT ? 'native' : 'token') };
  }

  /** Current state of every pool, stored as token rows. */
  async syncPools() {
    const accounts = await this.client.poolAccounts(this.connection, { commitment: 'confirmed' });
    const pools = accounts.filter(({ account }) => this.client.isPool(account.data)).map(({ pubkey, account }) => ({ pubkey, ...this.client.decodePool(account.data) }));
    const configKeys = [...new Set(pools.map(p => p.config.toBase58()))];
    const infos = configKeys.length ? await this.connection.getMultipleAccountsInfo(configKeys.map(k => new this.web3.PublicKey(k))) : [];
    const configs = new Map(configKeys.flatMap((k, i) => { try { return infos[i] ? [[k, this.client.decodeConfig(infos[i].data)]] : []; } catch { return []; } }));
    const extra = await this.poolExtras(pools, configs);
    const upsert = this.db.prepare('INSERT INTO tokens(mint, created, data) VALUES(?,?,?) ON CONFLICT(mint) DO UPDATE SET data=excluded.data');
    this.db.exec('BEGIN');
    try {
      for (const pool of pools) {
        const key = pool.config.toBase58(), cfg = configs.get(key);
        if (!cfg) continue;
        const quote = this.quoteOf(key, configs), d = quote.decimals, stats = poolStats(pool, d);
        // Locked: an issuer-controlled stock pair whose completing buy opened the program's own locked pool.
        const locked = pool.status === STATUS_LOCKED;
        const complete = pool.status === STATUS_GRADUATED || pool.status === STATUS_MIGRATED || locked;
        const mint = pool.mint.toBase58();
        const remaining = complete ? 0n : quoteBuy(pool, MAX_U64, cfg.baseFeeBps, cfg.baseFeeBps).gross;
        const x = extra.get(mint) ?? {}, migrated = pool.status === STATUS_MIGRATED;
        // After migration the curve is empty: price, market cap and liquidity come from the DEX pool (Raydium or PumpSwap).
        const pumpPrice = migrated && x.pumpBase > 0n ? Number(x.pumpQuote) / 10 ** d / (Number(x.pumpBase) / 10 ** TOKEN_DECIMALS) : null;
        const price = pumpPrice ?? stats.price;
        upsert.run(mint, Number(pool.createdAt), json({
          address: mint, pool: pool.pubkey.toBase58(), config: key, name: pool.name, symbol: pool.symbol, creator: pool.creator.toBase58(), reward: pool.reward.toBase58(),
          created: Number(pool.createdAt) * 1000, pair: quote.kind, quoteSymbol: quote.symbol, quoteDecimals: d, decimals: TOKEN_DECIMALS, dex: locked ? 'Elpida locked pool' : x.venue ?? (cfg.quoteMint.toBase58() === WSOL_MINT ? 'Raydium' : 'PumpSwap'),
          reserve: formatAmount(pool.realQuote, d), liquidityBonus: formatAmount(pool.liquidityBonus, d), sold: formatAmount(pool.sold, TOKEN_DECIMALS),
          circulatingSupply: formatAmount(TOKEN_SUPPLY, TOKEN_DECIMALS), saleCap: formatAmount(pool.curveSupply, TOKEN_DECIMALS), supply: formatAmount(TOKEN_SUPPLY, TOKEN_DECIMALS),
          spotPrice: price, marketCap: pumpPrice !== null ? pumpPrice * Number(TOKEN_SUPPLY) / 10 ** TOKEN_DECIMALS : stats.marketCap, progress: stats.progress, remainingBuy: formatAmount(remaining, d),
          complete, graduated: migrated || locked, lockedPool: locked, completedAt: Number(pool.graduatedAt), liquidityLocked: true,
          // D7: a completed curve that has not migrated can be reopened by anyone after the grace period.
          reopenableAt: pool.status === STATUS_GRADUATED && pool.graduatedAt > 0n ? Number(pool.graduatedAt) + GRADUATION_GRACE_SECS : null,
          ...(migrated ? { pumpPool: x.pumpPool, venue: x.venue, dexBase: x.dexBase, dexQuote: x.dexQuote, liquidity: x.pumpQuote !== undefined ? formatAmount(x.pumpQuote, d) : undefined,
            ...(x.lpBurned !== undefined ? { pendingBuyback: formatAmount(x.pendingBuyback, d) } : {}) } : {}),
          ...(locked ? { venue: 'Elpida locked pool', liquidity: formatAmount(pool.realQuote, d) } : {}),
          // Early-partner tier fixed at launch; tokens burned by its buybacks (curve trades plus LP-fee burns after migration).
          buybackBps: pool.buybackBps, burned: formatAmount(pool.buybackBurned + (x.lpBurned ?? 0n), TOKEN_DECIMALS),
          protocolFees: formatAmount(pool.protocolFees, d), creatorFees: formatAmount(pool.creatorFees, d),
          virtualQuote: pool.virtualQuote.toString(), virtualToken: pool.virtualToken.toString(),
          // Creator transparency (D6): the launch buy and the creator wallet's live holding, % of supply.
          ...(x.devBoughtRaw !== undefined ? { devBoughtRaw: x.devBoughtRaw.toString(), devBoughtPct: supplyPercent(x.devBoughtRaw, TOKEN_SUPPLY) } : {}),
          ...(x.devHoldingRaw !== undefined ? { devHoldingRaw: x.devHoldingRaw.toString(), devHoldingPct: supplyPercent(x.devHoldingRaw, TOKEN_SUPPLY) } : {}),
          ...(x.launchSignature ? { launchHash: x.launchSignature } : {}),
          metadataURI: x.metadataURI ?? '',
        }));
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.poolMints = new Map(pools.map(p => [p.pubkey.toBase58(), p.mint.toBase58()]));
    this.configs = configs;
  }

  /** Per-pool reads that are not in the pool account: dev badge, PumpSwap reserves, Metaplex URI. */
  async poolExtras(pools, configs) {
    const { PublicKey } = this.web3, out = new Map(pools.map(p => [p.mint.toBase58(), {}]));
    const batch = async keys => { const result = []; for (let i = 0; i < keys.length; i += 100) result.push(...await this.connection.getMultipleAccountsInfo(keys.slice(i, i + 100), 'confirmed')); return result; };
    const launchBuy = this.db.prepare("SELECT signature, data FROM trades WHERE mint=? AND json_extract(data,'$.launch')=1 ORDER BY slot LIMIT 1");
    // Creator holdings (the creator's associated token account for the mint).
    const holdings = await batch(pools.map(p => this.client.ata(p.creator, p.mint)));
    pools.forEach((p, i) => {
      const row = launchBuy.get(p.mint.toBase58()), x = out.get(p.mint.toBase58());
      if (row) { x.devBoughtRaw = BigInt(JSON.parse(row.data).tokenRaw); x.launchSignature = row.signature; }
      x.devHoldingRaw = this.client.tokenAmount(holdings[i]?.data);
    });
    // Metaplex URIs, read once per token (metadata is immutable).
    const known = new Map(this.db.prepare('SELECT mint, uri FROM token_meta').all().map(r => [r.mint, r.uri]));
    const missing = pools.filter(p => !known.has(p.mint.toBase58()));
    if (missing.length) {
      const infos = await batch(missing.map(p => this.client.metadataPda(p.mint)));
      const save = this.db.prepare('INSERT OR IGNORE INTO token_meta(mint, uri) VALUES(?,?)');
      // Only record definite answers: an existing account, or none at all for tokens launched before metadata.
      // A missing account is recorded as "no metadata" only for pools older than 10 minutes, so a lagging RPC
      // node cannot permanently hide a new token's metadata.
      const settled = p => Date.now() / 1000 - Number(p.createdAt) > 600;
      missing.forEach((p, i) => { const uri = metadataUri(infos[i]?.data); if (uri || (!infos[i] && settled(p))) { save.run(p.mint.toBase58(), uri); known.set(p.mint.toBase58(), uri); } });
    }
    for (const p of pools) out.get(p.mint.toBase58()).metadataURI = known.get(p.mint.toBase58()) ?? '';
    // PumpSwap reserves for migrated tokens.
    const migrated = pools.filter(p => p.status === STATUS_MIGRATED && configs.get(p.config.toBase58()));
    // Quote token program per quote mint (SPL Token or Token-2022), read from the mint's owner once.
    this.quotePrograms ??= new Map();
    const unknownMints = [...new Set(migrated.map(p => configs.get(p.config.toBase58()).quoteMint.toBase58()))].filter(m => !this.quotePrograms.has(m));
    if (unknownMints.length) (await batch(unknownMints.map(m => new PublicKey(m)))).forEach((info, i) => { if (info) this.quotePrograms.set(unknownMints[i], info.owner); });
    if (migrated.length) {
      // The migration record names the venue: Raydium CPMM (SOL pairs from the Raydium build) or PumpSwap.
      const records = (await batch(migrated.map(p => this.client.migrationPda(p.mint)))).map(info => { try { return info ? this.client.decodeMigration(info.data) : null; } catch { return null; } });
      const accounts = migrated.map((p, i) => {
        if (records[i]?.venue === VENUE_RAYDIUM) { const r = this.client.raydiumAccounts(p.mint); return { venue: 'Raydium', pool: r.pool, keys: [r.pool, r.vault0, r.vault1], base: r.baseVault, quote: r.quoteVault }; }
        const cfg = configs.get(p.config.toBase58()), a = this.client.pumpAccounts(p.mint, cfg.quoteMint, this.quoteProgramOf(cfg));
        return { venue: 'PumpSwap', pool: a.pool, keys: [a.pool, a.poolBase, a.poolQuote], base: a.poolBase, quote: a.poolQuote };
      });
      const infos = await batch(accounts.flatMap(a => a.keys));
      migrated.forEach((p, i) => {
        const [poolInfo, first, second] = infos.slice(i * 3, i * 3 + 3), x = out.get(p.mint.toBase58()), a = accounts[i];
        if (!poolInfo || !first || !second) return;
        const state = a.venue === 'Raydium' ? this.client.raydiumState(poolInfo.data, first.data, second.data, p.mint) : this.client.pumpState(poolInfo.data, first.data, second.data);
        Object.assign(x, { pumpPool: a.pool.toBase58(), venue: a.venue, dexBase: a.base.toBase58(), dexQuote: a.quote.toBase58(), pumpBase: state.base, pumpQuote: state.quote });
        if (records[i]) Object.assign(x, { lpBurned: records[i].baseBurned + records[i].buybackBurned, pendingBuyback: records[i].pendingBuyback });
      });
    }
    return out;
  }

  /** The quote mint's token program for a config: the mint's on-chain owner, else the deployment record. */
  quoteProgramOf(cfg) {
    const mint = cfg.quoteMint.toBase58(), owner = this.quotePrograms?.get(mint);
    if (owner) return owner;
    const pair = [...this.pairs.values()].find(p => (p.mint ?? p.quoteMint) === mint);
    return new this.web3.PublicKey(pair?.tokenProgram ?? pair?.quoteTokenProgram ?? TOKEN_PROGRAM);
  }

  /** DEX swaps (PumpSwap or Raydium) on migrated Elpida pools, one durable cursor per pool (oldest first). */
  async syncPumpTrades() {
    const tokens = this.tokens().filter(t => t.graduated && t.pumpPool);
    if (!tokens.length) return 0;
    const cursorOf = this.db.prepare('SELECT signature FROM pump_cursor WHERE pool=?');
    const setCursor = this.db.prepare('INSERT INTO pump_cursor(pool, signature, slot) VALUES(?,?,?) ON CONFLICT(pool) DO UPDATE SET signature=excluded.signature, slot=excluded.slot');
    const insert = this.db.prepare('INSERT OR IGNORE INTO trades(signature, idx, mint, slot, timestamp, data) VALUES(?,?,?,?,?,?)');
    let added = 0;
    for (const token of tokens) {
      const cfg = this.configs?.get(token.config);
      if (!cfg) continue;
      const raydium = token.venue === 'Raydium' && token.dexBase && token.dexQuote;
      const a = raydium ? { pool: new this.web3.PublicKey(token.pumpPool), poolBase: new this.web3.PublicKey(token.dexBase), poolQuote: new this.web3.PublicKey(token.dexQuote) }
        : this.client.pumpAccounts(new this.web3.PublicKey(token.address), cfg.quoteMint, this.quoteProgramOf(cfg));
      const cursor = cursorOf.get(token.pumpPool)?.signature;
      const fresh = [];
      let before;
      for (;;) {
        const page = await this.connection.getSignaturesForAddress(a.pool, { until: cursor, before, limit: 1000 }, 'confirmed');
        fresh.push(...page);
        if (page.length < 1000 || (!cursor && fresh.length >= this.backfill)) break;
        before = page.at(-1).signature;
      }
      // Oldest first, at most `pumpPerTick` per pool per tick; the cursor resumes from the last one handled.
      for (const sig of fresh.reverse().slice(0, this.pumpPerTick)) {
        let trade = null, tx;
        if (!sig.err) {
          tx = await this.connection.getTransaction(sig.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
          if (!tx?.meta) { const error = new Error('Transaction details not available yet.'); error.code = 'TRANSACTION_PENDING'; throw error; }
          if (!tx.meta.err) trade = (raydium ? raydiumSwapTrade : pumpSwapTrade)(tx, { pool: a.pool.toBase58(), poolBase: a.poolBase.toBase58(), poolQuote: a.poolQuote.toBase58() });
        }
        this.db.exec('BEGIN');
        try {
          if (trade) {
            const d = token.quoteDecimals, timestamp = tx?.blockTime ?? sig.blockTime ?? 0;
            added += Number(insert.run(sig.signature, 0, token.address, sig.slot, timestamp, json({
              hash: sig.signature, token: token.address, side: trade.side, account: trade.account, venue: raydium ? 'Raydium' : 'PumpSwap',
              quoteRaw: trade.quoteRaw, tokenRaw: trade.tokenRaw, quoteAmount: formatAmount(trade.quoteRaw, d), tokenAmount: formatAmount(trade.tokenRaw, TOKEN_DECIMALS),
              // The DEX's trade fee on the quote side (Raydium's 1% tier; PumpSwap 0.30%).
              feeRaw: (trade.quoteRaw < 0n ? -trade.quoteRaw : trade.quoteRaw) * (raydium ? 100n : 30n) / 10_000n,
              priceQuote: Number(trade.quoteRaw) / 10 ** d / (Number(trade.tokenRaw) / 10 ** TOKEN_DECIMALS), launch: false, timestamp, slot: sig.slot,
            })).changes);
          }
          setCursor.run(token.pumpPool, sig.signature, sig.slot);
          this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
        if (!sig.err && this.spacingMs) await sleep(this.spacingMs);
      }
    }
    return added;
  }

  /** Retains and resolves each token's published metadata document (best effort; IPFS outages are retried). */
  async syncMetadata() {
    if (!this.metadataStore) return;
    const save = this.db.prepare('UPDATE token_meta SET data=? WHERE mint=?');
    for (const row of this.db.prepare("SELECT mint, uri, data FROM token_meta WHERE uri<>''").all()) {
      try { this.metadataStore.retainPublished(row.uri); } catch { /* unknown to this server: resolved below if reachable */ }
      if (row.data) continue;
      try { save.run(JSON.stringify(await this.metadataStore.resolve(row.uri)), row.mint); } catch { /* retry next tick */ }
    }
  }

  /** New program transactions since the cursor (oldest first); backfills `backfill` signatures on first start. */
  async syncTrades() {
    const cursor = this.db.prepare('SELECT signature, slot FROM cursor WHERE id=1').get();
    const fresh = [];
    let before;
    for (;;) {
      const page = await this.connection.getSignaturesForAddress(this.client.programId, { until: cursor?.signature, before, limit: 1000 }, 'confirmed');
      fresh.push(...page);
      if (page.length < 1000 || (!cursor && fresh.length >= this.backfill)) break;
      before = page.at(-1).signature;
    }
    if (!fresh.length) return 0;
    const insert = this.db.prepare('INSERT OR IGNORE INTO trades(signature, idx, mint, slot, timestamp, data) VALUES(?,?,?,?,?,?)');
    let tokens = new Map(this.tokens().map(t => [t.pool, t])), refreshed = false;
    let added = 0;
    for (const sig of fresh.reverse()) {
      let transactionAdded = 0;
      let events = [], tx;
      if (!sig.err) {
        tx = await this.connection.getTransaction(sig.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
        // A listed signature may precede transaction availability on this RPC.
        // Preserve the checkpoint so a later tick retries rather than losing history.
        if (!tx?.meta) {
          const error = new Error('Transaction details not available yet.');
          error.code = 'TRANSACTION_PENDING';
          throw error;
        }
        if (!tx.meta.err) events = decodeEvents(programEventLogs(tx.meta.logMessages, this.deployment.programId), this.web3.PublicKey);
      }
      // A launch newer than the last pool snapshot (the fast tick reads trades first): load the pools once, so its
      // trades are not skipped past.
      if (!refreshed && events.some(e => CURVE_TRADES.includes(e.name) && !tokens.has(e.pool))) {
        refreshed = true;
        await this.syncPools();
        tokens = new Map(this.tokens().map(t => [t.pool, t]));
      }
      this.db.exec('BEGIN');
      try {
        events.forEach((e, idx) => {
          if (!CURVE_TRADES.includes(e.name)) return;
          const token = tokens.get(e.pool);
          if (!token) return;
          const d = token.quoteDecimals, buy = e.name !== 'CurveSold';
          const quoteRaw = buy ? e.quoteIn : e.quoteOut, tokenRaw = buy ? e.tokensOut : e.tokensIn;
          const result = insert.run(sig.signature, idx, token.address, sig.slot, tx?.blockTime ?? sig.blockTime ?? 0, json({
            hash: sig.signature, token: token.address, side: buy ? 'buy' : 'sell', account: buy ? (e.buyer ?? e.creator) : e.seller,
            quoteRaw, tokenRaw, quoteAmount: formatAmount(quoteRaw, d), tokenAmount: formatAmount(tokenRaw, TOKEN_DECIMALS),
            // The fee at the pool's own rate (the anti-snipe surplus is liquidity, not a fee): V2 airdrops weigh it.
            feeRaw: (e.fee ?? 0n) - (e.antiSnipeFee ?? 0n),
            priceQuote: tokenRaw > 0n ? Number(quoteRaw) / 10 ** d / (Number(tokenRaw) / 10 ** TOKEN_DECIMALS) : null,
            launch: e.name === 'CurveLaunched', timestamp: tx?.blockTime ?? sig.blockTime ?? 0, slot: sig.slot,
          }));
          transactionAdded += Number(result.changes);
        });
        this.db.prepare('INSERT INTO cursor(id, signature, slot) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET signature=excluded.signature, slot=excluded.slot').run(sig.signature, sig.slot);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      added += transactionAdded;
      if (!sig.err && this.spacingMs) await sleep(this.spacingMs);
    }
    return added;
  }

  /**
   * The fast tick, every few seconds: new program transactions first (the pools are reloaded only when a trade
   * happened or a new launch appears), then swaps on migrated pools. `sync()` remains the full pass.
   */
  async syncRecent() {
    if (this.running) return this.running;
    if (!this.networkValidated || !this.lastSuccess) return this.sync();
    this.running = (async () => {
      let phase = 'transaction_history';
      try {
        let added = await this.syncTrades();
        try { added += await this.syncPumpTrades(); } catch (error) { this.phaseErrors = { ...this.phaseErrors, pumpswap_history: String(error.code ?? error.name ?? 'INDEX_ERROR').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 64) }; }
        phase = 'pool_refresh';
        // Prices, market caps and DEX reserves move only with trades.
        if (added) await this.syncPools();
        this.lastError = null; this.lastErrorPhase = null; this.lastSuccess = new Date().toISOString();
      }
      catch (error) { this.lastErrorPhase = phase; this.lastError = rpcErrorCode(error); throw error; }
      finally { this.running = null; }
    })();
    return this.running;
  }

  /** Trades stored after row `rowid` (oldest first), for the live feed: { trades, last }. */
  tradesAfter(rowid, limit = 200) {
    const rows = this.db.prepare('SELECT rowid, timestamp, idx, data FROM trades WHERE rowid > ? ORDER BY rowid LIMIT ?').all(Number(rowid) || 0, limit);
    return { trades: rows.map(r => ({ ...JSON.parse(r.data), timestamp: r.timestamp, idx: r.idx })), last: rows.length ? rows.at(-1).rowid : Number(rowid) || 0 };
  }
  /** The newest stored trade row, so a restarted server does not replay history to open streams. */
  /** Trades with `start <= timestamp < end`, oldest first (V2 rounds and the flywheel). */
  tradesBetween(start, end) { return this.db.prepare('SELECT data FROM trades WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp, slot, idx').all(start, end).map(r => JSON.parse(r.data)); }
  /** The first time a wallet traded an Elpida token here (unix seconds), or null. */
  firstSeen(account) { return this.db.prepare("SELECT MIN(timestamp) AS t FROM trades WHERE json_extract(data, '$.account') = ?").get(account)?.t ?? null; }
  lastTradeRow() { return this.db.prepare('SELECT MAX(rowid) AS id FROM trades').get()?.id ?? 0; }

  async sync() {
    if (this.running) return this.running;
    this.running = (async () => {
      let phase = 'network_identity';
      try {
        const expected = SOLANA_GENESIS[this.network.cluster];
        if (expected && !this.networkValidated) {
          if (await this.connection.getGenesisHash() !== expected) {
            const error = new Error('Solana RPC does not match the configured cluster.');
            error.code = 'RPC_CLUSTER_MISMATCH'; throw error;
          }
          this.networkValidated = true;
        }
        phase = 'pool_snapshot';
        await this.syncPools(); phase = 'transaction_history';
        await this.syncTrades(); phase = 'pool_refresh'; await this.syncPools();
        // Optional phases are isolated: a PumpSwap backlog or an IPFS outage never blocks the others.
        this.phaseErrors = {};
        for (const [name, run] of [['metadata', () => this.syncMetadata()], ['pumpswap_history', () => this.syncPumpTrades()]]) {
          try { await run(); } catch (error) { this.phaseErrors[name] = String(error.code ?? error.name ?? 'INDEX_ERROR').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 64); }
        }
        this.lastError = null; this.lastErrorPhase = null; this.lastSuccess = new Date().toISOString();
      }
      catch (error) { this.lastErrorPhase = phase; this.lastError = rpcErrorCode(error); throw error; }
      finally { this.running = null; }
    })();
    return this.running;
  }

  tokens() { return this.db.prepare('SELECT data FROM tokens ORDER BY created DESC').all().map(r => JSON.parse(r.data)); }
  listings() {
    const meta = new Map(this.db.prepare('SELECT mint, data FROM token_meta WHERE data IS NOT NULL').all().map(r => [r.mint, r.data]));
    return this.tokens().map(t => ({ ...t, ...(meta.has(t.address) ? { metadata: JSON.parse(meta.get(t.address)), metadataStatus: 'published' } : t.metadataURI ? { metadataStatus: 'unavailable' } : {}),
      balance: '0', network: this.network.key, url: `${this.network.explorer}/address/${t.address}${this.network.cluster === 'mainnet' ? '' : `?cluster=${this.network.cluster}`}` }));
  }
  token(mint) { return this.listings().find(t => t.address === mint) ?? null; }
  /** Latest trades across every pool of this index, newest first (the "Last sale" strip). */
  recentTrades(limit = 20) { return this.db.prepare('SELECT timestamp, idx, data FROM trades ORDER BY timestamp DESC, slot DESC, idx DESC LIMIT ?').all(Math.max(1, Math.min(100, limit))).map(r => ({ ...JSON.parse(r.data), timestamp: r.timestamp, idx: r.idx })); }
  trades(mint, limit = 100) { return this.db.prepare('SELECT data FROM trades WHERE mint=? ORDER BY slot DESC, idx DESC LIMIT ?').all(mint, Math.max(1, Math.min(500, limit))).map(r => JSON.parse(r.data)); }
  /** OHLC and volume per bucket (1s to 1D), oldest first, the last `limit` buckets that had trades. */
  candles(mint, interval = 60, limit = 100) {
    if (![1, 15, 60, 300, 900, 3600, 14400, 86400].includes(interval)) throw new Error('Unsupported candle interval.');
    const keep = Math.max(1, Math.min(500, limit));
    const latest = this.db.prepare('SELECT MAX(timestamp) AS t FROM trades WHERE mint=?').get(mint)?.t;
    if (latest == null) return [];
    const buckets = new Map();
    const raw = value => { try { return BigInt(value ?? 0); } catch { return 0n; } };
    for (const row of this.db.prepare('SELECT data FROM trades WHERE mint=? AND timestamp>=? ORDER BY slot, idx').all(mint, latest - keep * interval * 2)) {
      const t = JSON.parse(row.data), p = t.priceQuote;
      if (!(p > 0)) continue;
      const time = Math.floor(t.timestamp / interval) * interval;
      const c = buckets.get(time) ?? { timestamp: time, open: p, high: p, low: p, close: p, trades: 0, quoteVolumeRaw: 0n, tokenVolumeRaw: 0n };
      c.high = Math.max(c.high, p); c.low = Math.min(c.low, p); c.close = p; c.trades++;
      c.quoteVolumeRaw += raw(t.quoteRaw); c.tokenVolumeRaw += raw(t.tokenRaw);
      buckets.set(time, c);
    }
    return [...buckets.values()].slice(-keep).map(c => ({ ...c, open: String(c.open), high: String(c.high), low: String(c.low), close: String(c.close), quoteVolumeRaw: c.quoteVolumeRaw.toString(), tokenVolumeRaw: c.tokenVolumeRaw.toString() }));
  }
  /**
   * Every wallet holder, largest first (curve vault and PumpSwap pool excluded), cached for a minute.
   * Reads all token accounts of the mint with getProgramAccounts (owner + amount slices only); falls back
   * to getTokenLargestAccounts (top 20) on RPCs that refuse it. `offset` / `limit` page the cached list.
   */
  async holders(mint, { offset = 0, limit = 100 } = {}) {
    const all = await this.allHolders(mint);
    return all.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(1, Math.min(1000, limit)));
  }
  async holderCount(mint) { return (await this.allHolders(mint)).length; }
  async allHolders(mint) {
    const hit = this.holderCache.get(mint);
    if (hit && Date.now() - hit.at < 60_000) return hit.rows;
    // One RPC lookup per mint at a time: concurrent requests share it.
    if (this.holderLookups.has(mint)) return this.holderLookups.get(mint);
    const lookup = this.lookupHolders(mint).finally(() => this.holderLookups.delete(mint));
    this.holderLookups.set(mint, lookup);
    return lookup;
  }
  async lookupHolders(mint) {
    const token = this.token(mint);
    if (!token) return [];
    const { PublicKey } = this.web3;
    try {
      const accounts = await this.connection.getProgramAccounts(new PublicKey(TOKEN_PROGRAM), { commitment: 'confirmed', dataSlice: { offset: 32, length: 40 }, filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }] });
      const totals = new Map();
      for (const { account } of accounts) {
        const data = account.data; if (data.length < 40) continue;
        const ownerBytes = data.subarray(0, 32), amount = this.client.tokenAmount(Buffer.concat([Buffer.alloc(64), data.subarray(32, 40)]));
        if (amount <= 0n || !PublicKey.isOnCurve(ownerBytes)) continue; // program-owned vaults (curve, PumpSwap) are off-curve PDAs
        const owner = new PublicKey(ownerBytes).toBase58();
        totals.set(owner, (totals.get(owner) ?? 0n) + amount);
      }
      const rows = [...totals].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0)).map(([address, amount]) => ({ address, balance: formatAmount(amount, TOKEN_DECIMALS), supplyShare: String(Number(amount) / Number(TOKEN_SUPPLY)) }));
      this.holderCache.set(mint, { at: Date.now(), rows });
      return rows;
    } catch { /* RPC refuses getProgramAccounts on the token program: top 20 only */ }
    const largest = (await this.connection.getTokenLargestAccounts(new this.web3.PublicKey(mint), 'confirmed')).value;
    const infos = largest.length ? await this.connection.getMultipleAccountsInfo(largest.map(a => a.address)) : [];
    const excluded = new Set([token.pool]);
    const rows = largest.flatMap((a, i) => {
      const data = infos[i]?.data; if (!data || data.length < 64) return [];
      const owner = new this.web3.PublicKey(data.subarray(32, 64)).toBase58();
      if (excluded.has(owner) || !this.web3.PublicKey.isOnCurve(data.subarray(32, 64))) return []; // program-owned vaults (curve, PumpSwap) are off-curve PDAs
      const amount = BigInt(a.amount);
      return amount > 0n ? [{ address: owner, balance: formatAmount(amount, TOKEN_DECIMALS), supplyShare: String(Number(amount) / Number(TOKEN_SUPPLY)) }] : [];
    });
    this.holderCache.set(mint, { at: Date.now(), rows });
    return rows;
  }
  /** Moves to another RPC (after repeated failures): the new one is checked against the cluster before use. */
  useConnection(connection, host = null) { this.connection = connection; this.networkValidated = false; this.rpcHost = host; }
  status() {
    const cursor = this.db.prepare('SELECT signature, slot FROM cursor WHERE id=1').get();
    return { network: this.network.key, programId: this.deployment.programId, tokens: this.db.prepare('SELECT COUNT(*) n FROM tokens').get().n, trades: this.db.prepare('SELECT COUNT(*) n FROM trades').get().n, cursorSlot: cursor?.slot ?? null, lastSuccess: this.lastSuccess, error: this.lastError, errorPhase: this.lastErrorPhase ?? null, rpc: this.rpcHost ?? null, phaseErrors: this.phaseErrors ?? {}, backend: 'SQLite WAL' };
  }
  close() { this.db.close(); }
}
