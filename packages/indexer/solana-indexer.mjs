// Read-only public indexer for the Elpida Solana program. It never holds keys.
//
// Every tick: pool accounts are read with getProgramAccounts (current curve state), and new program
// transactions are read through getSignaturesForAddress with a durable cursor. Launch, buy and sell
// events become trades and candles. Holders come from getTokenLargestAccounts, cached briefly.
// SQLite in WAL mode keeps everything on the data volume, so history survives restarts.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createElpidaSolana, decodeEvents, poolStats, quoteBuy, formatAmount, TOKEN_DECIMALS, TOKEN_SUPPLY, POOL_SIZE, STATUS_GRADUATED, STATUS_MIGRATED, WSOL_MINT } from '../solana/client.mjs';

const MAX_U64 = (1n << 64n) - 1n;
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

export class SolanaIndexer {
  /**
   * `web3`: @solana/web3.js; `connection`: a Connection; `deployment`: { programId, pairs }; `network`: net registry entry.
   * `backfill`: how many past program transactions to read on first start; `spacingMs`: delay between transaction reads.
   */
  constructor({ web3, connection, deployment, network, path = ':memory:', backfill = 1500, spacingMs = 120 }) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.web3 = web3; this.connection = connection; this.network = network; this.deployment = deployment;
    this.client = createElpidaSolana(web3, new web3.PublicKey(deployment.programId));
    this.pairs = new Map((deployment.pairs ?? []).map(p => [p.config, p]));
    this.backfill = backfill; this.spacingMs = spacingMs; this.holderCache = new Map(); this.lastError = null; this.lastSuccess = null;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cursor (id INTEGER PRIMARY KEY CHECK(id=1), signature TEXT NOT NULL, slot INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens (mint TEXT PRIMARY KEY, created INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trades (signature TEXT NOT NULL, idx INTEGER NOT NULL, mint TEXT NOT NULL, slot INTEGER NOT NULL, timestamp INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(signature, idx));
      CREATE INDEX IF NOT EXISTS trades_mint ON trades(mint, slot);`);
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
    const accounts = await this.connection.getProgramAccounts(this.client.programId, { commitment: 'confirmed', filters: [{ dataSize: POOL_SIZE }] });
    const pools = accounts.filter(({ account }) => this.client.isPool(account.data)).map(({ pubkey, account }) => ({ pubkey, ...this.client.decodePool(account.data) }));
    const configKeys = [...new Set(pools.map(p => p.config.toBase58()))];
    const infos = configKeys.length ? await this.connection.getMultipleAccountsInfo(configKeys.map(k => new this.web3.PublicKey(k))) : [];
    const configs = new Map(configKeys.flatMap((k, i) => { try { return infos[i] ? [[k, this.client.decodeConfig(infos[i].data)]] : []; } catch { return []; } }));
    const upsert = this.db.prepare('INSERT INTO tokens(mint, created, data) VALUES(?,?,?) ON CONFLICT(mint) DO UPDATE SET data=excluded.data');
    this.db.exec('BEGIN');
    try {
      for (const pool of pools) {
        const key = pool.config.toBase58(), cfg = configs.get(key);
        if (!cfg) continue;
        const quote = this.quoteOf(key, configs), d = quote.decimals, stats = poolStats(pool, d);
        const complete = pool.status === STATUS_GRADUATED || pool.status === STATUS_MIGRATED;
        const mint = pool.mint.toBase58();
        const remaining = complete ? 0n : quoteBuy(pool, MAX_U64, cfg.baseFeeBps, cfg.baseFeeBps).gross;
        upsert.run(mint, Number(pool.createdAt), json({
          address: mint, pool: pool.pubkey.toBase58(), config: key, name: pool.name, symbol: pool.symbol, creator: pool.creator.toBase58(), reward: pool.reward.toBase58(),
          created: Number(pool.createdAt) * 1000, pair: quote.kind, quoteSymbol: quote.symbol, quoteDecimals: d, decimals: TOKEN_DECIMALS, dex: 'PumpSwap',
          reserve: formatAmount(pool.realQuote, d), liquidityBonus: formatAmount(pool.liquidityBonus, d), sold: formatAmount(pool.sold, TOKEN_DECIMALS),
          circulatingSupply: formatAmount(TOKEN_SUPPLY, TOKEN_DECIMALS), saleCap: formatAmount(pool.curveSupply, TOKEN_DECIMALS), supply: formatAmount(TOKEN_SUPPLY, TOKEN_DECIMALS),
          spotPrice: stats.price, marketCap: stats.marketCap, progress: stats.progress, remainingBuy: formatAmount(remaining, d),
          complete, graduated: pool.status === STATUS_MIGRATED, completedAt: Number(pool.graduatedAt), liquidityLocked: true,
          protocolFees: formatAmount(pool.protocolFees, d), creatorFees: formatAmount(pool.creatorFees, d),
          virtualQuote: pool.virtualQuote.toString(), virtualToken: pool.virtualToken.toString(),
        }));
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.poolMints = new Map(pools.map(p => [p.pubkey.toBase58(), p.mint.toBase58()]));
    this.configs = configs;
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
    const tokens = new Map(this.tokens().map(t => [t.pool, t]));
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
      this.db.exec('BEGIN');
      try {
        events.forEach((e, idx) => {
          if (!['CurveLaunched', 'CurveBought', 'CurveSold'].includes(e.name)) return;
          const token = tokens.get(e.pool);
          if (!token) return;
          const d = token.quoteDecimals, buy = e.name !== 'CurveSold';
          const quoteRaw = buy ? e.quoteIn : e.quoteOut, tokenRaw = buy ? e.tokensOut : e.tokensIn;
          const result = insert.run(sig.signature, idx, token.address, sig.slot, tx?.blockTime ?? sig.blockTime ?? 0, json({
            hash: sig.signature, token: token.address, side: buy ? 'buy' : 'sell', account: buy ? (e.buyer ?? e.creator) : e.seller,
            quoteRaw, tokenRaw, quoteAmount: formatAmount(quoteRaw, d), tokenAmount: formatAmount(tokenRaw, TOKEN_DECIMALS),
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

  async sync() {
    if (this.running) return this.running;
    this.running = (async () => {
      let phase = 'pool_snapshot';
      try {
        await this.syncPools(); phase = 'transaction_history';
        await this.syncTrades(); phase = 'pool_refresh'; await this.syncPools();
        this.lastError = null; this.lastErrorPhase = null; this.lastSuccess = new Date().toISOString();
      }
      catch (error) { this.lastErrorPhase = phase; this.lastError = String(error.code ?? error.name ?? 'INDEX_ERROR').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 64); throw error; }
      finally { this.running = null; }
    })();
    return this.running;
  }

  tokens() { return this.db.prepare('SELECT data FROM tokens ORDER BY created DESC').all().map(r => JSON.parse(r.data)); }
  listings() { return this.tokens().map(t => ({ ...t, balance: '0', network: this.network.key, url: `${this.network.explorer}/address/${t.address}${this.network.cluster === 'mainnet' ? '' : `?cluster=${this.network.cluster}`}` })); }
  token(mint) { return this.listings().find(t => t.address === mint) ?? null; }
  trades(mint, limit = 100) { return this.db.prepare('SELECT data FROM trades WHERE mint=? ORDER BY slot DESC, idx DESC LIMIT ?').all(mint, Math.max(1, Math.min(500, limit))).map(r => JSON.parse(r.data)); }
  candles(mint, interval = 60, limit = 100) {
    if (![60, 300, 3600, 86400].includes(interval)) throw new Error('Unsupported candle interval.');
    const buckets = new Map();
    for (const row of this.db.prepare('SELECT data FROM trades WHERE mint=? ORDER BY slot, idx').all(mint)) {
      const t = JSON.parse(row.data), p = t.priceQuote;
      if (!(p > 0)) continue;
      const time = Math.floor(t.timestamp / interval) * interval;
      const c = buckets.get(time) ?? { timestamp: time, open: p, high: p, low: p, close: p, trades: 0 };
      c.high = Math.max(c.high, p); c.low = Math.min(c.low, p); c.close = p; c.trades++; buckets.set(time, c);
    }
    return [...buckets.values()].slice(-Math.max(1, Math.min(500, limit))).map(c => ({ ...c, open: String(c.open), high: String(c.high), low: String(c.low), close: String(c.close) }));
  }
  /** Largest wallet holders (curve vault and PumpSwap pool excluded), cached for a minute. */
  async holders(mint) {
    const hit = this.holderCache.get(mint);
    if (hit && Date.now() - hit.at < 60_000) return hit.rows;
    const token = this.token(mint);
    if (!token) return [];
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
  status() {
    const cursor = this.db.prepare('SELECT signature, slot FROM cursor WHERE id=1').get();
    return { network: this.network.key, programId: this.deployment.programId, tokens: this.db.prepare('SELECT COUNT(*) n FROM tokens').get().n, trades: this.db.prepare('SELECT COUNT(*) n FROM trades').get().n, cursorSlot: cursor?.slot ?? null, lastSuccess: this.lastSuccess, error: this.lastError, errorPhase: this.lastErrorPhase ?? null, backend: 'SQLite WAL' };
  }
  close() { this.db.close(); }
}
