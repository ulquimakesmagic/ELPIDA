// ELPIDA V2.0 keeper (test networks only until the V2 contracts are audited and Malik approves mainnet). One worker
// per network with a pinned V2 deployment, signing with the dedicated keeper key (ELPIDA_V2_KEEPER_KEY), which is the
// operator of the distributors and the flywheel vault. It never holds reward funds; it only:
//  - pays every V2 token's fees into the five recipients, daily (hook.withdrawFees; anyone may call it);
//  - posts each finished trader-airdrop round (monthly) and holder-reward round (weekly) and pushes every payout;
//  - runs a flywheel cycle daily (buy-and-burn of the top tokens);
// with the plans in packages/core/v2-keeper-plan.mjs, so every list and order can be recomputed from public data.
// Payout lists are published at /api/public/v2-rewards/manifest/… and linked from the on-chain root.
import { DatabaseSync } from 'node:sqlite';
import { Contract, JsonRpcProvider, NonceManager, Wallet, ZeroAddress, getAddress, parseEther, solidityPacked } from 'ethers';
import { buildRound } from '../../packages/core/v2-rounds.mjs';
import { airdropRound, holderRound, flywheelOrders, personalFunder, boundedFunderLinks, HOLDER_RULES, FLYWHEEL_RULES, latestJobs } from '../../packages/core/v2-keeper-plan.mjs';
import { usdOracles } from '../../packages/core/usd-oracles.mjs';
import { testnetDexes } from '../../packages/core/uniswap.mjs';
import { payoutStable } from '../../packages/core/payout-stable.mjs';
import { holderDistribution } from '../web/reward-policy.mjs';
import { KeeperLease, safeError } from '../../packages/core/keeper-lease.mjs';

const DAY = 86_400, BATCH = 80;
// Audit of 11 November 2026 (docs/AUDIT_TRIAGE_2026-11-11.md): every transaction goes through send(), which holds the
// signing lease (BE-01), stays inside a rolling 24-hour gas budget per chain (BE-07), waits for CONFIRMATIONS blocks and
// checks the receipt's block is still canonical (BE-02). At most MAX_ROUNDS_PER_TICK rounds per job are worked through
// per tick, so a fresh cursor never replays a whole history in one go (BE-07).
const CONFIRMATIONS = 2, MAX_ROUNDS_PER_TICK = 3, DAILY_GAS = 25n * 10n ** 16n;
const HOOK = ['function ledgers(address) view returns(uint256[5] owed,uint128[5] paid)', 'function withdrawFees(address)', 'function claim(address,uint8) returns(bool)', 'function launchOf(address) view returns(address quote,address creatorVault,uint64 launchedAt,uint16 feeBps,bool graduated,int24 upperTick,int24 lowerTick,uint128 liquidityBonus,uint128 accrued)'];
const DISTRIBUTOR = ['function currentRound() view returns(uint256)', 'function roundStart(uint256) view returns(uint256)', 'function roundEnd(uint256) view returns(uint256)', 'function available(address) view returns(uint256)',
  'function rounds(uint256,address) view returns(bytes32 root,uint128 total,uint128 claimed,uint32 recipients,uint64 postedAt,bool expired)', 'function postRoot(uint256,address,bytes32,uint256,uint32,string)',
  'function claimMany(uint256,address,(address account,uint256 amount,bytes32[] proof)[]) returns(uint256)', 'function convertToNative(uint256,uint256,uint24) returns(uint256)', 'function convertible() view returns(address)',
  'function claim(uint256,address,address,uint256,bytes32[]) returns(bool)'];
// USDC payouts (contracts/evm/v2/ElpidaV2UsdcDistributor.sol; Malik, 10 November): the trader airdrop and holder
// rewards pay only USDC. Each finished round's balance moves from the hook's distributor into its USDC distributor (a
// published round with that contract as the one recipient), is converted there to USDC, and is paid out in USDC.
const USDC_DISTRIBUTOR = [...DISTRIBUTOR, 'function usdc() view returns(address)', 'function source() view returns(address)', 'function convert(address,uint256,uint256,bytes) returns(uint256)'];
const QUOTER = ['function quoteExactInput(bytes,uint256) returns(uint256,uint160[],uint32[],uint256)'];
// Uniswap's tiers and PancakeSwap's (0.25%); a quote on a tier a DEX lacks simply fails and is skipped.
const FEE_TIERS = [100, 500, 2500, 3000, 10000];
const ZERO_ROOT = '0x' + '0'.repeat(64);
// Keeper gas (Malik, 10 November): when a round's native coin moves to the USDC distributor, the keeper tops its own
// wallet up to GAS_TARGET from it (never more than GAS_SHARE_BPS of that move), as a second recipient of the same
// published round. The rest is converted. Railway: ELPIDA_V2_KEEPER_GAS_TARGET (native coin), ELPIDA_V2_KEEPER_GAS_SHARE_BPS.
const GAS_TARGET = 5n * 10n ** 16n, GAS_SHARE_BPS = 1000n;
// Creator strategy vaults (contracts/evm/v2/ElpidaV2CreatorRewards.sol): the keeper is their operator.
const CREATOR = ['function CREATOR_REWARDS_VERSION() view returns(uint256)', 'function operator() view returns(address)', 'function token() view returns(address)', 'function feeAsset() view returns(address)',
  'function mode() view returns(uint8)', 'function threshold() view returns(uint256)', 'function minimumHolding() view returns(uint256)', 'function minimumHoldingUsdE6() view returns(uint256)', 'function vesting() view returns(uint64)', 'function bind(address)',
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
  /**
   * `distributions`: whether the trader airdrop, holder rewards and flywheel run. Off by default on mainnet: the first
   * mainnet release pays creator rewards only, the other shares accrue in their contracts (Malik, 11 November).
   * `dailyGas`: native coin the keeper may spend per chain per rolling 24 hours. `confirmations`: blocks to wait for.
   */
  constructor({ workers, path = ':memory:', publicUrl = 'https://elpida.fun', now = () => Math.floor(Date.now() / 1000), log = () => {}, tickMs = 300_000, network = 'testnet', gasTarget = GAS_TARGET, gasShareBps = GAS_SHARE_BPS,
    confirmations = CONFIRMATIONS, distributions = network !== 'mainnet', dailyGas = DAILY_GAS, maxRoundsPerTick = MAX_ROUNDS_PER_TICK, leaseTtl = 15 * 60 }) {
    this.gasTarget = gasTarget; this.gasShareBps = gasShareBps;
    Object.assign(this, { workers, publicUrl, now, log, tickMs, network, confirmations, distributions, dailyGas: BigInt(dailyGas), maxRoundsPerTick });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS v2k_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS v2k_runs(id INTEGER PRIMARY KEY, chain TEXT NOT NULL, job TEXT NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL, detail TEXT);
      CREATE TABLE IF NOT EXISTS v2k_manifests(chain_id INTEGER NOT NULL, distributor TEXT NOT NULL, round INTEGER NOT NULL, asset TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(chain_id, distributor, round, asset));
      CREATE TABLE IF NOT EXISTS v2k_funders(wallet TEXT PRIMARY KEY, funder TEXT);
      CREATE TABLE IF NOT EXISTS v2k_sources(address TEXT PRIMARY KEY, personal INTEGER NOT NULL, checked INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS v2k_pushes(chain TEXT NOT NULL, distributor TEXT NOT NULL, round INTEGER NOT NULL, asset TEXT NOT NULL, kind TEXT NOT NULL, next INTEGER NOT NULL, PRIMARY KEY(chain, distributor, round, asset));
      CREATE TABLE IF NOT EXISTS v2k_spend(id INTEGER PRIMARY KEY, chain TEXT NOT NULL, at INTEGER NOT NULL, wei TEXT NOT NULL);`);
    // A manifest is public only once its root is on chain and matches (audit BE-04); rows from before are published.
    try { this.db.exec("ALTER TABLE v2k_manifests ADD COLUMN status TEXT NOT NULL DEFAULT 'published'"); } catch { /* already there */ }
    this.lease = new KeeperLease(this.db, 'v2k_lock', { now, ttl: leaseTtl });
    this.busy = false;
  }

  get(key, fallback) { const r = this.db.prepare('SELECT value FROM v2k_state WHERE key=?').get(key); return r ? JSON.parse(r.value) : fallback; }
  set(key, value) { this.db.prepare('INSERT OR REPLACE INTO v2k_state VALUES(?,?)').run(key, json(value)); }
  record(chain, job, status, detail) {
    if (detail?.error) detail = { ...detail, error: safeError(detail.error) };
    this.db.prepare('INSERT INTO v2k_runs(chain,job,at,status,detail) VALUES(?,?,?,?,?)').run(chain, job, this.now(), status, detail ? json(detail).slice(0, 4000) : null); this.log({ event: 'v2_keeper', chain, job, status, ...(detail?.error ? { error: detail.error } : {}) });
  }

  /** Native coin this keeper spent on `chain` in the last 24 hours. */
  spent(chain) { return this.db.prepare('SELECT wei FROM v2k_spend WHERE chain=? AND at>?').all(chain, this.now() - DAY).reduce((a, r) => a + BigInt(r.wei), 0n); }

  /**
   * Sends one transaction: renews the lease first (throws lease_lost when another process took it), refuses once the
   * chain's 24-hour gas budget is spent, waits for the confirmations (1 on a local test chain, which mines on demand)
   * and checks the receipt's block is still the canonical one before anything is recorded as done.
   */
  async send(w, build) {
    this.lease.renew();
    if (this.dailyGas > 0n && this.spent(w.chain) >= this.dailyGas) throw Object.assign(new Error(`budget_reached: the keeper's 24-hour gas budget on ${w.chain} is spent`), { code: 'budget_reached' });
    const tx = await build(), receipt = await tx.wait(Number(w.net.chainId) === 31337 ? 1 : this.confirmations);
    if (!receipt || receipt.status !== 1) throw new Error(`transaction ${tx.hash} failed`);
    const price = receipt.gasPrice ?? receipt.effectiveGasPrice ?? tx.gasPrice ?? 0n;
    this.db.prepare('INSERT INTO v2k_spend(chain,at,wei) VALUES(?,?,?)').run(w.chain, this.now(), (BigInt(receipt.gasUsed ?? 0n) * BigInt(price)).toString());
    const block = await w.provider.getBlock(receipt.blockNumber);
    if (!block || block.hash !== receipt.blockHash) throw new Error(`transaction ${tx.hash} was reorganised out; nothing is recorded as done`);
    return receipt;
  }

  start() { if (!this.timer) { this.timer = setInterval(() => this.tick().catch(() => {}), this.tickMs); this.timer.unref?.(); setTimeout(() => this.tick().catch(() => {}), 10_000).unref?.(); } return this; }
  async close() { clearInterval(this.timer); this.timer = null; if (!this.busy) this.lease.release(); }

  /** The jobs this keeper runs: creator rewards and fee collection always; the rest only with distributions on. */
  jobs() { return this.distributions ? ['fees', 'airdrop', 'holder', 'creator', 'flywheel'] : ['fees', 'creator']; }

  async tick() {
    if (this.busy) return; this.busy = true;
    try {
      // Only the process holding the lease works; another one on the same data stays idle (audit BE-01).
      if (!this.lease.acquire()) { this.idle = 'lease_held_elsewhere'; return; }
      this.idle = null;
      for (const w of this.workers) {
        try { await this.resumePushes(w); } catch (e) { this.record(w.chain, 'push', 'failed', { error: e }); if (e.code === 'lease_lost') return; }
        for (const job of this.jobs()) {
          try { await this[job](w); (this.checked ??= {})[`${w.chain}:${job}`] = this.now(); }
          catch (e) { this.record(w.chain, job, 'failed', { error: e }); if (e.code === 'lease_lost') return; }
        }
      }
    }
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
      await this.collect(w, hook, t.address); paid++;
    }
    this.done(w, 'fees'); this.record(w.chain, 'fees', 'ok', { tokens: paid });
  }

  /**
   * Pays one token's five shares. withdrawFees is one transaction for all five; if it fails (a creator vault that burns
   * all the gas it is sent can make the batch revert, audit EVM-01), each share is claimed on its own, so one bad
   * recipient never holds back the other four.
   */
  async collect(w, hook, token) {
    try { await this.send(w, () => hook.withdrawFees(token)); return; }
    catch (e) { if (e.code === 'lease_lost' || e.code === 'budget_reached') throw e; }
    const { owed } = await hook.ledgers(token);
    for (let i = 0; i < 5; i++) if (owed[i] > 0n) { try { await this.send(w, () => hook.claim(token, i)); } catch (e) { if (e.code === 'lease_lost' || e.code === 'budget_reached') throw e; this.record(w.chain, 'fees', 'recipient-failed', { token, recipient: i, error: e }); } }
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

  /** Stores a round's list as pending (not served yet) and returns the URL its root will point to. A published list is never replaced. */
  publish(w, distributor, m) {
    this.db.prepare(`INSERT INTO v2k_manifests(chain_id,distributor,round,asset,data,status) VALUES(?,?,?,?,?,'pending')
      ON CONFLICT(chain_id,distributor,round,asset) DO UPDATE SET data=excluded.data WHERE status='pending'`).run(w.net.chainId, lower(distributor), m.round, lower(m.asset), JSON.stringify(m));
    return `${this.publicUrl}/api/public/v2-rewards/manifest/${w.net.chainId}/${lower(distributor)}/${m.round}/${lower(m.asset)}`;
  }
  /** Marks a list public once its root is read back from the chain and matches it (audit BE-04). */
  confirmPublished(w, distributor, m, onChainRoot) {
    if (lower(onChainRoot) !== lower(m.root)) throw new Error(`round ${m.round}: the root on chain (${onChainRoot}) is not the list's (${m.root}); the list stays unpublished`);
    this.db.prepare("UPDATE v2k_manifests SET status='published' WHERE chain_id=? AND distributor=? AND round=? AND asset=?").run(w.net.chainId, lower(distributor), m.round, lower(m.asset));
  }
  /** A published list; pending ones (root not confirmed on chain) are not served. */
  manifest(chainId, distributor, round, asset, { pending = false } = {}) {
    const r = this.db.prepare(`SELECT data FROM v2k_manifests WHERE chain_id=? AND distributor=? AND round=? AND asset=?${pending ? '' : " AND status='published'"}`).get(Number(chainId), lower(distributor), Number(round), lower(asset));
    return r ? JSON.parse(r.data) : null;
  }

  /**
   * Pushes a posted round's payouts in batches, remembering how far it got, so a crash or a failed batch resumes where
   * it stopped on the next tick (resumePushes) instead of leaving the rest unpaid. `kind`: 'distributor' (claimMany
   * by round and asset) or 'vault' (a creator vault's claimMany by round). A distributor batch that fails is retried
   * one wallet at a time, so one stale leaf (on contracts from before audit EVM-02) never blocks the others.
   */
  async pushRound(w, contract, kind, m) {
    const key = [w.chain, lower(contract.target), Number(m.round), lower(m.asset)];
    this.db.prepare('INSERT OR IGNORE INTO v2k_pushes VALUES(?,?,?,?,?,0)').run(...key, kind);
    let next = this.db.prepare('SELECT next FROM v2k_pushes WHERE chain=? AND distributor=? AND round=? AND asset=?').get(...key)?.next ?? 0, pushed = 0;
    for (; next < m.entries.length; next += BATCH) {
      const slice = m.entries.slice(next, next + BATCH), batch = slice.map(e => [e.account, e.amount, e.proof]);
      try { await this.send(w, () => kind === 'vault' ? contract.claimMany(m.round, batch) : contract.claimMany(m.round, m.asset, batch)); }
      catch (e) {
        if (kind === 'vault' || e.code === 'lease_lost' || e.code === 'budget_reached') throw e;
        for (const x of slice) { try { await this.send(w, () => contract.claim(m.round, m.asset, x.account, x.amount, x.proof)); } catch (err) { if (err.code === 'lease_lost' || err.code === 'budget_reached') throw err; } }
      }
      pushed += slice.length;
      this.db.prepare('UPDATE v2k_pushes SET next=? WHERE chain=? AND distributor=? AND round=? AND asset=?').run(next + BATCH, ...key);
    }
    this.db.prepare('DELETE FROM v2k_pushes WHERE chain=? AND distributor=? AND round=? AND asset=?').run(...key);
    return pushed;
  }

  /** Finishes pushes a previous tick or process left half done. */
  async resumePushes(w) {
    for (const r of this.db.prepare('SELECT * FROM v2k_pushes WHERE chain=?').all(w.chain)) {
      const m = this.manifest(w.net.chainId, r.distributor, r.round, r.asset);
      if (!m) { this.db.prepare('DELETE FROM v2k_pushes WHERE chain=? AND distributor=? AND round=? AND asset=?').run(r.chain, r.distributor, r.round, r.asset); continue; }
      const contract = new Contract(r.distributor, r.kind === 'vault' ? CREATOR : USDC_DISTRIBUTOR, w.signer);
      this.record(w.chain, 'push', 'resumed', { distributor: r.distributor, round: r.round, from: r.next, pushed: await this.pushRound(w, contract, r.kind, m) });
    }
  }

  /**
   * Posts a round's list for one asset, confirms the root on chain, publishes the list and pushes every payout. If the
   * root is not on chain afterwards (a reorg), this throws: the caller's cursor does not move and the next tick posts
   * again (audit BE-02).
   */
  async post(w, distributor, round, asset, payouts) {
    const m = buildRound({ chainId: w.net.chainId, distributor: distributor.target, round, asset }, payouts);
    const url = this.publish(w, distributor.target, m);
    await this.send(w, () => distributor.postRoot(round, asset, m.root, m.total, m.recipients, url));
    this.confirmPublished(w, distributor.target, m, (await distributor.rounds(round, asset)).root);
    const pushed = await this.pushRound(w, distributor, 'distributor', m);
    return { root: m.root, total: m.total, recipients: m.recipients, pushed };
  }

  /**
   * Stops a holder round whose payouts the chain already shows (its root is set) while this keeper's cursor has not
   * moved past it: the local totals are behind the chain (a restored backup, or a crash between posting and saving),
   * and paying from them could pay the same share twice (audit BE-05). Reconcile by hand, then move the cursor.
   */
  async refuseIfBehind(w, round, roots) {
    for (const [contract, asset] of roots) if ((await contract.rounds(round, asset)).root !== ZERO_ROOT)
      throw Object.assign(new Error(`state_behind_chain: ${w.chain} holder round ${round} is already posted on chain; reconcile the keeper's holder totals before it continues`), { code: 'state_behind_chain' });
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
        try { const c = new Contract(vault, CREATOR, w.provider); ours = [1n, 2n].includes(await c.CREATOR_REWARDS_VERSION()) && lower(await c.operator()) === me; } catch { ours = false; }
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
    if ((await vault.token()) === ZeroAddress) await this.send(w, () => vault.bind(t.address));
    const [mode, feeAsset, threshold, minimum] = await Promise.all([vault.mode(), vault.feeAsset(), vault.threshold(), vault.minimumHolding()]);
    const vested = await this.creatorVesting(w, vault);
    let fees = await vault.available(feeAsset);
    if (fees < threshold && (await hook.ledgers(t.address)).owed[0] > 0n) { await this.collect(w, hook, t.address); fees = await vault.available(feeAsset); }
    if (fees < threshold) return { token: t.address, status: 'gathering', fees: fees.toString(), threshold: threshold.toString(), vested };
    if (Number(mode) !== 0) {
      const expected = await vault.swap.staticCall(fees, 1n);
      await this.send(w, () => vault.swap(fees, expected * 97n / 100n));
    }
    const asset = await vault.payoutAsset(), pool = await vault.available(asset);
    const balances = new Map();
    for (const x of index.transfersOf(t.address)) for (const [a, d] of [[x.from, -x.amount], [x.to, x.amount]]) balances.set(a, (balances.get(a) ?? 0n) + d);
    const excluded = [ZeroAddress, DEAD, vault.target, w.deployment.poolManager, w.deployment.hook, w.deployment.router, w.deployment.factory, w.deployment.airdrop, w.deployment.holder, w.deployment.flywheel].filter(Boolean);
    // The creator's USD minimum (vaults of version 2): converted to tokens now with a fresh price, or the round waits.
    let floor = minimum, usdMinimum = 0n;
    try { usdMinimum = await vault.minimumHoldingUsdE6(); } catch { usdMinimum = 0n; }
    if (usdMinimum > 0n) {
      const tokenUsd = await this.tokenUsd(w, index, t);
      if (!tokenUsd) return { token: t.address, status: 'waiting for a fresh USD price for the minimum holding' };
      const tokens = BigInt(Math.ceil(Number(usdMinimum) / 1e6 / tokenUsd * 1e6)) * 10n ** 12n;
      if (tokens > floor) floor = tokens;
    }
    const rows = holderDistribution(pool, [...balances].filter(([, balance]) => balance > 0n).map(([address, balance]) => ({ address, balance })), floor, excluded);
    if (!rows.length) return { token: t.address, status: 'waiting for eligible holders' };
    const round = Number(await vault.roundCount());
    const m = buildRound({ chainId: w.net.chainId, distributor: vault.target, round, asset }, rows.map(r => [r.address, r.amount]));
    const url = this.publish(w, vault.target, m);
    await this.send(w, () => vault.postRound(m.root, m.total, m.recipients, url));
    this.confirmPublished(w, vault.target, m, (await vault.rounds(round)).root);
    await this.pushRound(w, vault, 'vault', m);
    if (Number(mode) === 2) this.set(`${w.chain}:creator:vesting:${lower(vault.target)}`, [...this.get(`${w.chain}:creator:vesting:${lower(vault.target)}`, []), round]);
    return { token: t.address, status: 'paid', round, asset, total: m.total.toString(), holders: m.recipients };
  }

  /** USD per whole token now: its last trade's price × its pair asset's USD price; null without both. */
  async tokenUsd(w, index, t) {
    const trades = index.tradesBetween(0, this.now()).filter(x => lower(x.token) === lower(t.address) && BigInt(x.tokenRaw ?? 0) > 0n);
    const last = trades[trades.length - 1]; if (!last) return null;
    const asset = lower(t.quoteAddress ?? ZeroAddress), usd = await this.assetUsd(w, asset); if (!usd) return null;
    return Number(last.quoteAmount) / Number(last.tokenAmount) * usd;
  }

  /** USD per whole unit of a pair asset: the configured price, else a stock's feed (V2 factory or test stock), at most 4 days old. */
  async assetUsd(w, asset) {
    const known = w.usdPerUnit(asset); if (known) return known;
    if (w.usdc && asset === lower(w.usdc)) return 1;
    const FEED = ['function decimals() view returns(uint8)', 'function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)'];
    let feed = null;
    try { const q = await new Contract(w.deployment.factory, ['function quoteFeeds(address) view returns(address,uint64,uint8,uint8)'], w.provider).quoteFeeds(asset); if (q[0] !== ZeroAddress) feed = q[0]; } catch { /* older factory */ }
    if (!feed) { try { feed = await new Contract(asset, ['function referenceFeed() view returns(address)'], w.provider).referenceFeed(); } catch { feed = null; } }
    if (!feed) return null;
    try {
      const f = new Contract(feed, FEED, w.provider), [round, decimals] = await Promise.all([f.latestRoundData(), f.decimals()]);
      if (round[1] <= 0n || this.now() - Number(round[3]) > 4 * 86_400) return null;
      return Number(round[1]) / 10 ** Number(decimals);
    } catch { return null; }
  }

  /** Buyback rounds: pushes what has vested since the last push, daily, until each round has fully vested. */
  async creatorVesting(w, vault) {
    const key = `${w.chain}:creator:vesting:${lower(vault.target)}`, open = this.get(key, []);
    if (!open.length || !this.due(w, `creator-vest:${lower(vault.target)}`, DAY)) return 0;
    const left = [];
    for (const round of open) {
      const r = await vault.rounds(round), m = this.manifest(w.net.chainId, vault.target, round, r.asset);
      if (!m) continue;
      for (let i = 0; i < m.entries.length; i += BATCH) await this.send(w, () => vault.claimMany(round, m.entries.slice(i, i + BATCH).map(e => [e.account, e.amount, e.proof])));
      if (this.now() < Number(r.postedAt) + Number(r.vesting)) left.push(round);
    }
    this.set(key, left); this.done(w, `creator-vest:${lower(vault.target)}`);
    return open.length;
  }

  /** The USDC distributor that pays `kind` ('airdrop' | 'holder') on this chain, or null while rewards pay in kind. */
  usdcDistributor(w, kind) {
    const a = w.deployment[kind === 'airdrop' ? 'usdcAirdrop' : 'usdcHolder'];
    return a && w.usdc ? new Contract(a, USDC_DISTRIBUTOR, w.signer) : null;
  }

  /**
   * Moves `amount` of `asset` for `round` from the hook's distributor into its USDC distributor: a published round
   * whose one recipient is that contract. False when this round and asset already have a root (posted before USDC).
   */
  async sweep(w, source, target, round, asset, amount) {
    if (amount <= 0n || (await source.rounds(round, asset)).root !== ZERO_ROOT) return false;
    const payouts = new Map(), gas = lower(asset) === lower(ZeroAddress) ? await this.gasRefill(w, amount) : 0n;
    if (amount > gas) payouts.set(lower(target.target), amount - gas);
    if (gas > 0n) payouts.set(lower(w.signer.address), gas);
    await this.post(w, source, round, asset, payouts);
    return { moved: amount - gas, gas };
  }

  /** What the keeper takes for gas from `amount` of native coin: up to its target balance, at most its share. */
  async gasRefill(w, amount) {
    const balance = await w.provider.getBalance(w.signer.address), need = this.gasTarget > balance ? this.gasTarget - balance : 0n, cap = amount * BigInt(this.gasShareBps) / 10_000n;
    return need < cap ? need : cap;
  }

  /** The best Uniswap v3 route from `asset` to USDC for `amount`: direct, or through the wrapped native coin. */
  async usdcRoute(w, asset, amount) {
    const dex = w.dex; if (!dex?.quoter || !dex?.weth) return null;
    const tokenIn = lower(asset) === lower(ZeroAddress) ? dex.weth : asset, quoter = new Contract(dex.quoter, QUOTER, w.provider), paths = [];
    for (const f of FEE_TIERS) paths.push(solidityPacked(['address', 'uint24', 'address'], [tokenIn, f, w.usdc]));
    if (lower(tokenIn) !== lower(dex.weth)) for (const f1 of FEE_TIERS) for (const f2 of FEE_TIERS) paths.push(solidityPacked(['address', 'uint24', 'address', 'uint24', 'address'], [tokenIn, f1, dex.weth, f2, w.usdc]));
    let best = null;
    for (const path of paths) { try { const [out] = await quoter.quoteExactInput.staticCall(path, amount); if (out > 0n && (!best || out > best.quoted)) best = { path, quoted: out }; } catch { /* no pool or no liquidity on this route */ } }
    return best;
  }

  /**
   * Converts `amount` of `asset` held by the USDC distributor into USDC along `route` (at least 97% of a fresh quote).
   * Returns the USDC received, or throws with the reason.
   */
  async toUsdc(w, target, asset, amount, route) {
    const fresh = await this.usdcRoute(w, asset, amount) ?? route;
    if (!fresh) throw new Error('no USDC route');
    const minOut = fresh.quoted * 97n / 100n, out = await target.convert.staticCall(asset, amount, minOut, fresh.path);
    await this.send(w, () => target.convert(asset, amount, minOut, fresh.path));
    return out;
  }

  /** Monthly: each finished trader-airdrop round, per pool asset (in USDC once the chain has a USDC distributor). */
  async airdrop(w) {
    const index = w.index(); if (!index) return;
    if (this.usdcDistributor(w, 'airdrop')) return this.airdropUsdc(w, index);
    const drop = new Contract(w.deployment.airdrop, DISTRIBUTOR, w.signer), current = Number(await drop.currentRound());
    for (let round = this.get(`${w.chain}:airdrop:next`, 0), stop = round + this.maxRoundsPerTick; round < current && round < stop; round++) {
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

  /**
   * The trader airdrop in USDC: at each round's end, every asset with a USDC route (USDC itself, or a Uniswap v3 pool
   * path) moves into the USDC distributor and is converted; an asset without a route stays where it is until one exists.
   * The whole USDC pool (less amounts carried for wallets under the minimum) is split by the same rules as before.
   */
  async airdropUsdc(w, index) {
    const drop = new Contract(w.deployment.airdrop, DISTRIBUTOR, w.signer), target = this.usdcDistributor(w, 'airdrop'), usdc = lower(w.usdc), current = Number(await drop.currentRound());
    for (let round = this.get(`${w.chain}:airdrop:next`, 0), stop = round + this.maxRoundsPerTick; round < current && round < stop; round++) {
      const [start, end] = (await Promise.all([drop.roundStart(round), drop.roundEnd(round)])).map(Number);
      await this.fees(w, { force: true });
      const assets = [...new Set([lower(ZeroAddress), usdc, ...index.listings().map(t => lower(t.quoteAddress ?? ZeroAddress))])], moved = {}, converted = {}, skipped = {};
      let gas = 0n;
      for (const a of assets) {
        const avail = await drop.available(a); if (avail <= 0n) continue;
        const route = a === usdc ? null : await this.usdcRoute(w, a, avail);
        if (a !== usdc && !route) { skipped[a] = 'no USDC route yet: held for a later round'; continue; }
        const s = await this.sweep(w, drop, target, round, a, avail);
        if (s) { moved[a] = s.moved.toString(); gas += s.gas; }
      }
      // Everything of a non-USDC asset the USDC distributor holds (this round's, and any earlier conversion that failed).
      for (const a of assets) {
        if (a === usdc) continue;
        const held = await target.available(a); if (held <= 0n) continue;
        try { converted[a] = (await this.toUsdc(w, target, a, held)).toString(); } catch (e) { skipped[a] = e.shortMessage ?? e.message; }
      }
      const linked = this.creatorLinked(index);
      const all = index.tradesBetween(0, end), trades = all.filter(t => t.timestamp >= start && !linked.get(lower(t.token))?.has(lower(t.account ?? '')));
      const firstSeen = new Map(); for (const t of all) if (t.account && !firstSeen.has(lower(t.account))) firstSeen.set(lower(t.account), t.timestamp);
      const usd = a => lower(a) === usdc ? 1 : w.usdPerUnit(a) ?? 0;
      const carried = new Map(Object.entries(this.get(`${w.chain}:airdrop:usdcCarried`, {})).map(([k, v]) => [k, BigInt(v)]));
      const held = [...carried.values()].reduce((x, y) => x + y, 0n), avail = await target.available(usdc), pools = avail > held ? { [usdc]: avail - held } : {};
      const plan = airdropRound({ trades: trades.map(t => ({ ...t, quoteUsd: Number(t.quoteAmount ?? 0) * usd(t.asset) })), start, end, usdPerUnit: usd, firstSeen: a => firstSeen.get(a), pools, carried: { [usdc]: carried }, decimals: { [usdc]: 6 },
        links: await this.links(w, trades.map(t => lower(t.account ?? ''))), creatorLinked: [...linked.values()].flatMap(s => [...s]) });
      const p = plan.byAsset[usdc];
      let result = null;
      if (p) {
        this.set(`${w.chain}:airdrop:usdcCarried`, Object.fromEntries([...p.carried].map(([k, v]) => [k, v.toString()])));
        if (p.payouts.size && (await target.rounds(round, usdc)).root === ZERO_ROOT) result = await this.post(w, target, round, usdc, p.payouts);
      }
      this.set(`${w.chain}:airdrop:next`, round + 1);
      this.record(w.chain, 'airdrop', 'ok', { round, usdc: true, moved, converted, skipped, keeperGas: gas.toString(), qualified: plan.qualified.length, result });
    }
  }

  /**
   * Holder rewards in USDC. A token is due when its pending holder share is worth the threshold (its USDC quote, so an
   * unpriced pair such as a test stock counts too). Due shares move into the USDC distributor per asset, are converted,
   * split back to the tokens pro rata, and paid to each token's holders in one USDC round. A share whose asset has no
   * USDC route stays in the holder distributor until one exists. USDC a token could not pay (no eligible holders) is
   * kept for it and added next time.
   */
  async holderUsdc(w, index) {
    const dist = new Contract(w.deployment.holder, DISTRIBUTOR, w.signer), target = this.usdcDistributor(w, 'holder'), usdc = lower(w.usdc), current = Number(await dist.currentRound());
    const hook = new Contract(w.deployment.hook, HOOK, w.provider), threshold = BigInt(Math.round(HOLDER_RULES.thresholdUsd[this.network] * 1e6));
    for (let round = this.get(`${w.chain}:holder:next`, 0), stop = round + this.maxRoundsPerTick; round < current && round < stop; round++) {
      const [start, end] = (await Promise.all([dist.roundStart(round), dist.roundEnd(round)])).map(Number);
      await this.fees(w, { force: true });
      await this.refuseIfBehind(w, round, [[target, usdc], ...[...new Set(index.listings().map(t => lower(t.quoteAddress ?? ZeroAddress)))].map(a => [dist, a])]);
      const done = this.get(`${w.chain}:holder:distributed`, {}), bank = new Map(Object.entries(this.get(`${w.chain}:holder:usdcBank`, {})).map(([k, v]) => [k, BigInt(v)]));
      const byAsset = new Map();
      for (const t of index.listings()) {
        const { owed, paid } = await hook.ledgers(t.address), pending = owed[3] + paid[3] - BigInt(done[lower(t.address)] ?? 0);
        if (pending <= 0n) continue;
        const a = lower(t.quoteAddress ?? ZeroAddress);
        if (!byAsset.has(a)) byAsset.set(a, []);
        byAsset.get(a).push({ token: lower(t.address), pending });
      }
      const moved = {}, skipped = {}, pools = new Map(bank);
      let gas = 0n;
      for (const [asset, list] of byAsset) {
        const total = list.reduce((x, d) => x + d.pending, 0n), route = asset === usdc ? { quoted: total } : await this.usdcRoute(w, asset, total);
        if (!route) { skipped[asset] = 'no USDC route yet: held for a later round'; continue; }
        const due = list.filter(d => route.quoted * d.pending / total + (bank.get(d.token) ?? 0n) >= threshold);
        let amount = due.reduce((x, d) => x + d.pending, 0n);
        const avail = await dist.available(asset); if (amount > avail) amount = avail;
        const s = amount > 0n ? await this.sweep(w, dist, target, round, asset, amount) : false;
        if (!s) continue;
        moved[asset] = s.moved.toString(); gas += s.gas;
        // The keeper's gas comes out of the moved native coin; the rest is converted and shared out.
        let out = s.moved;
        if (asset !== usdc && s.moved > 0n) { try { out = await this.toUsdc(w, target, asset, s.moved, route); } catch (e) { skipped[asset] = e.shortMessage ?? e.message; out = 0n; } }
        // The moved amount is no longer pending in the holder distributor; its USDC goes to the tokens pro rata.
        const dueTotal = due.reduce((x, d) => x + d.pending, 0n);
        let given = 0n;
        for (const [i, d] of due.entries()) {
          done[d.token] = (BigInt(done[d.token] ?? 0) + amount * d.pending / dueTotal).toString();
          const part = i + 1 === due.length ? out - given : out * d.pending / dueTotal; given += part;
          pools.set(d.token, (pools.get(d.token) ?? 0n) + part);
        }
      }
      const linked = this.creatorLinked(index), payouts = new Map(), stats = [], left = new Map();
      const excluded = [w.deployment.poolManager, w.deployment.hook, w.deployment.router, w.deployment.factory, w.deployment.airdrop, w.deployment.holder, w.deployment.flywheel, w.deployment.usdcAirdrop, w.deployment.usdcHolder].filter(Boolean);
      for (const [token, pool] of pools) {
        if (pool <= 0n) continue;
        const plan = pool >= threshold ? holderRound({ transfers: index.transfersOf(token), start, end, pool, excluded, creatorLinked: [...(linked.get(token) ?? [])] }) : null;
        if (!plan?.payouts.size) { left.set(token, pool); continue; }
        const sum = [...plan.payouts.values()].reduce((x, y) => x + y, 0n);
        for (const [k, v] of plan.payouts) payouts.set(k, (payouts.get(k) ?? 0n) + v);
        if (pool > sum) left.set(token, pool - sum);
        stats.push({ token, holders: plan.holders, usdc: sum.toString() });
      }
      let result = null;
      if (payouts.size && (await target.rounds(round, usdc)).root === ZERO_ROOT) result = await this.post(w, target, round, usdc, payouts);
      this.set(`${w.chain}:holder:distributed`, done);
      this.set(`${w.chain}:holder:usdcBank`, Object.fromEntries([...left].map(([k, v]) => [k, v.toString()])));
      this.set(`${w.chain}:holder:next`, round + 1);
      this.record(w.chain, 'holder', 'ok', { round, usdc: true, moved, skipped, keeperGas: gas.toString(), tokens: stats, result });
    }
  }

  /** Weekly: holders of tokens whose holder share has reached the threshold; USDC pairs converted to native first. */
  async holder(w) {
    const index = w.index(); if (!index) return;
    if (this.usdcDistributor(w, 'holder')) return this.holderUsdc(w, index);
    const dist = new Contract(w.deployment.holder, DISTRIBUTOR, w.signer), current = Number(await dist.currentRound()), hook = new Contract(w.deployment.hook, HOOK, w.provider);
    for (let round = this.get(`${w.chain}:holder:next`, 0), stop = round + this.maxRoundsPerTick; round < current && round < stop; round++) {
      const [start, end] = (await Promise.all([dist.roundStart(round), dist.roundEnd(round)])).map(Number);
      await this.fees(w, { force: true });
      await this.refuseIfBehind(w, round, [...new Set([lower(ZeroAddress), ...index.listings().map(t => lower(t.quoteAddress ?? ZeroAddress))])].map(a => [dist, a]));
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
          await this.send(w, () => dist.convertToNative(amount, minOut, 3000));
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
        await this.send(w, () => fw.buyAndBurn(o.token, o.amountIn, minOut, cycle)); done.push({ token: o.token, spent: o.amountIn });
      }
      catch (e) { if (e.code === 'lease_lost' || e.code === 'budget_reached') throw e; done.push({ token: o.token, skipped: safeError(e) }); }
    }
    this.done(w, 'flywheel'); this.record(w.chain, 'flywheel', 'ok', { cycle, orders: done });
  }

  status() {
    return { enabled: true, distributions: this.distributions, idle: this.idle ?? null, chains: this.workers.map(w => ({ spent24h: this.spent(w.chain).toString(), chain: w.chain, keeper: w.signer.address ?? null, airdropNext: this.get(`${w.chain}:airdrop:next`, 0), holderNext: this.get(`${w.chain}:holder:next`, 0),
      runs: this.db.prepare('SELECT job,at,status FROM v2k_runs WHERE chain=? ORDER BY id DESC LIMIT 8').all(w.chain),
      jobs: latestJobs(this.db.prepare('SELECT job,at,status,detail FROM v2k_runs WHERE id IN (SELECT MAX(id) FROM v2k_runs WHERE chain=? GROUP BY job) ORDER BY job').all(w.chain), Object.fromEntries(Object.entries(this.checked ?? {}).filter(([k]) => k.startsWith(`${w.chain}:`)).map(([k, v]) => [k.slice(w.chain.length + 1), v]))) })) };
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
      dex: testnetDexes[net.key]?.enabled ? testnetDexes[net.key] : null, usdc: payoutStable(net, oracles)?.address ?? null,
      index: () => indexFor(net.key), funderOf: env.ELPIDA_EXPLORER_API_KEY ? etherscanFunder(net.chainId, env.ELPIDA_EXPLORER_API_KEY) : null, ignoredFunders,
      usdPerUnit: asset => { if (lower(asset) === lower(ZeroAddress)) { const p = prices()[net.key]; return p?.status === 'fresh' ? p.usd : null; } const usdc = oracles[net.key]?.usdc; return usdc && lower(asset) === lower(usdc) ? 1 : null; } };
  });
  const gasTarget = /^\d+(\.\d{1,18})?$/.test(String(env.ELPIDA_V2_KEEPER_GAS_TARGET ?? '')) ? parseEther(env.ELPIDA_V2_KEEPER_GAS_TARGET) : undefined;
  const share = Number(env.ELPIDA_V2_KEEPER_GAS_SHARE_BPS), gasShareBps = Number.isInteger(share) && share >= 0 && share <= 5000 ? share : undefined;
  // Audit of 11 November: confirmations (default 2), a rolling 24-hour gas budget per chain in native coin (default 0.25),
  // and the distributions switch (default on for test networks; the first mainnet release keeps them off).
  const conf = Number(env.ELPIDA_KEEPER_CONFIRMATIONS), confirmations = Number.isInteger(conf) && conf >= 1 && conf <= 64 ? conf : undefined;
  const dailyGas = /^\d+(\.\d{1,18})?$/.test(String(env.ELPIDA_V2_KEEPER_DAILY_GAS ?? '')) ? parseEther(env.ELPIDA_V2_KEEPER_DAILY_GAS) : undefined;
  const distributions = env.ELPIDA_V2_DISTRIBUTIONS === 'off' ? false : env.ELPIDA_V2_DISTRIBUTIONS === 'on' ? true : undefined;
  const keeper = new V2Keeper({ workers, path, publicUrl, log, gasTarget, gasShareBps, confirmations, dailyGas, ...(distributions === undefined ? {} : { distributions }) });
  keeper.enabled = true; keeper.address = getAddress(address);
  return keeper;
}
