import { BrowserProvider, Contract, ContractFactory, parseUnits, formatUnits, isAddress, ZeroAddress } from '/vendor/ethers.js';

import { normalizeMetadata } from './metadata.mjs';
import { readMetadataCache, writeMetadataCache } from './metadata-cache.mjs';
import {publishForLaunch} from './launch-capabilities.mjs';
import { EVM_TEST_PAIRS } from '/pairs.mjs';

// EIP-6963: every installed EVM wallet announces itself, so Elpida can use the one the person picks
// instead of whichever extension last claimed window.ethereum (Phantom, Coinbase and MetaMask all try).
const announced = new Map();
if (typeof window !== 'undefined') {
  window.addEventListener('eip6963:announceProvider', event => { const d = event.detail; if (d?.info?.rdns && d.provider) announced.set(d.info.rdns, d); });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}
const EVM_CHOICE = 'elpida:evm-wallet';
/** Installed EVM wallets: [{ id, name, icon }]. Falls back to window.ethereum when none announce. */
export function evmWallets() {
  const list = [...announced.values()].map(d => ({ id: d.info.rdns, name: d.info.name, icon: d.info.icon }));
  if (!list.length && typeof window !== 'undefined' && window.ethereum) list.push({ id: 'injected', name: window.ethereum.isMetaMask ? 'MetaMask' : 'Browser wallet', icon: '' });
  return list;
}
export function chosenEvmWallet() { try { return localStorage.getItem(EVM_CHOICE); } catch { return null; } }
function evmProvider(id = chosenEvmWallet()) {
  if (id && announced.has(id)) return announced.get(id).provider;
  if (announced.size === 1) return [...announced.values()][0].provider;
  // Several wallets and no choice yet: prefer a dedicated EVM wallet over multi-chain ones.
  const preferred = [...announced.values()].find(d => !/phantom|backpack|solflare/i.test(d.info.rdns));
  return preferred?.provider ?? [...announced.values()][0]?.provider ?? window.ethereum ?? null;
}
/** Wallet requests that never open a popup otherwise hang forever; this turns that into a clear error. */
export function withWalletTimeout(promise, name = 'Your wallet', ms = 90_000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`${name} did not respond. Open the wallet extension: a request may be waiting there, or the wallet may be locked.`), { code: 'TIMEOUT' })), ms); })]).finally(() => clearTimeout(timer));
}
/** Readable text for the wallet errors people actually hit. */
export function walletErrorText(error, name = 'your wallet') {
  const code = error?.code ?? error?.data?.originalError?.code ?? error?.info?.error?.code;
  if (code === -32002) return `A request is already waiting in ${name}. Open the wallet extension and approve or reject it, then try again.`;
  if (code === 4001 || code === 'ACTION_REJECTED') return 'You cancelled the wallet request. Nothing was submitted.';
  if (code === 4100) return `${name} has not authorised Elpida yet. Connect again and approve the request.`;
  return null;
}
const metadataKey = (chain, factory, token) => `elpida:metadata:${chain}:${factory.toLowerCase()}:${token.toLowerCase()}`;
// Model 7 (DEX) and 6 (basic): native pricing. Older USDC-priced launchpads are not reused.
const modelOf = chainId => chainId===84532?"curve-dex-v9":"curve-beta-v8";
const deploymentKey = chainId => `elpida:${modelOf(chainId)}:deployment:${chainId}`;
/** Whole native coins (a decimal string) to wei. */
const wei = text => parseUnits(String(text), 18);
const read = key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };

// Browser-wallet flow for every EVM testnet in packages/core/networks.mjs.
export class TestnetWallet {
  constructor(config, onProgress) {
    this.config = config; this.onProgress = onProgress;
    this.select(config.testnets[0].key);
  }
  select(key) {
    const net = this.config.testnets.find(item => item.key === key);
    if (!net) throw new Error('That test network is not available.');
    if (this.net?.key !== key) { this.net = net; this.launches = new Map(); this.scannedBlock = undefined; this.launchFee = undefined; this.nativeVirtualQuote = undefined; this.needsMetadataUpgrade = false; }
    return net;
  }
  get dex(){return this.net.key==='base-sepolia'?this.config.publicDex:null;}
  get artifacts(){return {...this.config.contracts,factory:this.dex?this.config.contracts.dexFactory:this.config.contracts.legacyFactory,curve:this.dex?this.config.contracts.dexCurve:this.config.contracts.legacyCurve};}
  router(runner=this.provider){return new Contract(this.dex.router,['function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns(uint256)','function multicall(uint256 deadline,bytes[] data) payable returns(bytes[])','function unwrapWETH9(uint256 amountMinimum,address recipient) payable'],runner);}
  txUrl(hash) { return `${this.net.explorer}/tx/${hash}`; }
  /**
   * This network's native pricing from config/native-pricing.json (served by /api/config): creation fee
   * and starting FDV in the native coin. The EVM curve shape is fixed, so it completes at 16x startFdv.
   */
  get oracle() { return this.config.oracles?.[this.net.key]; }
  get pricing() {
    const p=this.config.prices?.[this.net.key];
    if(!p||p.status!=='fresh')return {launchFee:'Unavailable',startFdv:'Unavailable',launchFeeWei:0n,virtualQuoteWei:1n};
    return {launchFee:String(10/p.usd),startFdv:String(5000/p.usd),launchFeeWei:BigInt(Math.ceil(10/p.usd*1e18)),virtualQuoteWei:BigInt(Math.ceil(5000/p.usd*16/15*1e18))};
  }
  async oraclePrice() {
    if(!this.oracle?.available)throw new Error('Verified USD launch pricing is not configured for '+this.net.name+'. Browsing remains available.');
    const feed=new Contract(this.oracle.feed,['function decimals() view returns(uint8)','function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)'],this.provider);
    const [r,d,b]=await Promise.all([feed.latestRoundData(),feed.decimals(),this.provider.getBlock('latest')]);
    if(r[1]<=0n||r[0]===0n||r[4]<r[0]||r[3]<=0n||r[3]>BigInt(b.timestamp)||BigInt(b.timestamp)-r[3]>BigInt(this.oracle.maxAge)||d>18n)throw new Error('The launch oracle is stale or unavailable. Refresh later; no launch was sent.');
    return {usd:Number(r[1])/10**Number(d),updatedAt:Number(r[3]),maxAge:this.oracle.maxAge,status:'fresh',source:'On-chain USD oracle',feed:this.oracle.feed};
  }

  get deployment() {
    // Team deployment is authoritative across visitors; saved private deployments remain intact.
    if (this.net.shared?.factory && this.net.shared.model === modelOf(this.net.chainId)) return { ...this.net.shared, shared: true };
    const saved=read(deploymentKey(this.net.chainId));
    if(saved)return saved;
    return null;
  }
  get eth() { return this._eth ?? evmProvider(); }
  get walletName() { const eth = this.eth; const entry = [...announced.values()].find(d => d.provider === eth); return entry?.info.name ?? (eth?.isMetaMask ? 'MetaMask' : 'your wallet'); }
  /** Connects with the chosen EVM wallet (`walletId`, an EIP-6963 rdns), remembered for next time. */
  async connect(walletId) {
    if (walletId) { try { localStorage.setItem(EVM_CHOICE, walletId); } catch {} }
    const eth = evmProvider(walletId ?? chosenEvmWallet());
    if (!eth) throw new Error('Open this app in a browser with MetaMask or another Ethereum wallet installed.');
    this._eth = eth; this.walletId = walletId ?? chosenEvmWallet();
    const net = this.net, name = this.walletName;
    const chainId = `0x${net.chainId.toString(16)}`;
    const ask = args => withWalletTimeout(eth.request(args), name);
    try {
      // Accounts first: this request always opens the wallet, even when it is set to another chain.
      await ask({ method: 'eth_requestAccounts' });
      try { await ask({ method: 'wallet_switchEthereumChain', params: [{ chainId }] }); }
      catch (error) {
        const code = error.code ?? error.data?.originalError?.code;
        if (code !== 4902 && !/unrecognized chain|not been added|unsupported chain/i.test(error.message ?? '')) throw error;
        await ask({ method: 'wallet_addEthereumChain', params: [{ chainId, chainName: net.name, nativeCurrency: net.nativeCurrency, rpcUrls: [net.rpcUrl], blockExplorerUrls: [net.explorer] }] });
        await ask({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
      }
    } catch (error) { const text = walletErrorText(error, name); if (text) throw Object.assign(new Error(text), { code: error.code }); throw error; }
    this.provider?.destroy();
    this.provider = new BrowserProvider(eth, undefined, { cacheTimeout: -1 });
    this.signer = await this.provider.getSigner();
    this.address = await this.signer.getAddress();
    await this.checkNetwork();
    return this.address;
  }
  async checkNetwork() {
    if (!this.provider) throw new Error('Connect your wallet first.');
    const chainId = BigInt(await this.eth.request({ method: 'eth_chainId' }));
    if (chainId !== BigInt(this.net.chainId)) throw new Error(`Switch your wallet back to ${this.net.name}.`);
    const accounts = await this.eth.request({ method: 'eth_accounts' });
    if (!accounts[0] || accounts[0].toLowerCase() !== this.address.toLowerCase()) throw new Error('Your wallet account changed. Connect again to refresh it.');
  }
  /** Decimals, address and symbol of a launch's trading asset. */
  qd(item) { return item.pair === 'native' ? 18 : item.quoteDecimals ?? 18; }
  qaddr(item) { return item.pair === 'native' ? this.dex?.weth : item.quoteAddress; }
  qsym(item, wrapped = false) { return item.pair === 'native' ? (wrapped ? 'WETH' : this.net.nativeCurrency.symbol) : item.quoteSymbol ?? 'paired token'; }
  /** The creation fee in whole native coins: the factory's live value once deployed, else the configured one. */
  feeText() { return this.launchFee !== undefined ? formatUnits(this.launchFee, 18).replace(/\.0$/, '') : this.pricing.launchFee; }
  /**
   * Launchable trading assets by kind (packages/core/pairs.mjs). Native comes from the factory; xStock and
   * paired-token assets are the factory's approved quotes (DEX launchpads only). Every launch pays its
   * creation fee in the native coin.
   */
  pairOptions() {
    const native = this.net.nativeCurrency.symbol;
    const fee = { feeAmount: this.feeText(), feeSymbol: native };
    const approved = kind => (this.approvedQuotes ?? []).filter(a => a.kind === kind).map(a => ({ ...a, ...fee }));
    const missing = kind => !this.dex
      ? `${this.net.name} uses the basic launchpad, which supports ${native} pairs. xStock and paired-token launches need DEX graduation (Base Sepolia).`
      : !this.deployment ? 'Set up the launchpad on this network first.'
      : `No ${kind === 'xstock' ? 'xStock' : 'paired token'} is approved on ${this.net.name} yet. The launchpad owner can add the test assets from Network and funds.`;
    return {
      native: { assets: [{ id: 'native', symbol: native, name: this.net.nativeCurrency.name, decimals: 18, ...fee }] },
      xstock: approved('xstock').length ? { assets: approved('xstock') } : { assets: [], unavailable: missing('xstock') },
      token: approved('token').length ? { assets: approved('token') } : { assets: [], unavailable: missing('token') },
    };
  }
  /** Reads the DEX factory's approved quotes (QuoteApproved events) and labels each by `pairKind()`. */
  async loadPairs(factory) {
    if (!this.dex || !this.deployment) { this.approvedQuotes = []; return; }
    const latest = await this.provider.getBlockNumber();
    this.approvedQuotes ??= []; let from = this.pairsScanned === undefined ? this.deployment.block : this.pairsScanned + 1;
    for (; from <= latest; from += 100) {
      const to = Math.min(from + 99, latest);
      for (const event of await factory.queryFilter(factory.filters.QuoteApproved(), from, to)) {
        const address = event.args.asset, asset = new Contract(address, ['function symbol() view returns(string)', 'function name() view returns(string)', 'function decimals() view returns(uint8)', 'function pairKind() view returns(string)', 'function FAUCET_LIMIT() view returns(uint256)'], this.provider);
        const [symbol, name, decimals] = await Promise.all([asset.symbol(), asset.name(), asset.decimals()]);
        let kind = 'token', faucetLimit = 0n; try { kind = await asset.pairKind() === 'xstock' ? 'xstock' : 'token'; } catch {} try { faucetLimit = await asset.FAUCET_LIMIT(); } catch {}
        this.approvedQuotes.push({ id: address, address, kind, symbol, name, decimals: Number(decimals), virtualQuote: event.args.virtualQuote, test: faucetLimit > 0n,
          faucet: faucetLimit > 0n ? { label: `Get ${formatUnits(faucetLimit, decimals).replace(/\.0$/, '')} ${symbol}`, action: 'faucet', body: { asset: address } } : null });
      }
      this.pairsScanned = to;
    }
  }
  /** Treasury only, DEX launchpads: deploys the labelled test xStock and test paired token and approves them as pairs. */
  async setupTestPairs() {
    await this.checkNetwork();
    const factory = (await this.verifyFactory()).connect(this.signer);
    if (!this.dex) throw new Error('Test pairs need a launchpad with DEX graduation (Base Sepolia).');
    if ((await factory.treasury()).toLowerCase() !== this.address.toLowerCase()) throw new Error('Only the launchpad owner (its treasury wallet) can approve trading pairs.');
    await this.loadPairs(factory);
    const supply = await factory.TOKEN_SUPPLY(), vt = await factory.VIRTUAL_TOKEN();
    let last;
    for (const [i, t] of EVM_TEST_PAIRS.entries()) {
      if (this.approvedQuotes.some(a => a.symbol === t.symbol && a.test)) continue;
      const art = this.config.contracts.testAsset, adapterArt = this.config.contracts.adapter;
      this.onProgress(`Pair ${i + 1} of ${EVM_TEST_PAIRS.length}: confirm the ${t.symbol} test asset deployment…`);
      const asset = await new ContractFactory(art.abi, art.bytecode, this.signer).deploy(t.name, t.symbol, t.kind, t.decimals, BigInt(t.faucet)); await asset.waitForDeployment();
      this.onProgress(`Pair ${i + 1} of ${EVM_TEST_PAIRS.length}: confirm its Uniswap migration adapter…`);
      const adapter = await new ContractFactory(adapterArt.abi, adapterArt.bytecode, this.signer).deploy(this.dex.manager, asset.target, 10000); await adapter.waitForDeployment();
      const virtualQuote = parseUnits(t.startFdv, t.decimals) * vt / supply;
      last = await this.wait(factory.approveQuote(asset.target, virtualQuote, adapter.target), `Pair ${i + 1} of ${EVM_TEST_PAIRS.length}: approve ${t.symbol} as a trading pair…`);
    }
    this.pairsScanned = undefined; this.approvedQuotes = undefined; await this.loadPairs(factory);
    return { hash: last?.tx.hash, message: 'TEST-STOCK (xStock) and TEST-MEME (paired token) are now approved trading pairs.' };
  }
  factoryContract(runner = this.provider) {
    const deployment = this.deployment;
    if (!deployment || !isAddress(deployment.factory) || !Number.isSafeInteger(deployment.block) || deployment.block < 1) throw new Error('Deploy a testnet launchpad first.');
    return new Contract(deployment.factory, this.artifacts.factory.abi, runner);
  }
  async wait(pending, message) {
    this.onProgress(message);
    const tx = await pending;
    this.onProgress('Transaction submitted. Waiting for confirmation…');
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error('Transaction did not succeed.');
    return { tx, receipt };
  }
  async deploy() {
    await this.checkNetwork();
    if (this.deployment && !this.needsMetadataUpgrade) throw new Error(`This ${this.net.name} launchpad is already set up. Use it for your launches.`);
    const previousDeployment=this.deployment;
    await this.oraclePrice();
    if (await this.provider.getBalance(this.address) === 0n) throw new Error(`Get ${this.net.nativeCurrency.symbol} on ${this.net.name} from a faucet to pay deployment gas.`);
    const artifact = this.artifacts.factory;
    let migrationAdapter;
    if(this.dex){
      const manager=new Contract(this.dex.manager,['function factory() view returns(address)','function WETH9() view returns(address)'],this.provider);
      if((await manager.factory()).toLowerCase()!==this.dex.factory.toLowerCase()||(await manager.WETH9()).toLowerCase()!==this.dex.weth.toLowerCase())throw new Error('Unexpected Uniswap manager configuration.');
      // Native pairs graduate through an adapter whose ERC-20 side is WETH.
      const key='elpida:dex-adapter:'+this.net.chainId+':native',saved=read(key);
      if(saved&&isAddress(saved)&&await this.provider.getCode(saved)!=='0x'){
        const existing=new Contract(saved,this.config.contracts.adapter.abi,this.provider);
        if((await existing.manager()).toLowerCase()!==this.dex.manager.toLowerCase()||(await existing.usdc()).toLowerCase()!==this.dex.weth.toLowerCase()||await existing.fee()!==10000n)throw new Error('Saved adapter configuration mismatch.');migrationAdapter=saved;
      }else{this.onProgress('Step 1 of 2: confirm the Uniswap migration adapter deployment…');const a=this.config.contracts.adapter,c=await new ContractFactory(a.abi,a.bytecode,this.signer).deploy(this.dex.manager,this.dex.weth,10000);await c.waitForDeployment();migrationAdapter=c.target;write(key,migrationAdapter);}
    }
    this.onProgress('Confirm the launchpad deployment. Oracle pricing will enforce the $10 launch fee and $5,000 starting FDV…');
    const contract = await new ContractFactory(artifact.abi, artifact.bytecode, this.signer).deploy(this.address, 0n, 1n, ...(this.dex?[migrationAdapter]:[]));
    this.onProgress('Deployment submitted. Waiting for confirmation…');
    await contract.waitForDeployment();
    const receipt = await contract.deploymentTransaction().wait();
    const record = { factory: await contract.getAddress(), block: receipt.blockNumber, hash: receipt.hash, migrationAdapter, model: modelOf(this.net.chainId), metadataVersion:this.dex?1:undefined };
    if(previousDeployment && !write('elpida:previous-factory:'+this.net.chainId+':'+previousDeployment.factory,previousDeployment))throw new Error('Factory deployed, but previous deployment could not be archived. Save the new factory '+record.factory+' manually.');
    this.launches.clear(); this.scannedBlock = undefined;
    if (!write(deploymentKey(this.net.chainId), record)) throw new Error(`Deployed, but this browser blocks storage. Save factory ${record.factory} (block ${record.block}) in packages/core/networks.mjs.`);
    await this.wait(contract.configureUsdPricing(this.oracle.feed,this.oracle.maxAge,this.oracle.usdc??ZeroAddress),'Activate verified USD pricing. This fixes the oracle and enables launches…');
    this.needsMetadataUpgrade=false;
    return { hash: receipt.hash, message: `Your ${this.net.name} launchpad is deployed, using the on-chain USD oracle for the $10 launch fee.` };
  }
  async verifyFactory({launch=false}={}) {
    const factory=this.factoryContract(),version=await factory.MODEL_VERSION();
    if(version!==(this.dex?9n:8n))throw new Error('This launchpad needs the verified USD version. Set up a new launchpad from Network and funds.');
    if(!this.oracle?.available||(await factory.usdFeed()).toLowerCase()!==this.oracle.feed.toLowerCase()||await factory.maxPriceAge()!==BigInt(this.oracle.maxAge)||(await factory.feeUsdc()).toLowerCase()!==(this.oracle.usdc??ZeroAddress).toLowerCase())throw new Error('Activate verified USD pricing from Network and funds before launching.');
    this.feeUsdc=await factory.feeUsdc();
    try{[this.launchFee,this.nativeVirtualQuote,this.price]=await Promise.all([factory.launchFee(),factory.nativeVirtualQuote(),this.oraclePrice()]);}
    catch(error){this.launchFee=undefined;this.nativeVirtualQuote=undefined;this.price={...this.config.prices?.[this.net.key],status:'stale'};if(launch)throw error;}
    if(this.dex){try{this.needsMetadataUpgrade=await factory.METADATA_VERSION()!==1n;}catch{this.needsMetadataUpgrade=true;}}
    return factory;
  }
  /** Treasury only: activates the registry's verified oracle once, with no manual fee override. */
  async applyPricing() {
    await this.checkNetwork();await this.oraclePrice();
    const factory=this.factoryContract().connect(this.signer);
    if(await factory.usdFeed()!==ZeroAddress)throw new Error('Oracle pricing is already fixed. Manual pricing is disabled.');
    return this.wait(factory.configureUsdPricing(this.oracle.feed,this.oracle.maxAge,this.oracle.usdc??ZeroAddress),'Activate verified USD pricing…');
  }
  async state() {
    await this.checkNetwork();
    const native = this.net.nativeCurrency.symbol;
    const balance = formatUnits(await this.provider.getBalance(this.address), 18);
    if (!this.deployment) return { wallet: this.address, balance, balanceSymbol: native, nativeBalance: balance, nativeSymbol: native, tokens: [], activity: [], treasuryBalance: '0', undeployed: true };
    const factory = await this.verifyFactory();
    if(this.dex){try{this.needsMetadataUpgrade=await factory.METADATA_VERSION()!==1n;}catch{this.needsMetadataUpgrade=true;}}
    const latest = await this.provider.getBlockNumber();
    if(this.net.shared?.factory.toLowerCase()===this.deployment.factory.toLowerCase()){
      try{
        const [response,statusResponse]=await Promise.all([fetch('/api/public/tokens?network='+encodeURIComponent(this.net.key)),fetch('/api/public/status')]);
        if(response.ok&&statusResponse.ok){const entries=await response.json(),status=(await statusResponse.json()).networks[this.net.key];
          if(status.enabled&&status.indexedBlock!==null){this.launches.clear();for(const item of entries)this.launches.set(item.address.toLowerCase(),{...item});this.scannedBlock=status.indexedBlock;}
        }
      }catch{/* RPC scanning still recovers recent launches if the index API is offline. */}
    }
    const start = this.scannedBlock === undefined ? this.deployment.block : this.scannedBlock + 1;
    if (latest - start > 100_000) throw new Error('This deployment needs a dedicated indexer to load its history.');
    for (let block = start; block <= latest; block += 2000) {
      const to = Math.min(block + 1999, latest);
      const events = await factory.queryFilter(factory.filters.Launched(), block, to);
      for (const event of events) this.launches.set(event.args.token.toLowerCase(), { address: event.args.token, curve: event.args.curve, pair: event.args.nativePair ? 'native' : 'token', creator: event.args.creator, hash: event.transactionHash, created: event.blockNumber });
      if(this.dex)for(const event of await factory.queryFilter(factory.filters.MetadataPublished(),block,to)){const item=this.launches.get(event.args.token.toLowerCase());if(item)item.metadataURI=event.args.uri;}
      if(this.dex)for(const event of await factory.queryFilter(factory.filters.CustomPair(),block,to)){const item=this.launches.get(event.args.token.toLowerCase());if(item)item.quoteAddress=event.args.quote;}
      this.scannedBlock = to;
    }
    await this.loadPairs(factory);
    for (const item of this.launches.values()) {
      if (!item.quoteAddress || item.quoteSymbol) continue;
      const asset = this.approvedQuotes.find(a => a.address.toLowerCase() === item.quoteAddress.toLowerCase());
      Object.assign(item, asset ? { pair: asset.kind, quoteSymbol: asset.symbol, quoteDecimals: asset.decimals } : { pair: 'token', quoteSymbol: 'paired token', quoteDecimals: 18 });
    }
    const tokens = await Promise.all([...this.launches.values()].reverse().map(async item => {
      item = {...item,metadata:await readMetadataCache(metadataKey(this.net.chainId,this.deployment.factory,item.address)) ?? item.metadata ?? {}};
      if(item.metadataURI){try{const response=await fetch('/api/metadata/resolve?uri='+encodeURIComponent(item.metadataURI));if(!response.ok)throw new Error('unavailable');item.metadata=normalizeMetadata(await response.json());item.metadataStatus='published';}catch{item.metadataStatus='unavailable';}}
      const d = this.qd(item);
      const token = new Contract(item.address, this.config.contracts.token.abi, this.provider);
      const curve = new Contract(item.curve, this.artifacts.curve.abi, this.provider);
      const pool = await curve.pool(), graduated = pool !== ZeroAddress;
      if(graduated&&this.dex)return this.dexState(item,token,curve,pool,d);
      const market = graduated ? new Contract(pool, this.config.contracts.pool.abi, this.provider) : curve;
      const [name, symbol, reserve, sold, supply, held, protocol, creator, reward, complete] = await Promise.all([token.name(), token.symbol(), market.realReserve(), curve.sold(), token.totalSupply(), token.balanceOf(this.address), curve.protocolFees(), curve.creatorFees(), curve.creatorRewardVault(), curve.complete()]);
      const p = graduated ? await market.protocolFees() : 0n, c = graduated ? await market.creatorFees() : 0n;
      const priceQ = graduated ? reserve : await curve.virtualQuote() + reserve;
      const priceT = graduated ? await market.tokenReserve() : await curve.virtualToken() - sold;
      const circulation = supply - await token.balanceOf("0x000000000000000000000000000000000000dead") - await token.balanceOf(item.curve) - (graduated ? await token.balanceOf(pool) : 0n);
      return { ...item, pool, graduated, complete, liquidityLocked: graduated, quoteSymbol: this.qsym(item), quoteDecimals: d, spotPrice: Number(formatUnits(priceQ,d)) / Number(formatUnits(priceT,18)), circulatingSupply:formatUnits(circulation,18),saleCap: formatUnits(await curve.SALE_CAP(),18), remainingBuy: complete ? '0' : formatUnits(await curve.completionQuote(),d), name, symbol, reward, reserve: formatUnits(reserve, d), sold: formatUnits(sold, 18), supply: formatUnits(supply, 18), balance: formatUnits(held, 18), protocolFees: formatUnits(protocol+p, d), creatorFees: formatUnits(creator+c, d) };
    }));
    const pairBalances = {};
    for (const a of this.approvedQuotes ?? []) { try { pairBalances[a.id] = formatUnits(await new Contract(a.address, this.config.contracts.quote.abi, this.provider).balanceOf(this.address), a.decimals); } catch {} }
    const treasury = await factory.treasury();
    // Live factory pricing and freshness are authoritative for creation.
    const pricing = { verified:true,price:this.price,launchFee: this.launchFee===undefined?'Unavailable':formatUnits(this.launchFee, 18), startFdv: this.nativeVirtualQuote===undefined?'Unavailable':formatUnits(this.nativeVirtualQuote * 15n / 16n, 18), symbol: native, matches:true, owner: treasury.toLowerCase() === this.address.toLowerCase() };
    return { wallet: this.address, balance, balanceSymbol: native, pairBalances, nativeBalance: balance, nativeSymbol: native, wrappedNativeBalance:this.dex?formatUnits(await new Contract(this.dex.weth,this.config.contracts.quote.abi,this.provider).balanceOf(this.address),18):undefined, tokens, activity: [], pricing, treasuryBalance: formatUnits(await this.provider.getBalance(treasury), 18) };
  }
  async publicTokens(){
    const response=await fetch('/api/public/tokens?network='+encodeURIComponent(this.net.key));if(!response.ok)throw new Error('Public token discovery is unavailable.');
    const entries=await response.json();return Promise.all(entries.map(async item=>({...item,metadata:this.deployment?await readMetadataCache(metadataKey(this.net.chainId,this.deployment.factory,item.address))??item.metadata:item.metadata})));
  }
  async dexState(item,token,curve,pool,d){
    const market=new Contract(pool,this.config.contracts.dexPool.abi,this.provider),[slot,a,b,name,symbol,supply,sold,held,reward,cp,cc,locker,splitter]=await Promise.all([market.slot0(),market.token0(),market.token1(),token.name(),token.symbol(),token.totalSupply(),curve.sold(),token.balanceOf(this.address),curve.creatorRewardVault(),curve.protocolFees(),curve.creatorFees(),curve.locker(),curve.feeSplitter()]);
    const first=a.toLowerCase()===item.address.toLowerCase(),square=slot[0]*slot[0],Q=2n**192n,n=first?square:Q,den=first?Q:square,quoteAsset=first?b:a;
    const price=Number(formatUnits(n*10n**18n*10n**24n/(den*10n**BigInt(d)),24)),circulation=supply-await token.balanceOf('0x000000000000000000000000000000000000dead')-await token.balanceOf(item.curve)-await token.balanceOf(pool);
    const feeLocker=new Contract(locker,this.config.contracts.locker.abi,this.provider),manager=new Contract(await feeLocker.manager(),['function ownerOf(uint256) view returns(address)'],this.provider),positionId=await curve.positionId();
    const fees=new Contract(splitter,this.config.contracts.splitter.abi,this.provider),dexRewards=[];for(const asset of [a,b]){const isToken=asset.toLowerCase()===item.address.toLowerCase();dexRewards.push({asset,symbol:isToken?symbol:this.qsym(item,true),creator:formatUnits(await fees.claimable(asset,reward),isToken?18:d)});}
    return {...item,pool,graduated:true,complete:true,liquidityLocked:await feeLocker.locked()&&(await manager.ownerOf(positionId)).toLowerCase()===locker.toLowerCase(),locker,feeSplitter:splitter,positionId:positionId.toString(),venue:'Uniswap v3',feeBps:100,dexRewards,quoteSymbol:this.qsym(item),quoteDecimals:d,spotPrice:price,circulatingSupply:formatUnits(circulation,18),saleCap:formatUnits(await curve.SALE_CAP(),18),remainingBuy:'0',name,symbol,reward,reserve:formatUnits(await new Contract(quoteAsset,this.config.contracts.quote.abi,this.provider).balanceOf(pool),d),sold:formatUnits(sold,18),supply:formatUnits(supply,18),balance:formatUnits(held,18),protocolFees:formatUnits(cp,d),creatorFees:formatUnits(cc,d)};
  }
  async dexQuote(item,side,input){const asset=this.qaddr(item),quoter=new Contract(this.dex.quoter,this.config.contracts.quoter.abi,this.provider),result=await quoter.quoteExactInputSingle.staticCall({tokenIn:side==='buy'?asset:item.address,tokenOut:side==='buy'?item.address:asset,amountIn:input,fee:10000,sqrtPriceLimitX96:0});return result[0];}
  async dexTrade(item,side,body){
    const percent=Number(body.slippage);if(!Number.isFinite(percent)||percent<0.1||percent>5)throw new Error('Slippage must be between 0.1% and 5%.');
    const input=parseUnits(body.amount,side==='buy'?this.qd(item):18);if(input<=0n)throw new Error('Enter a positive amount.');
    const out=await this.dexQuote(item,side,input),minimum=out*(10000n-BigInt(Math.round(percent*100)))/10000n,asset=this.qaddr(item),router=this.router(this.signer),unwrap=side==='sell'&&item.pair==='native';
    const params={tokenIn:side==='buy'?asset:item.address,tokenOut:side==='buy'?item.address:asset,fee:10000,recipient:unwrap?router.target:this.address,amountIn:input,amountOutMinimum:minimum,sqrtPriceLimitX96:0};
    if(side==='sell'||item.pair!=='native'){const payment=new Contract(params.tokenIn,this.config.contracts.quote.abi,this.signer);if(await payment.allowance(this.address,router.target)<input)await this.wait(payment.approve(router.target,input),'Approve the DEX trade…');}
    // Router02 single-hop has no deadline; always wrap in its deadline-checked multicall.
    const calls=[router.interface.encodeFunctionData('exactInputSingle',[params])];if(unwrap)calls.push(router.interface.encodeFunctionData('unwrapWETH9',[minimum,this.address]));
    const deadline=BigInt((await this.provider.getBlock('latest')).timestamp+300);
    return this.wait(router['multicall(uint256,bytes[])'](deadline,calls,{value:side==='buy'&&item.pair==='native'?input:0}),'Confirm the Uniswap trade…');
  }
  async market(item, runner = this.provider) {
    const curve = new Contract(item.curve, this.artifacts.curve.abi, runner);
    const pool = await curve.pool();
    return pool === ZeroAddress ? curve : new Contract(pool, this.config.contracts.pool.abi, runner);
  }
  async getQuote({ token, side, amount }) {
    await this.checkNetwork();
    const item = this.launches.get(token.toLowerCase());
    if (!item) throw new Error('Token not found. Refresh the launchpad.');
    const curve = await this.market(item);
    const d = this.qd(item);
    if(this.dex&&await new Contract(item.curve,this.artifacts.curve.abi,this.provider).pool()!==ZeroAddress){const input=parseUnits(amount,side==='buy'?d:18),out=await this.dexQuote(item,side,input);return {out:formatUnits(out,side==='buy'?18:d),fee:formatUnits(input/100n,side==='buy'?d:18),feeSymbol:side==='buy'?this.qsym(item):await new Contract(item.address,this.config.contracts.token.abi,this.provider).symbol()};}
    const [out, fee] = side === 'buy' ? await curve.quoteBuy(parseUnits(amount, d)) : await curve.quoteSell(parseUnits(amount, 18));
    return { out: formatUnits(out, side === 'buy' ? 18 : d), fee: formatUnits(fee, d) };
  }
  async transact(action, body) {
    await this.checkNetwork();
    const factory = (await this.verifyFactory()).connect(this.signer);
    let result;
    if (action === 'setup-pairs') return this.setupTestPairs();
    if (action === 'apply-pricing') return this.applyPricing();
    if (action === 'faucet' && body?.asset) {
      const a = (this.approvedQuotes ?? []).find(x => x.address.toLowerCase() === String(body.asset).toLowerCase() && x.test);
      if (!a) throw new Error('That asset has no test faucet.');
      const c = new Contract(a.address, ['function faucet(uint256)', 'function FAUCET_LIMIT() view returns(uint256)'], this.signer), limit = await c.FAUCET_LIMIT();
      result = await this.wait(c.faucet(limit), `Confirm the free ${a.symbol} test mint in your wallet…`);
      return { hash: result.tx.hash, message: `Added ${formatUnits(limit, a.decimals)} ${a.symbol} (test asset, no value).` };
    }
    if (action === 'faucet') throw new Error(`Get test ${this.net.nativeCurrency.symbol} from the network faucet linked in Network and funds.`);
    let metadataSaved = true, metadataPublished = false;
    if (action === 'launch') {
      if(!['native','usdc'].includes(body.feeCurrency??'native'))throw new Error('Choose native currency or USDC for the launch fee.');
      await this.verifyFactory({launch:true});
      const details = normalizeMetadata(body);
      const kind = body.pair ?? 'native';
      if (!['native','xstock','token'].includes(kind)) throw new Error('Choose a trading pair.');
      const nativePair = kind === 'native', paired = kind === 'xstock' || kind === 'token';
      const asset = paired ? (this.approvedQuotes ?? []).find(a => a.kind === kind && a.address.toLowerCase() === String(body.quoteAsset ?? '').toLowerCase()) : null;
      if (paired && !asset) throw new Error(this.pairOptions()[kind].unavailable ?? 'Choose an approved asset for this pair.');
      const firstBuy = parseUnits(body.firstBuy, nativePair ? 18 : asset.decimals);
      const name = body.name.trim(), symbol = body.symbol.trim().toUpperCase();
      if (firstBuy <= 0n || !name || name.length > 40 || !/^[A-Z0-9]{1,10}$/.test(symbol)) throw new Error('Check the token name, symbol and first buy.');
      const reward = body.reward || this.address;
      if (!isAddress(reward) || reward === ZeroAddress) throw new Error('Enter a valid creator reward wallet.');
      const net = firstBuy - firstBuy * 125n / 10000n;
      const virtualQuote = paired ? asset.virtualQuote : await factory.nativeVirtualQuote();
      const out = await factory.VIRTUAL_TOKEN() * net / (virtualQuote + net);
      // Native fees include a refundable 1% cap; USDC approvals are exactly ten units.
      const inUsdc=body.feeCurrency==='usdc';
      if(inUsdc && (await factory.treasury()).toLowerCase()===this.address.toLowerCase())throw new Error('This wallet is also the launchpad fee recipient. The contract cannot verify a USDC fee paid to the same wallet. Choose native payment for this test, or launch from a different funded wallet to test USDC fee collection. No launch was submitted.');
      const fee = await factory.launchFee(), value = (inUsdc?0n:(fee*101n+99n)/100n) + (nativePair ? firstBuy : 0n), native = this.net.nativeCurrency.symbol;
      if (await this.provider.getBalance(this.address) <= value) throw new Error(`You need more than ${formatUnits(value, 18)} ${native} for the creation fee${nativePair ? ' and first buy' : ''} plus network fees.`);
      const pairToken = paired ? new Contract(asset.address, this.config.contracts.quote.abi, this.signer) : null;
      if (paired && await pairToken.balanceOf(this.address) < firstBuy) throw new Error(`You need ${formatUnits(firstBuy, asset.decimals)} ${asset.symbol} for the first buy.${asset.test ? ' Use its test faucet in Network and funds.' : ''}`);
      let published;
      if(publishForLaunch({chain:this.net.key,publicEnabled:this.config.metadataPublishing?.publicEnabled,metadataSupported:!this.needsMetadataUpgrade})){
        this.onProgress('Publishing your token metadata to IPFS…');
        const response=await fetch('/api/metadata/publish',{method:'POST',headers:{'Content-Type':'application/json','X-Elpida-Token':this.config.csrf},body:JSON.stringify({name,symbol,...details})});
        published=await response.json();if(!response.ok)throw new Error(published.error??'Metadata publishing failed.');
        if(!published.public || !/^ipfs:\/\//.test(published.uri))throw new Error('Public metadata did not publish. No launch was submitted.');
        await this.checkNetwork();
      }
      if (paired && await pairToken.allowance(this.address, await factory.getAddress()) < firstBuy) await this.wait(pairToken.approve(await factory.getAddress(), firstBuy), `Approve the ${asset.symbol} first buy…`);
      if(inUsdc){
        if(!this.feeUsdc||this.feeUsdc===ZeroAddress)throw new Error('USDC fee payment is unavailable on this network.');
        const coin=new Contract(this.feeUsdc,this.config.contracts.quote.abi,this.signer);
        if(await coin.balanceOf(this.address)<10_000_000n)throw new Error('Add 10 USDC on this network to pay the launch fee. Gas and first purchase are separate.');
        if(await coin.allowance(this.address,factory.target)<10_000_000n)await this.wait(coin.approve(factory.target,10_000_000n),'Approve exactly 10 USDC for the launch fee…');
      }
      await this.oraclePrice();await this.checkNetwork();
      const args=[name,symbol,asset?.address??ZeroAddress,firstBuy,out*9950n/10000n,reward,published?.uri??'',inUsdc];
      const gas=await factory.launchWithPayment.estimateGas(...args,{value});
      const gasPrice=(await this.provider.getFeeData()).maxFeePerGas??(await this.provider.getFeeData()).gasPrice??0n;
      if(await this.provider.getBalance(this.address)<value+gas*gasPrice)throw new Error('Add '+native+' for the estimated network gas in addition to the fee and first purchase.');
      const confirmation='Confirm the $10 launch fee, first purchase '+body.firstBuy+' '+this.qsym({pair:kind,quoteSymbol:asset?.symbol})+' and gas up to '+formatUnits(gas*gasPrice,18)+' '+native+'. Native fee cap includes 1%; unused fee is refunded.';
      result=await this.wait(factory.launchWithPayment(...args,{value}),confirmation);
      const event = result.receipt.logs.map(log => {try{return factory.interface.parseLog(log);}catch{return null;}}).find(log => log?.name === 'Launched');
      metadataSaved = !!event && await writeMetadataCache(metadataKey(this.net.chainId,this.deployment.factory,event.args.token),published?.metadata??details);
      if(published){metadataSaved=true;metadataPublished=true;}
    } else {
      const item = this.launches.get(body.token.toLowerCase());
      if (!item) throw new Error('Token not found.');
      const curve = await this.market(item, this.signer);
      const original = new Contract(item.curve, this.artifacts.curve.abi, this.signer);
      if (action === 'graduate') result = await this.wait(original.graduate(), this.dex?'Confirm graduation into Uniswap v3…':'Confirm graduation into the locked test pool…');
      else if (action === 'withdraw') {
        result = await this.wait(original.withdrawFees(), 'Claim bonding-curve fees…');
        if(await original.pool()!==ZeroAddress){if(this.dex){const locker=new Contract(await original.locker(),this.config.contracts.locker.abi,this.signer);result=await this.wait(locker.collectFees(),'Collect Uniswap position fees…');const splitter=new Contract(await original.feeSplitter(),this.config.contracts.splitter.abi,this.signer);for(const asset of [item.address,this.qaddr(item)])for(const recipient of [await factory.treasury(),await original.creatorRewardVault()])if(await splitter.claimable(asset,recipient)>0n)result=await this.wait(splitter.claim(asset,recipient),'Pay fees to their fixed recipient…');}else result=await this.wait(curve.withdrawFees(),'Claim locked-pool fees…');}
      }
      else if(this.dex&&await original.pool()!==ZeroAddress)result=await this.dexTrade(item,action,body);
      else {
        const percent = Number(body.slippage);
        if (!Number.isFinite(percent) || percent < 0.1 || percent > 5) throw new Error('Slippage must be between 0.1% and 5%.');
        const input = parseUnits(body.amount, action === 'buy' ? this.qd(item) : 18);
        if (input <= 0n) throw new Error('Enter a positive amount.');
        const [out] = action === 'buy' ? await curve.quoteBuy(input) : await curve.quoteSell(input);
        const payment = action === 'buy' ? new Contract(this.qaddr(item) ?? ZeroAddress, this.config.contracts.quote.abi, this.signer) : new Contract(item.address, this.config.contracts.token.abi, this.signer);
        const marketAddress = await curve.getAddress();
        if (!(action === 'buy' && item.pair === 'native') && await payment.allowance(this.address, marketAddress) < input) await this.wait(payment.approve(marketAddress, input), 'Approve this trade in your wallet…');
        const minimum = out * (10000n - BigInt(Math.round(percent * 100))) / 10000n;
        result = await this.wait(action === 'buy' ? curve.buy(input, minimum, {value: item.pair === 'native' ? input : 0n}) : curve.sell(input, minimum), 'Confirm the trade in your wallet…');
      }
    }
    return { hash: result.tx.hash, metadataSaved, message: action === 'launch' ? `Your token is live on ${this.net.name}.${metadataPublished ? ' Metadata published to IPFS and linked on-chain.' : metadataSaved ? ' Metadata saved in this browser.' : ' Browser metadata storage failed; keep a copy of your token details.'}` : action === 'withdraw' ? 'Fees distributed to their recipient wallets.' : `Trade confirmed on ${this.net.name}.` };
  }
}
