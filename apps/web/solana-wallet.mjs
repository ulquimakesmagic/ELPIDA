import { createElpidaSolana, quoteBuy, quoteSell, currentFeeBps, poolStats, parseAmount, formatAmount, explainError, TOKEN_DECIMALS, TOKEN_SUPPLY, POOL_SIZE, STATUS_GRADUATED, STATUS_MIGRATED, MIGRATE_COMPUTE_UNITS, HARVEST_COMPUTE_UNITS, PUMPSWAP_FEES, WSOL_MINT, harvestNow, withdrawOut } from '/elpida-solana.mjs';
import {normalizeMetadata} from './metadata.mjs';
import { PAIR_LIMITS } from '/pairs.mjs';
import { withWalletTimeout, walletErrorText } from './wallet.mjs';

const SOL_CHOICE = 'elpida:solana-wallet';
const SOLANA_WALLETS = [
  { id: 'phantom', name: 'Phantom', get: () => window.phantom?.solana ?? (window.solana?.isPhantom ? window.solana : null) },
  { id: 'solflare', name: 'Solflare', get: () => window.solflare ?? null },
  { id: 'backpack', name: 'Backpack', get: () => window.backpack ?? null },
];
/** Installed Solana wallets: [{ id, name }]. */
export function solanaWallets() {
  const list = SOLANA_WALLETS.filter(w => { try { return !!w.get(); } catch { return false; } }).map(({ id, name }) => ({ id, name }));
  if (!list.length && typeof window !== 'undefined' && window.solana) list.push({ id: 'injected', name: 'Solana wallet' });
  return list;
}
export function chosenSolanaWallet() { try { return localStorage.getItem(SOL_CHOICE); } catch { return null; } }
function solanaProvider(id = chosenSolanaWallet()) {
  const pick = SOLANA_WALLETS.find(w => w.id === id)?.get();
  return pick ?? SOLANA_WALLETS.map(w => w.get()).find(Boolean) ?? window.solana ?? null;
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
const chainNow = () => Math.floor(Date.now() / 1000) - 2;
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
  get provider() { return this._provider ?? solanaProvider(); }
  get walletName() { return SOLANA_WALLETS.find(w => w.id === (this.walletId ?? chosenSolanaWallet()))?.name ?? 'your Solana wallet'; }
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
  async connect(walletId) {
    if (!web3) throw new Error('The Solana library did not load. Refresh the page.');
    if (walletId) { try { localStorage.setItem(SOL_CHOICE, walletId); } catch {} }
    const provider = solanaProvider(walletId ?? chosenSolanaWallet());
    if (!provider) throw new Error('Install Phantom, Solflare or Backpack to use Solana Devnet.');
    this._provider = provider; this.walletId = walletId ?? chosenSolanaWallet();
    let result = null;
    // A wallet that is already connected to this site answers without a popup; asking again can stall.
    if (!(provider.isConnected && provider.publicKey)) {
      try { result = await withWalletTimeout(provider.connect(), this.walletName); }
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
   * token), each checked on-chain, with its quote mint's token program. Dollar (USDC) configs from older
   * deployments are ignored: pricing is native only.
   */
  async loadConfig() {
    if (this.programConfig) return this.programConfig;
    const c = this.client;
    const listed = (Array.isArray(this.deployment.pairs) && this.deployment.pairs.length ? this.deployment.pairs : [
      { kind: 'native', key: 'sol', symbol: 'SOL', name: 'SOL (wrapped automatically)', config: c.configFor(new web3.PublicKey(WSOL_MINT)).toBase58() },
    ]).filter(p => p.kind !== 'usdc');
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
  /** Launchable trading assets by kind, the same structure as every other network (packages/core/pairs.mjs). */
  pairOptions() {
    const all = [...(this.configs?.values() ?? [])];
    const asset = cfg => {
      const d = cfg.quoteDecimals, id = cfg.address.toBase58();
      // The creation fee is always lamports (SOL), whatever the pair.
      return { id, symbol: cfg.symbol, name: cfg.name, decimals: d, test: cfg.test, wsol: cfg.wsol, feeAmount: formatAmount(cfg.launchFee, 9), feeSymbol: 'SOL',
        curve: { vq: Number(cfg.virtualQuote) / 10 ** d, vt: Number(cfg.virtualToken) / 10 ** TOKEN_DECIMALS, cap: Number(cfg.curveSupply) / 10 ** TOKEN_DECIMALS, feeBps: cfg.baseFeeBps },
        faucet: cfg.test && cfg.faucet ? { label: `Get ${Number(cfg.faucet).toLocaleString()} ${cfg.symbol}`, action: 'faucet', body: { asset: id } } : cfg.wsol && this.net.gasFaucet ? { label: 'Get devnet SOL', href: this.net.gasFaucet } : null };
    };
    const group = kind => {
      const assets = all.filter(cfg => cfg.kind === kind).sort((a, b) => Number(b.test) - Number(a.test)).map(asset);
      if (assets.length) return { assets };
      return { assets: [], unavailable: PAIR_LIMITS.solana[kind] ?? (!this.deployment ? 'The Solana program is not deployed yet.' : this.net.mainnet ? `No ${kind === 'token' ? 'paired token' : 'asset of this kind'} is approved on mainnet yet.` : `Not set up on ${this.net.name} yet. Run solana-upgrade.cmd to add the SOL and test-token pairs.`) };
    };
    return { native: group('native'), xstock: group('xstock'), token: group('token') };
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
  /** Rent and fees a SOL-pair transaction needs on top of the trade (new accounts, priority-free fee). */
  static SOL_HEADROOM = 30_000_000n;
  async state() {
    this.checkWallet();
    if (!this.deployment) return { wallet: this.address, balance: '0', balanceSymbol: 'SOL', nativeSymbol: 'SOL', tokens: [], activity: [], treasuryBalance: '0', undeployed: true };
    const launchConfig = await this.loadConfig();
    await this.loadBeta();
    const accounts = await this.connection.getProgramAccounts(this.client.programId, { filters: [{ dataSize: POOL_SIZE }] });
    const pools = accounts.filter(({ account }) => this.client.isPool(account.data)).map(({ pubkey, account }) => ({ pubkey, ...this.client.decodePool(account.data) })).filter(pool => this.configOf(pool));
    const holdings = pools.length ? await this.connection.getMultipleAccountsInfo(pools.map(pool => this.client.ata(this.publicKey, pool.mint))) : [];
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
        created: Number(pool.createdAt)*1000, metadata:await readMetadata(metadataKey(this.deployment.programId,address)), migrationPending:false, pair: config.kind ?? 'native', url: this.addressUrl(address), decimals: TOKEN_DECIMALS, quoteSymbol: config.symbol, quoteDecimals: d, dex: 'PumpSwap',
        reserve: formatAmount(pool.realQuote, d), liquidityBonus: formatAmount(pool.liquidityBonus, d), lockedLiquidity: formatAmount(stats.lockedLiquidity, d),
        sold: formatAmount(pool.sold, TOKEN_DECIMALS), circulatingSupply: formatAmount(pool.sold, TOKEN_DECIMALS), saleCap: formatAmount(pool.curveSupply, TOKEN_DECIMALS),
        supply: formatAmount(TOKEN_SUPPLY, TOKEN_DECIMALS), balance: formatAmount(this.client.tokenAmount(holdings[index]?.data), TOKEN_DECIMALS),
        spotPrice: stats.price, marketCap: stats.marketCap, progress: stats.progress, remainingBuy: formatAmount(remainingBuy, d),
        feeBps: Number(feeBps), antiSnipeActive: !complete && feeBps > BigInt(config.baseFeeBps),
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
    const [treasury, lamports] = await Promise.all([this.connection.getBalance(launchConfig.treasury), this.connection.getBalance(this.publicKey)]);
    const pairBalances = {};
    for (const cfg of this.configs.values()) pairBalances[cfg.address.toBase58()] = formatAmount(await this.quoteBalance(this.publicKey, cfg), cfg.quoteDecimals);
    const sol = formatAmount(BigInt(lamports), 9);
    // Live native pricing of the SOL pair (set by the team with scripts/native-pricing.mjs).
    const start = poolStats({ ...launchConfig, realQuote: 0n, sold: 0n, liquidityBonus: 0n, status: 0 }, launchConfig.quoteDecimals);
    const pricing = { launchFee: formatAmount(launchConfig.launchFee, 9), startFdv: String(start.marketCap), symbol: 'SOL', matches: true, owner: false };
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
  async getQuote({ token, side, amount }) {
    await this.loadConfig();
    const { pool } = await this.freshPool(token);
    const config = this.configOf(pool);
    if (!config) throw new Error('This token uses an unknown configuration.');
    const d = config.quoteDecimals;
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
  async sendInstructions(instructions, extraSigners = [], message = 'Confirm the transaction in your wallet…') {
    this.checkWallet();
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
    const tx = new web3.Transaction({ feePayer: this.publicKey, blockhash, lastValidBlockHeight }).add(...instructions);
    try {
      const simulated = await this.connection.simulateTransaction(tx);
      if (simulated.value.err) throw Object.assign(new Error(`Simulation failed: ${JSON.stringify(simulated.value.err)}`), { logs: simulated.value.logs ?? [] });
      this.onProgress(message);
      const signed = await withWalletTimeout(this.provider.signTransaction(tx), this.walletName);
      for (const signer of extraSigners) signed.partialSign(signer);
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
      throw new Error('Solana USD-priced launches require the verified-oracle program upgrade. Existing tokens remain available; use simulation to test the launch flow.');
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
      const firstBuy = parseAmount(body.firstBuy, d);
      if(firstBuy<=0n)throw new Error('Enter a positive first buy.');
      let reward;
      try { reward = new web3.PublicKey(String(body.reward || this.address).trim()); } catch { throw new Error('Enter a valid Solana creator reward wallet.'); }
      const fresh = { virtualQuote: config.virtualQuote, virtualToken: config.virtualToken, curveSupply: config.curveSupply, realQuote: 0n, sold: 0n, liquidityBonus: 0n, status: 0 };
      // The creator's first buy pays only the base fee (no anti-snipe tax); a buy beyond the curve is capped.
      const q = quoteBuy(fresh, firstBuy, config.baseFeeBps, config.baseFeeBps);
      // The SOL creation fee is paid from plain SOL; for SOL pairs the first buy is wrapped from it too.
      const solNeeded = config.launchFee + (config.wsol ? q.gross : 0n) + SolanaWallet.SOL_HEADROOM;
      const getSol = this.net.mainnet ? '' : ' Get devnet SOL at faucet.solana.com.';
      if (config.wsol) { if (await this.quoteBalance(this.publicKey, config) < solNeeded) throw new Error(`You need about ${formatAmount(solNeeded, 9)} SOL (creation fee, first buy and account rent).${getSol}`); }
      else {
        if (BigInt(await this.connection.getBalance(this.publicKey)) < solNeeded) throw new Error(`You need about ${formatAmount(solNeeded, 9)} SOL for the creation fee and account rent.${getSol}`);
        if (await this.quoteBalance(this.publicKey, config) < q.gross) throw new Error(`You need ${formatAmount(q.gross, d)} ${config.symbol} for the first buy.${config.test ? ' Use its test faucet in Network and funds.' : ''}`);
      }
      const mint = web3.Keypair.generate();
      const signature = await this.sendInstructions([
        this.client.computeBudget(),
        ...await this.wrapFor(config, q.gross),
        this.client.launch({ creator: this.publicKey, config: refs, mint: mint.publicKey, name, symbol, firstBuy, minTokensOut: q.tokens * 9950n / 10000n, reward }),
        ...(config.wsol ? [this.client.unwrapSol(this.publicKey)] : []),
      ], [mint], `Confirm your token launch in your wallet (${formatAmount(config.launchFee, 9)} SOL creation fee)…`);
      const saved=await writeMetadataCache(metadataKey(this.deployment.programId,mint.publicKey.toBase58()),metadata);
      return { hash: signature, token: mint.publicKey.toBase58(), message: `Your token is live on ${this.net.name}.${saved?' Metadata saved in this browser.':' Metadata could not be saved in this browser.'}` };
    }
    const { mint, pool } = await this.freshPool(body.token);
    config = this.configOf(pool);
    if (!config) throw new Error('This token uses an unknown configuration.');
    d = config.quoteDecimals; refs = this.refsOf(config);
    if (action === 'graduate') {
      if (pool.status === STATUS_MIGRATED) throw new Error('This token already trades on PumpSwap.');
      if (pool.status !== STATUS_GRADUATED) throw new Error('The curve is not complete yet.');
      const signature = await this.sendInstructions([this.client.computeBudget(MIGRATE_COMPUTE_UNITS), this.client.migrateToPumpswap({ payer: this.publicKey, config: refs, mint })], [],
        'Confirm the PumpSwap migration in your wallet (you advance about 0.05 SOL of pool rent; the unused part comes straight back)…');
      return { hash: signature, message: 'Migrated to PumpSwap. The liquidity is locked for good; LP trading fees can be harvested from Rewards.' };
    }
    if (action === 'withdraw') {
      // Curve fees and PumpSwap LP fee growth are separate transactions (both permissionless).
      const hashes = [];
      if (pool.protocolFees + pool.creatorFees > 0n) {
        hashes.push(await this.sendInstructions([this.client.withdrawFees({ payer: this.publicKey, config: refs, mint, reward: pool.reward })], [], 'Confirm curve fee distribution in your wallet…'));
      }
      if (pool.status === STATUS_MIGRATED) {
        const [state] = (await this.pumpStates([pool])).values();
        if (state?.harvestable > 0n) {
          hashes.push(await this.sendInstructions([this.client.computeBudget(HARVEST_COMPUTE_UNITS), ...this.client.harvestLpFees({ payer: this.publicKey, config: refs, mint, reward: pool.reward })], [], 'Confirm the PumpSwap LP fee harvest in your wallet…'));
        }
      }
      if (!hashes.length) throw new Error('Nothing to distribute yet. LP fees become harvestable once PumpSwap trading has earned at least 0.01% of the locked position.');
      return { hash: hashes.at(-1), message: 'Fees distributed 50/50 to the treasury and the creator reward wallet.' };
    }
    if (pool.status === STATUS_MIGRATED) {
      const [state] = (await this.pumpStates([pool])).values();
      throw new Error(`This token trades on PumpSwap now (pool ${state?.pumpPool ?? 'unknown'}).`);
    }
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
      instruction = [...await this.wrapFor(config, q.gross), this.client.buy({ buyer: this.publicKey, config: refs, mint, grossIn: q.gross, minTokensOut: q.tokens * (10000n - bps) / 10000n })];
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
