// Automatic post-graduation buyback for partner tokens (docs/DESIGN_PARTNER_TIERS.md, docs/AUTOMATIC_BUYBACK.md).
//
// On the bonding curve every trade already buys back and burns its share in the same transaction. After graduation
// the share sits in the pool's trading fees until somebody harvests them, and until now that only happened when a
// creator pressed "Claim fees". This worker does it on a schedule, so a partner token keeps burning without anyone
// clicking. It calls only permissionless instructions: anyone may harvest a locked position and run the capped
// buyback, and the payouts can only go to the recipients fixed at launch. The worker's wallet pays network fees only.
//
// - EVM: `locker.collectFees()` (credits the creator and the treasury and queues the quote-side burn share), then
//   `splitter.buyback()` (spends at most 1% of the pool's quote balance per call; a backlog drains over later runs).
// - Solana: one transaction with `harvest_raydium_fees` (or `harvest_lp_fees` on PumpSwap) and, on Raydium,
//   `raydium_buyback` (also capped at 1% of the pool's SOL depth).
//
// Testnets only. Every transaction and every rolling 24 hours of gas are capped; the worker never spends more gas
// than the fees it collects on native-quote pools; only public addresses appear in its status.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { Contract, Wallet, parseEther, formatEther } from 'ethers';

/** EVM chains the worker may sign on: the public testnets and the local test chain. Mainnets are refused. */
export const BUYBACK_EVM_CHAINS = new Set([84532, 11155111, 97, 46630, 31337]);
const LOCKER_ABI = ['function collectFees() returns(uint256 amount0,uint256 amount1)'];
const SPLITTER_ABI = ['function buyback() returns(uint256 spent,uint256 tokensBurned)', 'function pendingBuyback(address) view returns(uint256)', 'function buybackBps() view returns(uint256)', 'event BuybackBurned(address indexed asset,uint256 quoteSpent,uint256 tokensBurned)'];
const DAY = 86_400_000;

/**
 * Schedules workers (one per chain) and keeps the shared journal: when each token last ran and what each chain spent.
 * A worker is `{ chain, unit, address(), candidates(), run(token, { spent, budget }) }`; `run` returns
 * `{ cost: bigint, hashes: string[], burned?: string }` after acting, or null when there was nothing worth doing.
 */
export class BuybackKeeper {
  constructor({ workers, path = ':memory:', everyMs = 10 * 60_000, tickMs = 60_000, now = Date.now, log = () => {} }) {
    if (!workers?.length) throw new Error('Buyback keeper needs at least one worker');
    Object.assign(this, { workers, everyMs, tickMs, now, log });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS buyback_runs(chain TEXT NOT NULL, token TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(chain, token));
      CREATE TABLE IF NOT EXISTS buyback_spend(chain TEXT NOT NULL, at INTEGER NOT NULL, amount TEXT NOT NULL, hashes TEXT NOT NULL, token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS buyback_lock(id INTEGER PRIMARY KEY, owner TEXT, expires INTEGER);
      INSERT OR IGNORE INTO buyback_lock VALUES(1, '', 0);`);
    this.owner = crypto.randomUUID();
    this.state = Object.fromEntries(workers.map(w => [w.chain, { chain: w.chain, unit: w.unit, state: 'starting' }]));
  }
  /** Gas spent on `chain` in the last 24 hours, in the chain's smallest unit. */
  spent(chain) {
    return this.db.prepare('SELECT amount FROM buyback_spend WHERE chain=? AND at>?').all(chain, this.now() - DAY).reduce((sum, r) => sum + BigInt(r.amount), 0n);
  }
  status() {
    return { enabled: true, everyMinutes: Math.round(this.everyMs / 60_000), chains: Object.values(this.state).map(s => ({ ...s, spentToday: this.workers.find(w => w.chain === s.chain).format(this.spent(s.chain)) })) };
  }
  start() { this.timer = setInterval(() => this.tick(), this.tickMs); this.timer.unref?.(); this.tick(); return this; }
  async tick() {
    if (this.running || this.stopping) return;
    // One worker per journal, even if two processes share the volume: a lease, as the graduation keeper does.
    if (!this.db.prepare('UPDATE buyback_lock SET owner=?, expires=? WHERE id=1 AND (expires<? OR owner=?)').run(this.owner, this.now() + 5 * 60_000, this.now(), this.owner).changes) return;
    this.running = true;
    try { for (const worker of this.workers) await this.runWorker(worker); }
    finally { this.running = false; }
  }
  async runWorker(worker) {
    const s = this.state[worker.chain];
    try {
      s.address = await worker.address();
      const due = (await worker.candidates()).filter(t => {
        const last = this.db.prepare('SELECT at FROM buyback_runs WHERE chain=? AND token=?').get(worker.chain, t.address.toLowerCase())?.at ?? 0;
        return this.now() - last >= this.everyMs;
      });
      s.watching = due.length; s.checkedAt = new Date(this.now()).toISOString(); s.state = 'watching'; delete s.error;
      for (const token of due) {
        const key = token.address.toLowerCase();
        let retrySoon = false;
        try {
          const result = await worker.run(token, { spent: this.spent(worker.chain) });
          if (result) {
            this.db.prepare('INSERT INTO buyback_spend VALUES(?,?,?,?,?)').run(worker.chain, this.now(), String(result.cost), JSON.stringify(result.hashes), key);
            s.last = { token: token.symbol ?? key, at: new Date(this.now()).toISOString(), hashes: result.hashes, burned: result.burned ?? null };
            this.log({ event: 'buyback_keeper_ran', chain: worker.chain, token: key, hashes: result.hashes });
          }
        } catch (error) {
          // One token failing (budget, a reverted simulation, an RPC hiccup) never blocks the others; it retries next round.
          s.lastError = { token: token.symbol ?? key, code: errorCode(error), at: new Date(this.now()).toISOString() };
          this.log({ event: 'buyback_keeper_error', chain: worker.chain, token: key, code: errorCode(error) });
          if (errorCode(error) === 'daily_budget') { s.state = 'budget_reached'; }
          // The index still loading (just after a restart) is not a reason to wait a whole interval: retry next tick.
          retrySoon = TRANSIENT.has(errorCode(error));
        }
        if (!retrySoon) this.db.prepare('INSERT INTO buyback_runs VALUES(?,?,?) ON CONFLICT(chain, token) DO UPDATE SET at=excluded.at').run(worker.chain, key, this.now());
      }
    } catch (error) { s.state = 'unavailable'; s.error = errorCode(error); }
  }
  async close() { this.stopping = true; clearInterval(this.timer); while (this.running) await new Promise(r => setTimeout(r, 50)); this.db.close(); }
}

/** Errors that only mean the index or the pool read is not ready yet; the token is retried on the next tick. */
export const TRANSIENT = new Set(['config_unavailable', 'pool_unavailable']);
const errorCode = error => String(error?.code && typeof error.code === 'string' ? error.code : error?.message ?? 'error').replace(/[^a-zA-Z0-9_ .:-]/g, '').slice(0, 80);
const fail = code => Object.assign(new Error(code), { code });

/** Checks one transaction's worst-case cost against the per-transaction cap and what is left of the daily budget. */
export function withinBudget(cost, { spent, maxCost, dailyBudget }) {
  if (cost > maxCost) throw fail('transaction_cost');
  if (spent + cost > dailyBudget) throw fail('daily_budget');
}

/**
 * EVM worker for one public index entry. `listings()` returns the indexed tokens; graduated partner tokens with a fee
 * locker and splitter are candidates. `signer` is an ethers signer on the chain's provider.
 */
export function evmBuybackWorker({ chain, chainId, signer, listings, maxCost = parseEther('0.0005'), dailyBudget = parseEther('0.005'), contract = (a, abi, r) => new Contract(a, abi, r) }) {
  if (!BUYBACK_EVM_CHAINS.has(Number(chainId))) throw new Error('Buyback keeper: chain is not an allowed testnet');
  const provider = signer.provider;
  const price = async () => { const f = await provider.getFeeData(); return f.maxFeePerGas ?? f.gasPrice ?? 0n; };
  return {
    chain, unit: 'wei', format: v => `${formatEther(v)} native`,
    address: () => signer.getAddress(),
    candidates: async () => (await listings()).filter(t => t.graduated && Number(t.buybackBps) > 0 && t.locker && t.feeSplitter && t.quoteAsset && !/^0x0+$/.test(t.locker)),
    async run(token, { spent }) {
      const locker = contract(token.locker, LOCKER_ABI, signer), splitter = contract(token.feeSplitter, SPLITTER_ABI, signer);
      const hashes = []; let cost = 0n;
      const send = async (target, name, worthIt) => {
        const gas = await target[name].estimateGas(), worst = gas * 12n / 10n * await price();
        if (worthIt && !worthIt(worst)) return null;
        withinBudget(worst, { spent: spent + cost, maxCost, dailyBudget });
        const receipt = await (await target[name]({ gasLimit: gas * 12n / 10n })).wait();
        if (receipt.status !== 1) throw fail(`${name}_reverted`);
        cost += receipt.gasUsed * (receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n); hashes.push(receipt.hash);
        return receipt;
      };
      // 1. Collect the position's fees when there are any. On a native-quote pool, never pay more gas than they are
      //    worth (token-side fees valued at the current price); smaller amounts wait for a later run.
      const [a0, a1] = await locker.collectFees.staticCall();
      const quoteOut = token.tokenFirst ? a1 : a0, tokenOut = token.tokenFirst ? a0 : a1, native = token.pair === 'native';
      const worth = quoteOut + parseEther((Number(formatEther(tokenOut)) * (Number(token.spotPrice) || 0)).toFixed(12));
      if (quoteOut > 0n || tokenOut > 0n) await send(locker, 'collectFees', worst => !native || worth >= worst);
      // 2. Spend the queued burn share (capped at 1% of depth per call by the contract).
      if (await splitter.pendingBuyback(token.quoteAsset) > 0n) {
        let receipt;
        try { receipt = await send(splitter, 'buyback'); }
        catch (error) { if (/nothing to buy back/.test(String(error?.shortMessage ?? error?.message))) receipt = null; else throw error; }
        if (receipt) {
          const burned = receipt.logs.map(l => { try { return splitter.interface.parseLog(l); } catch { return null; } }).find(e => e?.name === 'BuybackBurned');
          if (burned) return { cost, hashes, burned: burned.args[2].toString() };
        }
      }
      return hashes.length ? { cost, hashes } : null;
    },
  };
}

/**
 * Solana worker for the indexed SOL pair and other pairs. Graduated partner tokens are candidates. A Raydium pool is
 * harvested and bought back in one transaction; a PumpSwap pool is harvested (its token-side share burns; there is no
 * PumpSwap buyback). `payer` is a web3.js Keypair.
 */
export function solanaBuybackWorker({ chain, web3, connection, payer, client, listings, configs, quoteProgramOf, helpers, minHarvestLamports = 1_000_000n, maxCost = 100_000n, dailyBudget = 20_000_000n }) {
  const { harvestNow, withdrawOut, raydiumBuybackAmount, HARVEST_COMPUTE_UNITS } = helpers;
  return {
    chain, unit: 'lamports', format: v => `${Number(v) / 1e9} SOL`,
    address: async () => payer.publicKey.toBase58(),
    candidates: async () => (await listings()).filter(t => t.graduated && Number(t.buybackBps) > 0 && t.pumpPool && ['Raydium', 'PumpSwap'].includes(t.venue)),
    async run(token, { spent }) {
      const mint = new web3.PublicKey(token.address), cfg = configs().get(token.config);
      if (!cfg) throw fail('config_unavailable');
      const record = await connection.getAccountInfo(client.migrationPda(mint), 'confirmed');
      if (!record) throw fail('migration_missing');
      const migration = client.decodeMigration(record.data);
      const raydium = token.venue === 'Raydium';
      const keys = raydium ? (r => [r.pool, r.vault0, r.vault1])(client.raydiumAccounts(mint)) : (p => [p.pool, p.poolBase, p.poolQuote])(client.pumpAccounts(mint, cfg.quoteMint, quoteProgramOf(cfg)));
      const [pool, a, b] = await connection.getMultipleAccountsInfo(keys, 'confirmed');
      if (!pool || !a || !b) throw fail('pool_unavailable');
      const state = raydium ? client.raydiumState(pool.data, a.data, b.data, mint) : client.pumpState(pool.data, a.data, b.data);
      const lp = harvestNow(migration.lpLocked, migration.principal, state), out = lp > 0n ? withdrawOut(lp, state) : { quote: 0n, base: 0n };
      const instructions = [];
      const config = { address: new web3.PublicKey(token.config), quoteMint: cfg.quoteMint, treasury: cfg.treasury, quoteTokenProgram: quoteProgramOf(cfg) };
      const reward = new web3.PublicKey(token.reward);
      if (lp > 0n && out.quote >= minHarvestLamports) instructions.push(...(raydium ? client.harvestRaydiumFees({ payer: payer.publicKey, config, mint, reward }) : client.harvestLpFees({ payer: payer.publicKey, config, mint, reward })));
      const queued = BigInt(migration.pendingBuyback ?? 0n) + (instructions.length ? out.quote * BigInt(token.buybackBps) / 10_000n : 0n);
      if (raydium && raydiumBuybackAmount(queued, state.quote) > 0n) instructions.push(client.raydiumBuyback({ mint }));
      if (!instructions.length) return null;
      const tx = new web3.Transaction().add(client.computeBudget(HARVEST_COMPUTE_UNITS + 100_000), ...instructions);
      tx.feePayer = payer.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
      const fee = BigInt((await connection.getFeeForMessage(tx.compileMessage(), 'confirmed')).value ?? 0);
      withinBudget(fee, { spent, maxCost, dailyBudget });
      // A first harvest may create up to five token accounts (rent, paid once); the measured cost below records it.
      const before = BigInt(await connection.getBalance(payer.publicKey, 'confirmed'));
      if (before < fee + 5n * 2_039_280n) throw fail('keeper_balance_low');
      const signature = await web3.sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' });
      const after = BigInt(await connection.getBalance(payer.publicKey, 'confirmed'));
      return { cost: before > after ? before - after : fee, hashes: [signature] };
    },
  };
}

/** Reads a key from `<NAME>_FILE` (a mounted secret) or `<NAME>` (a host secret variable). Never logged or returned. */
function secret(env, name) {
  if (env[`${name}_FILE`]) { try { return readFileSync(env[`${name}_FILE`], 'utf8').trim(); } catch { throw new Error(`${name}_FILE is unreadable`); } }
  return env[name]?.trim() || null;
}

/**
 * Builds the keeper from the environment, or a disabled stub. EVM: `ELPIDA_BUYBACK_EVM_KEY` (or `_FILE`) signs on every
 * indexed testnet. Solana: `ELPIDA_BUYBACK_SOLANA_KEY` (or `_FILE`), a keypair as a JSON byte array, signs on the
 * indexed devnet cluster only.
 */
export async function configuredBuybackKeeper({ env, publicIndex, solanaIndex = null, path, log }) {
  const evmKey = secret(env, 'ELPIDA_BUYBACK_EVM_KEY'), solKey = secret(env, 'ELPIDA_BUYBACK_SOLANA_KEY');
  if (!evmKey && !solKey) return { status: () => ({ enabled: false, state: 'not_configured' }), close: async () => {} };
  if (env.RAILWAY_ENVIRONMENT_ID && !env.RAILWAY_VOLUME_MOUNT_PATH) throw new Error('The buyback keeper requires a persistent Railway volume');
  if (!path) throw new Error('The buyback keeper requires a persistent data directory');
  const workers = [];
  const maxCost = parseEther(env.ELPIDA_BUYBACK_MAX_COST_ETH ?? '0.0005'), dailyBudget = parseEther(env.ELPIDA_BUYBACK_DAILY_BUDGET_ETH ?? '0.005');
  if (evmKey) {
    for (const [key, entry] of publicIndex?.entries ?? []) {
      if (!entry.net?.chainId || !BUYBACK_EVM_CHAINS.has(Number(entry.net.chainId))) continue;
      let signer;
      try { signer = new Wallet(evmKey, entry.provider); } catch { throw new Error('ELPIDA_BUYBACK_EVM_KEY is not a valid private key'); }
      workers.push(evmBuybackWorker({ chain: key, chainId: entry.net.chainId, signer, listings: () => publicIndex.listings(key), maxCost, dailyBudget }));
    }
  }
  if (solKey && solanaIndex) {
    if (solanaIndex.network.cluster === 'mainnet' || solanaIndex.network.mainnet) throw new Error('The buyback keeper does not run on Solana mainnet');
    const web3 = await import('@solana/web3.js'), helpers = await import('../../packages/solana/client.mjs');
    let payer;
    try { payer = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(solKey))); } catch { throw new Error('ELPIDA_BUYBACK_SOLANA_KEY must be a keypair JSON byte array'); }
    workers.push(solanaBuybackWorker({ chain: solanaIndex.network.key, web3, connection: solanaIndex.connection, payer, client: solanaIndex.client,
      listings: async () => solanaIndex.listings(), configs: () => solanaIndex.configs ?? new Map(), quoteProgramOf: cfg => solanaIndex.quoteProgramOf(cfg), helpers,
      minHarvestLamports: BigInt(Math.round(Number(env.ELPIDA_BUYBACK_SOLANA_MIN_HARVEST_SOL ?? '0.001') * 1e9)),
      dailyBudget: BigInt(Math.round(Number(env.ELPIDA_BUYBACK_SOLANA_DAILY_BUDGET_SOL ?? '0.02') * 1e9)) }));
  }
  if (!workers.length) return { status: () => ({ enabled: false, state: 'no_eligible_network' }), close: async () => {} };
  return new BuybackKeeper({ workers, path, log, everyMs: Math.max(60_000, Number(env.ELPIDA_BUYBACK_EVERY_MINUTES ?? 10) * 60_000) }).start();
}
