import { nowSeconds } from './clock.mjs';
import {launchPublicTax,readTaxMarket,quoteTaxMarket,transactTaxMarket} from './tax-wallet.mjs';
import { BrowserProvider, JsonRpcProvider, FetchRequest, Contract, ContractFactory, Interface, parseUnits, formatUnits, isAddress, ZeroAddress } from '/vendor/ethers.js';
import { routerAbi, swapCalldata } from '/dex-router.mjs';

import { normalizeMetadata } from './metadata.mjs';
import { readMetadataCache, writeMetadataCache } from './metadata-cache.mjs';
import {publishForLaunch} from './launch-capabilities.mjs';
import { EVM_TEST_PAIRS } from '/pairs.mjs';
import { DEX_MODEL, LEGACY_DEX_MODEL, BETA_MODEL, MODEL_VERSIONS, isDexModel, curveShape, startFdvUsdFor, assertDeploymentTerms, usdQuoteTemplate, GRADUATION_GRACE_SECONDS, BASE_FEE_BPS, SNIPE_START_BPS, SNIPE_WINDOW_SECONDS, SALE_CAP } from '/curve-model.mjs';
import { quoteUsdcConversion, conversionCalls, CONVERSION_ROUTER_ABI } from './usdc-conversion.mjs';
import {nativeFundingError} from './payment-errors.mjs';
import {supportsAtomicLaunch,waitAtomicLaunch,waitAtomicBatch,atomicBatchRequest} from './wallet-batch.mjs';
import {prepareUploadProof} from './upload-proof.mjs';

// EIP-6963: every installed EVM wallet announces itself, so Elpida can use the one the person picks
// instead of whichever extension last claimed window.ethereum (Phantom, Coinbase and MetaMask all try).
import { injectedEvmWallets } from './wallet-discovery.mjs';
const announced = new Map();
if (typeof window !== 'undefined') {
  window.addEventListener('eip6963:announceProvider', event => { const d = event.detail; if (d?.info?.rdns && d.provider) announced.set(d.info.rdns, d); });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}
const EVM_CHOICE = 'elpida:evm-wallet';
/** Installed EVM wallets: [{ id, name, icon }]. Falls back to window.ethereum when none announce. */
export function evmWallets() { return injectedEvmWallets(typeof window==='undefined'?{}:window,[...announced.values()]); }
export function chosenEvmWallet() { try { return localStorage.getItem(EVM_CHOICE); } catch { return null; } }
function evmProvider(id = chosenEvmWallet()) {
  const list=evmWallets();
  if(id){const selected=list.find(w=>w.id===id);if(selected)return selected.provider;return null;}
  return list.length===1?list[0].provider:null;
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
// New deployments: model 10 (DEX, Base Sepolia) and model 8 (basic). A pinned model 9 team deployment stays usable.
// Model 10 (DEX graduation) runs on every network with an enabled public DEX; the rest keep the beta curve.
const modelOf = (chainId, dex = false) => chainId===84532||dex?DEX_MODEL:BETA_MODEL;
const deploymentKey = (chainId, dex = false) => `elpida:${modelOf(chainId, dex)}:deployment:${chainId}`;
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
    if (this.net?.key !== key) { this.net = net; this.atomicLaunch=undefined; this.launches = new Map(); this.scannedBlock = undefined; this.launchFee = undefined; this.pairsScanned=undefined;this.approvedQuotes=[]; this.nativeVirtualQuote = undefined; this.factoryStartFdvUsd = undefined; this.needsMetadataUpgrade = false;this.feeAccountingVersion=undefined; }
    return net;
  }
  /** The graduation DEX for this network, only when it is switched on (Base Sepolia, and others once their fork check passes). */
  get dex(){return this.config.publicDexes?.[this.net.key]??(this.net.key==='base-sepolia'?this.config.publicDex:null);}
  get artifacts(){return {...this.config.contracts,factory:this.dex?(this.config.contracts.atomicFactory??this.config.contracts.dexFactory):this.config.contracts.legacyFactory,curve:this.dex?this.config.contracts.dexCurve:this.config.contracts.legacyCurve};}
  router(runner=this.provider){return new Contract(this.dex.router,routerAbi(this.dex.routerVersion??2),runner);}
  txUrl(hash) { return `${this.net.explorer}/tx/${hash}`; }
  /**
   * Estimated launch pricing before a wallet connects: the $10 creation fee and the deployment's starting FDV
   * in the native coin. Model 10 ends at 10x its start; legacy model 8/9 deployments end at 16x.
   */
  get oracle() { return this.config.oracles?.[this.net.key]; }
  get pricing() {
    const p=this.config.prices?.[this.net.key];
    if(!p||p.status!=='fresh')return {launchFee:'Unavailable',startFdv:'Unavailable',launchFeeWei:0n,virtualQuoteWei:1n};
    const start=this.startFdvUsd,shape=curveShape(this.model);
    return {launchFee:String(10/p.usd),startFdv:String(start/p.usd),launchFeeWei:BigInt(Math.ceil(10/p.usd*1e18)),virtualQuoteWei:BigInt(Math.ceil(start/p.usd*shape.virtualFactor*1e18))};
  }
  /** Curve model of this network's deployment (or of a new deployment when none exists yet). */
  get model() { return this.deployment?.model ?? modelOf(this.net.chainId, !!this.dex); }
  /** Starting FDV in US dollars: read from a model 10 factory, else $5,000 for legacy, else the testnet size. */
  get startFdvUsd() {
    if (this.factoryStartFdvUsd) return this.factoryStartFdvUsd;
    return this.model === DEX_MODEL ? startFdvUsdFor(this.net) : 5000;
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
    // A model 10 record saved by this browser takes precedence over a pinned legacy model 9 team deployment.
    const shared=this.net.shared, model=modelOf(this.net.chainId, !!this.dex), saved=read(deploymentKey(this.net.chainId, !!this.dex));
    if(saved?.launchFeaturesVersion===1&&saved.model===DEX_MODEL&&(shared?.launchFeaturesVersion??0)<1)return saved;
    if(this.net.key==='base-sepolia'&&saved?.model===DEX_MODEL&&saved.feeAccountingVersion===1&&(shared?.feeAccountingVersion??0)<1)return saved;
    if (shared?.factory && shared.model === model) return { ...shared, shared: true };
    if (saved) return saved;
    if (shared?.factory && isDexModel(model) && isDexModel(shared.model)) return { ...shared, shared: true };
    return null;
  }
  /** True when this network still uses a legacy model 9 launchpad and model 10 can be deployed. */
  get modelUpgradeAvailable() { return !!this.dex && this.deployment?.model === LEGACY_DEX_MODEL;
  }
  get feeFixUpgradeAvailable(){return this.net.key==='base-sepolia'&&this.model===DEX_MODEL&&!!this.deployment&&this.feeAccountingVersion===0;}
  get launchUpgradeAvailable(){return this.net.key==='base-sepolia'&&this.model===DEX_MODEL&&!!this.deployment&&this.launchFeaturesChecked&&!this.automaticGraduationSupported;}
  async checkLaunchFeatures(factory=this.factoryContract()){
    if(this.launchFeaturesChecked&&this._launchFeaturesFactory===factory.target)return;
    this.launchFeaturesChecked=false;this.automaticGraduationSupported=false;
    if(this.model===DEX_MODEL){
      try{this.automaticGraduationSupported=await new Contract(factory.target,['function automaticGraduation() view returns(bool)'],this.provider).automaticGraduation();}
      catch(error){if(error.code!=='CALL_EXCEPTION'||(error.data&&error.data!=='0x'))throw error;}
    }
    this.launchFeaturesChecked=true;this._launchFeaturesFactory=factory.target;
  }
  /** A token's own curve model: tokens from a legacy team factory keep that factory's model. */
  modelOf(item) { return item?.deploymentModel ?? this.model; }
  /** Factory that created `item`: its legacy team factory, or the current launchpad. */
  factoryOf(item) { return item?.factory && item.factory.toLowerCase() !== this.deployment?.factory.toLowerCase() ? new Contract(item.factory, this.artifacts.factory.abi, this.provider) : this.factoryContract(); }
  get eth() { return this._eth ?? evmProvider(); }
  get walletName() { return evmWallets().find(w => w.provider === this.eth)?.name ?? 'your wallet'; }
  /** Connects with the chosen EVM wallet (`walletId`, an EIP-6963 rdns), remembered for next time. */
  async connect(walletId, {silent=false}={}) {
    if (walletId) { try { localStorage.setItem(EVM_CHOICE, walletId); } catch {} }
    const eth = evmProvider(walletId ?? chosenEvmWallet());
    if (!eth) throw new Error('Open this app in a browser with MetaMask or another Ethereum wallet installed.');
    this._eth = eth; this.walletId = walletId ?? chosenEvmWallet();
    const net = this.net, name = this.walletName;
    const chainId = `0x${net.chainId.toString(16)}`;
    const ask = args => withWalletTimeout(eth.request(args), name);
    try {
      // Accounts first: this request always opens the wallet, even when it is set to another chain.
      if(silent){
        const accounts=await ask({method:'eth_accounts'});
        if(!accounts.length||BigInt(await ask({method:'eth_chainId'}))!==BigInt(net.chainId))throw new Error('Reconnect your wallet to '+net.name+'.');
      } else await ask({ method: 'eth_requestAccounts' });
      if(!silent) try { await ask({ method: 'wallet_switchEthereumChain', params: [{ chainId }] }); }
      catch (error) {
        const code = error.code ?? error.data?.originalError?.code;
        if (code !== 4902 && !/unrecognized chain|not been added|unsupported chain/i.test(error.message ?? '')) throw error;
        await ask({ method: 'wallet_addEthereumChain', params: [{ chainId, chainName: net.name, nativeCurrency: net.nativeCurrency, rpcUrls: [net.rpcUrl], blockExplorerUrls: [net.explorer] }] });
        await ask({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
      }
    } catch (error) { const text = walletErrorText(error, name); if (text) throw Object.assign(new Error(text), { code: error.code }); throw error; }
    this.provider?.destroy();
    this.signerProvider?.destroy();
    this.signerProvider = new BrowserProvider(eth, undefined, { cacheTimeout: -1 });
    this.signer = await this.signerProvider.getSigner();
    // Wallet RPCs often restrict historical logs. Read from the registry's chain RPC;
    // signatures and transaction submissions always stay with the selected wallet.
    const rpc=new FetchRequest(net.rpcUrl);rpc.timeout=15000;
    this.provider = new JsonRpcProvider(rpc, net.chainId, { staticNetwork:true,cacheTimeout: -1, batchMaxCount: 1 });
    this.address = await this.signer.getAddress();
    await this.checkNetwork();
    this.atomicLaunch=await supportsAtomicLaunch(args=>eth.request(args),this.address,net.chainId);
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
   * paired-token assets are the factory's approved quotes (DEX launchpads only). Native and USDC fee
   * payment remain independent of the trading pair.
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
      native: { assets: [{ id: 'native', symbol: native, name: this.net.nativeCurrency.name, decimals: 18, ...fee, curve: this.previewCurve() }] },
      usdc: approved('usdc').length ? { assets: approved('usdc') } : { assets: [], unavailable: !this.dex ? 'USDC trading pairs need a DEX graduation adapter on this network.' : 'USDC trading setup is incomplete on this deployment. The owner can finish it here once; it then becomes available to everyone.' },
      xstock: approved('xstock').length ? { assets: approved('xstock') } : { assets: [], unavailable: missing('xstock') },
      token: approved('token').length ? { assets: approved('token') } : { assets: [], unavailable: missing('token') },
    };
  }
  /** Whole-unit native curve for the launch preview, once the factory's live virtual reserve is known. */
  previewCurve() {
    if (!this.nativeVirtualQuote) return undefined;
    const shape = curveShape(this.model);
    return { vq: Number(formatUnits(this.nativeVirtualQuote, 18)), vt: shape.virtualTokens, cap: shape.saleCap, feeBps: BASE_FEE_BPS };
  }
  /** Reads the DEX factory's approved quotes (QuoteApproved events) and labels each by `pairKind()`. */
  async setupUsdcPair(configuredFactory=null) {
    await this.checkNetwork(); const factory=(configuredFactory??await this.verifyFactory()).connect(this.signer);
    this.feeUsdc=await factory.feeUsdc();
    if(!this.dex||!this.feeUsdc||this.feeUsdc===ZeroAddress)throw new Error('A configured USDC asset and DEX adapter are required on this network.');
    if((await factory.treasury()).toLowerCase()!==this.address.toLowerCase())throw new Error('Only the launchpad treasury can approve the USDC trading pair.');
    if((await factory.approvedQuotes(this.feeUsdc)).adapter!==ZeroAddress)return {message:'USDC trading pair is already approved.'};
    if(Number(await new Contract(this.feeUsdc,['function decimals() view returns(uint8)'],this.provider).decimals())!==6)throw new Error('The configured USDC asset must use six decimals.');
    const adapterKey=`elpida:usdc-adapter:${this.net.chainId}:${factory.target.toLowerCase()}`;
    let adapterAddress=localStorage.getItem(adapterKey);
    if(adapterAddress){const a=new Contract(adapterAddress,['function manager() view returns(address)','function usdc() view returns(address)','function fee() view returns(uint24)'],this.provider);if((await a.manager()).toLowerCase()!==this.dex.manager.toLowerCase()||(await a.usdc()).toLowerCase()!==this.feeUsdc.toLowerCase()||await a.fee()!==10000n)throw new Error('Saved USDC adapter does not match this launchpad.');}
    else {const a=this.config.contracts.adapter;this.onProgress('Confirm the USDC graduation adapter deployment…');const adapter=await new ContractFactory(a.abi,a.bytecode,this.signer).deploy(this.dex.manager,this.feeUsdc,10000);await adapter.waitForDeployment();adapterAddress=adapter.target;localStorage.setItem(adapterKey,adapterAddress);}
    // Model 10: start FDV x 10/9 in USDC units. Legacy model 9: $5,000 x 16/15.
    const legacy=this.model===LEGACY_DEX_MODEL,start=legacy?5000n:await factory.startFdvUsd();
    const vq=legacy?5_000_000_000n*await factory.VIRTUAL_TOKEN()/await factory.TOKEN_SUPPLY():usdQuoteTemplate(start,6);
    const result=await this.wait(factory.approveQuote(this.feeUsdc,vq,adapterAddress),`Approve USDC trading: starting valuation ${start.toLocaleString()} USDC, permanent locked-pool graduation…`);
    this.pairsScanned=undefined;this.approvedQuotes=[];await this.loadPairs(factory);
    return {hash:result.tx.hash,message:'USDC trading pair is approved. Launch-fee currency remains independently selectable.'};
  }
  async getUsdcConversionQuote(body) {
    await this.checkNetwork();await this.verifyFactory();
    const slippageBps=Math.round(Number(body.slippage??'1')*100);
    const q=await quoteUsdcConversion({Contract,provider:this.provider,dex:this.dex,usdc:this.feeUsdc,amountOut:parseUnits(body.nativeAmount,18),slippageBps});
    return {nativeAmount:formatUnits(q.amountOut,18),usdcAmount:formatUnits(q.amountIn,6),maxUsdc:formatUnits(q.maxUsdc,6),quotedAt:q.quotedAt,fee:q.fee};
  }
  async convertUsdc(body) {
    await this.checkNetwork();await this.verifyFactory();
    if(!Number.isSafeInteger(body.quotedAt)||Date.now()-body.quotedAt>60000||body.quotedAt>Date.now())throw new Error('Conversion quote expired. Get a fresh quote.');
    const q=await quoteUsdcConversion({Contract,provider:this.provider,dex:this.dex,usdc:this.feeUsdc,amountOut:parseUnits(body.nativeAmount,18),slippageBps:Math.round(Number(body.slippage??'1')*100)});
    const ceiling=parseUnits(body.maxUsdc,6);if(ceiling<=0n||q.amountIn>ceiling)throw new Error('USDC conversion price moved beyond your maximum. Get a new quote.');q.maxUsdc=ceiling;
    const coin=new Contract(this.feeUsdc,this.config.contracts.quote.abi,this.signer);
    if(await coin.balanceOf(this.address)<ceiling)throw new Error('Add at least '+body.maxUsdc+' USDC on this network. Native gas is also required.');
    if(await coin.allowance(this.address,this.dex.router)<ceiling)await this.wait(coin.approve(this.dex.router,ceiling),'Approve at most '+body.maxUsdc+' USDC for conversion only…');
    await this.checkNetwork();
    const router=new Contract(this.dex.router,CONVERSION_ROUTER_ABI,this.signer),deadline=Math.floor(nowSeconds())+120;
    const calls=conversionCalls({Contract,router:this.dex.router,dex:this.dex,usdc:this.feeUsdc,owner:this.address,quote:q});
    const gas=await router['multicall(uint256,bytes[])'].estimateGas(deadline,calls),data=await this.provider.getFeeData();
    if(await this.provider.getBalance(this.address)<gas*(data.maxFeePerGas??data.gasPrice??0n))throw new Error('Add native currency for conversion gas. USDC cannot pay gas.');
    const result=await this.wait(router['multicall(uint256,bytes[])'](deadline,calls),'Convert at most '+body.maxUsdc+' USDC into '+body.nativeAmount+' '+this.net.nativeCurrency.symbol+'. Launch or buy is a separate transaction…');
    return {hash:result.tx.hash,nativeAmount:body.nativeAmount,message:'Conversion complete. Native funds are in your wallet; continue with your launch or purchase.'};
  }
  async loadPairs(factory) {
    if (!this.dex || !this.deployment) { this.approvedQuotes = []; return; }
    const latest = await this.provider.getBlockNumber();
    this.approvedQuotes ??= [];
    const add=async address=>{
      if(this.approvedQuotes.some(a=>a.address.toLowerCase()===address.toLowerCase()))return;
      const template=await factory.approvedQuotes(address);
      if(template.adapter===ZeroAddress||template.virtualQuote<=0n)return;
      const asset=new Contract(address,['function symbol() view returns(string)','function name() view returns(string)','function decimals() view returns(uint8)','function pairKind() view returns(string)','function FAUCET_LIMIT() view returns(uint256)'],this.provider);
      const [symbol,name,decimals]=await Promise.all([asset.symbol(),asset.name(),asset.decimals()]);
      let kind='token',faucetLimit=0n;try{kind=await asset.pairKind()==='xstock'?'xstock':'token';}catch{}try{faucetLimit=await asset.FAUCET_LIMIT();}catch{}
      if (this.feeUsdc && address.toLowerCase() === this.feeUsdc.toLowerCase()) kind='usdc';
      this.approvedQuotes.push({id:address,address,kind,symbol,name,decimals:Number(decimals),virtualQuote:template.virtualQuote,test:faucetLimit>0n,faucet:faucetLimit>0n?{label:'Get '+formatUnits(faucetLimit,decimals).replace(/\.0$/,'')+' '+symbol,action:'faucet',body:{asset:address}}:null});
    };
    if(this.pairsScanned===undefined&&this.deployment.shared){
      const response=await fetch('/api/public/quotes?network='+encodeURIComponent(this.net.key),{signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw new Error('Trading pair discovery is temporarily unavailable. Refresh shortly.');
      const data=await response.json();
      if(data.factory?.toLowerCase()!==this.deployment.factory.toLowerCase()||data.chainId!==this.net.chainId||!Number.isSafeInteger(data.indexedBlock)||data.indexedBlock>latest||data.indexedBlock<this.deployment.block||!Array.isArray(data.assets)||data.assets.some(a=>!isAddress(a)))throw new Error('Trading pair index does not match this launchpad.');
      for(const address of new Set(data.assets))await add(address);
      this.pairsScanned=data.indexedBlock;
    }
    let from=this.pairsScanned===undefined?this.deployment.block:this.pairsScanned+1;
    if(latest-from>20000)throw new Error('This launchpad needs its public pair index to load trading assets.');
    for(;from<=latest;from+=100){const to=Math.min(from+99,latest);for(const event of await factory.queryFilter(factory.filters.QuoteApproved(),from,to))await add(event.args.asset);this.pairsScanned=to;}
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
  /**
   * Sends several calls with as few wallet confirmations as possible. A wallet that supports atomic batches
   * (EIP-5792) gets ONE confirmation for all of them; otherwise each call is sent in order. Callers pass only
   * calls that are safe when they have nothing to do, so an all-or-nothing batch never fails on an empty step.
   * `calls` are {to, data, value?, label}. Returns {tx:{hash}, receipt} for the last transaction.
   */
  /** True when the connected wallet advertises atomic batches on this chain (checked once per network). */
  async canBatch() {
    const key = `${this.address}:${this.net?.chainId}`;
    if (this.batchSupport?.key !== key) this.batchSupport = { key, value: await supportsAtomicLaunch(args => this.eth.request(args), this.address, this.net.chainId) };
    return this.batchSupport.value;
  }
  async sendCalls(calls, message) {
    if (!calls.length) throw new Error('Nothing to send.');
    const request = args => this.eth.request(args);
    if (calls.length > 1 && await this.canBatch()) {
      await this.checkNetwork();
      this.onProgress(`${message} One confirmation covers all ${calls.length} steps.`);
      const sent = await withWalletTimeout(request(atomicBatchRequest({ from: this.address, chainId: this.net.chainId, calls, id: crypto.randomUUID() })), this.walletName);
      if (typeof sent?.id !== 'string' || !sent.id) throw new Error('Wallet did not return a batch ID. Check it before retrying.');
      this.onProgress('Batch submitted. Waiting for confirmation…');
      const receipts = await waitAtomicBatch(request, sent.id, this.net.chainId);
      const hash = receipts.at(-1).transactionHash, receipt = await this.provider.getTransactionReceipt(hash);
      if (!receipt || receipt.status !== 1) throw new Error('The batch receipt is not available yet. Check your wallet before retrying.');
      return { tx: { hash }, receipt };
    }
    let result;
    for (const [i, c] of calls.entries()) result = await this.wait(this.signer.sendTransaction({ to: c.to, data: c.data, value: c.value ?? 0n }), calls.length > 1 ? `Step ${i + 1} of ${calls.length}: ${c.label ?? message}` : (c.label ?? message));
    return result;
  }
  async approvePayment(coin,spender,amount,message,feeInUsdc) {
    const gas=await coin.approve.estimateGas(spender,amount),fees=await this.provider.getFeeData();
    const error=nativeFundingError({balance:await this.provider.getBalance(this.address),gasCost:gas*(fees.maxFeePerGas??fees.gasPrice??0n),native:this.net.nativeCurrency.symbol,network:this.net.name,feeInUsdc,stage:'approval'});
    if(error)throw new Error(error);
    return this.wait(coin.approve(spender,amount),message);
  }
  async confirmLaunchBatch(key,record){
    const request=args=>this.eth.request(args),factory=this.factoryContract();
    try{
      const receipts=await waitAtomicLaunch(request,record.id,this.net.chainId);
      const receipt=receipts.find(r=>r.logs.some(l=>l.address.toLowerCase()===factory.target.toLowerCase()&&(()=>{try{const event=factory.interface.parseLog(l);return event?.name==='Launched'&&event.args.creator.toLowerCase()===this.address.toLowerCase();}catch{return false;}})()));
      if(!receipt)throw new Error('Confirmed batch has no creator launch event. Check your wallet before retrying.');
      const actual=await this.provider.getTransactionReceipt(receipt.transactionHash);
      if(!actual||actual.status!==1)throw new Error('Launch receipt is not available yet. Check your wallet before retrying.');
      // A bundler receipt may contain other users' events. Keep only this wallet batch's verified logs.
      const logs=receipt.logs.filter(log=>actual.logs.some(l=>l.address.toLowerCase()===log.address.toLowerCase()&&l.data===log.data&&JSON.stringify(l.topics)===JSON.stringify(log.topics)));
      if(logs.length!==receipt.logs.length)throw new Error('Wallet batch logs do not match the chain receipt.');
      localStorage.removeItem(key);return {tx:{hash:receipt.transactionHash},receipt:{...actual,logs}};
    }catch(error){if(error.batchFailed)localStorage.removeItem(key);throw error;}
  }
  async deploy() {
    await this.checkNetwork();
    if (this.deployment && !this.needsMetadataUpgrade && !this.modelUpgradeAvailable && !this.feeFixUpgradeAvailable && !this.launchUpgradeAvailable) throw new Error(`This ${this.net.name} launchpad is already set up. Use it for your launches.`);
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
    // Model 10 terms are fixed at deployment: $50 test-sized curves on testnets, $5,000 on mainnet (enforced).
    const terms=this.dex?assertDeploymentTerms(this.net,{startFdvUsd:startFdvUsdFor(this.net),graduationGrace:GRADUATION_GRACE_SECONDS}):null;
    this.onProgress(`Confirm the launchpad deployment. Oracle pricing will enforce the $10 launch fee and $${(terms?.startFdvUsd??5000).toLocaleString()} starting FDV…`);
    const contract = await new ContractFactory(artifact.abi, artifact.bytecode, this.signer).deploy(this.address, ...(this.dex?[migrationAdapter,terms.startFdvUsd,terms.graduationGrace]:[0n,1n]));
    this.onProgress('Deployment submitted. Waiting for confirmation…');
    await contract.waitForDeployment();
    const receipt = await contract.deploymentTransaction().wait();
    const record = { factory: await contract.getAddress(), block: receipt.blockNumber, hash: receipt.hash, migrationAdapter, model: modelOf(this.net.chainId, !!this.dex), metadataVersion:this.dex?1:undefined,feeAccountingVersion:this.dex?Number(await contract.FEE_ACCOUNTING_VERSION()):undefined,launchFeaturesVersion:this.dex&&this.config.contracts.atomicFactory?1:undefined };
    if(previousDeployment && !write('elpida:previous-factory:'+this.net.chainId+':'+previousDeployment.factory,previousDeployment))throw new Error('Factory deployed, but previous deployment could not be archived. Save the new factory '+record.factory+' manually.');
    this.launches.clear(); this.scannedBlock = undefined; this.factoryStartFdvUsd = undefined;this.pairsScanned=undefined;this.approvedQuotes=[];this.nativeVirtualQuote=undefined;this.launchFee=undefined;
    if (!write(deploymentKey(this.net.chainId, !!this.dex), record)) throw new Error(`Deployed, but this browser blocks storage. Save factory ${record.factory} (block ${record.block}) in packages/core/networks.mjs.`);
    await this.wait(contract.configureUsdPricing(this.oracle.feed,this.oracle.maxAge,this.oracle.usdc??ZeroAddress),'Activate verified USD pricing. This fixes the oracle and enables launches…');
    if(this.dex&&this.oracle.usdc&&this.oracle.usdc!==ZeroAddress)await this.setupUsdcPair(contract);
    this.needsMetadataUpgrade=false;this.feeAccountingVersion=record.feeAccountingVersion;
    return { hash: receipt.hash, message: `Your ${this.net.name} launchpad is deployed, using the on-chain USD oracle for the $10 launch fee.${this.dex&&this.oracle.usdc?' USDC trading is configured for all creators.':''}` };
  }
  async checkFeeAccounting(factory=this.factoryContract()){
    this.feeAccountingVersion=undefined;
    if(this.net.key==='base-sepolia'&&this.model===DEX_MODEL){try{this.feeAccountingVersion=Number(await new Contract(factory.target,['function FEE_ACCOUNTING_VERSION() view returns(uint256)'],this.provider).FEE_ACCOUNTING_VERSION());}catch(error){if(error.code==='CALL_EXCEPTION'&&(!error.data||error.data==='0x'))this.feeAccountingVersion=0;else throw error;}}
    return this.feeAccountingVersion;
  }
  async verifyFactory({launch=false}={}) {
    const factory=this.factoryContract(),version=Number(await factory.MODEL_VERSION());
    await this.checkFeeAccounting(factory);
    await this.checkLaunchFeatures(factory);
    if(version!==MODEL_VERSIONS[this.model]||(this.dex?!isDexModel(this.model):this.model!==BETA_MODEL))throw new Error('This launchpad needs the verified USD version. Set up a new launchpad from Network and funds.');
    if(this.model===DEX_MODEL&&!this.factoryStartFdvUsd)this.factoryStartFdvUsd=Number(await factory.startFdvUsd());
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
    const result=await this.wait(factory.configureUsdPricing(this.oracle.feed,this.oracle.maxAge,this.oracle.usdc??ZeroAddress),'Activate verified USD pricing…');
    if(this.dex&&this.oracle.usdc&&this.oracle.usdc!==ZeroAddress)await this.setupUsdcPair(factory);
    return result;
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
      item = {...item,metadata:await readMetadataCache(metadataKey(this.net.chainId,item.factory??this.deployment.factory,item.address)) ?? item.metadata ?? {}};
      if(item.metadataURI){try{const response=await fetch('/api/metadata/resolve?uri='+encodeURIComponent(item.metadataURI));if(!response.ok)throw new Error('unavailable');item.metadata=normalizeMetadata(await response.json());item.metadataStatus='published';}catch{item.metadataStatus='unavailable';}}
      if(item.tax)return readTaxMarket(this,item);
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
      // Model 10: anti-snipe schedule, partial-fill final buys and the graduation escape hatch.
      let v10 = {};
      if (this.modelOf(item) === DEX_MODEL) { const [launchedAt, completedAt, grace] = await Promise.all([curve.launchedAt(), curve.completedAt(), curve.graduationGrace()]); v10 = { launchedAt: Number(launchedAt), partialFill: true, feeSchedule: { base: BASE_FEE_BPS, start: SNIPE_START_BPS, window: SNIPE_WINDOW_SECONDS }, reopenableAt: complete && !graduated && completedAt > 0n ? Number(completedAt + grace) : null }; }
      return { ...item, ...v10, pool, graduated, complete, liquidityLocked: graduated, quoteSymbol: this.qsym(item), quoteDecimals: d, spotPrice: Number(formatUnits(priceQ,d)) / Number(formatUnits(priceT,18)), circulatingSupply:formatUnits(circulation,18),saleCap: formatUnits(await curve.SALE_CAP(),18), remainingBuy: complete ? '0' : formatUnits(await curve.completionQuote(),d), remainingBase: complete || this.modelOf(item) !== DEX_MODEL ? undefined : formatUnits(await curve.remainingAtBaseFee(),d), name, symbol, reward, reserve: formatUnits(reserve, d), sold: formatUnits(sold, 18), supply: formatUnits(supply, 18), balance: formatUnits(held, 18), protocolFees: formatUnits(protocol+p, d), creatorFees: formatUnits(creator+c, d) };
    }));
    const pairBalances = {};
    for (const a of this.approvedQuotes ?? []) { try { pairBalances[a.id] = formatUnits(await new Contract(a.address, this.config.contracts.quote.abi, this.provider).balanceOf(this.address), a.decimals); } catch {} }
    const treasury = await factory.treasury();
    // Live factory pricing and freshness are authoritative for creation.
    const pricing = { verified:true,price:this.price,launchFee: this.launchFee===undefined?'Unavailable':formatUnits(this.launchFee, 18), startFdv: this.nativeVirtualQuote===undefined?'Unavailable':formatUnits(this.model===DEX_MODEL?this.nativeVirtualQuote * 9n / 10n:this.nativeVirtualQuote * 15n / 16n, 18), symbol: native, matches:true, owner: treasury.toLowerCase() === this.address.toLowerCase() };
    return { wallet: this.address, balance, balanceSymbol: native, pairBalances, nativeBalance: balance, nativeSymbol: native, wrappedNativeBalance:this.dex?formatUnits(await new Contract(this.dex.weth,this.config.contracts.quote.abi,this.provider).balanceOf(this.address),18):undefined, tokens, activity: [], pricing, treasuryBalance: formatUnits(await this.provider.getBalance(treasury), 18) };
  }
  async publicTokens(){
    const response=await fetch('/api/public/tokens?network='+encodeURIComponent(this.net.key));if(!response.ok)throw new Error('Public token discovery is unavailable.');
    const entries=await response.json();return Promise.all(entries.map(async item=>({...item,metadata:this.deployment&&!item.metadataURI?await readMetadataCache(metadataKey(this.net.chainId,item.factory??this.deployment.factory,item.address))??item.metadata:item.metadata})));
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
    const params={tokenIn:side==='buy'?asset:item.address,tokenOut:side==='buy'?item.address:asset,fee:this.dex.fee??10000,recipient:this.address,amountIn:input,amountOutMinimum:minimum};
    // An exact approval (only when needed) and the swap go out together: one confirmation on wallets that batch.
    const steps=[];
    if(side==='sell'||item.pair!=='native'){const payment=new Contract(params.tokenIn,this.config.contracts.quote.abi,this.signer);if(await payment.allowance(this.address,router.target)<input)steps.push({to:payment.target,data:payment.interface.encodeFunctionData('approve',[router.target,input]),label:'Approve exactly this trade amount…'});}
    // Deadline-checked swap for this DEX's router layout (Uniswap SwapRouter02 or PancakeSwap's v3 SwapRouter).
    const deadline=BigInt((await this.provider.getBlock('latest')).timestamp+300);
    const data=swapCalldata(Interface,this.dex.routerVersion??2,router.target,params,{deadline,unwrapTo:unwrap?this.address:null});
    steps.push({to:router.target,data,value:side==='buy'&&item.pair==='native'?input:0n,label:`Confirm the ${this.dex.name??'DEX'} trade…`});
    return this.sendCalls(steps,`Confirm the ${this.dex.name??'DEX'} trade.`);
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
    if(item.tax)return quoteTaxMarket(this,item,side,amount);
    const curve = await this.market(item);
    const d = this.qd(item);
    if(this.dex&&await new Contract(item.curve,this.artifacts.curve.abi,this.provider).pool()!==ZeroAddress){const input=parseUnits(amount,side==='buy'?d:18),out=await this.dexQuote(item,side,input);return {out:formatUnits(out,side==='buy'?18:d),fee:formatUnits(input/100n,side==='buy'?d:18),feeSymbol:side==='buy'?this.qsym(item):await new Contract(item.address,this.config.contracts.token.abi,this.provider).symbol()};}
    if (side === 'buy' && this.modelOf(item) === DEX_MODEL) {
      // Model 10 partially fills a buy larger than the rest of the curve and charges only what it uses.
      const input = parseUnits(amount, d), [out, fee, spent] = await curve.previewBuy(input);
      return { out: formatUnits(out, 18), fee: formatUnits(fee, d), spend: formatUnits(spent, d), completesCurve: spent < input, ...await this.feeSchedule(item) };
    }
    const [out, fee] = side === 'buy' ? await curve.quoteBuy(parseUnits(amount, d)) : await curve.quoteSell(parseUnits(amount, 18));
    return { out: formatUnits(out, side === 'buy' ? 18 : d), fee: formatUnits(fee, d), ...await this.feeSchedule(item) };
  }
  /** Model 10 anti-snipe schedule for the trade panel; legacy curves always charge the base fee. */
  async feeSchedule(item) {
    if (this.modelOf(item) !== DEX_MODEL) return { feeBps: BASE_FEE_BPS, antiSnipeActive: false };
    const curve = new Contract(item.curve, this.artifacts.curve.abi, this.provider);
    const [feeBps, launchedAt] = await Promise.all([curve.currentFeeBps(), curve.launchedAt()]);
    return { feeBps: Number(feeBps), launchedAt: Number(launchedAt), antiSnipeActive: Number(feeBps) > BASE_FEE_BPS };
  }
  async transact(action, body) {
    await this.checkNetwork();
    if(action==='launch'&&body.tax)return launchPublicTax(this,body);
    const factory = (await this.verifyFactory()).connect(this.signer);
    let result;
    if (action === 'setup-pairs') return this.setupTestPairs();
    if (action === 'setup-usdc-pair') return this.setupUsdcPair();
    if (action === 'convert-usdc') return this.convertUsdc(body);
    if (action === 'apply-pricing') return this.applyPricing();
    if (action === 'faucet' && body?.asset) {
      const a = (this.approvedQuotes ?? []).find(x => x.address.toLowerCase() === String(body.asset).toLowerCase() && x.test);
      if (!a) throw new Error('That asset has no test faucet.');
      const c = new Contract(a.address, ['function faucet(uint256)', 'function FAUCET_LIMIT() view returns(uint256)'], this.signer), limit = await c.FAUCET_LIMIT();
      result = await this.wait(c.faucet(limit), `Confirm the free ${a.symbol} test mint in your wallet…`);
      return { hash: result.tx.hash, message: `Added ${formatUnits(limit, a.decimals)} ${a.symbol} (test asset, no value).` };
    }
    if (action === 'faucet') throw new Error(`Get test ${this.net.nativeCurrency.symbol} from the network faucet linked in Network and funds.`);
    let metadataSaved = true, metadataPublished = false, launchedToken, metadataStorage;
    if (action === 'launch') {
      const pendingKey='elpida:launch-batch:'+this.net.chainId+':'+this.address.toLowerCase(),pending=localStorage.getItem(pendingKey);
      if(pending){
        const record=JSON.parse(pending);this.onProgress('Checking your previous launch batch. No new launch will be submitted…');
        const completed=await this.confirmLaunchBatch(pendingKey,record),event=completed.receipt.logs.map(l=>{try{return factory.interface.parseLog(l);}catch{return null;}}).find(l=>l?.name==='Launched'&&l.args.creator.toLowerCase()===this.address.toLowerCase());
        const saved=event&&await writeMetadataCache(metadataKey(this.net.chainId,this.deployment.factory,event.args.token),record.metadata??{});
        return {hash:completed.tx.hash,token:event?.args.token,metadataSaved:!!saved,metadataPublished:!!record.uri,metadataStorage:record.storage,message:'Your previous launch is confirmed. No duplicate token was created.'};
      }
      if(!['native','usdc'].includes(body.feeCurrency??'native'))throw new Error('Choose native currency or USDC for the launch fee.');
      await this.verifyFactory({launch:true});
      const details = normalizeMetadata(body);
      const kind = body.pair ?? 'native';
      if (!['native','usdc','xstock','token'].includes(kind)) throw new Error('Choose a trading pair.');
      const nativePair = kind === 'native', paired = !nativePair;
      const asset = paired ? (this.approvedQuotes ?? []).find(a => a.kind === kind && a.address.toLowerCase() === String(body.quoteAsset ?? '').toLowerCase()) : null;
      if (paired && !asset) throw new Error(this.pairOptions()[kind].unavailable ?? 'Choose an approved asset for this pair.');
      if(body.tax)throw new Error('Public tax launches need a registered V2 tax factory. Use the local DEX rehearsal until that deployment is verified. Nothing was submitted.');
      const firstBuy = parseUnits(body.firstBuy || '0', nativePair ? 18 : asset.decimals);
      const name = body.name.trim(), symbol = body.symbol.trim().toUpperCase();
      if (firstBuy < 0n || !name || name.length > 40 || !/^[A-Z0-9]{1,10}$/.test(symbol)) throw new Error('Check the token name, symbol and creator buy.');
      if(firstBuy===0n){
        let supported=false;
        try{supported=await new Contract(this.deployment.factory,['function OPTIONAL_CREATOR_BUY_VERSION() view returns(uint256)'],this.provider).OPTIONAL_CREATOR_BUY_VERSION()>=1n;}catch(error){if(error.code!=='CALL_EXCEPTION')throw error;}
        if(!supported)throw new Error('This deployed factory requires an upgrade before zero-buy launches are available. Nothing was submitted.');
      }
      const reward = body.reward || this.address;
      if (!isAddress(reward) || reward === ZeroAddress) throw new Error('Enter a valid creator reward wallet.');
      const net = firstBuy - firstBuy * 125n / 10000n;
      const virtualQuote = paired ? asset.virtualQuote : await factory.nativeVirtualQuote();
      const out = await factory.VIRTUAL_TOKEN() * net / (virtualQuote + net);
      // Model 10 partially fills a first buy larger than the curve; it then receives exactly the sale cap.
      const cappedOut = this.model === DEX_MODEL && out > SALE_CAP ? SALE_CAP : out;
      // Native fees include a refundable 1% cap; USDC approvals are exactly ten units.
      const inUsdc=body.feeCurrency==='usdc';
      if(inUsdc && (await factory.treasury()).toLowerCase()===this.address.toLowerCase())throw new Error('This wallet is also the launchpad fee recipient. The contract cannot verify a USDC fee paid to the same wallet. Choose native payment for this test, or launch from a different funded wallet to test USDC fee collection. No launch was submitted.');
      const fee = await factory.launchFee(), value = (inUsdc?0n:(fee*101n+99n)/100n) + (nativePair ? firstBuy : 0n), native = this.net.nativeCurrency.symbol;
      const fundingError=nativeFundingError({balance:await this.provider.getBalance(this.address),value,native,network:this.net.name,feeInUsdc:inUsdc});
      if(fundingError)throw new Error(fundingError);
      const pairToken = paired ? new Contract(asset.address, this.config.contracts.quote.abi, this.signer) : null;
      if (paired && await pairToken.balanceOf(this.address) < firstBuy) throw new Error(`You need ${formatUnits(firstBuy, asset.decimals)} ${asset.symbol} for the first buy.${asset.test ? ' Use its test faucet in Network and funds.' : ''}`);
      let published;
      if(publishForLaunch({chain:this.net.key,publicEnabled:this.config.metadataPublishing?.publicEnabled,metadataSupported:!this.needsMetadataUpgrade,publiclyIndexed:!!this.deployment?.shared&&this.model===DEX_MODEL})){
        this.onProgress('Preparing public token details for the launch transaction…');
        const payload=JSON.stringify({network:this.net.key,name,symbol,...details}),proof=await prepareUploadProof(payload);
        const response=await fetch('/api/metadata/stage',{method:'POST',headers:{'Content-Type':'application/json','X-Elpida-Token':this.config.csrf,...proof},body:payload});
        published=await response.json();if(!response.ok)throw new Error(published.error??'Metadata publishing failed.');
        if(!/^ipfs:\/\//.test(published.uri)||!['public-ipfs','elpida-hosted'].includes(published.storage))throw new Error('Token details were not staged safely. No launch was submitted.');
        metadataStorage=published.storage;
        await this.checkNetwork();
      }
      const sharedUsdc = inUsdc && paired && asset.address.toLowerCase()===this.feeUsdc?.toLowerCase();
      const approvalCalls=[],batchKey='elpida:launch-batch:'+this.net.chainId+':'+this.address.toLowerCase();
      const batchRequest=args=>this.eth.request(args);
      const atomic=await supportsAtomicLaunch(batchRequest,this.address,this.net.chainId);
      const approve=async(coin,amount,message)=>{if(atomic)approvalCalls.push({to:coin.target,data:coin.interface.encodeFunctionData('approve',[factory.target,amount]),value:'0x0'});else await this.approvePayment(coin,factory.target,amount,message,inUsdc);};
      if (paired && !sharedUsdc && await pairToken.allowance(this.address, await factory.getAddress()) < firstBuy) await approve(pairToken,firstBuy,`Approve the ${asset.symbol} first buy…`);
      if(inUsdc){
        if(!this.feeUsdc||this.feeUsdc===ZeroAddress)throw new Error('USDC fee payment is unavailable on this network.');
        const coin=new Contract(this.feeUsdc,this.config.contracts.quote.abi,this.signer);
        const totalUsdc=10_000_000n+(sharedUsdc?firstBuy:0n);
        if(await coin.balanceOf(this.address)<totalUsdc)throw new Error('Add '+formatUnits(totalUsdc,6)+' USDC on this network for the launch fee'+(sharedUsdc?' and first purchase':'')+'. Native gas is separate.');
        if(await coin.allowance(this.address,factory.target)<totalUsdc)await approve(coin,totalUsdc,'Approve exactly '+formatUnits(totalUsdc,6)+' USDC for the launch fee'+(sharedUsdc?' and first purchase':'')+'…');
      }
      await this.oraclePrice();await this.checkNetwork();
      const args=[name,symbol,asset?.address??ZeroAddress,firstBuy,cappedOut*9950n/10000n,reward,published?.uri??'',inUsdc];
      // A separate estimate cannot simulate allowances that only exist inside the atomic batch.
      // The wallet must simulate the entire batch; ordinary launches retain the RPC estimate.
      const gas=approvalCalls.length?null:await factory.launchWithPayment.estimateGas(...args,{value});
      const gasPrice=(await this.provider.getFeeData()).maxFeePerGas??(await this.provider.getFeeData()).gasPrice??0n;
      const launchGasError=nativeFundingError({balance:await this.provider.getBalance(this.address),value,gasCost:gas===null?0n:gas*gasPrice,native,network:this.net.name,feeInUsdc:inUsdc});
      if(launchGasError)throw new Error(launchGasError);
      const confirmation='Confirm the '+(inUsdc?'10 USDC':'$10 equivalent native')+' launch fee, first purchase '+body.firstBuy+' '+this.qsym({pair:kind,quoteSymbol:asset?.symbol})+(gas===null?' and wallet-estimated gas.':' and estimated gas '+formatUnits(gas*gasPrice,18)+' '+native+'.')+' '+(inUsdc?'USDC covers the launch fee; native currency covers gas.':'Native fee cap includes 1%; unused fee is refunded.');
      if(approvalCalls.length){
        const id=crypto.randomUUID(),calls=[...approvalCalls,{to:factory.target,data:factory.interface.encodeFunctionData('launchWithPayment',args),value:'0x'+value.toString(16)}];
        const record={id,chain:this.net.chainId,created:Date.now(),metadata:published?.metadata??details,uri:published?.uri,storage:metadataStorage};
        localStorage.setItem(batchKey,JSON.stringify(record));
        this.onProgress('Confirm one atomic launch in your wallet: exact payment approval, token details, creation and first purchase. '+confirmation);
        try{const sent=await withWalletTimeout(batchRequest({method:'wallet_sendCalls',params:[{version:'2.0.0',id,from:this.address,chainId:'0x'+BigInt(this.net.chainId).toString(16),atomicRequired:true,calls}]}),this.walletName);
          if(typeof sent?.id!=='string'||!sent.id)throw new Error('Wallet did not return a launch batch ID. Check it before retrying.');
          record.id=sent.id;localStorage.setItem(batchKey,JSON.stringify(record));
          this.onProgress('Launch batch submitted. Waiting for confirmation…');
          result=await this.confirmLaunchBatch(batchKey,record);
        }catch(error){if(error.code===4001||error.code==='ACTION_REJECTED')localStorage.removeItem(batchKey);throw error;}
      }else result=await this.wait(factory.launchWithPayment(...args,{value}),confirmation);
      const event = result.receipt.logs.map(log => {try{return factory.interface.parseLog(log);}catch{return null;}}).find(log => log?.name === 'Launched');
      launchedToken=event?.args.token;
      metadataSaved = !!event && await writeMetadataCache(metadataKey(this.net.chainId,this.deployment.factory,event.args.token),published?.metadata??details);
      if(published){metadataSaved=true;metadataPublished=true;}
    } else {
      const item = this.launches.get(body.token.toLowerCase());
      if (!item) throw new Error('Token not found.');
      if(item.tax){const result=await transactTaxMarket(this,item,action,body);return {hash:result.tx.hash,message:'Tax market transaction confirmed.'};}
      const curve = await this.market(item, this.signer);
      const original = new Contract(item.curve, this.artifacts.curve.abi, this.signer);
      if (action === 'reopen') { if (this.modelOf(item) !== DEX_MODEL) throw new Error('Only model 10 curves can be reopened.'); result = await this.wait(original.reopen(), 'Confirm reopening the curve for trading…'); }
      else if (action === 'graduate') result = await this.wait(original.graduate(), this.dex?'Confirm graduation into Uniswap v3…':'Confirm graduation into the locked test pool…');
      else if (action === 'withdraw') {
        // Every step is zero-safe on-chain (withdrawFees, collectFees and claim all succeed with nothing owed), so a
        // batching wallet gets them all in ONE confirmation. Other wallets get only the steps that will move money.
        const steps = [], add = (contract, fn, label) => steps.push({ to: contract.target, data: contract.interface.encodeFunctionData(fn.name, fn.args), label });
        const batch = await this.canBatch();
        if ((await original.protocolFees()) + (await original.creatorFees()) > 0n) add(original, { name: 'withdrawFees', args: [] }, 'Claim bonding-curve fees…');
        if (await original.pool() !== ZeroAddress) {
          if (this.dex) {
            const locker = new Contract(await original.locker(), this.config.contracts.locker.abi, this.signer);
            const splitter = new Contract(await original.feeSplitter(), this.config.contracts.splitter.abi, this.signer);
            // What a collect would move right now (read-only dry run); unknown counts as "something".
            let collected = null; try { const [a0, a1] = await locker.collectFees.staticCall(); collected = new Map([[(await locker.token0()).toLowerCase(), a0], [(await locker.token1()).toLowerCase(), a1]]); } catch { collected = null; }
            const willCollect = collected === null || [...collected.values()].some(v => v > 0n);
            if (batch || willCollect) add(locker, { name: 'collectFees', args: [] }, 'Collect Uniswap position fees…');
            const recipients = [...new Set([(await this.factoryOf(item).treasury()).toLowerCase(), (await original.creatorRewardVault()).toLowerCase()])];
            for (const asset of [item.address, this.qaddr(item)]) {
              const incoming = collected === null ? 1n : (collected.get(String(asset).toLowerCase()) ?? 0n);
              for (const recipient of recipients) if (batch ? true : (await splitter.claimable(asset, recipient)) > 0n || incoming > 1n) add(splitter, { name: 'claim', args: [asset, recipient] }, 'Pay fees to their fixed recipient…');
            }
          } else add(curve, { name: 'withdrawFees', args: [] }, 'Claim locked-pool fees…');
        }
        if (!steps.length) throw new Error('Nothing to claim yet. Fees appear here once the curve or the pool has traded.');
        result = await this.sendCalls(steps, 'Claim fees to their fixed recipients.');
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
        const steps = [];
        if (!(action === 'buy' && item.pair === 'native') && await payment.allowance(this.address, marketAddress) < input) steps.push({ to: payment.target, data: payment.interface.encodeFunctionData('approve', [marketAddress, input]), label: 'Approve exactly this trade amount…' });
        const minimum = out * (10000n - BigInt(Math.round(percent * 100))) / 10000n;
        steps.push({ to: marketAddress, data: action === 'buy' ? curve.interface.encodeFunctionData('buy', [input, minimum]) : curve.interface.encodeFunctionData('sell', [input, minimum]), value: action === 'buy' && item.pair === 'native' ? input : 0n, label: 'Confirm the trade in your wallet…' });
        result = await this.sendCalls(steps, 'Confirm the trade.');
      }
    }
    return { hash: result.tx.hash, token:launchedToken, metadataSaved, metadataPublished, metadataStorage, message: action === 'launch' ? `Your token is live on ${this.net.name}.${metadataPublished ? (metadataStorage==='public-ipfs'?' Metadata pinned to public IPFS and linked on-chain.':' Metadata hosted by Elpida and linked on-chain; public IPFS pinning is not configured.') : metadataSaved ? ' Metadata saved in this browser.' : ' Browser metadata storage failed; keep a copy of your token details.'}` : action === 'withdraw' ? 'Fees distributed to their recipient wallets.' : `Trade confirmed on ${this.net.name}.` };
  }
}
