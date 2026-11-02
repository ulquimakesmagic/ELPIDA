// Revenue flywheel keeper (docs/REVENUE_FLYWHEEL.md). Malik tops up a dedicated wallet with 10% of the protocol fees
// the treasury received. On a schedule this worker splits what that wallet may spend into ten equal slots, one for each
// of the ten eligible Elpida tokens with the highest market cap on the chain, buys each token on its curve or its
// locked pool, and sends what it bought to the dead address. Anything a slot cannot spend stays in the wallet.
//
// Guards: testnets only; native-pair tokens only (the budget is the native coin); a token must be a day old; on the
// curve at most 25% of what is left to complete it, so the flywheel never graduates a curve; on a pool at most 0.5% of
// its quote balance, and only while the pool price is within 150 ticks of its 10-minute average (the same rule as the
// partner buyback, review finding E-1); a dry run sets the minimum output, less 1% slippage. Every order is written to
// the journal before it is sent and settled after, so a restart never repeats or loses one; tokens bought but not yet
// sent to the dead address are sent at the next cycle. The worker's key never leaves the server.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { Contract, Interface, Wallet, parseEther, formatEther } from 'ethers';
import { planFlywheelCycle, FLYWHEEL_POLICY } from '../../packages/core/revenue-flywheel.mjs';
import { swapCalldata, routerAbi } from '../../packages/core/dex-router.mjs';

/** EVM chains the flywheel may spend on: the public testnets and the local test chain. Mainnets are refused. */
export const FLYWHEEL_EVM_CHAINS = new Set([84532, 11155111, 97, 46630, 31337]);
export const DEAD = '0x000000000000000000000000000000000000dEaD';
export const TWAP_WINDOW = 600, MIN_TWAP_WINDOW = 120, MAX_TWAP_DEVIATION_TICKS = 150, POOL_OBSERVATIONS = 16;
const CURVE_ABI = ['function quoteBuy(uint256 gross) view returns(uint256 out,uint256 fee)', 'function buy(uint256 input,uint256 minOut) payable returns(uint256 out)', 'function complete() view returns(bool)'];
const TOKEN_ABI = ['function balanceOf(address) view returns(uint256)', 'function transfer(address,uint256) returns(bool)'];
// Reads Uniswap v3 and PancakeSwap v3 pools alike (PancakeSwap's feeProtocol is uint32).
const POOL_ABI = ['function increaseObservationCardinalityNext(uint16)', 'function slot0() view returns(uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint32 feeProtocol,bool unlocked)', 'function observations(uint256) view returns(uint32 blockTimestamp,int56 tickCumulative,uint160 secondsPerLiquidityCumulativeX128,bool initialized)', 'function observe(uint32[] secondsAgos) view returns(int56[] tickCumulatives,uint160[] secondsPerLiquidityCumulativeX128s)'];
const fail = code => Object.assign(new Error(code), { code });
const errorCode = error => String(error?.code && typeof error.code === 'string' ? error.code : error?.shortMessage ?? error?.message ?? 'error').replace(/[^a-zA-Z0-9_ .:-]/g, '').slice(0, 80);
/** Order outcomes that mean "not now" rather than a fault: the order is skipped and nothing is spent. */
export const WAIT = new Set(['price_unsettled', 'price_history_short', 'curve_complete', 'nothing_bought']);

/**
 * The pool's average tick over the last TWAP_WINDOW seconds (or the history it keeps, at least MIN_TWAP_WINDOW), and
 * its current tick. Throws `price_history_short` when the pool has not kept enough history.
 */
export async function poolPriceCheck(pool, now) {
  const [, tick, index, cardinality] = await pool.slot0();
  let [oldest, , , initialized] = await pool.observations((Number(index) + 1) % Number(cardinality));
  if (!initialized) [oldest] = await pool.observations(0);
  const age = Number(now) - Number(oldest), window = Math.min(TWAP_WINDOW, age);
  if (window < MIN_TWAP_WINDOW) throw fail('price_history_short');
  const [cumulative] = await pool.observe([window, 0]);
  const delta = cumulative[1] - cumulative[0], span = BigInt(window);
  let average = delta / span;
  if (delta < 0n && delta % span !== 0n) average -= 1n;
  return { tick: BigInt(tick), average, near: (BigInt(tick) > average ? BigInt(tick) - average : average - BigInt(tick)) <= BigInt(MAX_TWAP_DEVIATION_TICKS) };
}

/**
 * EVM worker for one chain. `listings()` returns the public index's records for the chain; `dex` is that chain's DEX
 * configuration (router, WETH, fee tier, router version).
 */
export function evmFlywheelWorker({ chain, chainId, signer, listings, dex, explorer = null, name = chain, slippageBps = 100, contract = (a, abi, r) => new Contract(a, abi, r) }) {
  if (!FLYWHEEL_EVM_CHAINS.has(Number(chainId))) throw new Error('Flywheel keeper: chain is not an allowed testnet');
  const provider = signer.provider;
  const wei = v => { try { return parseEther(String(v ?? '0')); } catch { return 0n; } };
  const send = async promise => { const receipt = await (await promise).wait(); if (receipt.status !== 1) throw fail('reverted'); return receipt; };
  return {
    chain, name, explorer, format: v => formatEther(v),
    address: () => signer.getAddress(),
    balance: async () => provider.getBalance(await signer.getAddress()),
    /** Index records as the planner's integers, native unit. */
    async tokens() {
      return (await listings()).map(t => ({
        address: t.address, symbol: t.metadata?.symbol ?? t.symbol ?? null, pair: t.pair ?? 'native', graduated: !!t.graduated, complete: !!t.complete,
        pool: t.graduated && t.pool && !/^0x0+$/.test(t.pool) ? t.pool : null, curve: t.curve ?? null, created: Number(t.created),
        marketCap: wei(t.circulatingMarketCapQuote ?? t.fdvQuote), remainingBuy: wei(t.remainingBuy), poolReserve: t.graduated ? wei(t.reserve) : 0n,
        restricted: !!(t.stock?.paused || t.restricted),
      }));
    },
    /** Sends any of `token` the wallet already holds (bought in an earlier, interrupted order) to the dead address. */
    async burnHeld(token) {
      const coin = contract(token, TOKEN_ABI, signer), held = await coin.balanceOf(await signer.getAddress());
      if (held === 0n) return null;
      const receipt = await send(coin.transfer(DEAD, held));
      return { burned: held, burnTx: receipt.hash };
    },
    /** Buys `order.spend` of the token, then sends exactly what was bought to the dead address. */
    async execute(order) {
      const me = await signer.getAddress(), coin = contract(order.token, TOKEN_ABI, signer), before = await coin.balanceOf(me);
      let buy;
      if (order.venue === 'curve') {
        const curve = contract(order.curve, CURVE_ABI, signer);
        if (await curve.complete()) throw fail('curve_complete');
        const [out] = await curve.quoteBuy(order.spend);
        buy = await send(curve.buy(order.spend, out * BigInt(10_000 - slippageBps) / 10_000n, { value: order.spend }));
      } else {
        const pool = contract(order.pool, POOL_ABI, signer), now = (await provider.getBlock('latest')).timestamp;
        // A pool that keeps a single price point has no usable average once anyone trades: ask it, once, to keep more.
        const [, , , , next] = await pool.slot0();
        if (Number(next) < POOL_OBSERVATIONS) await send(pool.increaseObservationCardinalityNext(POOL_OBSERVATIONS));
        if (!(await poolPriceCheck(pool, now)).near) throw fail('price_unsettled');
        const router = contract(dex.router, routerAbi(dex.routerVersion ?? 2), signer), deadline = BigInt(now + 600);
        const params = { tokenIn: dex.weth, tokenOut: order.token, fee: dex.fee ?? 10_000, recipient: me, amountIn: order.spend, sqrtPriceLimitX96: 0n };
        const dry = swapCalldata(Interface, dex.routerVersion ?? 2, dex.router, { ...params, amountOutMinimum: 0n }, { deadline, refundETH: true });
        const [results] = router.interface.decodeFunctionResult(router.interface.getFunction(dry.slice(0, 10)), await provider.call({ to: dex.router, from: me, data: dry, value: order.spend }));
        const expected = BigInt(router.interface.decodeFunctionResult('exactInputSingle', results[0])[0]);
        const data = swapCalldata(Interface, dex.routerVersion ?? 2, dex.router, { ...params, amountOutMinimum: expected * BigInt(10_000 - slippageBps) / 10_000n }, { deadline, refundETH: true });
        buy = await send(signer.sendTransaction({ to: dex.router, data, value: order.spend }));
      }
      const bought = (await coin.balanceOf(me)) - before;
      if (bought <= 0n) throw fail('nothing_bought');
      const burn = await send(coin.transfer(DEAD, bought));
      return { buyTx: buy.hash, burnTx: burn.hash, bought, gas: buy.gasUsed * (buy.gasPrice ?? 0n) + burn.gasUsed * (burn.gasPrice ?? 0n) };
    },
  };
}

/**
 * Runs cycles on a schedule and keeps the journal. A worker is
 * `{ chain, format, address(), balance(), tokens(), burnHeld(token), execute(order) }`.
 */
export class FlywheelKeeper {
  constructor({ workers, path = ':memory:', everyMs = 24 * 3_600_000, tickMs = 60_000, maxPerCycle = parseEther('0.05'), gasReserve = parseEther('0.005'), now = Date.now, log = () => {}, policy = FLYWHEEL_POLICY }) {
    if (!workers?.length) throw new Error('Flywheel keeper needs at least one worker');
    Object.assign(this, { workers, everyMs, tickMs, maxPerCycle, gasReserve, now, log, policy });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS flywheel_cycles(id INTEGER PRIMARY KEY, chain TEXT NOT NULL, at INTEGER NOT NULL, balance TEXT NOT NULL, budget TEXT NOT NULL, planned TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS flywheel_orders(id INTEGER PRIMARY KEY, cycle INTEGER NOT NULL, chain TEXT NOT NULL, rank INTEGER NOT NULL, token TEXT NOT NULL, symbol TEXT, venue TEXT NOT NULL,
        market_cap TEXT NOT NULL, spend TEXT NOT NULL, bought TEXT, buy_tx TEXT, burn_tx TEXT, status TEXT NOT NULL, error TEXT, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS flywheel_lock(id INTEGER PRIMARY KEY, owner TEXT, expires INTEGER);
      INSERT OR IGNORE INTO flywheel_lock VALUES(1, '', 0);`);
    this.owner = crypto.randomUUID();
    this.state = Object.fromEntries(workers.map(w => [w.chain, { chain: w.chain, state: 'starting' }]));
  }
  start() { this.timer = setInterval(() => this.tick(), this.tickMs); this.timer.unref?.(); this.tick(); return this; }
  async tick() {
    if (this.running || this.stopping) return;
    if (!this.db.prepare('UPDATE flywheel_lock SET owner=?, expires=? WHERE id=1 AND (expires<? OR owner=?)').run(this.owner, this.now() + 30 * 60_000, this.now(), this.owner).changes) return;
    this.running = true;
    try {
      for (const worker of this.workers) {
        const last = this.db.prepare('SELECT at FROM flywheel_cycles WHERE chain=? ORDER BY at DESC LIMIT 1').get(worker.chain)?.at ?? 0;
        if (this.now() - last >= this.everyMs) await this.runCycle(worker);
      }
    } finally { this.running = false; }
  }
  /** One cycle on one chain: recover interrupted orders, plan, then buy and burn each order in rank order. */
  async runCycle(worker) {
    const s = this.state[worker.chain];
    try {
      s.address = await worker.address();
      // Orders interrupted after the buy: the tokens the wallet still holds go to the dead address first.
      for (const o of this.db.prepare("SELECT id, token FROM flywheel_orders WHERE chain=? AND status IN ('sending','bought')").all(worker.chain)) {
        let held = null; try { held = await worker.burnHeld(o.token); } catch (error) { this.log({ event: 'flywheel_recovery_error', chain: worker.chain, token: o.token, code: errorCode(error) }); continue; }
        this.db.prepare("UPDATE flywheel_orders SET status=?, bought=COALESCE(bought, ?), burn_tx=COALESCE(burn_tx, ?) WHERE id=?").run(held ? 'burned' : 'unknown', held ? String(held.burned) : null, held?.burnTx ?? null, o.id);
      }
      const balance = await worker.balance(), spendable = balance > this.gasReserve ? balance - this.gasReserve : 0n;
      const budget = spendable < this.maxPerCycle ? spendable : this.maxPerCycle;
      const plan = planFlywheelCycle({ chain: worker.chain, budget, tokens: await worker.tokens(), now: Math.floor(this.now() / 1000), policy: this.policy });
      const planned = plan.orders.reduce((sum, o) => sum + o.spend, 0n);
      const cycle = Number(this.db.prepare('INSERT INTO flywheel_cycles(chain, at, balance, budget, planned, status) VALUES(?,?,?,?,?,?)').run(worker.chain, this.now(), String(balance), String(budget), String(planned), plan.orders.length ? 'running' : budget > 0n ? 'no_eligible_token' : 'no_budget').lastInsertRowid);
      let spent = 0n;
      for (const order of plan.orders) {
        const id = Number(this.db.prepare("INSERT INTO flywheel_orders(cycle, chain, rank, token, symbol, venue, market_cap, spend, status, at) VALUES(?,?,?,?,?,?,?,?, 'sending', ?)").run(cycle, worker.chain, order.rank, order.token, order.symbol, order.venue, String(order.marketCap), String(order.spend), this.now()).lastInsertRowid);
        try {
          const r = await worker.execute(order);
          this.db.prepare("UPDATE flywheel_orders SET status='burned', bought=?, buy_tx=?, burn_tx=? WHERE id=?").run(String(r.bought), r.buyTx, r.burnTx, id);
          spent += order.spend;
          this.log({ event: 'flywheel_burned', chain: worker.chain, token: order.token, buyTx: r.buyTx, burnTx: r.burnTx });
        } catch (error) {
          const code = errorCode(error);
          // Nothing was bought: a refusal or a reverted buy. (A crash between buy and burn leaves 'sending' for recovery.)
          this.db.prepare('UPDATE flywheel_orders SET status=?, error=? WHERE id=?').run(WAIT.has(code) ? 'skipped' : 'failed', code, id);
          this.log({ event: 'flywheel_order_error', chain: worker.chain, token: order.token, code });
        }
      }
      this.db.prepare('UPDATE flywheel_cycles SET status=? WHERE id=?').run(plan.orders.length ? 'done' : plan.orders.length === 0 && budget > 0n ? 'no_eligible_token' : 'no_budget', cycle);
      Object.assign(s, { state: 'watching', lastCycle: new Date(this.now()).toISOString(), lastSpent: worker.format(spent) });
      delete s.error;
    } catch (error) { s.state = 'unavailable'; s.error = errorCode(error); this.log({ event: 'flywheel_cycle_error', chain: worker.chain, code: s.error }); }
  }
  /** Public, read-only: totals per chain and the most recent orders. Addresses and transaction hashes only. */
  summary({ limit = 30 } = {}) {
    const chains = this.workers.map(w => {
      const burned = this.db.prepare("SELECT spend, bought FROM flywheel_orders WHERE chain=? AND status='burned'").all(w.chain);
      return { chain: w.chain, name: w.name ?? w.chain, explorer: w.explorer ?? null, address: this.state[w.chain].address ?? null, state: this.state[w.chain].state, lastCycle: this.state[w.chain].lastCycle ?? null,
        orders: burned.length, spent: w.format(burned.reduce((n, r) => n + BigInt(r.spend), 0n)) };
    });
    const recent = this.db.prepare('SELECT chain, rank, token, symbol, venue, spend, bought, buy_tx AS buyTx, burn_tx AS burnTx, status, error, at FROM flywheel_orders ORDER BY id DESC LIMIT ?').all(limit).map(r => ({ ...r }));
    return { enabled: true, everyHours: Math.round(this.everyMs / 3_600_000), policy: { slots: this.policy.slots, minAgeHours: this.policy.minAgeSec / 3600, curveSharePct: this.policy.curveShareBps / 100, poolDepthPct: this.policy.poolDepthBps / 100 }, chains, recent };
  }
  async close() { this.stopping = true; clearInterval(this.timer); while (this.running) await new Promise(r => setTimeout(r, 50)); this.db.close(); }
}

function secret(env, name) {
  if (env[`${name}_FILE`]) { try { return readFileSync(env[`${name}_FILE`], 'utf8').trim(); } catch { throw new Error(`${name}_FILE is unreadable`); } }
  return env[name]?.trim() || null;
}

/**
 * Builds the keeper from the environment, or a disabled stub. `ELPIDA_FLYWHEEL_EVM_KEY` (or `_FILE`) signs on every
 * indexed EVM testnet with a configured DEX.
 */
export function configuredFlywheelKeeper({ env, publicIndex, dexes, path, log }) {
  const key = secret(env, 'ELPIDA_FLYWHEEL_EVM_KEY');
  if (!key) return { summary: () => ({ enabled: false, state: 'not_configured' }), close: async () => {} };
  if (env.RAILWAY_ENVIRONMENT_ID && !env.RAILWAY_VOLUME_MOUNT_PATH) throw new Error('The flywheel keeper requires a persistent Railway volume');
  if (!path) throw new Error('The flywheel keeper requires a persistent data directory');
  const workers = [];
  for (const [chain, entry] of publicIndex?.entries ?? []) {
    if (!entry.net?.chainId || !FLYWHEEL_EVM_CHAINS.has(Number(entry.net.chainId)) || !dexes[chain]?.router) continue;
    let signer; try { signer = new Wallet(key, entry.provider); } catch { throw new Error('ELPIDA_FLYWHEEL_EVM_KEY is not a valid private key'); }
    workers.push(evmFlywheelWorker({ chain, chainId: entry.net.chainId, name: entry.net.name, explorer: entry.net.explorer ?? null, signer, dex: dexes[chain], listings: () => publicIndex.listings(chain) }));
  }
  if (!workers.length) return { summary: () => ({ enabled: false, state: 'no_eligible_network' }), close: async () => {} };
  return new FlywheelKeeper({ workers, path, log, everyMs: Math.max(3_600_000, Number(env.ELPIDA_FLYWHEEL_EVERY_HOURS ?? 24) * 3_600_000),
    maxPerCycle: parseEther(env.ELPIDA_FLYWHEEL_MAX_PER_CYCLE_ETH ?? '0.05'), gasReserve: parseEther(env.ELPIDA_FLYWHEEL_GAS_RESERVE_ETH ?? '0.005') }).start();
}
