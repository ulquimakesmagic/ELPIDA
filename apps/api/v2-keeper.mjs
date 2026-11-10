// ELPIDA V2.0 keeper (test networks only until the V2 contracts are audited and Malik approves mainnet). One worker
// per network with a pinned V2 deployment, signing with the dedicated keeper key (ELPIDA_V2_KEEPER_KEY), which is the
// operator of the distributors and the flywheel vault. It never holds reward funds; it only:
//  - pays every V2 token's fees into the five recipients, daily (hook.withdrawFees; anyone may call it);
//  - posts each finished trader-airdrop round (monthly) and holder-reward round (weekly) and pushes every payout;
//  - runs a flywheel cycle daily (buy-and-burn of the top tokens);
// with the plans in packages/core/v2-keeper-plan.mjs, so every list and order can be recomputed from public data.
// Payout lists are published at /api/public/v2-rewards/manifest/… and linked from the on-chain root.
import { DatabaseSync } from 'node:sqlite';
import { Contract, JsonRpcProvider, NonceManager, Wallet, ZeroAddress, getAddress } from 'ethers';
import { buildRound } from '../../packages/core/v2-rounds.mjs';
import { airdropRound, holderRound, flywheelOrders, personalFunder, boundedFunderLinks, HOLDER_RULES, FLYWHEEL_RULES, latestJobs } from '../../packages/core/v2-keeper-plan.mjs';
import { usdOracles } from '../../packages/core/usd-oracles.mjs';
import { holderDistribution } from '../web/reward-policy.mjs';

const DAY = 86_400, BATCH = 80;
const HOOK = ['function ledgers(address) view returns(uint256[5] owed,uint128[5] paid)', 'function withdrawFees(address)', 'function launchOf(address) view returns(address quote,address creatorVault,uint64 launchedAt,uint16 feeBps,bool graduated,int24 upperTick,int24 lowerTick,uint128 liquidityBonus,uint128 accrued)'];
const DISTRIBUTOR = ['function currentRound() view returns(uint256)', 'function roundStart(uint256) view returns(uint256)', 'function roundEnd(uint256) view returns(uint256)', 'function available(address) view returns(uint256)',
  'function rounds(uint256,address) view returns(bytes32 root,uint128 total,uint128 claimed,uint32 recipients,uint64 postedAt,bool expired)', 'function postRoot(uint256,address,bytes32,uint256,uint32,string)',
  'function claimMany(uint256,address,(address account,uint256 amount,bytes32[] proof)[]) returns(uint256)', 'function convertToNative(uint256,uint256,uint24) returns(uint256)', 'function convertible() view returns(address)'];
// Creator strategy vaults (contracts/evm/v2/ElpidaV2CreatorRewards.sol): the keeper is their operator.
const CREATOR = ['function CREATOR_REWARDS_VERSION() view returns(uint256)', 'function operator() view returns(address)', 'function token() view returns(address)', 'function feeAsset() view returns(address)',
  'function mode() view returns(uint8)', 'function threshold() view returns(uint256)', 'function minimumHolding() view returns(uint256)', 'function vesting() view returns(uint64)', 'function bind(address)',
  'function payoutAsset() view returns(address)', 'function available(address) view returns(uint256)', 'function roundCount() view returns(uint256)', 'function swap(uint256,uint256) returns(uint256)',
  'function postRound(bytes32,uint256,uint32,string) returns(uint256)', 'function claimMany(uint256,(address account,uint256 amount,bytes32[] proof)[]) returns(uint256)', 'function rounds(uint256) view returns(address asset,bytes32 root,uint128 total,uint128 claimed,uint32 recipients,uint64 postedAt,uint64 vesting)'];
const DEAD = '0x000000000000000000000000000000000000dead';
const FLYWHEEL = ['function buyAndBurn(address,uint256,uint256,uint256) returns(uint256)', 'function lastBuy(address) view returns(uint64)'];
const ROUTER = ['function quote(address token,bool buy,uint256 amountIn) returns(uint256 fee,uint256 out)'];
const ERC20 = ['function balanceOf(address) view returns(uint256)'];
const lower = a => String(a).toLowerCase();
const json = v => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Map ? Object.fromEntries(x) : x));

export class V2Keeper {
  /**
   * `workers`: [{ chain, net, signer, provider, deployment: { hook, airdrop, holder, flywheel, poolManager, router, factory },
   * index: () => V2Indexer | null, usdPerUnit: asset => dollars | null, funderOf?: wallet => Promise<address | null> }].
   */
  constructor({ workers, path = ':memory:', publicUrl = 'https://elpida.fun', now = () => Math.floor(Date.now() / 1000), log = () => {}, tickMs = 300_000, network = 'testnet' }) {
    Object.assign(this, { workers, publicUrl, now, log, tickMs, network });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS v2k_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS v2k_runs(id INTEGER PRIMARY KEY, chain TEXT NOT NULL, job TEXT NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL, detail TEXT);
      CREATE TABLE IF NOT EXISTS v2k_manifests(chain_id INTEGER NOT NULL, distributor TEXT NOT NULL, round INTEGER NOT NULL, asset TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(chain_id, distributor, round, asset));
      CREATE TABLE IF NOT EXISTS v2k_funders(wallet TEXT PRIMARY KEY, funder TEXT);
      CREATE TABLE IF NOT EXISTS v2k_sources(address TEXT PRIMARY KEY, personal INTEGER NOT NULL, checked INTEGER NOT NULL);`);
    this.busy = false;
  }

  get(key, fallback) { const r = this.db.prepare('SELECT value FROM v2k_state WHERE key=?').get(key); return r ? JSON.parse(r.value) : fallback; }
  set(key, value) { this.db.prepare('INSERT OR REPLACE INTO v2k_state VALUES(?,?)').run(key, json(value)); }
  record(chain, job, status, detail) { this.db.prepare('INSERT INTO v2k_runs(chain,job,at,status,detail) VALUES(?,?,?,?,?)').run(chain, job, this.now(), status, detail ? json(detail).slice(0, 4000) : null); this.log({ event: 'v2_keeper', chain, job, status, ...(detail?.error ? { error: String(detail.error).slice(0, 200) } : {}) }); }

  start() { if (!this.timer) { this.timer = setInterval(() => this.tick().catch(() => {}), this.tickMs); this.timer.unref?.(); setTimeout(() => this.tick().catch(() => {}), 10_000).unref?.(); } return this; }
  async close() { clearInterval(this.timer); this.timer = null; }

  async tick() {
    if (this.busy) return; this.busy = true;
    try { for (const w of this.workers) for (const job of ['fees', 'airdrop', 'holder', 'creator', 'flywheel']) { try { await this[job](w); } catch (e) { this.record(w.chain, job, 'failed', { error: e.shortMessage ?? e.message }); } } }
    finally { this.busy = false; }
  }

  due(w, job, everySeconds) { const last = this.get(`${w.chain}:${job}:last`, 0); return this.now() - last >= everySeconds; }
  done(w, job) { this.set(`${w.chain}:${job}:last`, this.now()); }

  /** Daily: pays every V2 token's unpaid fee shares to their five recipients. */
  async fees(w, { force = false } = {}) {
    if (!force && !this.due(w, 'fees', DAY)) return;
    const index = w.index(); if (!index) return;
    const hook = new Contract(w.deployment.hook, HOOK, w.signer); let paid = 0;
    for (const t of index.listings()) {
      const { owed } = await hook.ledgers(t.address);
      if (owed.slice(1, 4).every(x => x === 0n)) continue;
      await (await hook.withdrawFees(t.address)).wait(); paid++;
    }
    this.done(w, 'fees'); this.record(w.chain, 'fees', 'ok', { tokens: paid });
  }

  /** Wallets linked to each token's creator: the creator, its reward vault, and wallets it sent the token to. */
  creatorLinked(index) {
    const byToken = new Map();
    for (const t of index.listings()) {
      const creator = lower(t.creator), set = new Set([creator, lower(t.reward ?? creator)]);
      for (const x of index.transfersOf(t.address)) if (x.from === creator) set.add(x.to);
      byToken.set(lower(t.address), set);
    }
    return byToken;
  }

  /**
   * Funding links (same first funder), when a block-explorer key is configured; cached. Only personal funders link:
   * exchanges, faucets, bridges and other services never join the wallets they fund (LINK_RULES).
   */
  async links(w, wallets) {
    if (!w.funderOf) return [];
    const out = [];
    for (const wallet of new Set(wallets.filter(Boolean).map(lower))) {
      let row = this.db.prepare('SELECT funder FROM v2k_funders WHERE wallet=?').get(wallet);
      if (!row) { let funder = null; try { funder = await w.funderOf(wallet); } catch { continue; } this.db.prepare('INSERT OR REPLACE INTO v2k_funders VALUES(?,?)').run(wallet, funder ? lower(funder) : null); row = { funder }; }
      if (row.funder && await this.personal(w, row.funder)) out.push([row.funder, wallet]);
    }
    return boundedFunderLinks(out);
  }

  /** Whether a funder is a person (re-checked weekly: a growing service crosses the transaction threshold). */
  async personal(w, funder) {
    const a = lower(funder);
    if (w.ignoredFunders?.has(a)) return false;
    const row = this.db.prepare('SELECT personal, checked FROM v2k_sources WHERE address=?').get(a);
    if (row && (!row.personal || this.now() - row.checked < 7 * DAY)) return !!row.personal;
    try {
      const [code, nonce] = await Promise.all([w.provider.getCode(a), w.provider.getTransactionCount(a)]);
      const personal = personalFunder({ code, nonce });
      this.db.prepare('INSERT OR REPLACE INTO v2k_sources VALUES(?,?,?)').run(a, personal ? 1 : 0, this.now());
      return personal;
    } catch { return false; }
  }

  publish(w, distributor, m) {
    this.db.prepare('INSERT OR REPLACE INTO v2k_manifests VALUES(?,?,?,?,?)').run(w.net.chainId, lower(distributor), m.round, lower(m.asset), JSON.stringify(m));
    return `${this.publicUrl}/api/public/v2-rewards/manifest/${w.net.chainId}/${lower(distributor)}/${m.round}/${lower(m.asset)}`;
  }
  manifest(chainId, distributor, round, asset) {
    const r = this.db.prepare('SELECT data FROM v2k_manifests WHERE chain_id=? AND distributor=? AND round=? AND asset=?').get(Number(chainId), lower(distributor), Number(round), lower(asset));
    return r ? JSON.parse(r.data) : null;
  }

  /** Posts a round's list for one asset and pushes every payout in batches. */
  async post(w, distributor, round, asset, payouts) {
    const m = buildRound({ chainId: w.net.chainId, distributor: distributor.target, round, asset }, payouts);
    await (await distributor.postRoot(round, asset, m.root, m.total, m.recipients, this.publish(w, distributor.target, m))).wait();
    let paid = 0;
    for (let i = 0; i < m.entries.length; i += BATCH) {
      const batch = m.entries.slice(i, i + BATCH).map(e => [e.account, e.amount, e.proof]);
      await (await distributor.claimMany(round, asset, batch)).wait(); paid += batch.length;
    }
    return { root: m.root, total: m.total, recipients: m.recipients, pushed: paid };
  }

  /**
   * Hourly: tokens whose creator chose a holder strategy at launch (their creator vault is an ElpidaV2CreatorRewards
   * this keeper operates). Once the vault holds at least its threshold: collect the creator share from the hook, swap
   * it into the payout asset (reward token or buyback), and pay holders by their balance now, at least the vault's
   * minimum holding, pools and Elpida contracts excluded. Buyback rounds vest; their vested parts are pushed daily.
   */
  async creator(w) {
    if (!this.due(w, 'creator', 3600)) return;
    const index = w.index(); if (!index) return;
    const hook = new Contract(w.deployment.hook, HOOK, w.signer), me = lower(await w.signer.getAddress()), out = [];
    for (const t of index.listings()) {
      const key = `${w.chain}:creator:${lower(t.address)}`;
      let known = this.get(key, null);
      if (known === false) continue;
      if (!known) {
        const vault = (await hook.launchOf(t.address)).creatorVault;
        let ours = false;
        try { const c = new Contract(vault, CREATOR, w.provider); ours = (await c.CREATOR_REWARDS_VERSION()) === 1n && lower(await c.operator()) === me; } catch { ours = false; }
        this.set(key, ours ? { vault } : false);
        if (!ours) continue;
        known = { vault };
      }
      try { out.push(await this.creatorStep(w, hook, index, t, new Contract(known.vault, CREATOR, w.signer))); }
      catch (e) { this.record(w.chain, 'creator', 'failed', { token: t.address, error: e.shortMessage ?? e.message }); }
    }
    this.done(w, 'creator');
    if (out.length) this.record(w.chain, 'creator', 'ok', { tokens: out });
  }

  async creatorStep(w, hook, index, t, vault) {
    if ((await vault.token()) === ZeroAddress) await (await vault.bind(t.address)).wait();
    const [mode, feeAsset, threshold, minimum] = await Promise.all([vault.mode(), vault.feeAsset(), vault.threshold(), vault.minimumHolding()]);
    const vested = await this.creatorVesting(w, vault);
    let fees = await vault.available(feeAsset);
    if (fees < threshold && (await hook.ledgers(t.address)).owed[0] > 0n) { await (await hook.withdrawFees(t.address)).wait(); fees = await vault.available(feeAsset); }
    if (fees < threshold) return { token: t.address, status: 'gathering', fees: fees.toString(), threshold: threshold.toString(), vested };
    if (Number(mode) !== 0) {
      const expected = await vault.swap.staticCall(fees, 1n);
      await (await vault.swap(fees, expected * 97n / 100n)).wait();
    }
    const asset = await vault.payoutAsset(), pool = await vault.available(asset);
    const balances = new Map();
    for (const x of index.transfersOf(t.address)) for (const [a, d] of [[x.from, -x.amount], [x.to, x.amount]]) balances.set(a, (balances.get(a) ?? 0n) + d);
    const excluded = [ZeroAddress, DEAD, vault.target, w.deployment.poolManager, w.deployment.hook, w.deployment.router, w.deployment.factory, w.deployment.airdrop, w.deployment.holder, w.deployment.flywheel].filter(Boolean);
    const rows = holderDistribution(pool, [...balances].filter(([, balance]) => balance > 0n).map(([address, balance]) => ({ address, balance })), minimum, excluded);
    if (!rows.length) return { token: t.address, status: 'waiting for eligible holders' };
    const round = Number(await vault.roundCount());
    const m = buildRound({ chainId: w.net.chainId, distributor: vault.target, round, asset }, rows.map(r => [r.address, r.amount]));
    await (await vault.postRound(m.root, m.total, m.recipients, this.publish(w, vault.target, m))).wait();
    for (let i = 0; i < m.entries.length; i += BATCH) await (await vault.claimMany(round, m.entries.slice(i, i + BATCH).map(e => [e.account, e.amount, e.proof]))).wait();
    if (Number(mode) === 2) this.set(`${w.chain}:creator:vesting:${lower(vault.target)}`, [...this.get(`${w.chain}:creator:vesting:${lower(vault.target)}`, []), round]);
    return { token: t.address, status: 'paid', round, asset, total: m.total.toString(), holders: m.recipients };
  }

  /** Buyback rounds: pushes what has vested since the last push, daily, until each round has fully vested. */
  async creatorVesting(w, vault) {
    const key = `${w.chain}:creator:vesting:${lower(vault.target)}`, open = this.get(key, []);
    if (!open.length || !this.due(w, `creator-vest:${lower(vault.target)}`, DAY)) return 0;
    const left = [];
    for (const round of open) {
      const r = await vault.rounds(round), m = this.manifest(w.net.chainId, vault.target, round, r.asset);
      if (!m) continue;
      for (let i = 0; i < m.entries.length; i += BATCH) await (await vault.claimMany(round, m.entries.slice(i, i + BATCH).map(e => [e.account, e.amount, e.proof]))).wait();
      if (this.now() < Number(r.postedAt) + Number(r.vesting)) left.push(round);
    }
    this.set(key, left); this.done(w, `creator-vest:${lower(vault.target)}`);
    return open.length;
  }

  /** Monthly: each finished trader-airdrop round, per pool asset. */
  async airdrop(w) {
    const index = w.index(); if (!index) return;
    const drop = new Contract(w.deployment.airdrop, DISTRIBUTOR, w.signer), current = Number(await drop.currentRound());
    for (let round = this.get(`${w.chain}:airdrop:next`, 0); round < current; round++) {
      const [start, end] = (await Promise.all([drop.roundStart(round), drop.roundEnd(round)])).map(Number);
      await this.fees(w, { force: true });
      const linked = this.creatorLinked(index);
      const all = index.tradesBetween(0, end), trades = all.filter(t => t.timestamp >= start && !linked.get(lower(t.token))?.has(lower(t.account ?? '')));
      const firstSeen = new Map(); for (const t of all) if (t.account && !firstSeen.has(lower(t.account))) firstSeen.set(lower(t.account), t.timestamp);
      const usd = a => w.usdPerUnit(a) ?? 0, assets = [...new Set(trades.map(t => t.asset))].filter(a => usd(a) > 0);
      const carried = this.get(`${w.chain}:airdrop:carried`, {}), carriedMaps = Object.fromEntries(Object.entries(carried).map(([a, m]) => [a, new Map(Object.entries(m).map(([k, v]) => [k, BigInt(v)]))]));
      const pools = {};
      for (const a of assets) { const held = [...(carriedMaps[a]?.values() ?? [])].reduce((x, y) => x + y, 0n), avail = await drop.available(a); if (avail > held) pools[a] = avail - held; }
      const plan = airdropRound({ trades: trades.map(t => ({ ...t, quoteUsd: Number(t.quoteAmount ?? 0) * usd(t.asset) })), start, end, usdPerUnit: usd, firstSeen: a => firstSeen.get(a), pools, carried: carriedMaps, links: await this.links(w, trades.map(t => t.account)) });
      const results = {};
      for (const [asset, p] of Object.entries(plan.byAsset)) {
        carried[asset] = Object.fromEntries([...p.carried].map(([k, v]) => [k, v.toString()]));
        if ((await drop.rounds(round, asset)).root !== '0x' + '0'.repeat(64) || !p.payouts.size) continue;
        results[asset] = await this.post(w, drop, round, asset, p.payouts);
      }
      this.set(`${w.chain}:airdrop:carried`, carried); this.set(`${w.chain}:airdrop:next`, round + 1);
      this.record(w.chain, 'airdrop', 'ok', { round, qualified: plan.qualified.length, results });
    }
  }

  /** Weekly: holders of tokens whose holder share has reached the threshold; USDC pairs converted to native first. */
  async holder(w) {
    const index = w.index(); if (!index) return;
    const dist = new Contract(w.deployment.holder, DISTRIBUTOR, w.signer), current = Number(await dist.currentRound()), hook = new Contract(w.deployment.hook, HOOK, w.provider);
    for (let round = this.get(`${w.chain}:holder:next`, 0); round < current; round++) {
      const [start, end] = (await Promise.all([dist.roundStart(round), dist.roundEnd(round)])).map(Number);
      await this.fees(w, { force: true });
      const linked = this.creatorLinked(index), done = this.get(`${w.chain}:holder:distributed`, {}), convertible = lower(await dist.convertible());
      const threshold = HOLDER_RULES.thresholdUsd[this.network], due = [];
      for (const t of index.listings()) {
        const { owed, paid } = await hook.ledgers(t.address), earned = owed[3] + paid[3], pending = earned - BigInt(done[lower(t.address)] ?? 0);
        const asset = lower(t.quoteAddress ?? ZeroAddress), unit = w.usdPerUnit(asset);
        if (pending > 0n && unit && Number(pending) / 10 ** (t.quoteDecimals ?? 18) * unit >= threshold) due.push({ token: lower(t.address), asset, pending, decimals: t.quoteDecimals ?? 18 });
      }
      // USDC pairs: convert their pending USDC into the native coin, then split it by each token's share.
      const usdcDue = due.filter(d => d.asset === convertible && convertible !== lower(ZeroAddress));
      if (usdcDue.length) {
        const amount = usdcDue.reduce((a, d) => a + d.pending, 0n), native = w.usdPerUnit(lower(ZeroAddress));
        let out = 0n;
        try {
          const minOut = BigInt(Math.floor(Number(amount) / 10 ** usdcDue[0].decimals / native * 0.97 * 1e18));
          out = await dist.convertToNative.staticCall(amount, minOut, 3000);
          await (await dist.convertToNative(amount, minOut, 3000)).wait();
        } catch (e) { this.record(w.chain, 'holder', 'conversion-skipped', { error: e.shortMessage ?? e.message }); usdcDue.length = 0; }
        for (const d of usdcDue) { d.convertedFrom = d.pending; d.pool = out * d.pending / amount; d.payAsset = lower(ZeroAddress); }
      }
      const merged = new Map(), stats = [];
      for (const d of due) {
        if (d.asset === convertible && !d.payAsset) continue;
        const payAsset = d.payAsset ?? d.asset, pool = d.pool ?? d.pending;
        const excluded = [w.deployment.poolManager, w.deployment.hook, w.deployment.router, w.deployment.factory, w.deployment.airdrop, w.deployment.holder, w.deployment.flywheel].filter(Boolean);
        const plan = holderRound({ transfers: index.transfersOf(d.token), start, end, pool, excluded, creatorLinked: [...(linked.get(d.token) ?? [])] });
        if (!plan.payouts.size) continue;
        if (!merged.has(payAsset)) merged.set(payAsset, new Map());
        for (const [k, v] of plan.payouts) merged.get(payAsset).set(k, (merged.get(payAsset).get(k) ?? 0n) + v);
        done[d.token] = (BigInt(done[d.token] ?? 0) + (d.convertedFrom ?? d.pending)).toString();
        stats.push({ token: d.token, holders: plan.holders });
      }
      const results = {};
      for (const [asset, payouts] of merged) if ((await dist.rounds(round, asset)).root === '0x' + '0'.repeat(64)) results[asset] = await this.post(w, dist, round, asset, payouts);
      this.set(`${w.chain}:holder:distributed`, done); this.set(`${w.chain}:holder:next`, round + 1);
      this.record(w.chain, 'holder', 'ok', { round, tokens: stats, results });
    }
  }

  /** Daily: buy and burn the top tokens by independent net buying, within the vault's limits. */
  async flywheel(w) {
    if (!this.due(w, 'flywheel', DAY)) return;
    const index = w.index(); if (!index) return;
    const fw = new Contract(w.deployment.flywheel, FLYWHEEL, w.signer), now = this.now();
    const trades = index.tradesBetween(now - FLYWHEEL_RULES.windowSeconds, now + 1), linked = this.creatorLinked(index), usd = a => w.usdPerUnit(a) ?? 0;
    const assets = [...new Set(trades.map(t => t.asset))], balances = {};
    for (const a of assets) balances[a] = a === lower(ZeroAddress) ? await w.provider.getBalance(w.deployment.flywheel) : await new Contract(a, ERC20, w.provider).balanceOf(w.deployment.flywheel);
    const orders = flywheelOrders({ trades: trades.map(t => ({ ...t, quoteUsd: Number(t.quoteAmount ?? 0) * usd(t.asset) })), now, balances, links: await this.links(w, trades.map(t => t.account)), creatorLinkedOf: tok => [...(linked.get(tok) ?? [])], twapOf: tok => index.twap(tok, now, FLYWHEEL_RULES.priceWindowSeconds), network: this.network });
    const cycle = Math.floor(now / DAY), done = [];
    const router = new Contract(w.deployment.router, ROUTER, w.provider);
    for (const o of orders) {
      try {
        // Live quote against the recent average: skip a pumped pool; otherwise allow 1% slippage from the live quote.
        const [, live] = await router.quote.staticCall(o.token, true, o.amountIn);
        if (live < o.minOut) { done.push({ token: o.token, skipped: 'price more than 10% above the recent average' }); continue; }
        const minOut = live * BigInt(10_000 - FLYWHEEL_RULES.slippageBps) / 10_000n;
        await (await fw.buyAndBurn(o.token, o.amountIn, minOut, cycle)).wait(); done.push({ token: o.token, spent: o.amountIn });
      }
      catch (e) { done.push({ token: o.token, skipped: e.shortMessage ?? e.message }); }
    }
    this.done(w, 'flywheel'); this.record(w.chain, 'flywheel', 'ok', { cycle, orders: done });
  }

  status() {
    return { enabled: true, chains: this.workers.map(w => ({ chain: w.chain, keeper: w.signer.address ?? null, airdropNext: this.get(`${w.chain}:airdrop:next`, 0), holderNext: this.get(`${w.chain}:holder:next`, 0),
      runs: this.db.prepare('SELECT job,at,status FROM v2k_runs WHERE chain=? ORDER BY id DESC LIMIT 8').all(w.chain),
      jobs: latestJobs(this.db.prepare('SELECT job,at,status,detail FROM v2k_runs WHERE id IN (SELECT MAX(id) FROM v2k_runs WHERE chain=? GROUP BY job) ORDER BY job').all(w.chain)) })) };
  }
}

/** First funder of a wallet through Etherscan's multichain API (first incoming transaction with value). */
export function etherscanFunder(chainId, apiKey, fetchImpl = fetch) {
  return async wallet => {
    const u = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=account&action=txlist&address=${wallet}&page=1&offset=5&sort=asc&apikey=${encodeURIComponent(apiKey)}`;
    const r = await (await fetchImpl(u, { signal: AbortSignal.timeout(10_000) })).json();
    const tx = (Array.isArray(r.result) ? r.result : []).find(t => lower(t.to) === lower(wallet) && BigInt(t.value ?? 0) > 0n);
    return tx ? lower(tx.from) : null;
  };
}

/**
 * The server's keeper: on only with ELPIDA_V2_KEEPER_KEY, on test networks with a pinned V2 deployment. Funding links
 * need ELPIDA_EXPLORER_API_KEY (Etherscan multichain); without it only creator transfers link wallets.
 */
export function configuredV2Keeper({ env, networks, indexFor, prices, path, publicUrl, log }) {
  const key = env.ELPIDA_V2_KEEPER_KEY;
  const nets = networks.filter(n => !n.mainnet && n.v2?.shared?.hook && n.v2.shared.airdrop);
  const valid = !!key && /^(0x)?[0-9a-fA-F]{64}$/.test(key);
  // With the key set but no V2 pinned yet, the keeper is idle but its address is public, so the operator panel deploys
  // the reward contracts with the keeper as operator (not the operator's own wallet).
  const idleAddress = valid ? getAddress(new Wallet(key).address) : null;
  if (!valid || !nets.length) return { enabled: false, address: idleAddress, status: () => ({ enabled: false, state: valid ? 'waiting_for_v2_deployment' : 'not_configured', keeper: idleAddress }), manifest: () => null, start() { return this; }, close: async () => {} };
  const address = new Wallet(key).address, oracles = usdOracles(env);
  // Extra exchange or service wallets that must never link the wallets they fund (comma-separated addresses).
  const ignoredFunders = new Set(String(env.ELPIDA_FUNDER_IGNORE ?? '').split(',').map(x => x.trim().toLowerCase()).filter(x => /^0x[0-9a-f]{40}$/.test(x)));
  const workers = nets.map(net => {
    const provider = new JsonRpcProvider(net.rpcUrl, undefined, { cacheTimeout: -1, batchMaxCount: 1 }), d = net.v2.shared;
    return { chain: net.key, net, provider, signer: Object.assign(new NonceManager(new Wallet(key, provider)), { address }), deployment: { ...d, poolManager: net.v4?.poolManager },
      index: () => indexFor(net.key), funderOf: env.ELPIDA_EXPLORER_API_KEY ? etherscanFunder(net.chainId, env.ELPIDA_EXPLORER_API_KEY) : null, ignoredFunders,
      usdPerUnit: asset => { if (lower(asset) === lower(ZeroAddress)) { const p = prices()[net.key]; return p?.status === 'fresh' ? p.usd : null; } const usdc = oracles[net.key]?.usdc; return usdc && lower(asset) === lower(usdc) ? 1 : null; } };
  });
  const keeper = new V2Keeper({ workers, path, publicUrl, log });
  keeper.enabled = true; keeper.address = getAddress(address);
  return keeper;
}
