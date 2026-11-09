// ELPIDA V2.0 rewards indexer: the figures behind the analytics page's Rewards section, read from chain events only.
//  - the V2 hook:      Launched (each token's quote), Fee (fees at the token's rate), FeesWithdrawn;
//  - the distributors: RootPosted, Claimed, ClaimFailed, Expired (trader airdrop and holder rewards);
//  - the flywheel:     BoughtAndBurned.
// A vault's size is what it has earned so far less what it has paid out: earned is its exact share of every token's
// running fee total (splitAccrued, as the hook computes it), whether or not the hook has paid it over yet. Nothing is
// estimated: a chain without a pinned V2 deployment has no Rewards section at all.
import { Contract, Interface, getAddress } from 'ethers';
import { splitAccrued } from '../core/v2-economics.mjs';
import { schedule, countdown, roundStats } from '../core/v2-rounds.mjs';

export const V2_REWARD_ABIS = Object.freeze({
  hook: ['event Launched(address indexed token,address indexed quote,address indexed creatorVault,uint256 feeBps,int24 upperTick,int24 lowerTick,uint128 saleLiquidity,uint128 upperLiquidity,uint256 dustBurned)',
    'event Fee(address indexed token,address indexed trader,bool buy,uint256 feeBps,uint256 fee,uint256 lockedBonus)',
    'event FeesWithdrawn(address indexed token,uint8 indexed recipient,address to,uint256 amount)'],
  distributor: ['event RootPosted(uint256 indexed round,address indexed asset,bytes32 root,uint256 total,uint256 recipients,string manifestURI)',
    'event Claimed(uint256 indexed round,address indexed asset,address indexed account,uint256 amount)',
    'event ClaimFailed(uint256 indexed round,address indexed asset,address indexed account,uint256 amount)',
    'event Expired(uint256 indexed round,address indexed asset,uint256 returnedToPool)',
    'function period() view returns(uint256)', 'function genesis() view returns(uint256)', 'function CLAIM_WINDOW_ROUNDS() view returns(uint256)'],
  flywheel: ['event BoughtAndBurned(address indexed token,address indexed asset,uint256 indexed cycle,uint256 spent,uint256 burned,uint256 supplyAfter)'],
});

const DAY = 86_400;
/** RPC refusals that mean "ask for fewer blocks": range caps, oversized responses, too many results. */
export const RANGE_LIMIT = /range|too large|413|too many|limit exceeded|query returned more than|block range|exceed/i;
const rpcMessage = e => [e?.message, e?.info?.responseBody, e?.error?.message, e?.shortMessage].filter(Boolean).join(' ');
const SHARE = { airdrop: 'traderAirdrop', holder: 'holderRewards', flywheel: 'flywheel' };
const lower = a => String(a).toLowerCase();

export class V2RewardsIndexer {
  /** `contracts`: { hook, airdrop, holder, flywheel } addresses; `fromBlock`: the deployment block. */
  constructor({ provider, contracts, fromBlock = 0, confirmations = 0, batchSize = 2000 }) {
    this.provider = provider; this.fromBlock = fromBlock; this.confirmations = confirmations; this.batchSize = batchSize;
    this.addresses = Object.fromEntries(Object.entries(contracts).map(([k, v]) => [k, lower(getAddress(v))]));
    this.kinds = new Map(Object.entries(this.addresses).map(([k, v]) => [v, k]));
    this.iface = { hook: new Interface(V2_REWARD_ABIS.hook), airdrop: new Interface(V2_REWARD_ABIS.distributor), holder: new Interface(V2_REWARD_ABIS.distributor), flywheel: new Interface(V2_REWARD_ABIS.flywheel) };
    this.next = fromBlock; this.blockTimes = new Map(); this.reset();
  }

  reset() {
    this.tokens = new Map();        // token → { quote, accrued }
    this.events = [];               // { time, kind, asset, delta } changes to a vault's size, in order
    this.rounds = { airdrop: new Map(), holder: new Map() };
    this.burns = [];
    this.claims = [];
    this.schedules = {};
    this.lastSync = null; this.lastError = null;
  }

  async sync() {
    try {
      for (const kind of ['airdrop', 'holder']) if (this.addresses[kind] && !this.schedules[kind]) {
        const c = new Contract(this.addresses[kind], V2_REWARD_ABIS.distributor, this.provider);
        const [period, genesis, window] = await Promise.all([c.period(), c.genesis(), c.CLAIM_WINDOW_ROUNDS()]);
        this.schedules[kind] = { period: Number(period), genesis: Number(genesis), claimWindowRounds: Number(window) };
      }
      const head = Number(await this.provider.send('eth_blockNumber', [])) - this.confirmations;
      while (this.next <= head) {
        const from = this.next, to = Math.min(head, from + this.batchSize - 1);
        let logs;
        try { logs = await this.provider.getLogs({ address: [...this.kinds.keys()], fromBlock: from, toBlock: to }); }
        catch (e) {
          // Public RPCs cap eth_getLogs ranges (Base Sepolia: 200 blocks, sometimes less). Halve and retry the range.
          if (this.batchSize > 1 && RANGE_LIMIT.test(rpcMessage(e))) { this.batchSize = Math.max(1, Math.floor(this.batchSize / 2)); continue; }
          throw e;
        }
        logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
        for (const log of logs) await this.apply(log);
        this.next = to + 1;
      }
      this.lastSync = Date.now(); this.lastError = null;
    } catch (e) { this.lastError = e.message; throw e; }
    return this.status();
  }

  status() { return { nextBlock: this.next, lastSync: this.lastSync, error: this.lastError }; }

  async time(blockNumber) {
    if (!this.blockTimes.has(blockNumber)) this.blockTimes.set(blockNumber, (await this.provider.getBlock(blockNumber)).timestamp);
    return this.blockTimes.get(blockNumber);
  }

  async apply(log) {
    const kind = this.kinds.get(lower(log.address));
    let ev; try { ev = this.iface[kind].parseLog(log); } catch { return; }
    if (!ev) return;
    const time = await this.time(log.blockNumber), tx = log.transactionHash, a = ev.args;
    if (kind === 'hook' && ev.name === 'Launched') this.tokens.set(lower(a.token), { quote: lower(a.quote), accrued: 0n, feeBps: Number(a.feeBps) });
    if (kind === 'hook' && ev.name === 'Fee') {
      const t = this.tokens.get(lower(a.token)); if (!t) return;
      const before = splitAccrued(t.accrued); t.accrued += a.fee - a.lockedBonus; const after = splitAccrued(t.accrued);
      for (const [vault, key] of Object.entries(SHARE)) if (after[key] > before[key]) this.events.push({ time, kind: vault, asset: t.quote, delta: after[key] - before[key] });
    }
    if ((kind === 'airdrop' || kind === 'holder') && ev.name === 'RootPosted')
      this.rounds[kind].set(`${a.round}:${lower(a.asset)}`, { round: Number(a.round), asset: lower(a.asset), root: a.root, total: a.total, recipients: Number(a.recipients), manifestURI: a.manifestURI, postedAt: time, postTx: tx, paid: [], failed: 0, expired: false });
    if ((kind === 'airdrop' || kind === 'holder') && ev.name === 'Claimed') {
      const r = this.rounds[kind].get(`${a.round}:${lower(a.asset)}`); if (r) r.paid.push(a.amount);
      this.events.push({ time, kind, asset: lower(a.asset), delta: -a.amount });
      this.claims.push({ kind, round: Number(a.round), asset: lower(a.asset), account: lower(a.account), amount: a.amount, time, tx });
    }
    if ((kind === 'airdrop' || kind === 'holder') && ev.name === 'ClaimFailed') { const r = this.rounds[kind].get(`${a.round}:${lower(a.asset)}`); if (r) r.failed++; }
    if ((kind === 'airdrop' || kind === 'holder') && ev.name === 'Expired') { const r = this.rounds[kind].get(`${a.round}:${lower(a.asset)}`); if (r) { r.expired = true; r.returnedToPool = a.returnedToPool; } }
    if (kind === 'flywheel' && ev.name === 'BoughtAndBurned') {
      this.events.push({ time, kind: 'flywheel', asset: lower(a.asset), delta: -a.spent });
      this.burns.push({ token: lower(a.token), asset: lower(a.asset), cycle: Number(a.cycle), spent: a.spent, burned: a.burned, supplyAfter: a.supplyAfter, time, tx });
    }
  }

  /** A vault's size per asset at the end of each UTC day, from its first event to `now`. */
  series(kind, now) {
    const events = this.events.filter(e => e.kind === kind);
    const assets = [...new Set(events.map(e => e.asset))], out = {};
    for (const asset of assets) {
      const mine = events.filter(e => e.asset === asset), points = [];
      let size = 0n, i = 0;
      for (let day = mine[0].time - mine[0].time % DAY; day <= now; day += DAY) {
        while (i < mine.length && mine[i].time < day + DAY) size += mine[i++].delta;
        points.push({ day, size });
      }
      out[asset] = points;
    }
    return out;
  }

  /** Everything the Rewards section shows, at `now` (seconds). Amounts are base units of each asset. */
  summary(now = Math.floor(Date.now() / 1000)) {
    const vault = kind => {
      const series = this.series(kind, now);
      return { assets: Object.entries(series).map(([asset, points]) => ({ asset, size: points.at(-1)?.size ?? 0n, series: points })) };
    };
    const distributor = kind => {
      const s = this.schedules[kind];
      const rounds = [...this.rounds[kind].values()].sort((x, y) => y.round - x.round || (x.asset < y.asset ? -1 : 1)).map(r => {
        const claimed = r.paid.reduce((t, v) => t + v, 0n);
        return { round: r.round, asset: r.asset, total: r.total, recipients: r.recipients, paidRecipients: r.paid.length, claimed, unclaimed: r.total - claimed - (r.returnedToPool ?? 0n), failed: r.failed, expired: r.expired,
          postedAt: r.postedAt, postTx: r.postTx, manifestURI: r.manifestURI, start: s ? schedule(s).start(r.round) : null, end: s ? schedule(s).end(r.round) : null, stats: roundStats(r.paid) };
      });
      return { schedule: s ?? null, countdown: s ? countdown(schedule(s), now) : null, ...vault(kind), rounds };
    };
    const burned = new Map(), spent = new Map();
    for (const b of this.burns) { burned.set(b.token, (burned.get(b.token) ?? 0n) + b.burned); spent.set(b.asset, (spent.get(b.asset) ?? 0n) + b.spent); }
    return {
      airdrop: this.addresses.airdrop ? distributor('airdrop') : null,
      holder: this.addresses.holder ? distributor('holder') : null,
      flywheel: this.addresses.flywheel ? { ...vault('flywheel'), burns: [...this.burns].reverse().slice(0, 50), burnedByToken: [...burned].map(([token, amount]) => ({ token, amount })), spentByAsset: [...spent].map(([asset, amount]) => ({ asset, amount })), cycles: new Set(this.burns.map(b => b.cycle)).size } : null,
      status: this.status(),
    };
  }

  /** Tokens the flywheel vault bought and burned, per token (lowercase address → base units). */
  burnedByToken() {
    const out = new Map();
    for (const b of this.burns) out.set(b.token, (out.get(b.token) ?? 0n) + b.burned);
    return out;
  }

  /** Payouts a wallet has received, newest first. */
  payoutsOf(wallet) {
    const w = lower(wallet);
    return this.claims.filter(c => c.account === w).reverse();
  }
}

/** JSON-safe copy (BigInt as decimal strings) for the public API. */
export const toJson = value => JSON.parse(JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
