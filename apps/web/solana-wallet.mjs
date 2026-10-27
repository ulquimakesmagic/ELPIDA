import { nowSeconds } from './clock.mjs';
import { createElpidaSolana, quoteBuy, quoteSell, currentFeeBps, poolStats, parseAmount, formatAmount, explainError, TOKEN_DECIMALS, TOKEN_SUPPLY, parsePriceUpdate, usdToQuote, virtualQuoteForFdv, PYTH_RECEIVER, POOL_SIZE, STATUS_GRADUATED, STATUS_MIGRATED, MIGRATE_COMPUTE_UNITS, HARVEST_COMPUTE_UNITS, PUMPSWAP_COMPUTE_UNITS, PUMPSWAP_FEES, WSOL_MINT, harvestNow, withdrawOut } from '/elpida-solana.mjs';
import {normalizeMetadata} from './metadata.mjs';
import {prepareUploadProof} from './upload-proof.mjs';
import { PAIR_LIMITS, usdReferenceFor } from '/pairs.mjs';
import { withWalletTimeout, walletErrorText } from './wallet.mjs';

import { injectedSolanaWallets, standardSolanaWallets, standardSolanaProvider } from './wallet-discovery.mjs';
const SOL_CHOICE = 'elpida:solana-wallet';
/** Installed Solana signing wallets; standard adapters take precedence. */
export function solanaWallets(chain='solana:devnet') {
 const list=injectedSolanaWallets(typeof window==='undefined'?{}:window);
 const standard=standardSolanaWallets(chain);
 return [...standard,...list.filter(w=>!standard.some(a=>a.name.toLowerCase()===w.name.toLowerCase()))];
}
export function chosenSolanaWallet() { try { return localStorage.getItem(SOL_CHOICE); } catch { return null; } }
function solanaProvider(id = chosenSolanaWallet(),chain='solana:devnet') {
  if(id?.startsWith('standard:'))return standardSolanaProvider(id,globalThis.solanaWeb3,chain);
  const list=injectedSolanaWallets(typeof window==='undefined'?{}:window);
  if(id)return list.find(w=>w.id===id)?.provider??null;
  return list.length===1?list[0].provider:null;
}
import {readMetadataCache,writeMetadataCache} from './metadata-cache.mjs';
const metadataKey=(program,mint)=>`elpida:solana-metadata:${program}:${mint}`;
const readMetadata=async key=>{try{return normalizeMetadata(await readMetadataCache(key)??{});}catch{return {};}};

const web3 = globalThis.solanaWeb3;

// Browser-wallet flow for the Elpida Solana program, model 3 (Phantom, Solflare or Backpack).
// Same surface as TestnetWallet so the UI can treat every chain alike. Pricing is native: launches pair
// with SOL by default, curves are sized in SOL and every launch pays its creation fee in SOL, at the
// values the team sets in config/native-pricing.json. The anti-snipe fee starts at 90% and decays to the
// base fee over the first minute, with the surplus locked into the token's liquidity. A complete curve
// migrates (anyone can trigger it) into a PumpSwap pool whose LP stays locked by the program; LP fee
// growth is harvested 50/50 to the treasury and the creator reward wallet. Pools always trade through
// the config they were launched with.
const MAX_U64 = (1n << 64n) - 1n;
// Quote with a clock two seconds early: a slightly higher anti-snipe fee, so slippage limits stay safe.
const chainNow = () => Math.floor(nowSeconds()) - 2;
export class SolanaWallet {
  constructor(config, onProgress) {
    this.config = config; this.net = config.solana; this.onProgress = onProgress;
    this.launches = new Map();
    // Mainnet uses the server's RPC proxy (a relative URL), so the provider key stays server-side.
    this.connection = web3 ? new web3.Connection(new URL(this.net.rpcUrl, location.origin).href, 'confirmed') : null;
  }
  select(key) {
    if (key !== this.net.key) throw new Error('That Solana network is not available.');
    return this.net;
  }
  get deployment() { return this.net.deployment ?? null; }
  get provider() { return this._provider ?? solanaProvider(undefined,this.net.mainnet?'solana:mainnet':'solana:devnet'); }
  get walletName() { return solanaWallets(this.net.mainnet?'solana:mainnet':'solana:devnet').find(w => w.id === (this.walletId ?? chosenSolanaWallet()))?.name ?? 'your Solana wallet'; }
  get client() {
    if (!this.deployment) throw new Error('The Solana program is not deployed yet. Run npm run solana:deploy once (see docs/LOCALHOST_AND_TESTNET.md).');
    return (this._client ??= createElpidaSolana(web3, this.deployment.programId));
  }
  txUrl(signature) { return `${this.net.explorer}/tx/${signature}${this.clusterQuery}`; }
  addressUrl(address) { return `${this.net.explorer}/address/${address}${this.clusterQuery}`; }
  get clusterQuery() { return this.net.cluster === 'localnet' ? `?cluster=custom&customUrl=${encodeURIComponent(this.net.rpcUrl)}` : this.net.mainnet ? '' : `?cluster=${this.net.cluster}`; }
  /** Beta launch gate for the connected wallet: { enabled, allowed }. Launches are open without a gate. */
  async loadBeta() {
    const [gate, entry] = await this.connection.getMultipleAccountsInfo([this.client.betaGatePda, this.client.betaCreatorPda(this.publicKey)]);
    const state = this.client.decodeBetaGate(gate?.owner.equals(this.client.programId) ? gate.data : null);
    this.beta = { enabled: !!state?.enabled, allowed: !state?.enabled || !!entry?.owner.equals(this.client.programId) };
    return this.beta;
  }

  /** Connects with the chosen Solana wallet (`walletId`), remembered for next time. */
  async connect(walletId, {silent=false}={}) {
    if (!web3) throw new Error('The Solana library did not load. Refresh the page.');
    if (walletId) { try { localStorage.setItem(SOL_CHOICE, walletId); } catch {} }
    const provider = solanaProvider(walletId ?? chosenSolanaWallet(),this.net.mainnet?'solana:mainnet':'solana:devnet');
    if (!provider) throw new Error('Install Phantom, Solflare or Backpack to use Solana Devnet.');
    this._provider = provider; this.walletId = walletId ?? chosenSolanaWallet();
    let result = null;
    // A wallet that is already connected to this site answers without a popup; asking again can stall.
    if (!(provider.isConnected && provider.publicKey)) {
      try { result = await withWalletTimeout(provider.connect(silent?{onlyIfTrusted:true}:undefined), this.walletName); }
      catch (error) { const text = walletErrorText(error, this.walletName); if (text) throw Object.assign(new Error(text), { code: error.code }); throw error; }
    }
    const key = result?.publicKey ?? provider.publicKey;
    if (!key) throw new Error('Your Solana wallet did not share an address.');
    this.publicKey = new web3.PublicKey(key.toString());
    this.address = this.publicKey.toBase58();
    return this.address;
  }
  checkWallet() {
    if (!this.publicKey) throw new Error('Connect your Solana wallet first.');
    const current = this.provider?.publicKey?.toString();
    if (current && current !== this.address) throw new Error('Your Solana wallet account changed. Connect again to refresh it.');
  }
  async deploy() {
    throw new Error('Solana programs are deployed from a terminal, not the browser: run npm run solana:deploy once, then restart npm run dev.');
  }
  /**
   * Loads every trading-pair config the deployment records (SOL and, on test networks, the test paired
   * token), each checked on-chain, with its quote mint's token program. USDC pairs require an explicit
   * deployed configuration and retain SOL for network gas.
   */
  async loadConfig() {
    if (this.programConfig) return this.programConfig;
    const c = this.client;
    const listed = (Array.isArray(this.deployment.pairs) && this.deployment.pairs.length ? this.deployment.pairs : [
      { kind: 'native', key: 'sol', symbol: 'SOL', name: 'SOL (wrapped automatically)', config: c.configFor(new web3.PublicKey(WSOL_MINT)).toBase58() },
    ]);
    const infos = await this.connection.getMultipleAccountsInfo(listed.map(p => new web3.PublicKey(p.config)));
    this.configs = new Map();
    listed.forEach((p, i) => {
      const info = infos[i];
      if (!info?.owner.equals(c.programId)) return;
      const config = { address: new web3.PublicKey(p.config), ...c.decodeConfig(info.data), symbol: p.symbol, name: p.name ?? p.symbol, kind: p.kind, key: p.key, test: !!p.test, faucet: p.faucet ?? null };
      if (config.modelVersion !== 3) return;
      config.wsol = config.quoteMint.toBase58() === WSOL_MINT;
      this.configs.set(p.config, config);
    });
    if (!this.configs.size) throw new Error('The Solana SOL pair is not set up. Upgrade the program and run the deploy again (solana-upgrade.cmd, then npm.cmd run solana:deploy).');
    const mints = await this.connection.getMultipleAccountsInfo([...this.configs.values()].map(cfg => cfg.quoteMint));
    [...this.configs.values()].forEach((cfg, i) => { cfg.quoteTokenProgram = mints[i]?.owner ?? c.tokenProgram; });
    const all = [...this.configs.values()];
    const launch = all.find(cfg => cfg.kind === 'native') ?? all[0];
    this.programConfig = launch; this.decimals = launch.quoteDecimals;
    return launch;
  }
  /** Tokens from the server's public Solana indexer: browsable without a wallet, persistent across restarts. */
  async indexedTokens() {
    const response = await fetch('/api/public/tokens?network=' + encodeURIComponent(this.net.key));
    if (!response.ok) throw new Error('Public Solana token discovery is unavailable.');
    const entries = await response.json();
    return Promise.all(entries.map(async item => ({ ...item, metadata: this.deployment ? await readMetadata(metadataKey(this.deployment.programId, item.address)) ?? item.metadata ?? {} : item.metadata ?? {} })));
  }
  /** USDC mint accepted for the $10 fee, when the deployment's USD pricing offers it. */
  get feeUsdc() { return this.deployment?.usdPricing?.usdcMint ?? null; }
  /**
   * Reads the SOL pair's on-chain pricing and the bound Pyth SOL/USD account, the same values the program
   * verifies at launch. Sets `price` (for the fee preview) and `usdPricing` ({ pricing, oracle }).
   */
  async loadPrice() {
    const configs = [...(this.configs?.values() ?? [])];
    this.usdPricing = null; this.price = null;
    if (!configs.length) return null;
    const infos = await this.connection.getMultipleAccountsInfo(configs.map(cfg => this.client.pricingPda(cfg.address)));
    configs.forEach((cfg, i) => { cfg.pricing = this.client.decodePricing(infos[i]?.data); });
    const bound = configs.find(cfg => cfg.pricing)?.pricing;
    if (!bound) return null;
    const info = await this.connection.getAccountInfo(bound.priceFeed);
    const oracle = info?.owner.toBase58() === PYTH_RECEIVER ? parsePriceUpdate(info.data) : null;
    if (!oracle || oracle.feedId !== bound.feedId) { this.price = { status: 'unavailable', source: 'Pyth SOL/USD (on-chain)' }; return null; }
    const usd = Number(oracle.price) * 10 ** oracle.exponent, age = nowSeconds() - oracle.publishTime;
    this.price = { symbol: 'SOL', usd, updatedAt: oracle.publishTime, source: 'Pyth SOL/USD (verified on-chain)', maxAge: bound.maxAgeSecs, status: age <= bound.maxAgeSecs && Number(oracle.conf) * 10000 <= Number(oracle.price) * bound.maxConfBps ? 'fresh' : 'stale' };
    this.usdPricing = { oracle, priceFeed: bound.priceFeed };
    return this.usdPricing;
  }
  /** The SOL fee and virtual reserve a launch on `cfg` will use at the current on-chain price. */
  launchTerms(cfg) {
    const priced = cfg.pricing && this.usdPricing && cfg.pricing.priceFeed.equals(this.usdPricing.priceFeed) ? cfg.pricing : null;
    const oracle = this.usdPricing?.oracle;
    return {
      priced: !!priced, priceFeed: priced?.priceFeed ?? null, usdcMint: priced && !priced.usdcMint.equals(web3.PublicKey.default) ? priced.usdcMint : null, usdcFee: priced?.feeUsdE6 ?? 0n,
      fee: priced ? usdToQuote(priced.feeUsdE6, oracle, 9) : cfg.launchFee,
      virtualQuote: priced && priced.startFdvUsdE6 > 0n ? virtualQuoteForFdv(priced.startFdvUsdE6, oracle, cfg.virtualToken) : cfg.virtualQuote,
    };
  }
  /** Launchable trading assets by kind, the same structure as every other network (packages/core/pairs.mjs). */
  pairOptions() {
    const all = [...(this.configs?.values() ?? [])];
    const asset = cfg => {
      const d = cfg.quoteDecimals, id = cfg.address.toBase58();
      // The creation fee is always lamports (SOL), whatever the pair.
      // Oracle-priced SOL pair: the $10 fee in SOL and the $-sized virtual reserve at the current Pyth price.
      const terms = this.launchTerms(cfg);
      return { id, symbol: cfg.symbol, name: cfg.name, decimals: d, test: cfg.test, wsol: cfg.wsol, feeAmount: formatAmount(terms.fee, 9), feeSymbol: 'SOL', usdPriced: terms.priced,
        curve: { vq: Number(terms.virtualQuote) / 10 ** d, vt: Number(cfg.virtualToken) / 10 ** TOKEN_DECIMALS, cap: Number(cfg.curveSupply) / 10 ** TOKEN_DECIMALS, feeBps: cfg.baseFeeBps },
        faucet: cfg.test && cfg.faucet ? { label: `Get ${Number(cfg.faucet).toLocaleString()} ${cfg.symbol}`, action: 'faucet', body: { asset: id } } : cfg.wsol && this.net.gasFaucet ? { label: 'Get devnet SOL', href: this.net.gasFaucet } : null };
    };
    const group = kind => {
      const assets = all.filter(cfg => cfg.kind === kind).sort((a, b) => Number(b.test) - Number(a.test)).map(asset);
      if (assets.length) return { assets };
      return { assets: [], unavailable: PAIR_LIMITS.solana[kind] ?? (!this.deployment ? 'The Solana program is not deployed yet.' : this.net.mainnet ? `No ${kind === 'token' ? 'paired token' : 'asset of this kind'} is approved on mainnet yet.` : `Not set up on ${this.net.name} yet. Run solana-upgrade.cmd to add the SOL, USDC and test-token pairs.`) };
    };
    return { native: group('native'), usdc: group('usdc'), xstock: group('xstock'), token: group('token') };
  }
  /** The config a pool was launched with (null for pools of unknown configs). */
  configOf(pool) { return this.configs?.get(pool.config.toBase58()) ?? null; }
  refsOf(config) { return { address: config.address, quoteMint: config.quoteMint, treasury: config.treasury, quoteTokenProgram: config.quoteTokenProgram }; }
  /** Spendable balance of a config's quote asset; for SOL pairs that is wallet SOL plus any wrapped SOL. */
  async quoteBalance(owner = this.publicKey, config = null) {
    config ??= await this.loadConfig();
    const held = this.client.tokenAmount((await this.connection.getAccountInfo(this.client.quoteAta(owner, config)))?.data);
    return config.wsol ? held + BigInt(await this.connection.getBalance(owner)) : held;
  }
  /** Wraps exactly what a SOL-pair instruction will spend (beyond wrapped SOL already held). */
  async wrapFor(config, amount) {
    if (!config.wsol) return [];
    const held = this.client.tokenAmount((await this.connection.getAccountInfo(this.client.quoteAta(this.publicKey, config)))?.data);
    return this.client.wrapSol(this.publicKey, amount > held ? amount - held : 0n);
  }
  /**
   * The buy that completes a curve and the PumpSwap migration go in ONE transaction: if the migration fails, the buy
   * fails with it and the curve keeps trading, so it is never left closed waiting for someone to migrate or reopen it.
   * For SOL pairs, wrapping (and unwrapping) move to their own transactions only if everything does not fit in one.
   */
  async completeAndMigrate({ config, refs, mint, wrap, buyIx, symbol = null }) {
    if (BigInt(await this.connection.getBalance(this.publicKey)) < SolanaWallet.MIGRATION_RENT + SolanaWallet.SOL_HEADROOM) throw new Error(`This buy completes the curve and opens its PumpSwap pool in the same transaction, which needs about ${formatAmount(SolanaWallet.MIGRATION_RENT, 9)} SOL of pool rent (most of it comes back). Add SOL and try again. Nothing was sent.`);
    const core = [this.client.computeBudget(MIGRATE_COMPUTE_UNITS + 200_000), buyIx, this.client.migrateToPumpswap({ payer: this.publicKey, config: refs, mint })];
    const unwrap = config.wsol ? [this.client.unwrapSol(this.publicKey)] : [];
    const message = 'Confirm the final buy. It completes the curve and opens the PumpSwap pool in the same transaction…';
    let signature;
    if (!wrap.length && !unwrap.length) signature = await this.sendInstructions(core, [], message);
    else if (await this.fitsOneTransaction([...wrap, ...core, ...unwrap])) signature = await this.sendInstructions([...wrap, ...core, ...unwrap], [], message);
    else {
      if (wrap.length) await this.sendInstructions(wrap, [], 'Step 1: confirm wrapping SOL for the final buy…');
      signature = await this.sendInstructions(core, [], 'Step 2: ' + message);
      if (unwrap.length) await this.sendInstructions(unwrap, [], 'Step 3: confirm returning the unused wrapped SOL…').catch(() => {});
    }
    // Name the launched token, not the pair asset (`config.symbol` is SOL or USDC).
    return { hash: signature, message: `The curve is complete and ${symbol ?? 'the token'} now trades on PumpSwap. The liquidity is locked for good.` };
  }
  /** Rent the PumpSwap migration advances (most of it is refunded in the same transaction). */
  static MIGRATION_RENT = 60_000_000n;
  /** Rent and fees a SOL-pair transaction needs on top of the trade (new accounts, priority-free fee). */
  static SOL_HEADROOM = 30_000_000n;
  /** Public discovery: the server's indexer first (persistent, with history), else a direct read-only chain scan. */
  async publicTokens(){
    try{const indexed=await this.indexedTokens();if(indexed.length)return indexed.map(t=>({...t,usdReference:usdReferenceFor({...t,usdReference:null},this.price)}));}catch{}
    return (await this.state({readOnly:true})).tokens;
  }
  async state({readOnly=false}={}) {
    if(!readOnly)this.checkWallet();
    if (!this.deployment) return { wallet: this.address, balance: '0', balanceSymbol: 'SOL', nativeSymbol: 'SOL', tokens: [], activity: [], treasuryBalance: '0', undeployed: true };
    const launchConfig = await this.loadConfig();
    await this.loadPrice().catch(() => { this.price = { status: 'unavailable', source: 'Pyth SOL/USD (on-chain)' }; });
    if(!readOnly)await this.loadBeta();
    const accounts = await this.client.poolAccounts(this.connection);
    const pools = accounts.filter(({ account }) => this.client.isPool(account.data)).map(({ pubkey, account }) => ({ pubkey, ...this.client.decodePool(account.data) })).filter(pool => this.configOf(pool));
    const holdings = !readOnly&&pools.length ? await this.connection.getMultipleAccountsInfo(pools.map(pool => this.client.ata(this.publicKey, pool.mint))) : [];
    this.launches.clear();
    const now = chainNow();
    const migrated = await this.pumpStates(pools.filter(pool => pool.status === STATUS_MIGRATED));
    const tokens = await Promise.all(pools.map(async (pool, index) => {
      const address = pool.mint.toBase58();
      this.launches.set(address, pool);
      const config = this.configOf(pool), d = config.quoteDecimals;
      const stats = poolStats(pool, d);
      const complete = pool.status === STATUS_GRADUATED || pool.status === STATUS_MIGRATED;
      const feeBps = currentFeeBps(config, pool.createdAt, now);
      // Cost to finish the curve at the base fee (what it costs once the anti-snipe minute is over).
      const remainingBuy = complete ? 0n : quoteBuy(pool, MAX_U64, config.baseFeeBps, config.baseFeeBps).gross;
      const token = {
        address, pool: pool.pubkey.toBase58(), name: pool.name, symbol: pool.symbol, creator: pool.creator.toBase58(), reward: pool.reward.toBase58(),
        created: Number(pool.createdAt)*1000, metadata:await readMetadata(metadataKey(this.deployment.programId,address)), migrationPending:false, pair: config.kind ?? 'native', url: this.addressUrl(address), decimals: TOKEN_DECIMALS, quoteSymbol: config.symbol, quoteDecimals: d, dex: 'PumpSwap', usdReference: config.wsol ? this.price : usdReferenceFor({ pair: config.kind ?? 'native' }, null),
        reserve: formatAmount(pool.realQuote, d), liquidityBonus: formatAmount(pool.liquidityBonus, d), lockedLiquidity: formatAmount(stats.lockedLiquidity, d),
        sold: formatAmount(pool.sold, TOKEN_DECIMALS), circulatingSupply: formatAmount(pool.sold, TOKEN_DECIMALS), saleCap: formatAmount(pool.curveSupply, TOKEN_DECIMALS),
        supply: formatAmount(TOKEN_SUPPLY, TOKEN_DECIMALS), balance: formatAmount(this.client.tokenAmount(holdings[index]?.data), TOKEN_DECIMALS),
        spotPrice: stats.price, marketCap: stats.marketCap, progress: stats.progress, remainingBuy: formatAmount(remainingBuy, d),
        feeBps: Number(feeBps), antiSnipeActive: !complete && feeBps > BigInt(config.baseFeeBps),
        // Live anti-snipe schedule for the trade panel's fee window countdown.
        launchedAt: Number(pool.createdAt), feeSchedule: { base: Number(config.baseFeeBps), start: Number(config.snipeStartBps), window: Number(config.snipeWindowSecs) },
        // `complete`: the curve sold out; `graduated`: its liquidity is now in the locked PumpSwap pool.
        complete, graduated: pool.status === STATUS_MIGRATED, completedAt: Number(pool.graduatedAt),
        protocolFees: formatAmount(pool.protocolFees, d), creatorFees: formatAmount(pool.creatorFees, d), liquidityLocked: true,
      };
      const m = migrated.get(address);
      if (m) {
        const priceQ = Number(m.state.quote) / 10 ** d, priceT = Number(m.state.base) / 10 ** TOKEN_DECIMALS;
        const out = withdrawOut(m.harvestable, m.state);
        Object.assign(token, {
          venue: 'PumpSwap', pumpPool: m.pumpPool, dexUrl: this.dexUrl(m.pumpPool), lpFeeBps: PUMPSWAP_FEES.lpFeeBps,
          spotPrice: priceQ / priceT, marketCap: priceQ / priceT * Number(TOKEN_SUPPLY) / 10 ** TOKEN_DECIMALS,
          reserve: formatAmount(m.state.quote, d), lockedLiquidity: formatAmount(m.migration.quoteMigrated, d),
          lpLocked: m.migration.lpLocked.toString(), harvestableQuote: formatAmount(out.quote, d), harvestableTokens: formatAmount(out.base, TOKEN_DECIMALS),
          harvestedQuote: formatAmount(m.migration.harvestedQuote, d), harvestedTokens: formatAmount(m.migration.harvestedBase, TOKEN_DECIMALS),
        });
      }
      return token;
    }));
    if(readOnly)return {tokens,balance:'0',nativeBalance:'0',disconnected:true};
    const [treasury, lamports] = await Promise.all([this.connection.getBalance(launchConfig.treasury), this.connection.getBalance(this.publicKey)]);
    const pairBalances = {};
    for (const cfg of this.configs.values()) pairBalances[cfg.address.toBase58()] = formatAmount(await this.quoteBalance(this.publicKey, cfg), cfg.quoteDecimals);
    const sol = formatAmount(BigInt(lamports), 9);
    // Live native pricing of the SOL pair (set by the team with scripts/native-pricing.mjs).
    const start = poolStats({ ...launchConfig, realQuote: 0n, sold: 0n, liquidityBonus: 0n, status: 0 }, launchConfig.quoteDecimals);
    const terms = this.launchTerms(launchConfig);
    const pricing = { launchFee: formatAmount(terms.fee, 9), usdPriced: terms.priced, usdcFee: terms.usdcMint ? formatAmount(terms.usdcFee, 6) : null, startFdv: String(poolStats({ ...launchConfig, virtualQuote: terms.virtualQuote, realQuote: 0n, sold: 0n, liquidityBonus: 0n, status: 0 }, launchConfig.quoteDecimals).marketCap), symbol: 'SOL', matches: true, owner: false, price: this.price };
    return { wallet: this.address, balance: sol, balanceSymbol: 'SOL', pairBalances, nativeBalance: sol, nativeSymbol: 'SOL', tokens, activity: [], pricing, treasuryBalance: formatAmount(BigInt(treasury), 9) };
  }
  dexUrl(pumpPool) { return this.net.cluster === 'devnet' || this.net.cluster === 'localnet' ? this.addressUrl(pumpPool) : `https://dexscreener.com/solana/${pumpPool}`; }
  /** Migration record, PumpSwap reserves and harvestable LP for migrated pools. */
  async pumpStates(pools) {
    const result = new Map();
    if (!pools.length) return result;
    const mints = pools.map(pool => pool.mint);
    const keys = pools.flatMap(pool => { const cfg = this.configOf(pool); const p = this.client.pumpAccounts(pool.mint, cfg.quoteMint, cfg.quoteTokenProgram); return [this.client.migrationPda(pool.mint), p.pool, p.poolBase, p.poolQuote]; });
    const infos = [];
    for (let i = 0; i < keys.length; i += 100) infos.push(...await this.connection.getMultipleAccountsInfo(keys.slice(i, i + 100)));
    mints.forEach((mint, i) => {
      const [migration, pumpPool, base, quote] = infos.slice(i * 4, i * 4 + 4);
      if (!migration || !pumpPool || !base || !quote) return;
      const record = this.client.decodeMigration(migration.data);
      const state = this.client.pumpState(pumpPool.data, base.data, quote.data);
      result.set(mint.toBase58(), { migration: record, state, pumpPool: record.pumpPool.toBase58(), harvestable: harvestNow(record.lpLocked, record.principal, state) });
    });
    return result;
  }
  async freshPool(token) {
    const mint = new web3.PublicKey(token);
    const info = await this.connection.getAccountInfo(this.client.poolPda(mint));
    if (!info) throw new Error('Token not found. Refresh the launchpad.');
    return { mint, pool: this.client.decodePool(info.data) };
  }
  /** PumpSwap's official SDK (bundled vendor module), loaded only when a migrated token is traded. Injectable in tests. */
  async pumpSwap() {
    this.pumpSwapModule ??= await import('/vendor/pumpswap.mjs');
    return this.pumpSwapModule;
  }
  /** The migrated token's PumpSwap pool address, from its Elpida migration record. */
  async pumpPoolOf(pool) {
    const [state] = (await this.pumpStates([pool])).values();
    if (!state?.pumpPool) throw new Error('The PumpSwap pool for this token could not be read. Try again in a moment.');
    return new web3.PublicKey(state.pumpPool);
  }
  /** Amount, side and slippage checks shared by the PumpSwap quote and trade. */
  pumpSwapInput({ config, side, amount, slippage = '1' }) {
    if (side !== 'buy' && side !== 'sell') throw new Error('Unknown action.');
    const raw = parseAmount(amount, side === 'buy' ? config.quoteDecimals : TOKEN_DECIMALS);
    if (raw <= 0n) throw new Error('Enter an amount greater than zero.');
    const percent = Number(slippage);
    if (!Number.isFinite(percent) || percent < 0.1 || percent > 5) throw new Error('Slippage must be between 0.1% and 5%.');
    return { raw, slippageBps: Math.round(percent * 100) };
  }
  /**
   * After migration the token trades on its locked PumpSwap pool, from this page like any other trade. The wallet
   * still signs once: SOL is wrapped and unwrapped inside the same transaction, and it is simulated before signing.
   */
  async pumpSwapTrade({ pool, config, action, body }) {
    const { raw, slippageBps } = this.pumpSwapInput({ config, side: action, amount: body.amount, slippage: body.slippage });
    if (action === 'sell') {
      const held = this.client.tokenAmount((await this.connection.getAccountInfo(this.client.ata(this.publicKey, pool.mint)))?.data);
      if (held < raw) throw new Error(`You hold ${formatAmount(held, TOKEN_DECIMALS)} ${pool.symbol}.`);
    }
    const { pumpSwapTrade } = await this.pumpSwap();
    const trade = await pumpSwapTrade({ connection: this.connection, pool: await this.pumpPoolOf(pool), user: this.publicKey, side: action, amount: raw, slippageBps });
    // A PumpSwap buy takes an exact token amount and may charge up to the slippage limit, so that is what must be held.
    if (action === 'buy') {
      const held = await this.quoteBalance(this.publicKey, config);
      if (held < trade.limit + (config.wsol ? SolanaWallet.SOL_HEADROOM : 0n)) throw new Error(`Not enough ${config.symbol} on ${this.net.name}: this buy may charge up to ${formatAmount(trade.limit, config.quoteDecimals)} ${config.symbol} with your slippage setting.${config.wsol ? ' Keep a little SOL for network fees and new accounts.' : ''}`);
    }
    const signature = await this.sendInstructions([this.client.computeBudget(PUMPSWAP_COMPUTE_UNITS), ...trade.instructions], [], `Confirm the ${action} on PumpSwap in your wallet…`);
    return { hash: signature, message: `${action === 'buy' ? 'Bought' : 'Sold'} ${pool.symbol} on PumpSwap.` };
  }
  async getQuote({ token, side, amount }) {
    await this.loadConfig();
    const { pool } = await this.freshPool(token);
    const config = this.configOf(pool);
    if (!config) throw new Error('This token uses an unknown configuration.');
    const d = config.quoteDecimals;
    if (pool.status === STATUS_MIGRATED) {
      const { raw, slippageBps } = this.pumpSwapInput({ config, side, amount });
      const { pumpSwapQuote } = await this.pumpSwap();
      const q = await pumpSwapQuote({ connection: this.connection, pool: await this.pumpPoolOf(pool), user: this.publicKey ?? web3.PublicKey.default, side, amount: raw, slippageBps });
      // Fees come from PumpSwap's own fee schedule, as its SDK computes them for this pool now.
      return side === 'buy'
        ? { out: formatAmount(q.out, TOKEN_DECIMALS), fee: formatAmount(q.fee, d), spend: formatAmount(raw, d), maxSpend: formatAmount(q.limit, d), venue: 'PumpSwap' }
        : { out: formatAmount(q.out, d), fee: formatAmount(q.fee, d), venue: 'PumpSwap' };
    }
    const feeBps = currentFeeBps(config, pool.createdAt, chainNow());
    const extra = { feeBps: Number(feeBps), antiSnipeActive: feeBps > BigInt(config.baseFeeBps) };
    if (side === 'buy') {
      const q = quoteBuy(pool, parseAmount(amount, d), feeBps, config.baseFeeBps);
      return { ...extra, out: formatAmount(q.tokens, TOKEN_DECIMALS), fee: formatAmount(q.fee, d), antiSnipeFee: formatAmount(q.antiSnipeFee, d), spend: formatAmount(q.gross, d), completesCurve: q.graduates };
    }
    const q = quoteSell(pool, parseAmount(amount, TOKEN_DECIMALS), feeBps, config.baseFeeBps);
    return { ...extra, out: formatAmount(q.net, d), fee: formatAmount(q.fee, d), antiSnipeFee: formatAmount(q.antiSnipeFee, d) };
  }
  // Wallet signs first, then any extra signer (the new mint keypair), as Phantom recommends.
  /**
   * Whether the deployed program writes Metaplex metadata at launch (the D7/D11 upgrade). Detected once by
   * simulating `reopen_curve` on an empty pool address: an upgraded program fails on the missing account,
   * an older one with InstructionFallbackNotFound (101).
   */
  /** Whether the program has early-partner tiers (then launches pass the creator's `partner` account). */
  async supportsPartnerTiers() {
    this._partnerSupport ??= await this.client.supportsPartnerTiers(this.connection, this.publicKey);
    return this._partnerSupport;
  }
  async supportsMetadata() {
    this._metadataSupport ??= await this.client.supportsMetadata(this.connection, this.publicKey);
    return this._metadataSupport;
  }
  /** A reserved vanity mint (the server co-signs the launch after the wallet), or a fresh random keypair. */
  async mintFor() {
    const random = { mint: web3.Keypair.generate(), remote: null, vanityNote: '' };
    if (!this.config.vanity?.enabled) return random;
    const post = async (path, body) => {
      const response = await fetch('/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Elpida-Token': this.config.csrf }, body: JSON.stringify(body) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error ?? 'Vanity mint request failed.'); return data;
    };
    let reserved;
    try { reserved = await post('solana/vanity-mint', { wallet: this.publicKey.toBase58() }); } catch { return { ...random, vanityNote: ' Its mint address is random (the address service is unavailable).' }; }
    if (!reserved.mint) return { ...random, vanityNote: reserved.reason ? ` ${reserved.reason}` : '' };
    const pubkey = new web3.PublicKey(reserved.mint), wallet = this.publicKey.toBase58();
    const toBase64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
    const fromBase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
    return { mint: { publicKey: pubkey }, vanityNote: ` Its address ends in "${this.config.vanity.suffix}".`,
      remote: { pubkey, sign: async message => fromBase64((await post('solana/vanity-sign', { id: reserved.id, wallet, message: toBase64(message) })).signature) } };
  }
  /** `remoteSigners`: [{ pubkey, sign(messageBytes) → signature bytes }], applied after the wallet (vanity mint). */
  /** True when these instructions fit in one transaction and simulate cleanly. Nothing is signed or sent. */
  async fitsOneTransaction(instructions) {
    try {
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
      const tx = new web3.Transaction({ feePayer: this.publicKey, blockhash, lastValidBlockHeight }).add(...instructions);
      if (tx.serializeMessage().length + 1 + 64 * tx.compileMessage().header.numRequiredSignatures > 1232) return false;
      return !(await this.connection.simulateTransaction(tx)).value.err;
    } catch { return false; }
  }
  async sendInstructions(instructions, extraSigners = [], message = 'Confirm the transaction in your wallet…', remoteSigners = []) {
    this.checkWallet();
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
    const tx = new web3.Transaction({ feePayer: this.publicKey, blockhash, lastValidBlockHeight }).add(...instructions);
    // Solana caps a transaction at 1,232 bytes: say so before asking the wallet to sign.
    const size = tx.serializeMessage().length + 1 + 64 * tx.compileMessage().header.numRequiredSignatures;
    if (size > 1232) throw new Error(`This transaction is too large for Solana (${size} of 1,232 bytes). Shorten the token name, or pay the launch fee in SOL instead of USDC, and try again. Nothing was submitted.`);
    try {
      const simulated = await this.connection.simulateTransaction(tx);
      if (simulated.value.err) throw Object.assign(new Error(`Simulation failed: ${JSON.stringify(simulated.value.err)}`), { logs: simulated.value.logs ?? [] });
      this.onProgress(message);
      const signed = await withWalletTimeout(this.provider.signTransaction(tx), this.walletName);
      for (const signer of extraSigners) signed.partialSign(signer);
      for (const remote of remoteSigners) signed.addSignature(remote.pubkey, await remote.sign(signed.serializeMessage()));
      const signature = await this.connection.sendRawTransaction(signed.serialize(), { preflightCommitment: 'confirmed' });
      this.onProgress('Transaction submitted. Waiting for confirmation…');
      for (;;) {
        const { value: [status] } = await this.connection.getSignatureStatuses([signature]);
        if (status?.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
        if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return signature;
        if (await this.connection.getBlockHeight('confirmed') > lastValidBlockHeight) throw new Error('The transaction expired before confirmation. Try again.');
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (error) {
      const text = walletErrorText(error, this.walletName);
      if (text) throw Object.assign(new Error(text), { code: error.code });
      if (error.code === 'TIMEOUT') throw error;
      throw new Error(explainError(error));
    }
  }
  async transact(action, body) {
    let config = await this.loadConfig();
    let d = this.decimals;
    let refs = this.refsOf(config);
    if (action === 'faucet') {
      const target = body?.asset ? this.configs.get(String(body.asset)) : config;
      if (!target?.test || !target.faucet) throw new Error('Get devnet SOL from faucet.solana.com.');
      const amount = parseAmount(target.faucet, target.quoteDecimals);
      const signature = await this.sendInstructions([this.client.testUsdcFaucet({ user: this.publicKey, mint: target.quoteMint, tokenProgram: target.quoteTokenProgram, amount })], [], `Confirm the free ${target.symbol} mint in your wallet…`);
      return { hash: signature, message: `Minted ${Number(formatAmount(amount, target.quoteDecimals)).toLocaleString()} ${target.symbol} (test asset, no value).` };
    }
    if (action === 'launch') {
      if (!(await this.loadBeta()).allowed) throw new Error('Launches are invite-only during the beta, and this wallet is not on the list yet. Ask the Elpida team to add it.');
      const kind = body.pair ?? 'native';
      const options = this.pairOptions()[kind];
      if (!options) throw new Error('Choose a trading pair.');
      if (!options.assets.length) throw new Error(options.unavailable);
      config = this.configs.get(String(body.quoteAsset ?? '')) ?? this.configs.get(options.assets[0].id);
      if (config.kind !== kind) throw new Error('Choose an asset for this trading pair.');
      d = config.quoteDecimals; refs = this.refsOf(config);
      const metadata=normalizeMetadata(body);
      const name = String(body.name ?? '').trim(), symbol = String(body.symbol ?? '').trim().toUpperCase();
      if (!name || new TextEncoder().encode(name).length > 32 || !/^[A-Z0-9]{1,10}$/.test(symbol)) throw new Error('Use a name up to 32 characters and a symbol of 1–10 letters or numbers.');
      const firstBuy = parseAmount(body.firstBuy || '0', d, true);
      if(firstBuy===0n&&!await this.client.supportsOptionalBuy(this.connection,this.publicKey))throw new Error('The Solana program needs the optional-buy upgrade before a zero-buy launch. Nothing was submitted.');
      if(firstBuy<0n)throw new Error('Enter zero or a positive creator buy.');
      let reward;
      try { reward = new web3.PublicKey(String(body.reward || this.address).trim()); } catch { throw new Error('Enter a valid Solana creator reward wallet.'); }
      // Price-aware terms read from chain just before signing: the program recomputes them at execution.
      await this.loadPrice();
      const terms = this.launchTerms(config), inUsdc = body.feeCurrency === 'usdc';
      if (!terms.priced) throw new Error(`USD pricing is not active for this pair on ${this.net.name} yet. The team turns it on with the Solana deploy script.`);
      if (this.price?.status !== 'fresh') throw new Error('The on-chain SOL/USD price is stale or uncertain right now. Wait a moment and refresh before launching.');
      if (inUsdc && !terms.usdcMint) throw new Error('Paying the fee in USDC is not available for this pair.');
      // A 1% cap above the quoted SOL fee: the launch fails instead of overcharging if SOL drops before it lands.
      const maxFee = inUsdc ? 0n : terms.fee * 101n / 100n + 1n;
      const fresh = { virtualQuote: terms.virtualQuote, virtualToken: config.virtualToken, curveSupply: config.curveSupply, realQuote: 0n, sold: 0n, liquidityBonus: 0n, status: 0 };
      // The creator's first buy pays only the base fee (no anti-snipe tax); a buy beyond the curve is capped.
      const q = firstBuy===0n ? {tokens:0n,gross:0n,fee:0n} : quoteBuy(fresh, firstBuy, config.baseFeeBps, config.baseFeeBps);
      // The buy that completes a curve also opens its PumpSwap pool in the same transaction, so a curve is never left
      // closed. That does not fit inside a launch transaction, so a creator buy cannot take the whole curve.
      if (q.graduates) throw new Error(`A creator buy can take at most part of the curve: the buy that completes it must also open the PumpSwap pool, which does not fit in the launch transaction. Lower the first buy below ${formatAmount(q.gross, d)} ${config.symbol}. Nothing was submitted.`);
      // The SOL creation fee is paid from plain SOL; for SOL pairs the first buy is wrapped from it too.
      const solNeeded = maxFee + (config.wsol ? q.gross : 0n) + SolanaWallet.SOL_HEADROOM;
      let usdc = null;
      if (inUsdc) {
        const mintInfo = await this.connection.getAccountInfo(terms.usdcMint);
        usdc = { mint: terms.usdcMint, tokenProgram: mintInfo?.owner };
        const held = this.client.tokenAmount((await this.connection.getAccountInfo(this.client.ata(this.publicKey, terms.usdcMint, usdc.tokenProgram)))?.data);
        const required=terms.usdcFee+(config.quoteMint.equals(terms.usdcMint)?q.gross:0n);
        if (held < required) throw new Error(`You need ${formatAmount(required, 6)} USDC for the creation fee and any USDC first buy.${this.net.mainnet ? '' : ' Get devnet USDC at faucet.circle.com (Solana Devnet).'}`);
      }
      const getSol = this.net.mainnet ? '' : ' Get devnet SOL at faucet.solana.com.';
      if (config.wsol) { if (await this.quoteBalance(this.publicKey, config) < solNeeded) throw new Error(`You need about ${formatAmount(solNeeded, 9)} SOL (creation fee, first buy and account rent).${getSol}`); }
      else {
        if (BigInt(await this.connection.getBalance(this.publicKey)) < solNeeded) throw new Error(`You need about ${formatAmount(solNeeded, 9)} SOL for the creation fee and account rent.${getSol}`);
        if (await this.quoteBalance(this.publicKey, config) < q.gross) throw new Error(`You need ${formatAmount(q.gross, d)} ${config.symbol} for the first buy.${config.test ? ' Use its test faucet in Network and funds.' : ''}`);
      }
      // Token details are published first: the program writes this IPFS URI into immutable Metaplex
      // metadata in the launch transaction (D11), so wallets and explorers show the name and image.
      // A program not yet upgraded to metadata support keeps the earlier launch (details in this browser).
      const withMetadata = await this.supportsMetadata(), partnerTiers = withMetadata && await this.supportsPartnerTiers();
      // Token details are always written in the launch transaction, never afterwards.
      if (!withMetadata) throw new Error(`The ${this.net.name} program does not write token details at launch yet, and Elpida launches only with details included. The team upgrades it with the Solana deploy script. Nothing was submitted.`);
      let published = { metadata, storage: null };
      if (withMetadata) {
        this.onProgress?.('Publishing token details for the launch…');
        const payload = JSON.stringify({ network: this.net.key, name, symbol, ...metadata }), proof = await prepareUploadProof(payload);
        const staged = await fetch('/api/metadata/stage', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Elpida-Token': this.config.csrf, ...proof }, body: payload });
        published = await staged.json();
        if (!staged.ok) throw new Error(published.error ?? 'Publishing token details failed. No launch was submitted.');
        if (!/^ipfs:\/\//.test(published.uri ?? '') || !['public-ipfs', 'elpida-hosted'].includes(published.storage)) throw new Error('Token details were not staged safely. No launch was submitted.');
      }
      // D9: a pre-ground mint address ending in "hope" when the server has one ready, else a random mint.
      const { mint, remote, vanityNote } = await this.mintFor();
      const signature = await this.sendInstructions([
        this.client.computeBudget(),
        ...await this.wrapFor(config, q.gross),
        this.client.launch({ creator: this.publicKey, config: refs, mint: mint.publicKey, name, symbol, firstBuy, minTokensOut: q.tokens * 9950n / 10000n, reward, uri: published.uri, legacy: !withMetadata, partnerTiers, priceUpdate: terms.priceFeed, maxFee, usdc }),
        ...(config.wsol ? [this.client.unwrapSol(this.publicKey)] : []),
      ], remote ? [] : [mint], `Confirm your token launch in your wallet ($10 fee: ${inUsdc ? `${formatAmount(terms.usdcFee, 6)} USDC` : `${formatAmount(terms.fee, 9)} SOL, at most ${formatAmount(maxFee, 9)} SOL`})…`, remote ? [remote] : []);
      await writeMetadataCache(metadataKey(this.deployment.programId,mint.publicKey.toBase58()),published.metadata??metadata);
      return { hash: signature, token: mint.publicKey.toBase58(), metadataPublished: withMetadata, metadataStorage: published.storage,
        message: `Your token is live on ${this.net.name}.${vanityNote} ${!withMetadata ? 'Its details are saved in this browser (this network\'s program does not write token metadata yet).' : published.storage === 'public-ipfs' ? 'Its details are pinned to public IPFS and written into immutable token metadata.' : 'Its details are hosted by Elpida and written into immutable token metadata; public IPFS pinning is not configured.'}` };
    }
    const { mint, pool } = await this.freshPool(body.token);
    config = this.configOf(pool);
    if (!config) throw new Error('This token uses an unknown configuration.');
    d = config.quoteDecimals; refs = this.refsOf(config);
    if (action === 'reopen') {
      // D7 escape hatch: permissionless once a completed curve has waited 24 h without migrating.
      if (pool.status !== STATUS_GRADUATED) throw new Error('Only a completed curve that has not migrated can be reopened.');
      const signature = await this.sendInstructions([this.client.reopenCurve({ mint })], [], 'Confirm reopening the curve for trading in your wallet…');
      return { hash: signature, message: 'The curve is trading again. Holders can sell, and it graduates again once complete.' };
    }
    if (action === 'graduate') {
      if (pool.status === STATUS_MIGRATED) throw new Error('This token already trades on PumpSwap.');
      if (pool.status !== STATUS_GRADUATED) throw new Error('The curve is not complete yet.');
      const signature = await this.sendInstructions([this.client.computeBudget(MIGRATE_COMPUTE_UNITS), this.client.migrateToPumpswap({ payer: this.publicKey, config: refs, mint })], [],
        'Confirm the PumpSwap migration in your wallet (you advance about 0.05 SOL of pool rent; the unused part comes straight back)…');
      return { hash: signature, message: 'Migrated to PumpSwap. The liquidity is locked for good; LP trading fees can be harvested from Rewards.' };
    }
    if (action === 'withdraw') {
      // Curve fees and PumpSwap LP fee growth (both permissionless). When both are due they go in ONE transaction if it
      // fits and simulates; otherwise two, exactly as before. The check signs nothing.
      const hashes = [];
      const curveFees = pool.protocolFees + pool.creatorFees > 0n ? [this.client.withdrawFees({ payer: this.publicKey, config: refs, mint, reward: pool.reward })] : [];
      let harvest = [];
      if (pool.status === STATUS_MIGRATED) {
        const [state] = (await this.pumpStates([pool])).values();
        if (state?.harvestable > 0n) harvest = this.client.harvestLpFees({ payer: this.publicKey, config: refs, mint, reward: pool.reward });
      }
      const combined = curveFees.length && harvest.length ? [this.client.computeBudget(HARVEST_COMPUTE_UNITS + 100_000), ...curveFees, ...harvest] : null;
      if (combined && await this.fitsOneTransaction(combined)) {
        hashes.push(await this.sendInstructions(combined, [], 'Confirm the curve fee distribution and PumpSwap LP fee harvest (one transaction) in your wallet…'));
      } else {
        if (curveFees.length) hashes.push(await this.sendInstructions(curveFees, [], 'Confirm curve fee distribution in your wallet…'));
        if (harvest.length) hashes.push(await this.sendInstructions([this.client.computeBudget(HARVEST_COMPUTE_UNITS), ...harvest], [], 'Confirm the PumpSwap LP fee harvest in your wallet…'));
      }
      if (!hashes.length) throw new Error('Nothing to distribute yet. LP fees become harvestable once PumpSwap trading has earned at least 0.01% of the locked position.');
      return { hash: hashes.at(-1), message: 'Fees distributed 50/50 to the treasury and the creator reward wallet.' };
    }
    if (pool.status === STATUS_MIGRATED) return this.pumpSwapTrade({ pool, config, action, body });
    const percent = Number(body.slippage);
    if (!Number.isFinite(percent) || percent < 0.1 || percent > 5) throw new Error('Slippage must be between 0.1% and 5%.');
    const bps = BigInt(Math.round(percent * 100));
    let instruction;
    if (pool.status === STATUS_GRADUATED) throw new Error('This curve is complete. Migrate it to PumpSwap to continue trading.');
    const feeBps = currentFeeBps(config, pool.createdAt, chainNow());
    if (action === 'buy') {
      const grossIn = parseAmount(body.amount, d);
      const q = quoteBuy(pool, grossIn, feeBps, config.baseFeeBps);
      const held = await this.quoteBalance(this.publicKey, config);
      if (held < q.gross + (config.wsol ? 5_000_000n : 0n)) throw new Error(`Not enough ${config.symbol} on ${this.net.name}.${config.test ? ' Use its test faucet in Network and funds.' : config.wsol ? ' Get devnet SOL at faucet.solana.com.' : ''}`);
      // Only what the trade actually charges is wrapped; a partial final fill leaves the rest unspent.
      const wrap = await this.wrapFor(config, q.gross), buyIx = this.client.buy({ buyer: this.publicKey, config: refs, mint, grossIn: q.gross, minTokensOut: q.tokens * (10000n - bps) / 10000n });
      if (q.graduates) return this.completeAndMigrate({ config, refs, mint, wrap, buyIx, symbol: pool.symbol });
      instruction = [...wrap, buyIx];
    } else if (action === 'sell') {
      const tokensIn = parseAmount(body.amount, TOKEN_DECIMALS);
      const q = quoteSell(pool, tokensIn, feeBps, config.baseFeeBps);
      instruction = [this.client.sell({ seller: this.publicKey, config: refs, mint, tokensIn, minQuoteOut: q.net * (10000n - bps) / 10000n })];
    } else throw new Error('Unknown action.');
    // SOL pairs: close the wrapped-SOL account afterwards so proceeds and change arrive as plain SOL.
    const signature = await this.sendInstructions([...instruction, ...(config.wsol ? [this.client.unwrapSol(this.publicKey)] : [])], [], 'Confirm the trade in your wallet…');
    return { hash: signature, message: `Trade confirmed on ${this.net.name}.` };
  }
}
