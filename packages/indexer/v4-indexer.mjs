// Model 11 indexer (phase 4): Elpida launches that live in one Uniswap v4 pool each, behind ElpidaV4Hook. There is no
// curve contract, so a launch is read from four sources:
//  - the factory:    Launched (creator, token, quote, first buy), MetadataPublished, QuoteApproved;
//  - the hook:       Launched (ticks and liquidity), Fee (every fee: the PoolManager's Swap leaves it out), BuybackBurned,
//                    Milestone, LiquidityOpened, FeesWithdrawn, FeePayoutFailed;
//  - the PoolManager: Swap, filtered by the launches' pool ids (the manager serves every v4 pool on the network);
//  - the router:     Swapped, which names the real trader (the hook only sees the router).
// It writes the same tables and row shapes as EvmIndexer, so listings, trades, candles, holders and balances are served
// by the same code. Test networks only until the hook is audited.
import { AbiCoder, Contract, Interface, ZeroAddress, formatUnits, keccak256, getAddress } from 'ethers';
import { EvmIndexer, mapLimit, ratio } from './evm-indexer.mjs';
import { supplyPercent } from '../core/curve-model.mjs';
import { V4_FEE, V4_FLAG_MASK, V4_HOOK_FLAGS, V4_MODEL, V4_MODEL_VERSION, V4_TICK_SPACING, grossForNet, v4PoolState, v4Price } from '../core/v4-model.mjs';

const dead = '0x000000000000000000000000000000000000dead';
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
const coder = AbiCoder.defaultAbiCoder();

export const V4_ABIS = Object.freeze({
  factory: ['event Launched(address indexed creator,address indexed token,address indexed quote,uint256 firstBuy,uint256 bought)', 'event MetadataPublished(address indexed token,string uri)', 'event QuoteApproved(address indexed asset,uint256 virtualQuote)', 'event PartnerSet(address indexed creator,uint16 buybackBps,uint64 expiresAt)', 'event HookSet(address indexed hook)', 'function MODEL_VERSION() view returns(uint256)', 'function hook() view returns(address)', 'function feeUsdc() view returns(address)', 'function treasury() view returns(address)'],
  hook: ['event Launched(address indexed token,address indexed quote,address indexed creatorVault,int24 upperTick,int24 lowerTick,uint128 saleLiquidity,uint128 upperLiquidity,uint256 dustBurned)', 'event Fee(address indexed token,address indexed trader,bool buy,uint256 feeBps,uint256 fee,uint256 lockedBonus)', 'event BuybackBurned(address indexed token,uint256 quoteIn,uint256 tokensBurned)', 'event Milestone(address indexed token,uint256 saleQuote,uint256 bonus,uint128 liquidity,uint256 dust)', 'event LiquidityOpened(address indexed token)', 'event FeesWithdrawn(address indexed token,address indexed recipient,uint256 amount)', 'event FeePayoutFailed(address indexed token,address indexed recipient,uint256 amount)',
    'function launches(address) view returns(address quote,bool liquidityOpen,address creatorVault,uint64 launchedAt,uint16 buybackBps,bool graduated,int24 upperTick,int24 lowerTick,uint128 saleLiquidity,uint128 upperLiquidity,uint128 milestoneLiquidity,uint256 creatorFees,uint256 protocolFees,uint256 liquidityBonus,uint256 buybackBurned,uint256 buybackQuoteSpent)', 'function currentFeeBps(address) view returns(uint256)', 'function factory() view returns(address)', 'function protocolTreasury() view returns(address)'],
  pool: ['event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)', 'function extsload(bytes32) view returns(bytes32)'],
  router: ['event Swapped(address indexed token,address indexed trader,address indexed recipient,bool buy,uint256 quoteAmount,uint256 tokenAmount)', 'function ROUTER_VERSION() view returns(uint256)', 'function hook() view returns(address)', 'function poolManager() view returns(address)'],
  token: ['event Transfer(address indexed from,address indexed to,uint256 value)', 'function name() view returns(string)', 'function symbol() view returns(string)', 'function totalSupply() view returns(uint256)', 'function balanceOf(address) view returns(uint256)', 'function decimals() view returns(uint8)'],
});
const SWAP_TOPIC = new Interface(V4_ABIS.pool).getEvent('Swap').topicHash;

/** The v4 pool key of an Elpida launch: quote is currency0, the token currency1, LP fee 0, tick spacing 10. */
export const v4PoolKey = (quote, token, hook) => [quote || ZeroAddress, token, 0, V4_TICK_SPACING, hook];
/** PoolId = keccak256(abi.encode(PoolKey)). */
export const v4PoolId = key => keccak256(coder.encode(['address', 'address', 'uint24', 'int24', 'address'], key));
/** slot0 of a pool through the PoolManager's extsload (StateLibrary: pools mapping at slot 6). */
export async function v4Slot0(manager, poolId, call = {}) {
  const slot = keccak256(coder.encode(['bytes32', 'uint256'], [poolId, 6n]));
  const word = BigInt(await manager.extsload(slot, call));
  return { sqrtPrice: word & ((1n << 160n) - 1n), tick: Number(BigInt.asIntN(24, (word >> 160n) & 0xffffffn)) };
}

export class V4Indexer extends EvmIndexer {
  constructor({ provider, factory, hook, poolManager, router = null, path = ':memory:', chainId = 31337, fromBlock = 0, confirmations = 0, nativeSymbol = 'ETH', batchSize = 100, fullRefreshMs = 0, abis = V4_ABIS }) {
    super({ provider, factory, contracts: { factory: { abi: abis.factory }, curve: { abi: abis.hook }, pool: { abi: abis.pool }, token: { abi: abis.token } }, path, chainId, fromBlock, confirmations, nativeSymbol, batchSize, dexName: 'Uniswap v4', fullRefreshMs });
    this.hook = hook.toLowerCase(); this.poolManager = poolManager.toLowerCase(); this.router = router ? router.toLowerCase() : null;
    this.abis = abis; this.interfaces.hook = this.interfaces.curve; this.interfaces.router = new Interface(abis.router);
    this.hookContract = new Contract(hook, abis.hook, provider); this.managerContract = new Contract(poolManager, V4_ABIS.pool, provider);
  }
  /** Contract handles follow an RPC failover (PublicIndexer replaces `provider`). */
  bind() {
    if (this.boundTo === this.provider) return;
    this.hookContract = new Contract(this.hook, this.abis.hook, this.provider); this.managerContract = new Contract(this.poolManager, V4_ABIS.pool, this.provider);
    this.boundTo = this.provider;
  }
  kindOf(address) {
    const a = address.toLowerCase();
    return a === this.factory ? 'factory' : a === this.hook ? 'hook' : a === this.poolManager ? 'pool' : a === this.router ? 'router' : 'token';
  }
  async scan() {
    this.bind();
    const head = Number(await this.provider.send('eth_blockNumber', [])), target = head - this.confirmations;
    this.head = head;
    let tip = this.tip();
    while (tip) {
      const current = await this.provider.getBlock(tip.height);
      if (current?.hash === tip.hash && tip.height <= target) break;
      this.rollback(tip.height - 1); tip = this.tip();
    }
    const full = this.fullRefreshMs === 0 || Date.now() - this.lastFull >= this.fullRefreshMs;
    for (let height = tip ? tip.height + 1 : this.fromBlock; height <= target; height += this.batchSize) {
      const end = Math.min(target, height + this.batchSize - 1);
      await this.scanRange(height, end, full && end === target);
    }
    if (full && (tip ? tip.height : this.fromBlock - 1) < target) this.lastFull = Date.now();
    this.head = head; this.lastError = null;
    return this.status();
  }
  async scanRange(from, to, refreshAll) {
    const known = this.tokens();
    const base = [this.factory, this.hook, ...(this.router ? [this.router] : []), ...known.map(t => t.address)];
    const logs = await this.provider.getLogs({ address: base, fromBlock: from, toBlock: to });
    const fresh = [];
    for (const l of logs) if (l.address.toLowerCase() === this.factory) { const e = this.parse('factory', l); if (e?.name === 'Launched') fresh.push({ token: e.args.token, quote: e.args.quote }); }
    if (fresh.length) logs.push(...await this.provider.getLogs({ address: fresh.map(f => f.token), fromBlock: from, toBlock: to }));
    const ids = [...known.map(t => t.poolId), ...fresh.map(f => v4PoolId(v4PoolKey(f.quote, f.token, this.hook)))];
    if (ids.length) logs.push(...await this.provider.getLogs({ address: this.poolManager, topics: [SWAP_TOPIC, ids], fromBlock: from, toBlock: to }));
    const unique = [...new Map(logs.map(l => [`${l.transactionHash}:${l.index}`, l])).values()]
      .sort((a, b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex || a.index - b.index);
    const heights = [...new Set([...unique.map(l => l.blockNumber), to])].sort((a, b) => a - b);
    const blocks = new Map();
    await mapLimit(heights, 8, async h => { blocks.set(h, await this.provider.getBlock(h)); });
    for (const h of heights) await this.scanV4Block(h, blocks.get(h), unique.filter(l => l.blockNumber === h), refreshAll && h === to);
  }
  async scanV4Block(height, block, logs, refreshAll) {
    if (!block) throw new Error('Block unavailable; retry indexing.');
    if (logs.some(l => l.blockHash && l.blockHash !== block.hash)) throw new Error('Chain changed during indexing; retry.');
    const call = { blockTag: height }, records = new Map(this.tokens().map(t => [t.address, t])), fresh = [];
    const parsed = logs.map(l => ({ l, kind: this.kindOf(l.address), e: null })).map(x => ({ ...x, e: this.parse(x.kind, x.l) })).filter(x => x.e);
    // New launches: the factory event carries the creator and first buy, the hook's the positions.
    const uris = new Map(parsed.filter(x => x.kind === 'factory' && x.e.name === 'MetadataPublished').map(x => [x.e.args.token.toLowerCase(), x.e.args.uri]));
    for (const x of parsed) {
      if (x.kind !== 'factory' || x.e.name !== 'Launched') continue;
      const address = x.e.args.token.toLowerCase(), quote = x.e.args.quote, native = quote === ZeroAddress;
      const placed = parsed.find(y => y.kind === 'hook' && y.e.name === 'Launched' && y.e.args.token.toLowerCase() === address);
      if (!placed) throw new Error('Launch without hook positions; retry indexing.');
      const token = new Contract(address, this.abis.token, this.provider), [name, symbol] = await Promise.all([token.name(call), token.symbol(call)]);
      let pair = native ? 'native' : 'token', quoteSymbol = this.nativeSymbol, quoteDecimals = 18;
      if (!native) {
        const q = new Contract(quote, this.abis.token, this.provider);
        [quoteSymbol, quoteDecimals] = await Promise.all([q.symbol(call), q.decimals(call).then(Number)]);
        try { if ((await new Contract(this.factory, this.abis.factory, this.provider).feeUsdc(call)).toLowerCase() === quote.toLowerCase()) pair = 'usdc'; } catch { /* pricing not configured */ }
        // Test stocks (and later approved real ones) describe themselves: pairKind() === 'xstock'.
        if (pair === 'token') try { if (await new Contract(quote, ['function pairKind() view returns(string)'], this.provider).pairKind(call) === 'xstock') pair = 'xstock'; } catch { /* a plain token */ }
      }
      const positions = { upperTick: Number(placed.e.args.upperTick), lowerTick: Number(placed.e.args.lowerTick), saleLiquidity: placed.e.args.saleLiquidity.toString(), upperLiquidity: placed.e.args.upperLiquidity.toString() };
      const saleTokens = v4PoolState({ ...positions, milestoneLiquidity: 0n, graduated: false }, 0n).saleTokens;
      const key = v4PoolKey(quote, x.e.args.token, getAddress(this.hook));
      const r = { address, metadataURI: uris.get(address) ?? '', curve: this.hook, hook: this.hook, poolManager: this.poolManager, poolId: v4PoolId(key), poolKey: key, creator: x.e.args.creator, reward: placed.e.args.creatorVault, name, symbol, pair, quoteAddress: quote, quoteDecimals, quoteSymbol,
        saleCapRaw: saleTokens.toString(), created: block.timestamp * 1000, creationBlock: height, hash: x.l.transactionHash, venue: 'Uniswap v4', partialFill: false,
        dustBurned: placed.e.args.dustBurned.toString(), ...positions, ...await this.launchFields(address, x.e, placed.e, call),
        devBoughtRaw: x.e.args.bought.toString(), devBoughtPct: supplyPercent(x.e.args.bought.toString()) };
      fresh.push(r); records.set(address, r);
    }
    // Trades: each PoolManager Swap of a launch's pool, with the hook's Fee that follows it. A Swap the hook itself
    // makes is a buyback when BuybackBurned follows (not a trade), or the creator's first buy when Fee does.
    const byPool = new Map([...records.values()].map(r => [r.poolId.toLowerCase(), r]));
    const trades = [], touched = new Set(fresh.map(r => r.address)), txs = new Map();
    for (const x of parsed) { const list = txs.get(x.l.transactionHash) ?? []; list.push(x); txs.set(x.l.transactionHash, list); }
    for (const [hash, list] of txs) {
      const pending = new Map(), done = [], routed = [];
      const close = (r, swap, fee) => {
        const a0 = swap.e.args.amount0, a1 = swap.e.args.amount1, buy = a0 < 0n, f = fee ? fee.e.args.fee : 0n;
        const quoteRaw = buy ? -a0 + f : a0 - f, tokenRaw = buy ? a1 : -a1;
        if (quoteRaw <= 0n || tokenRaw <= 0n) return;
        const first = swap.e.args.sender.toLowerCase() === this.hook;
        done.push({ r, swap, buy, quoteRaw, tokenRaw, fee: f, feeBps: fee ? Number(fee.e.args.feeBps) : 0, first, account: first ? fee?.e.args.trader ?? null : null });
      };
      for (const x of list) {
        if (x.kind === 'pool' && x.e.name === 'Swap') {
          const r = byPool.get(String(x.e.args.id).toLowerCase()); if (!r) continue;
          touched.add(r.address);
          const open = pending.get(r.address); if (open) close(r, open, null);
          pending.set(r.address, x);
        } else if (x.kind === 'hook' && ['Fee', 'BuybackBurned'].includes(x.e.name)) {
          const address = x.e.args.token.toLowerCase(), r = records.get(address), open = pending.get(address);
          touched.add(address);
          if (!r || !open) continue;
          pending.delete(address);
          if (x.e.name === 'Fee') close(r, open, x);
        } else if (x.kind === 'hook' && x.e.args?.token) touched.add(x.e.args.token.toLowerCase());
        else if (x.kind === 'router' && x.e.name === 'Swapped') routed.push(x);
        else if (x.kind === 'token') touched.add(x.l.address.toLowerCase());
      }
      for (const [address, open] of pending) close(records.get(address), open, null);
      for (const t of done) {
        if (t.first) { t.basis = 'launch first buy (factory buyer)'; continue; }
        const i = routed.findIndex(x => x.e.args.token.toLowerCase() === t.r.address && x.e.args.buy === t.buy);
        if (i >= 0) { const [x] = routed.splice(i, 1); t.account = t.buy ? x.e.args.recipient : x.e.args.trader; t.basis = 'Elpida router'; }
        else { t.account = (await this.provider.getTransaction(hash))?.from ?? null; t.basis = 'transaction sender; trade went through another router'; }
      }
      trades.push(...done);
    }
    const snapshots = [];
    for (const r of records.values()) if (refreshAll || touched.has(r.address) || !this.snapshot(r.address)) snapshots.push([r, await this.readSnapshot(r, height, block)]);
    if ((await this.provider.getBlock(height))?.hash !== block.hash) throw new Error('Chain changed during indexing; retry.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO blocks VALUES(?,?,?,?)').run(height, block.hash, block.parentHash, block.timestamp);
      for (const r of fresh) this.db.prepare('INSERT INTO tokens VALUES(?,?,?)').run(r.address, height, json(r));
      for (const { l, kind, e } of parsed) {
        // Swaps of other pools never reach here (filtered by id); Swaps of ours are stored with their pool.
        const transfer = kind === 'token' && e.name === 'Transfer';
        this.db.prepare('INSERT OR IGNORE INTO events(tx,idx,height,data,address,sender,recipient) VALUES(?,?,?,?,?,?,?)').run(l.transactionHash, l.index, height, json({ address: l.address, kind, name: e.name, args: e.args.toArray(), blockHash: block.hash }), l.address.toLowerCase(), transfer ? String(e.args[0]).toLowerCase() : null, transfer ? String(e.args[1]).toLowerCase() : null);
      }
      for (const t of trades) {
        const d = t.r.quoteDecimals, l = t.swap.l;
        const trade = { hash: l.transactionHash, index: l.index, token: t.r.address, market: this.poolManager, venue: 'Uniswap v4', side: t.buy ? 'buy' : 'sell', account: t.account, sender: t.swap.e.args.sender, accountBasis: t.basis,
          quoteRaw: t.quoteRaw.toString(), tokenRaw: t.tokenRaw.toString(), quoteAmount: formatUnits(t.quoteRaw, d), tokenAmount: formatUnits(t.tokenRaw, 18), quoteSymbol: t.r.quoteSymbol, feeRaw: t.fee.toString(), feeBps: t.feeBps,
          priceQuote: ratio(t.quoteRaw * 10n ** 18n, t.tokenRaw * 10n ** BigInt(d)), priceBasis: 'execution, including trader fees', timestamp: block.timestamp, blockNumber: height, ...(t.first ? { launch: true } : {}) };
        this.db.prepare('INSERT OR IGNORE INTO trades VALUES(?,?,?,?,?,?)').run(l.transactionHash, l.index, t.r.address, height, block.timestamp, json(trade));
      }
      for (const [r, s] of snapshots) this.db.prepare('INSERT INTO snapshots VALUES(?,?,?)').run(r.address, height, json(s));
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  /** The model's own fields of a new launch record (Model 11: fixed 1.25% fee, 1% after the milestone, partner tiers). */
  async launchFields(address, factoryEvent, hookEvent, call) {
    const launch = await this.hookContract.launches(address, call);
    return { curveModel: 11, model: V4_MODEL, launchedAt: Number(launch.launchedAt), feeSchedule: { base: V4_FEE.base, start: V4_FEE.start, window: V4_FEE.window }, poolFeeBps: V4_FEE.pool, buybackBps: Number(launch.buybackBps) };
  }
  async readSnapshot(r, height, block) {
    const call = { blockTag: height }, t = new Contract(r.address, V4_ABIS.token, this.provider), d = r.quoteDecimals;
    const [l, slot, feeBps, supply, deadBalance, inPools, devHolding] = await Promise.all([this.hookContract.launches(r.address, call), v4Slot0(this.managerContract, r.poolId, call), this.hookContract.currentFeeBps(r.address, call), t.totalSupply(call), t.balanceOf(dead, call), t.balanceOf(this.poolManager, call), t.balanceOf(r.creator, call)]);
    const state = v4PoolState({ upperTick: Number(l.upperTick), lowerTick: Number(l.lowerTick), saleLiquidity: l.saleLiquidity, upperLiquidity: l.upperLiquidity, milestoneLiquidity: l.milestoneLiquidity, graduated: l.graduated }, slot.sqrtPrice);
    const square = slot.sqrtPrice * slot.sqrtPrice, Q = 1n << 192n, circulating = supply - deadBalance - inPools;
    const graduated = l.graduated, bps = Number(feeBps);
    return { pool: this.poolManager, poolId: r.poolId, graduated, complete: graduated, soldOut: false, liquidityLocked: true, liquidityOpen: l.liquidityOpen, venue: 'Uniswap v4', feeBps: bps, antiSnipeActive: !graduated && bps > V4_FEE.base,
      sqrtPriceX96: slot.sqrtPrice.toString(), tick: slot.tick, reserve: formatUnits(state.quoteReserve, d), reserveBasis: 'quote in the hook\'s locked positions (the PoolManager holds every v4 pool\'s funds together)', poolTokens: formatUnits(state.tokenReserve, 18),
      sold: formatUnits(state.saleSold, 18), saleCap: formatUnits(state.saleTokens, 18), supply: formatUnits(supply, 18), circulatingSupply: formatUnits(circulating, 18), deadSupply: formatUnits(deadBalance, 18),
      spotPrice: v4Price(slot.sqrtPrice, d), fdvQuote: square ? ratio(Q * supply, square * 10n ** BigInt(d)) : null, circulatingMarketCapQuote: square ? ratio(Q * circulating, square * 10n ** BigInt(d)) : null, supplyPolicy: 'exclude PoolManager inventory and known dead address v1', priceUsd: null, usdBasis: null,
      protocolFees: formatUnits(l.protocolFees, d), creatorFees: formatUnits(l.creatorFees, d), feesBasis: 'unclaimed, held as claims in the PoolManager', liquidityBonus: formatUnits(l.liquidityBonus, d), buybackBps: Number(l.buybackBps), burned: formatUnits(l.buybackBurned, 18), milestoneLiquidity: l.milestoneLiquidity.toString(),
      remainingBuy: graduated ? '0' : formatUnits(grossForNet(state.toMilestone, bps), d), remainingBase: graduated ? '0' : formatUnits(grossForNet(state.toMilestone, V4_FEE.base), d),
      devHoldingRaw: devHolding.toString(), devHoldingPct: supplyPercent(devHolding, supply), indexedBlock: height, indexedBlockHash: block.hash, priceTimestamp: block.timestamp };
  }
  status() { return { ...super.status(), hook: this.hook, poolManager: this.poolManager, router: this.router, model: V4_MODEL, adapters: ['Elpida v4 hook', 'Uniswap v4 PoolManager', ...(this.router ? ['Elpida v4 router'] : [])] }; }
}

/** Reads a Model 11 deployment's wiring from the chain: the factory's hook, the hook's factory, the router's hook. */
export async function verifyV4Deployment(provider, { factory, hook, router, poolManager }) {
  const f = new Contract(factory, V4_ABIS.factory, provider), h = new Contract(hook, V4_ABIS.hook, provider);
  const [version, factoryHook, hookFactory] = await Promise.all([f.MODEL_VERSION(), f.hook(), h.factory()]);
  if (Number(version) !== V4_MODEL_VERSION || factoryHook.toLowerCase() !== hook.toLowerCase() || hookFactory.toLowerCase() !== factory.toLowerCase()) throw new Error('Model 11 deployment mismatch');
  if ((BigInt(hook) & V4_FLAG_MASK) !== V4_HOOK_FLAGS) throw new Error('Hook address lacks its permission bits');
  if (router) { const r = new Contract(router, V4_ABIS.router, provider), [rh, rm] = await Promise.all([r.hook(), r.poolManager()]); if (rh.toLowerCase() !== hook.toLowerCase() || rm.toLowerCase() !== poolManager.toLowerCase()) throw new Error('Model 11 router mismatch'); }
  return true;
}
