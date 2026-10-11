import { createElpidaSolana, quoteBuy, quoteSell, currentFeeBps, poolStats, parseAmount, formatAmount, explainError, TOKEN_DECIMALS, TOKEN_SUPPLY, POOL_SIZE, STATUS_GRADUATED, STATUS_MIGRATED, MIGRATE_COMPUTE_UNITS, HARVEST_COMPUTE_UNITS, PUMPSWAP_FEES, TEST_USDC_FAUCET_MAX, harvestNow, withdrawOut } from '/elpida-solana.mjs';
import {normalizeMetadata} from './metadata.mjs';
import {readMetadataCache,writeMetadataCache} from './metadata-cache.mjs';
const metadataKey=(program,mint)=>`elpida:solana-metadata:${program}:${mint}`;
const readMetadata=async key=>{try{return normalizeMetadata(await readMetadataCache(key)??{});}catch{return {};}};

const web3 = globalThis.solanaWeb3;

// Browser-wallet flow for the Elpida Solana program, model 3 (Phantom, Solflare or Backpack).
// Same surface as TestnetWallet so the UI can treat every chain alike. Launches use a USDC virtual
// curve ($5k starting FDV, complete at $50k FDV); the anti-snipe fee starts at 90% and decays to the
// base fee over the first minute, with the surplus locked into the token's liquidity. A complete curve
// migrates (anyone can trigger it) into a PumpSwap pool whose LP stays locked by the program; LP fee
// growth is harvested 50/50 to the treasury and the creator reward wallet. On test networks the program
// also has an Elpida tUSDC config (free faucet), used for new launches so curves can really complete;
// pools always trade through the config they were launched with.
const MAX_U64 = (1n << 64n) - 1n;
// Quote with a clock two seconds early: a slightly higher anti-snipe fee, so slippage limits stay safe.
const chainNow = () => Math.floor(Date.now() / 1000) - 2;
export class SolanaWallet {
  constructor(config, onProgress) {
    this.config = config; this.net = config.solana; this.onProgress = onProgress;
    this.usesTestToken = false;
    this.launches = new Map();
    this.connection = web3 ? new web3.Connection(this.net.rpcUrl, 'confirmed') : null;
  }
  select(key) {
    if (key !== this.net.key) throw new Error('That Solana network is not available.');
    return this.net;
  }
  get deployment() { return this.net.deployment ?? null; }
  get provider() { return window.phantom?.solana ?? window.solflare ?? window.backpack ?? window.solana ?? null; }
  get client() {
    if (!this.deployment) throw new Error('The Solana program is not deployed yet. Run npm run solana:deploy once (see docs/LOCALHOST_AND_TESTNET.md).');
    return (this._client ??= createElpidaSolana(web3, this.deployment.programId));
  }
  txUrl(signature) { return `${this.net.explorer}/tx/${signature}${this.clusterQuery}`; }
  addressUrl(address) { return `${this.net.explorer}/address/${address}${this.clusterQuery}`; }
  get clusterQuery() { return this.net.cluster === 'localnet' ? `?cluster=custom&customUrl=${encodeURIComponent(this.net.rpcUrl)}` : `?cluster=${this.net.cluster}`; }

  async connect() {
    if (!web3) throw new Error('The Solana library did not load. Refresh the page.');
    const provider = this.provider;
    if (!provider) throw new Error('Install Phantom, Solflare or Backpack to use Solana Devnet.');
    const result = await provider.connect();
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
  async loadConfig() {
    if (this.programConfig) return this.programConfig;
    const c = this.client;
    const [info, testInfo] = await this.connection.getMultipleAccountsInfo([c.configPda, c.configFor(c.testUsdcMint)]);
    if (!info) throw new Error('The Solana curve configuration is missing. Upgrade and initialize the devnet program with npm.cmd run solana:deploy -- --upgrade.');
    const config = { address: c.configPda, symbol: 'USDC', ...c.decodeConfig(info.data) };
    if(!info.owner.equals(this.client.programId)||config.modelVersion!==3)throw new Error('This deployment does not match the Solana curve preview.');
    if (this.net.quote.address && config.quoteMint.toBase58() !== this.net.quote.address) throw new Error('This Solana deployment does not use the expected test USDC.');
    this.configs = new Map([[config.address.toBase58(), config]]);
    let launch = config;
    if (testInfo?.owner.equals(c.programId)) {
      launch = { address: c.configFor(c.testUsdcMint), symbol: 'tUSDC', test: true, ...c.decodeConfig(testInfo.data) };
      this.configs.set(launch.address.toBase58(), launch);
    }
    this.usesTestToken = Boolean(launch.test);
    this.programConfig = launch; this.decimals = launch.quoteDecimals;
    return launch;
  }
  /** The config a pool was launched with (null for pools of unknown configs). */
  configOf(pool) { return this.configs?.get(pool.config.toBase58()) ?? null; }
  refsOf(config) { return { address: config.address, quoteMint: config.quoteMint, treasury: config.treasury }; }
  async quoteBalance(owner = this.publicKey) {
    const config = await this.loadConfig();
    return this.client.tokenAmount((await this.connection.getAccountInfo(this.client.ata(owner, config.quoteMint)))?.data);
  }
  async state() {
    this.checkWallet();
    if (!this.deployment) return { wallet: this.address, balance: '0', tokens: [], activity: [], treasuryBalance: '0', undeployed: true };
    const launchConfig = await this.loadConfig();
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
        created: Number(pool.createdAt)*1000, metadata:await readMetadata(metadataKey(this.deployment.programId,address)), migrationPending:false, pair:'usdc', url: this.addressUrl(address), decimals: TOKEN_DECIMALS, quoteSymbol: config.symbol, quoteDecimals: d, dex: 'PumpSwap',
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
    const [balance, treasury] = await Promise.all([this.quoteBalance(), this.quoteBalance(launchConfig.treasury)]);
    return { wallet: this.address, balance: formatAmount(balance, launchConfig.quoteDecimals), balanceSymbol: launchConfig.symbol, tokens, activity: [], treasuryBalance: formatAmount(treasury, launchConfig.quoteDecimals) };
  }
  dexUrl(pumpPool) { return this.net.cluster === 'devnet' || this.net.cluster === 'localnet' ? this.addressUrl(pumpPool) : `https://dexscreener.com/solana/${pumpPool}`; }
  /** Migration record, PumpSwap reserves and harvestable LP for migrated pools. */
  async pumpStates(pools) {
    const result = new Map();
    if (!pools.length) return result;
    const mints = pools.map(pool => pool.mint);
    const keys = pools.flatMap(pool => { const p = this.client.pumpAccounts(pool.mint, this.configOf(pool).quoteMint); return [this.client.migrationPda(pool.mint), p.pool, p.poolBase, p.poolQuote]; });
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
      const signed = await this.provider.signTransaction(tx);
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
      if (error.code === 4001) throw error;
      throw new Error(explainError(error));
    }
  }
  async transact(action, body) {
    let config = await this.loadConfig();
    let d = this.decimals;
    let refs = this.refsOf(config);
    if (action === 'faucet') {
      if (!config.test) throw new Error('Get Solana Devnet test USDC from faucet.circle.com.');
      const signature = await this.sendInstructions([this.client.testUsdcFaucet({ user: this.publicKey, amount: TEST_USDC_FAUCET_MAX })], [], 'Confirm the free Elpida tUSDC mint in your wallet…');
      return { hash: signature, message: `Minted ${formatAmount(TEST_USDC_FAUCET_MAX, 6)} Elpida tUSDC (test token, no value).` };
    }
    if (action === 'launch') {
      if(body.pair!=='usdc')throw new Error('Solana preview launches currently use the USDC pair.');
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
      const needed = config.launchFee + q.gross;
      if (await this.quoteBalance() < needed) throw new Error(config.test ? `You need ${formatAmount(needed, d)} Elpida tUSDC. Use the faucet button to mint some for free.` : `You need ${formatAmount(needed, d)} test USDC on ${this.net.name}. Get it from faucet.circle.com (choose Solana Devnet).`);
      const mint = web3.Keypair.generate();
      const signature = await this.sendInstructions([
        this.client.computeBudget(),
        this.client.launch({ creator: this.publicKey, config: refs, mint: mint.publicKey, name, symbol, firstBuy, minTokensOut: q.tokens * 9950n / 10000n, reward }),
      ], [mint], 'Confirm your token launch in your wallet…');
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
      const held = this.client.tokenAmount((await this.connection.getAccountInfo(this.client.ata(this.publicKey, config.quoteMint)))?.data);
      if (held < q.gross) throw new Error(`Not enough ${config.symbol} on ${this.net.name}.${config.test ? ' Use the faucet button to mint free Elpida tUSDC.' : ''}`);
      instruction = this.client.buy({ buyer: this.publicKey, config: refs, mint, grossIn, minTokensOut: q.tokens * (10000n - bps) / 10000n });
    } else if (action === 'sell') {
      const tokensIn = parseAmount(body.amount, TOKEN_DECIMALS);
      const q = quoteSell(pool, tokensIn, feeBps, config.baseFeeBps);
      instruction = this.client.sell({ seller: this.publicKey, config: refs, mint, tokensIn, minQuoteOut: q.net * (10000n - bps) / 10000n });
    } else throw new Error('Unknown action.');
    const signature = await this.sendInstructions([instruction], [], 'Confirm the trade in your wallet…');
    return { hash: signature, message: `Trade confirmed on ${this.net.name}.` };
  }
}
