// ELPIDA V2 keeper on Solana (docs/V2_0_SOLANA.md, step 4b-1). Runs only with ELPIDA_V2_KEEPER_SOLANA_KEY and a
// deployment that recorded `v2` (npm run solana:deploy -- --v2). Every job is idempotent and safe to repeat:
//  - fees (daily): `withdraw_v2_fees` for every V2 pool that owes the vaults anything (permissionless; destinations fixed);
//  - harvest (daily): five-way harvest of graduated V2 pools' locked-position fees (Raydium for SOL, PumpSwap otherwise);
//  - sweep (daily): the airdrop and holder vaults' wrapped SOL becomes plain SOL (`sweep_v2_sol`), so rounds pay SOL;
//  - flywheel (daily, operator): buys and burns up to ten V2 tokens at least a day old, ranked by reserve, each order a
//    tenth of 10% of the flywheel vault (the program also refuses anything above 10%, younger than a day, within 6 hours
//    of the last order, or that would complete a curve), with 1% slippage from a live quote.
// The keeper key pays network fees only; reward funds stay in the program's vault PDAs.
// Reward rounds (Merkle lists) on Solana arrive in step 4b-2.
import { DatabaseSync } from 'node:sqlite';
import * as web3 from '@solana/web3.js';
import { createElpidaSolana, v2Owed, quoteBuy, raydiumQuote, ownFeeBps, tradeFeeBps, POOL_SIZE_V2, STATUS_TRADING, STATUS_MIGRATED, WSOL_MINT, V2_DIST, V2_WITHDRAW_COMPUTE_UNITS, HARVEST_COMPUTE_UNITS, RAYDIUM_SWAP_COMPUTE_UNITS, explainError } from '../../packages/solana/client.mjs';
import { send } from '../../packages/solana/deploy.mjs';

const DAY = 86_400;
const { PublicKey, Keypair } = web3;
export const SOLANA_FLYWHEEL = Object.freeze({ slots: 10, shareBps: 1_000n, slippageBps: 100n, minAgeSecs: DAY });

export class SolanaV2Keeper {
  /** `deployment`: the served Solana deployment (programId, v2). `payer`: the keeper Keypair. */
  constructor({ connection, payer, deployment, path = ':memory:', now = () => Math.floor(Date.now() / 1000), log = () => {}, tickMs = 300_000, cluster = 'devnet', sendTx = send }) {
    Object.assign(this, { connection, payer, deployment, now, log, tickMs, sendTx });
    this.client = createElpidaSolana(web3, deployment.programId, { cluster });
    this.config = new PublicKey(deployment.v2.config);
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sv2_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sv2_runs(id INTEGER PRIMARY KEY, job TEXT NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL, detail TEXT);`);
    this.busy = false;
  }

  get(key, fallback) { const r = this.db.prepare('SELECT value FROM sv2_state WHERE key=?').get(key); return r ? JSON.parse(r.value) : fallback; }
  set(key, value) { this.db.prepare('INSERT OR REPLACE INTO sv2_state VALUES(?,?)').run(key, JSON.stringify(value)); }
  record(job, status, detail) {
    this.db.prepare('INSERT INTO sv2_runs(job,at,status,detail) VALUES(?,?,?,?)').run(job, this.now(), status, detail ? JSON.stringify(detail, (_, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 4000) : null);
    this.log({ event: 'v2_keeper', chain: 'solana', job, status, ...(detail?.error ? { error: String(detail.error).slice(0, 200) } : {}) });
  }
  due(job, every = DAY) { return this.now() - this.get(`${job}:last`, 0) >= every; }
  done(job) { this.set(`${job}:last`, this.now()); }

  start() { if (!this.timer) { this.timer = setInterval(() => this.tick().catch(() => {}), this.tickMs); this.timer.unref?.(); setTimeout(() => this.tick().catch(() => {}), 15_000).unref?.(); } return this; }
  async close() { clearInterval(this.timer); this.timer = null; }

  async tick() {
    if (this.busy) return; this.busy = true;
    try { for (const job of ['fees', 'harvest', 'sweep', 'flywheel']) { if (!this.due(job)) continue; try { await this[job](); } catch (e) { this.record(job, 'failed', { error: e.message }); } } }
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

  status() {
    return { chain: this.deployment.cluster ?? 'solana', keeper: this.payer.publicKey.toBase58(), runs: this.db.prepare('SELECT job,at,status FROM sv2_runs ORDER BY id DESC LIMIT 8').all() };
  }
}

/**
 * On only with ELPIDA_V2_KEEPER_SOLANA_KEY (a keypair JSON byte array) and a deployment that recorded `v2` whose
 * distributors this key operates. Never on mainnet without its own approval.
 */
export function configuredSolanaV2Keeper({ env, net, connection, path, log }) {
  const raw = env.ELPIDA_V2_KEEPER_SOLANA_KEY, d = net?.deployment;
  const off = state => ({ enabled: false, status: () => ({ enabled: false, state }), start() { return this; }, close: async () => {} });
  if (!raw) return off('not_configured');
  let payer;
  try { payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw))); } catch { return off('invalid_key'); }
  if (net.mainnet) return off('mainnet_needs_approval');
  if (!d?.v2?.config) return { ...off('waiting_for_v2_setup'), address: payer.publicKey.toBase58() };
  const keeper = new SolanaV2Keeper({ connection, payer, deployment: d, path, log, cluster: net.cluster === 'mainnet' ? 'mainnet' : 'devnet' });
  keeper.enabled = true; keeper.address = payer.publicKey.toBase58();
  return keeper;
}
