// ELPIDA V2 rewards on Solana for the analytics page (docs/V2_0_SOLANA.md, step 4c): the same chain summary the EVM
// rewards index gives (/api/public/v2-rewards), read from the Solana program's accounts once a minute:
//  - each vault's size: what it has earned (its share of every V2 pool's fee ledger) less what it has paid out
//    (claimed round payouts; flywheel spending);
//  - a daily series of those sizes, sampled by this server (from the day it starts);
//  - posted rounds (V2Round accounts), with per-round payout statistics when this server's keeper published the list;
//  - the flywheel's per-token spending and burns (V2FlywheelOrder accounts), which also tag tokens on Explore.
// Amounts are lamports of SOL (the V2 pair on Solana); USD only with a fresh price. Hidden when V2 is not set up.
import { DatabaseSync } from 'node:sqlite';
import * as web3 from '@solana/web3.js';
import { createElpidaSolana, DISCRIMINATORS, POOL_SIZE_V2, WSOL_MINT, V2, V2_DIST, v2Owed } from '../../packages/solana/client.mjs';
import { schedule, countdown, roundStats } from '../../packages/core/v2-rounds.mjs';

const { PublicKey } = web3;
const DAY = 86_400, TICK_MS = 60_000;
const ROUND_FIXED = 8 + 1 + 4 + 32 + 32 + 8 + 8 + 4 + 8 + 1 + 1;
const bs58 = bytes => new PublicKey(bytes).toBase58();
const u64 = (b, o) => new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(o, true);
const share = (accrued, i) => BigInt(accrued) * BigInt(V2.split[i]) / 10_000n;
const SHARE = { airdrop: 1, flywheel: 2, holder: 3 };

/** A V2Round account: kind, round, asset, total, claimed, recipients, postedAt, expired, and the claim bitmap. */
export function decodeV2Round(raw) {
  const b = new Uint8Array(raw), view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { kind: b[8], round: view.getUint32(9, true), asset: bs58(b.subarray(13, 45)), total: u64(b, 77), claimed: u64(b, 85), recipients: view.getUint32(93, true),
    postedAt: Number(view.getBigInt64(97, true)), expired: b[105] === 1, paid: index => ((b[ROUND_FIXED + (index >> 3)] ?? 0) >> (index & 7)) & 1 };
}
/** A V2FlywheelOrder account: last order time, orders, quote spent, tokens burned. */
export function decodeFlywheelOrder(raw) {
  const b = new Uint8Array(raw), view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { lastAt: Number(view.getBigInt64(8, true)), orders: view.getUint32(16, true), spent: u64(b, 20), burned: u64(b, 28) };
}

export class SolanaV2Rewards {
  /** `net`: the served Solana network with `deployment.v2`; `manifest(kind, round)`: the keeper's published lists. */
  constructor({ connection, net, path = ':memory:', now = () => Math.floor(Date.now() / 1000), manifest = () => null, log = () => {} }) {
    Object.assign(this, { connection, net, now, manifest, log });
    this.deployment = net.deployment;
    this.client = createElpidaSolana(web3, this.deployment.programId, { cluster: net.mainnet ? 'mainnet' : 'devnet' });
    this.config = new PublicKey(this.deployment.v2.config);
    // Stablecoin payouts: rounds in USDC, and each distributor's USDC (converted from its SOL) is part of its vault.
    this.usdcMint = this.deployment.v2.usdc?.mint ?? null;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS sr_series(day INTEGER NOT NULL, kind TEXT NOT NULL, size TEXT NOT NULL, PRIMARY KEY(day, kind));`);
    this.state = null; this.error = null; this.lastSync = null;
  }
  start() { const run = () => this.sync().catch(e => { this.error = e.message; this.log({ event: 'solana_v2_rewards_error', message: String(e.message).slice(0, 200) }); }); run(); this.timer = setInterval(run, TICK_MS); this.timer.unref?.(); return this; }
  stop() { clearInterval(this.timer); }

  async sync() {
    const c = this.client, programId = c.programId;
    const [poolAccounts, roundAccounts, distInfos] = await Promise.all([
      this.connection.getProgramAccounts(programId, { filters: [{ dataSize: POOL_SIZE_V2 }] }),
      this.connection.getProgramAccounts(programId, { filters: [{ memcmp: { offset: 0, bytes: bs58Disc(DISCRIMINATORS.V2Round) } }] }),
      this.connection.getMultipleAccountsInfo([c.v2DistPda(V2_DIST.airdrop), c.v2DistPda(V2_DIST.holder)]),
    ]);
    const pools = poolAccounts.map(({ account }) => c.decodePool(account.data)).filter(p => p.v2 && p.config.equals(this.config));
    const rounds = roundAccounts.map(({ account }) => decodeV2Round(account.data)).filter(r => r.asset === WSOL_MINT || (this.usdcMint && r.asset === this.usdcMint));
    const flyKeys = pools.map(p => c.v2FlyPda(p.mint)), flyInfos = flyKeys.length ? await this.connection.getMultipleAccountsInfo(flyKeys) : [];
    const orders = pools.map((p, i) => ({ mint: p.mint.toBase58(), ...(flyInfos[i] ? decodeFlywheelOrder(flyInfos[i].data) : { orders: 0, spent: 0n, burned: 0n, lastAt: 0 }) }));
    const earned = Object.fromEntries(Object.entries(SHARE).map(([k, i]) => [k, pools.reduce((t, p) => t + share(p.v2.accrued, i), 0n)]));
    const paid = kind => rounds.filter(r => r.kind === kind && r.asset === WSOL_MINT).reduce((t, r) => t + r.claimed, 0n);
    const sizes = { airdrop: earned.airdrop - paid(V2_DIST.airdrop), holder: earned.holder - paid(V2_DIST.holder), flywheel: earned.flywheel - orders.reduce((t, o) => t + o.spent, 0n) };
    const usdcSizes = {};
    if (this.usdcMint) {
      // With conversions, a distributor's SOL is what its vault holds plus what pools still owe it; its USDC is its USDC account.
      const mint = new PublicKey(this.usdcMint), kinds = [['airdrop', V2_DIST.airdrop], ['holder', V2_DIST.holder]];
      const infos = await this.connection.getMultipleAccountsInfo(kinds.flatMap(([, k]) => [c.distVault(k), c.ata(c.distVault(k), mint)]));
      for (const [i, [name]] of kinds.entries()) {
        const owed = pools.reduce((t, p) => t + v2Owed(p.v2)[SHARE[name]], 0n), lamports = BigInt(infos[2 * i]?.lamports ?? 0);
        sizes[name] = owed + (lamports > 890_880n ? lamports - 890_880n : 0n);
        usdcSizes[name] = c.tokenAmount(infos[2 * i + 1]?.data);
      }
    }
    const day = this.now() - this.now() % DAY;
    for (const [kind, size] of Object.entries(sizes)) this.db.prepare('INSERT OR REPLACE INTO sr_series VALUES(?,?,?)').run(day, kind, (size > 0n ? size : 0n).toString());
    const schedules = distInfos.map(info => (info ? c.decodeV2Distributor(info.data) : null));
    // Every V2 fee so far (SOL) and the creators' share (index 0 of the split), for the analytics headline.
    const fees = { total: pools.reduce((t, p) => t + BigInt(p.v2.accrued), 0n), creator: pools.reduce((t, p) => t + share(p.v2.accrued, 0), 0n), tokens: pools.length };
    this.state = { pools: pools.length, rounds, orders, sizes, usdcSizes, schedules, fees };
    this.lastSync = Date.now(); this.error = null;
  }

  series(kind) { return this.db.prepare('SELECT day, size FROM sr_series WHERE kind=? ORDER BY day').all(kind).map(r => ({ day: r.day, size: BigInt(r.size) })); }

  /** Tokens the V2 flywheel bought and burned (mint → base units, 6 decimals). */
  burnedByToken() { return new Map((this.state?.orders ?? []).filter(o => o.burned > 0n).map(o => [o.mint, o.burned])); }

  /** The chain object for /api/public/v2-rewards, in the EVM rewards index's shape; null when nothing is known yet. */
  summary(prices = {}) {
    if (!this.state) return null;
    const now = this.now(), p = prices[this.net.key], fresh = p?.status === 'fresh' && p.usd > 0;
    const vault = kind => ({ assets: [{ asset: WSOL_MINT, size: this.state.sizes[kind] > 0n ? this.state.sizes[kind] : 0n, series: this.series(kind) },
      ...(this.usdcMint && kind in (this.state.usdcSizes ?? {}) ? [{ asset: this.usdcMint, size: this.state.usdcSizes[kind], series: [] }] : [])] });
    const distributor = (name, kind) => {
      const d = this.state.schedules[kind];
      const s = d ? { period: d.period, genesis: d.genesis, claimWindowRounds: 12 } : null;
      let sched = null; try { sched = s ? schedule(s) : null; } catch { sched = null; }
      const rounds = this.state.rounds.filter(r => r.kind === kind).sort((a, b) => b.round - a.round).map(r => {
        const m = this.manifest(kind, r.round), amounts = m ? m.rows.filter(x => r.paid(x.index)).map(x => BigInt(x.amount)) : [];
        const paidRecipients = m ? amounts.length : (r.claimed === r.total ? r.recipients : 0);
        return { round: r.round, asset: r.asset, total: r.total, recipients: r.recipients, paidRecipients, claimed: r.claimed, unclaimed: r.expired ? 0n : r.total - r.claimed, failed: 0, expired: r.expired,
          postedAt: r.postedAt, postTx: null, manifestURI: m ? `/api/public/v2-rewards/solana-manifest/${kind}/${r.round}` : null,
          start: sched ? sched.start(r.round) : null, end: sched ? sched.end(r.round) : null, stats: roundStats(amounts, r.asset === WSOL_MINT ? 10n ** 9n : 10n ** 6n) };
      });
      return { schedule: s, countdown: sched ? countdown(sched, now) : null, ...vault(name), rounds };
    };
    const burned = this.burnedByToken();
    return {
      key: this.net.key, name: this.net.name, explorer: null, testnet: !this.net.mainnet,
      assets: { [WSOL_MINT]: { symbol: 'SOL', decimals: 9, usd: fresh ? p.usd : null }, ...(this.usdcMint ? { [this.usdcMint]: { symbol: 'USDC', decimals: 6, usd: 1 } } : {}) },
      fees: this.state.fees ? [{ asset: WSOL_MINT, ...this.state.fees }] : [],
      airdrop: distributor('airdrop', V2_DIST.airdrop), holder: distributor('holder', V2_DIST.holder),
      flywheel: { ...vault('flywheel'), burns: [], burnedByToken: [...burned].map(([token, amount]) => ({ token, amount })), spentByAsset: [{ asset: WSOL_MINT, amount: this.state.orders.reduce((t, o) => t + o.spent, 0n) }], cycles: this.state.orders.reduce((t, o) => t + o.orders, 0) },
      status: { lastSync: this.lastSync, error: this.error, pools: this.state.pools },
    };
  }
}

/** Base58 of an 8-byte account discriminator, for getProgramAccounts memcmp filters. */
function bs58Disc(bytes) {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n; for (const x of bytes) n = n * 256n + BigInt(x);
  let s = ''; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  for (const x of bytes) { if (x) break; s = '1' + s; }
  return s;
}
