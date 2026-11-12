// ELPIDA V2 keeper on Solana (docs/V2_0_SOLANA.md, step 4b-1). Runs only with ELPIDA_V2_KEEPER_SOLANA_KEY and a
// deployment that recorded `v2` (npm run solana:deploy -- --v2). Every job is idempotent and safe to repeat:
//  - fees (daily): `withdraw_v2_fees` for every V2 pool that owes the vaults anything (permissionless; destinations fixed);
//  - harvest (daily): five-way harvest of graduated V2 pools' locked-position fees (Raydium for SOL, PumpSwap otherwise);
//  - sweep (daily): the airdrop and holder vaults' wrapped SOL becomes plain SOL (`sweep_v2_sol`), so rounds pay SOL;
//  - flywheel (daily, operator): buys and burns up to ten V2 tokens at least a day old, ranked by reserve, each order a
//    tenth of 10% of the flywheel vault (the program also refuses anything above 10%, younger than a day, within 6 hours
//    of the last order, or that would complete a curve), with 1% slippage from a live quote.
// The keeper key pays network fees only; reward funds stay in the program's vault PDAs.
//  - airdrop (monthly, operator) and holder (weekly, operator) rounds, step 4b-2: the same plans as EVM
//    (packages/core/v2-keeper-plan.mjs: 20% equal / 40% square root / 40% pro rata, 1% cap, $1 minimum carried, creator-
//    linked wallets excluded). The list is posted as a Merkle root, published at /api/public/v2-rewards/solana-manifest,
//    and every leaf is then paid by the keeper (anyone may pay one). SOL is paid natively from the vault PDA.
//    Holder weights come from daily holder snapshots (a wallet must appear in two to count), the Solana stand-in for
//    EVM's transfer history.
import { KeeperLease, safeError } from '../../packages/core/keeper-lease.mjs';
import { DatabaseSync } from 'node:sqlite';
import * as web3 from '@solana/web3.js';
import { createElpidaSolana, v2Owed, parseAmount, TOKEN_DECIMALS, quoteBuy, raydiumQuote, ownFeeBps, tradeFeeBps, POOL_SIZE_V2, STATUS_TRADING, STATUS_MIGRATED, WSOL_MINT, V2_DIST, V2_WITHDRAW_COMPUTE_UNITS, HARVEST_COMPUTE_UNITS, RAYDIUM_SWAP_COMPUTE_UNITS, explainError } from '../../packages/solana/client.mjs';
import { send } from '../../packages/solana/deploy.mjs';
import { buildSolanaRound, solanaRoundStart, solanaCurrentRound } from '../../packages/solana/v2-rounds.mjs';
import { airdropRound, HOLDER_RULES, linkGroups, latestJobs } from '../../packages/core/v2-keeper-plan.mjs';
import { allocateAirdrop, walletPayouts } from '../../packages/core/v2-airdrop.mjs';

const DAY = 86_400;
const { PublicKey, Keypair } = web3;
export const SOLANA_FLYWHEEL = Object.freeze({ slots: 10, shareBps: 1_000n, slippageBps: 100n, minAgeSecs: DAY });

const EMPTY_RENT = 890_880n;

/**
 * Holder rewards from daily snapshots: a wallet's weight is the sum of its balances over the round's snapshots, and it
 * counts only if it appears in at least two (held across a day). Then the same 20/40/40 blend and 1% cap as the
 * airdrop, linked wallets as one, creator-linked and program wallets excluded.
 */
export function snapshotHolderRound({ snapshots, pool, excluded = [], links = [], creatorLinked = [], rules = HOLDER_RULES }) {
  const skip = new Set(excluded), seen = new Map(), weights = new Map();
  for (const s of snapshots) for (const [w, v] of s.holders) { if (skip.has(w) || v <= 0n) continue; seen.set(w, (seen.get(w) ?? 0) + 1); weights.set(w, (weights.get(w) ?? 0n) + v); }
  const eligible = [...weights].filter(([w]) => seen.get(w) >= 2);
  const { groupOf, isCreatorLinked } = linkGroups(eligible.map(([w]) => w), { links, creatorLinked });
  const groups = new Map(), wallets = [];
  for (const [w, v] of eligible) { if (isCreatorLinked(w)) continue; const g = groupOf(w); groups.set(g, (groups.get(g) ?? 0n) + v); wallets.push({ wallet: w, group: g, fees: v }); }
  const { allocations } = allocateAirdrop(pool, [...groups].map(([id, fees]) => ({ id, fees })), rules);
  const { payouts } = walletPayouts(allocations, wallets.filter(w => allocations.has(w.group)), 0n);
  return { payouts, holders: groups.size };
}

export class SolanaV2Keeper {
  /** `deployment`: the served Solana deployment (programId, v2). `payer`: the keeper Keypair. */
  /** `index()`: the Solana public index (trades, tokens, holders) or null; `solUsd()`: fresh SOL/USD or null. */
  constructor({ connection, payer, deployment, path = ':memory:', now = () => Math.floor(Date.now() / 1000), log = () => {}, tickMs = 300_000, cluster = 'devnet', sendTx = send, index = () => null, solUsd = () => null, publicUrl = 'https://elpida.fun', network = 'testnet', distributions = network !== 'mainnet', leaseTtl = 15 * 60 }) {
    Object.assign(this, { connection, payer, deployment, now, log, tickMs, index, solUsd, publicUrl, network, distributions });
    // Every transaction renews the signing lease first (audit BE-01): a second process on the same data never signs.
    this.sendTx = (...args) => { this.lease.renew(); return sendTx(...args); };
    this.client = createElpidaSolana(web3, deployment.programId, { cluster });
    this.config = new PublicKey(deployment.v2.config);
    // Stablecoin payouts (Malik, 10 November): with `v2.usdc` ({ mint, pool }) recorded, each round's SOL is converted
    // to USDC through that Raydium WSOL/USDC pool and the rounds pay USDC.
    const u = deployment.v2.usdc;
    this.usdc = u?.mint && u?.pool ? { mint: new PublicKey(u.mint), pool: new PublicKey(u.pool) } : null;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sv2_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sv2_runs(id INTEGER PRIMARY KEY, job TEXT NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL, detail TEXT);
      CREATE TABLE IF NOT EXISTS sv2_manifests(kind INTEGER NOT NULL, round INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind, round));
      CREATE TABLE IF NOT EXISTS sv2_snapshots(day INTEGER NOT NULL, mint TEXT NOT NULL, holders TEXT NOT NULL, PRIMARY KEY(day, mint));`);
    this.lease = new KeeperLease(this.db, 'sv2_lock', { now, ttl: leaseTtl });
    this.busy = false;
  }

  get(key, fallback) { const r = this.db.prepare('SELECT value FROM sv2_state WHERE key=?').get(key); return r ? JSON.parse(r.value) : fallback; }
  set(key, value) { this.db.prepare('INSERT OR REPLACE INTO sv2_state VALUES(?,?)').run(key, JSON.stringify(value)); }
  record(job, status, detail) {
    if (detail?.error) detail = { ...detail, error: safeError(detail.error) };
    this.db.prepare('INSERT INTO sv2_runs(job,at,status,detail) VALUES(?,?,?,?)').run(job, this.now(), status, detail ? JSON.stringify(detail, (_, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 4000) : null);
    this.log({ event: 'v2_keeper', chain: 'solana', job, status, ...(detail?.error ? { error: String(detail.error).slice(0, 200) } : {}) });
  }
  due(job, every = DAY) { return this.now() - this.get(`${job}:last`, 0) >= every; }
  done(job) { this.set(`${job}:last`, this.now()); }

  start() { if (!this.timer) { this.timer = setInterval(() => this.tick().catch(() => {}), this.tickMs); this.timer.unref?.(); setTimeout(() => this.tick().catch(() => {}), 15_000).unref?.(); } return this; }
  async close() { clearInterval(this.timer); this.timer = null; if (!this.busy) this.lease.release(); }

  async tick() {
    if (this.busy) return; this.busy = true;
    try {
      if (!this.lease.acquire()) { this.idle = 'lease_held_elsewhere'; return; }
      this.idle = null;
      const clean = job => { (this.checked ??= {})[job] = this.now(); };
      // With distributions off (the first mainnet release) only fees and harvests run; the other shares accrue.
      const daily = this.distributions ? ['fees', 'harvest', 'sweep', 'snapshot', 'flywheel'] : ['fees', 'harvest'];
      for (const job of daily) { if (!this.due(job)) continue; try { await this[job](); clean(job); } catch (e) { this.record(job, 'failed', { error: e }); if (e.code === 'lease_lost') return; } }
      for (const job of this.distributions ? ['airdrop', 'holder'] : []) { try { await this[job](); clean(job); } catch (e) { this.record(job, 'failed', { error: e }); if (e.code === 'lease_lost') return; } }
    }
    finally { this.busy = false; }
  }

  /** The pair config with its treasury and token program, as the client's builders take it. */
  async pair() {
    if (this._pair) return this._pair;
    const cfg = this.client.decodeConfig((await this.connection.getAccountInfo(this.config)).data);
    const mint = await this.connection.getAccountInfo(cfg.quoteMint);
    return (this._pair = { address: this.config, quoteMint: cfg.quoteMint, treasury: cfg.treasury, quoteTokenProgram: mint?.owner ?? new PublicKey(this.client.tokenProgram), decimals: cfg.quoteDecimals, raw: cfg });
  }

  /** Every V2 pool of this deployment's V2 pair. */
  async pools() {
    const accounts = await this.connection.getProgramAccounts(this.client.programId, { filters: [{ dataSize: POOL_SIZE_V2 }] });
    return accounts.map(({ pubkey, account }) => ({ pubkey, ...this.client.decodePool(account.data) })).filter(p => p.v2 && p.config.equals(this.config));
  }

  /** Daily: pays every pool's owed shares (creator, three vaults, treasury). */
  async fees() {
    const pair = await this.pair(), paid = [];
    for (const p of await this.pools()) {
      const owed = v2Owed(p.v2);
      if (!owed.some(v => v > 0n)) continue;
      try {
        await this.sendTx(this.connection, this.payer, [this.client.computeBudget(V2_WITHDRAW_COMPUTE_UNITS), this.client.withdrawV2Fees({ payer: this.payer.publicKey, config: pair, mint: p.mint, reward: p.reward })]);
        paid.push(p.mint.toBase58());
      } catch (e) { paid.push({ mint: p.mint.toBase58(), error: explainError(e) }); }
    }
    this.done('fees'); this.record('fees', 'ok', { pools: paid });
  }

  /** Daily: five-way harvest of graduated pools' fee growth (token side burned, quote side into the ledger). */
  async harvest() {
    const pair = await this.pair(), out = [];
    const sol = pair.quoteMint.toBase58() === WSOL_MINT;
    for (const p of (await this.pools()).filter(p => p.status === STATUS_MIGRATED)) {
      const ixs = sol ? this.client.harvestRaydiumFees({ payer: this.payer.publicKey, config: pair, mint: p.mint, reward: p.reward, v2: true })
        : this.client.harvestLpFees({ payer: this.payer.publicKey, config: pair, mint: p.mint, reward: p.reward, v2: true });
      try { await this.sendTx(this.connection, this.payer, [this.client.computeBudget(HARVEST_COMPUTE_UNITS), ...ixs]); out.push(p.mint.toBase58()); }
      catch (e) { if (!/6018|0x1772|No trading fees to harvest/.test(`${e.message} ${(e.logs ?? []).join(' ')}`)) out.push({ mint: p.mint.toBase58(), error: explainError(e) }); }
    }
    this.done('harvest'); this.record('harvest', 'ok', { pools: out });
  }

  /** Daily: wrapped SOL in the airdrop and holder vaults becomes plain SOL, which SOL rounds pay from. */
  async sweep() {
    const swept = [];
    for (const kind of [V2_DIST.airdrop, V2_DIST.holder]) {
      const vault = this.client.distVault(kind), wsol = this.client.ata(vault, new PublicKey(WSOL_MINT));
      const info = await this.connection.getAccountInfo(wsol);
      if (!info || this.client.tokenAmount(info.data) === 0n) continue;
      await this.sendTx(this.connection, this.payer, [this.client.sweepV2Sol({ kind })]);
      swept.push(kind === V2_DIST.airdrop ? 'airdrop' : 'holder');
    }
    this.done('sweep'); this.record('sweep', 'ok', { swept });
  }

  /** The flywheel's plan for now: tokens at least a day old, by reserve, at most ten, equal slices of 10% of the vault. */
  plan(pools, vaultBalance, now) {
    const eligible = pools.filter(p => (p.status === STATUS_TRADING || p.status === STATUS_MIGRATED) && now - Number(p.createdAt) >= SOLANA_FLYWHEEL.minAgeSecs)
      .sort((a, b) => (b.realQuote > a.realQuote ? 1 : b.realQuote < a.realQuote ? -1 : 0)).slice(0, SOLANA_FLYWHEEL.slots);
    if (!eligible.length || vaultBalance <= 0n) return [];
    const each = vaultBalance * SOLANA_FLYWHEEL.shareBps / 10_000n / BigInt(eligible.length);
    return each > 0n ? eligible.map(p => ({ pool: p, amountIn: each })) : [];
  }

  /** Daily, operator: buy-and-burn orders through the curve or the Raydium pool. */
  async flywheel() {
    const pair = await this.pair(), now = this.now(), fly = this.client.v2VaultPda('flywheel');
    const balance = this.client.tokenAmount((await this.connection.getAccountInfo(this.client.ata(fly, pair.quoteMint, pair.quoteTokenProgram)))?.data);
    const orders = this.plan(await this.pools(), balance, now), done = [];
    for (const { pool, amountIn } of orders) {
      try {
        if (pool.status === STATUS_TRADING) {
          const q = quoteBuy(pool, amountIn, tradeFeeBps(pair.raw, pool, BigInt(now)), BigInt(ownFeeBps(pair.raw, pool)));
          if (q.graduates) { done.push({ mint: pool.mint.toBase58(), skipped: 'would complete the curve' }); continue; }
          const minOut = q.tokens * (10_000n - SOLANA_FLYWHEEL.slippageBps) / 10_000n;
          await this.sendTx(this.connection, this.payer, [this.client.computeBudget(), this.client.v2FlywheelCurve({ operator: this.payer.publicKey, config: pair, mint: pool.mint, amountIn, minOut })]);
        } else {
          if (pair.quoteMint.toBase58() !== WSOL_MINT) { done.push({ mint: pool.mint.toBase58(), skipped: 'no flywheel route on PumpSwap yet' }); continue; }
          const r = this.client.raydiumAccounts(pool.mint), [poolInfo, v0, v1] = await this.connection.getMultipleAccountsInfo([r.pool, r.vault0, r.vault1]);
          const st = this.client.raydiumState(poolInfo.data, v0.data, v1.data, pool.mint), { out } = raydiumQuote(amountIn, st.quote, st.base);
          const minOut = out * (10_000n - SOLANA_FLYWHEEL.slippageBps) / 10_000n;
          await this.sendTx(this.connection, this.payer, [this.client.computeBudget(RAYDIUM_SWAP_COMPUTE_UNITS + 100_000), ...this.client.v2FlywheelRaydium({ operator: this.payer.publicKey, config: pair, mint: pool.mint, amountIn, minOut })]);
        }
        done.push({ mint: pool.mint.toBase58(), spent: amountIn });
      } catch (e) { done.push({ mint: pool.mint.toBase58(), skipped: explainError(e) }); }
    }
    this.done('flywheel'); this.record('flywheel', 'ok', { orders: done });
  }

  // ---------- reward rounds (step 4b-2) ----------

  /** A distributor's schedule ({ period, genesis }), read once. */
  async schedule(kind) {
    this._sched ??= {};
    if (!this._sched[kind]) this._sched[kind] = this.client.decodeV2Distributor((await this.connection.getAccountInfo(this.client.v2DistPda(kind))).data);
    return this._sched[kind];
  }

  /** Native SOL a distributor can still promise: its vault's lamports less the account's rent and what rounds owe. */
  async solAvailable(kind) {
    const vault = this.client.distVault(kind), wsol = new PublicKey(WSOL_MINT);
    const [lamports, ledger] = await Promise.all([this.connection.getBalance(vault), this.connection.getAccountInfo(this.client.v2LedgerPda(kind, wsol))]);
    const free = BigInt(lamports) - EMPTY_RENT - this.client.decodeV2Ledger(ledger?.data).reserved;
    return free > 0n ? free : 0n;
  }

  /** V2 tokens of this pair in the index, with their creator-linked wallets (creator and reward wallet). */
  v2Tokens() {
    const index = this.index(); if (!index) return [];
    return index.tokens().filter(t => t.config === this.config.toBase58());
  }

  /** USDC a distributor can still promise: its vault's USDC less what posted USDC rounds owe. */
  async usdcAvailable(kind) {
    const vault = this.client.distVault(kind), [account, ledger] = await this.connection.getMultipleAccountsInfo([this.client.ata(vault, this.usdc.mint), this.client.v2LedgerPda(kind, this.usdc.mint)]);
    const free = this.client.tokenAmount(account?.data) - this.client.decodeV2Ledger(ledger?.data).reserved;
    return free > 0n ? free : 0n;
  }

  /**
   * Converts `lamports` of distributor `kind`'s unpromised SOL into USDC (at least 97% of the pool's quote). Returns the
   * USDC received, or 0 when the amount is too small to matter or the pool cannot take it (the SOL then stays).
   */
  async toUsdc(kind, lamports) {
    if (lamports < 1_000_000n) return 0n;
    const r = this.client.raydiumStablePool(this.usdc.pool, this.usdc.mint), [v0, v1] = await this.connection.getMultipleAccountsInfo([r.vault0, r.vault1]);
    const [a0, a1] = [this.client.tokenAmount(v0?.data), this.client.tokenAmount(v1?.data)], [usdcReserve, solReserve] = r.usdcIs0 ? [a0, a1] : [a1, a0];
    if (usdcReserve <= 0n || solReserve <= 0n) return 0n;
    // At most 2% of the pool's SOL per conversion, and only at a fair price: the pool must pay at least 95% of SOL/USD.
    // Otherwise the SOL stays (and is paid out later or as SOL); a thin or off-price pool never eats the rewards.
    const cap = solReserve / 50n; if (lamports > cap) lamports = cap;
    if (lamports < 1_000_000n) return 0n;
    const quoted = raydiumQuote(lamports, solReserve, usdcReserve).out, minOut = quoted * 97n / 100n, usd = this.solUsd?.();
    if (!(usd > 0)) throw new Error('no fresh SOL/USD price; SOL kept until there is one');
    const fair = BigInt(Math.floor(Number(lamports) * usd / 1000));
    if (quoted * 100n < fair * 95n) throw new Error(`the USDC pool pays $${(Number(quoted) * 1000 / Number(lamports)).toFixed(2)} per SOL against SOL/USD $${usd.toFixed(2)}; SOL kept until the pool is rebalanced`);
    if (minOut <= 0n) return 0n;
    const before = await this.usdcAvailable(kind);
    await this.sendTx(this.connection, this.payer, [this.client.computeBudget(400_000), ...this.client.v2ConvertUsdc({ operator: this.payer.publicKey, kind, config: this.config, usdcMint: this.usdc.mint, pool: this.usdc.pool, amountIn: lamports, minOut })]);
    return (await this.usdcAvailable(kind)) - before;
  }

  /** Posts one round's list, publishes it, then pays every leaf. `payouts`: Map wallet (base58) → base units of `asset` (SOL by default). */
  async post(kind, round, payouts, asset = new PublicKey(WSOL_MINT)) {
    const wsol = asset, rows = [...payouts].filter(([, v]) => v > 0n).map(([w, v]) => [new PublicKey(w), v]);
    if (!rows.length) return { posted: false };
    const list = buildSolanaRound({ programId: this.client.programId, kind, round, asset: wsol }, rows);
    const manifest = { program: this.client.programId.toBase58(), kind, round, asset: wsol.toBase58(), root: Buffer.from(list.root).toString('hex'), total: list.total.toString(),
      rows: list.rows.map(r => ({ index: r.index, account: r.account.toBase58(), amount: r.amount.toString(), proof: r.proof.map(p => Buffer.from(p).toString('hex')) })) };
    this.db.prepare('INSERT OR REPLACE INTO sv2_manifests VALUES(?,?,?)').run(kind, round, JSON.stringify(manifest));
    const uri = `${this.publicUrl}/api/public/v2-rewards/solana-manifest/${kind}/${round}`;
    if (!await this.connection.getAccountInfo(this.client.v2RoundPda(kind, wsol, round))) {
      await this.sendTx(this.connection, this.payer, [this.client.computeBudget(), this.client.postV2Root({ operator: this.payer.publicKey, kind, round, asset: wsol, root: list.root, total: list.total, recipients: list.recipients, manifestUri: uri })]);
    }
    let paid = 0, failed = 0;
    for (const r of list.rows) {
      try { await this.sendTx(this.connection, this.payer, [this.client.claimV2({ payer: this.payer.publicKey, kind, round, asset: wsol, index: r.index, account: r.account, amount: r.amount, proof: r.proof })]); paid++; }
      catch (e) { if (/0x179d|already claimed/i.test(`${e.message} ${(e.logs ?? []).join(' ')}`)) paid++; else failed++; }
    }
    return { posted: true, recipients: list.recipients, total: list.total, paid, failed };
  }

  manifest(kind, round) { const r = this.db.prepare('SELECT data FROM sv2_manifests WHERE kind=? AND round=?').get(Number(kind), Number(round)); return r ? JSON.parse(r.data) : null; }

  /** Monthly: the trader airdrop for every ended round not yet done, from indexed trades of V2 tokens. */
  async airdrop() {
    const index = this.index(); if (!index) return;
    const kind = V2_DIST.airdrop, d = await this.schedule(kind), current = solanaCurrentRound(d, this.now());
    for (let round = this.get('airdrop:next', 0); round < current; round++) {
      const start = solanaRoundStart(d, round), end = solanaRoundStart(d, round + 1), usd = this.solUsd();
      if (!usd) { this.record('airdrop', 'waiting', { round, reason: 'no fresh SOL/USD price' }); return; }
      await this.fees(); await this.harvest(); await this.sweep();
      const tokens = this.v2Tokens(), mints = new Set(tokens.map(t => t.address)), creatorLinked = tokens.flatMap(t => [t.creator, t.reward]).filter(Boolean);
      const trades = index.tradesBetween(start, end).filter(t => mints.has(t.token) && t.account).map(t => ({ ...t, asset: WSOL_MINT, quoteDecimals: 9, quoteUsd: Number(t.quoteAmount ?? 0) * usd }));
      const carried = Object.fromEntries(Object.entries(this.get('airdrop:carried', {})).map(([a, m]) => [a, new Map(Object.entries(m).map(([k, v]) => [k, BigInt(v)]))]));
      // Paid in USDC when configured: the round's free SOL is converted first; carried amounts are then USDC.
      const asset = this.usdc ? this.usdc.mint.toBase58() : WSOL_MINT;
      let converted = 0n;
      if (this.usdc) { try { converted = await this.toUsdc(kind, await this.solAvailable(kind)); } catch (e) { this.record('airdrop', 'warning', { round, error: `USDC conversion: ${e.message}` }); } }
      const held = [...(carried[asset]?.values() ?? [])].reduce((x, y) => x + y, 0n), avail = this.usdc ? await this.usdcAvailable(kind) : await this.solAvailable(kind);
      const plan = airdropRound({ trades, start, end, usdPerUnit: a => (a === asset && this.usdc ? 1 : usd), firstSeen: a => index.firstSeen(a), pools: avail > held ? { [asset]: avail - held } : {}, carried, creatorLinked, decimals: this.usdc ? { [asset]: 6 } : {} });
      const p = plan.byAsset[asset], result = p ? await this.post(kind, round, p.payouts, new PublicKey(asset)) : { posted: false };
      if (p) this.set('airdrop:carried', { [asset]: Object.fromEntries([...p.carried].map(([k, v]) => [k, v.toString()])) });
      if (this.usdc) result.usdcConverted = converted;
      this.set('airdrop:next', round + 1);
      this.record('airdrop', 'ok', { round, qualified: plan.qualified.length, ...result });
    }
  }

  /** Daily: every V2 token's holders, the basis of time-weighted holder rewards. */
  async snapshot() {
    const index = this.index(); if (!index) return;
    const day = Math.floor(this.now() / DAY);
    for (const t of this.v2Tokens()) {
      // The index lists owners with formatted balances (6 decimals); stored raw.
      const holders = (await index.allHolders(t.address)).map(h => [h.address, parseAmount(String(h.balance), TOKEN_DECIMALS).toString()]).filter(([a, v]) => a && v !== '0');
      this.db.prepare('INSERT OR REPLACE INTO sv2_snapshots VALUES(?,?,?)').run(day, t.address, JSON.stringify(holders));
    }
    this.done('snapshot'); this.record('snapshot', 'ok', { tokens: this.v2Tokens().length });
  }

  /** Weekly: holders of tokens whose holder share since the last payout reached the threshold. */
  async holder() {
    const index = this.index(); if (!index) return;
    const kind = V2_DIST.holder, d = await this.schedule(kind), current = solanaCurrentRound(d, this.now());
    for (let round = this.get('holder:next', 0); round < current; round++) {
      const start = solanaRoundStart(d, round), end = solanaRoundStart(d, round + 1), usd = this.solUsd();
      if (!usd) { this.record('holder', 'waiting', { round, reason: 'no fresh SOL/USD price' }); return; }
      await this.fees(); await this.harvest(); await this.sweep();
      const done = this.get('holder:distributed', {}), threshold = HOLDER_RULES.thresholdUsd[this.network] ?? HOLDER_RULES.thresholdUsd.testnet;
      const pools = new Map((await this.pools()).map(p => [p.mint.toBase58(), p]));
      let budget = await this.solAvailable(kind);
      const merged = new Map(), stats = [];
      for (const t of this.v2Tokens()) {
        const p = pools.get(t.address); if (!p) continue;
        const earned = p.v2.accrued * 1_000n / 10_000n, pending = earned - BigInt(done[t.address] ?? 0);
        if (pending <= 0n || Number(pending) / 1e9 * usd < threshold || pending > budget) continue;
        const plan = snapshotHolderRound({ snapshots: this.snapshots(t.address, start, end), pool: pending, excluded: [p.pubkey.toBase58(), this.client.lpAuthorityPda(p.mint).toBase58(), ...[V2_DIST.airdrop, V2_DIST.holder].map(k => this.client.distVault(k).toBase58()), this.client.v2VaultPda('flywheel').toBase58()], creatorLinked: [t.creator, t.reward].filter(Boolean) });
        if (!plan.payouts.size) continue;
        for (const [k, v] of plan.payouts) merged.set(k, (merged.get(k) ?? 0n) + v);
        done[t.address] = (BigInt(done[t.address] ?? 0) + pending).toString(); budget -= pending;
        stats.push({ token: t.address, holders: plan.holders });
      }
      let result;
      if (this.usdc && merged.size) {
        // Convert exactly what is due, then scale each holder's SOL amount to the USDC received.
        const due = [...merged.values()].reduce((x, y) => x + y, 0n);
        let got = 0n;
        try { got = await this.toUsdc(kind, due); } catch (e) { this.record('holder', 'warning', { round, error: `USDC conversion: ${e.message}` }); }
        if (got > 0n) {
          const usdcPayouts = new Map(); let given = 0n; const entries = [...merged];
          for (const [i, [w, v]] of entries.entries()) { const part = i + 1 === entries.length ? got - given : got * v / due; given += part; if (part > 0n) usdcPayouts.set(w, part); }
          result = { ...(await this.post(kind, round, usdcPayouts, this.usdc.mint)), usdcConverted: got };
        } else { this.record('holder', 'waiting', { round, reason: 'USDC conversion did not go through; the SOL stays for the next round' }); return; }
      } else result = merged.size ? await this.post(kind, round, merged) : { posted: false };
      this.set('holder:distributed', done); this.set('holder:next', round + 1);
      this.record('holder', 'ok', { round, tokens: stats, ...result });
    }
  }

  /** Daily snapshots of one token's holders within [start, end). */
  snapshots(mint, start, end) {
    return this.db.prepare('SELECT day, holders FROM sv2_snapshots WHERE mint=? AND day>=? AND day<? ORDER BY day').all(mint, Math.floor(start / DAY), Math.floor(end / DAY)).map(r => ({ day: r.day, holders: new Map(JSON.parse(r.holders).map(([a, v]) => [a, BigInt(v)])) }));
  }

  status() {
    return { chain: this.deployment.cluster ?? 'solana', keeper: this.payer.publicKey.toBase58(), distributions: this.distributions, idle: this.idle ?? null, airdropNext: this.get('airdrop:next', 0), holderNext: this.get('holder:next', 0), runs: this.db.prepare('SELECT job,at,status FROM sv2_runs ORDER BY id DESC LIMIT 8').all(), jobs: latestJobs(this.db.prepare('SELECT job,at,status,detail FROM sv2_runs WHERE id IN (SELECT MAX(id) FROM sv2_runs GROUP BY job) ORDER BY job').all(), this.checked ?? {}) };
  }
}

/**
 * On only with ELPIDA_V2_KEEPER_SOLANA_KEY (a keypair JSON byte array) and a deployment that recorded `v2` whose
 * distributors this key operates. Never on mainnet without its own approval.
 */
export function configuredSolanaV2Keeper({ env, net, connection, path, log, index = () => null, solUsd = () => null, publicUrl }) {
  const raw = env.ELPIDA_V2_KEEPER_SOLANA_KEY, d = net?.deployment;
  const off = state => ({ enabled: false, status: () => ({ enabled: false, state }), start() { return this; }, close: async () => {} });
  if (!raw) return off('not_configured');
  let payer;
  try { payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw))); } catch { return off('invalid_key'); }
  if (net.mainnet) return off('mainnet_needs_approval');
  if (!d?.v2?.config) return { ...off('waiting_for_v2_setup'), address: payer.publicKey.toBase58() };
  const keeper = new SolanaV2Keeper({ connection, payer, deployment: d, path, log, index, solUsd, publicUrl, cluster: net.cluster === 'mainnet' ? 'mainnet' : 'devnet' });
  keeper.enabled = true; keeper.address = payer.publicKey.toBase58();
  return keeper;
}
