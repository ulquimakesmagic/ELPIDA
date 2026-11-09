import {prepareTestLiquidity,testLiquidityCalls,TEST_MANAGER_ABI} from './test-stock-liquidity.mjs';
import {verifyNativeRouter,findCurveNonce} from './native-trade-router.mjs';
import { nowSeconds } from './clock.mjs';
import {launchPublicTax,readTaxMarket,quoteTaxMarket,transactTaxMarket} from './tax-wallet.mjs';
import { isV4Token, v4Available, v4Deployment, deployTestPoolManager, v4Quote, v4Trade, v4WithdrawFees, v4TokenState } from './v4-launchpad.mjs';
import { V4_MODEL } from '/v4-model.mjs';
import { V2_MODEL } from '/v2-economics.mjs';
import { deployV2, launchV2, approveV2Stock } from './v2-launchpad.mjs';
import { PacedJsonRpcProvider } from '/paced-rpc.mjs';
import { BrowserProvider, JsonRpcProvider, FetchRequest, Contract, ContractFactory, Interface, parseUnits, formatUnits, isAddress, getAddress, getCreateAddress, ZeroAddress } from '/vendor/ethers.js';
import { routerAbi, swapCalldata } from '/dex-router.mjs';

import { normalizeMetadata, withSavedMetadata } from './metadata.mjs';
import { readMetadataCache, writeMetadataCache } from './metadata-cache.mjs';
import {launchDetailsError} from './launch-capabilities.mjs';
import { EVM_TEST_PAIRS } from '/pairs.mjs';
import { testStockHold, MARKET_STATUS } from './test-stock.mjs';
import { DEX_MODEL, LEGACY_DEX_MODEL, BETA_MODEL, MODEL_VERSIONS, isDexModel, curveShape, startFdvUsdFor, assertDeploymentTerms, usdQuoteTemplate, GRADUATION_GRACE_SECONDS, BASE_FEE_BPS, SNIPE_START_BPS, SNIPE_WINDOW_SECONDS, SALE_CAP } from '/curve-model.mjs';
import { quoteUsdcConversion, quoteNativePairConversion, conversionCalls, CONVERSION_ROUTER_ABI } from './usdc-conversion.mjs';
import { conversionKey, convertForLaunch, pendingConversion } from './launch-conversion.mjs';
import {nativeFundingError} from './payment-errors.mjs';
import {supportsAtomicLaunch,waitAtomicLaunch,waitAtomicBatch,atomicBatchRequest} from './wallet-batch.mjs';
import { PublicRpcSigner, resumeSetupDeployment } from './public-rpc-signer.mjs';
import { MULTICALL3, multicallData, approvalFor, launchApproval, waitForAllowance } from './one-confirmation.mjs';
import { readSafe, treasuryError, safeBatch } from './safe-batch.mjs';
import { stockApprovalGate, stockVirtualQuote, freshFeedPrice } from './stock-approval.mjs';
import { graduationSqrtPriceX96, blockedByPool, tokenCheaperInPool } from './graduation-unblock.mjs';
import {prepareUploadProof} from './upload-proof.mjs';

// EIP-6963: every installed EVM wallet announces itself, so Elpida can use the one the person picks
// instead of whichever extension last claimed window.ethereum (Phantom, Coinbase and MetaMask all try).
import { injectedEvmWallets, walletsChanged } from './wallet-discovery.mjs';
const announced = new Map();
if (typeof window !== 'undefined') {
  window.addEventListener('eip6963:announceProvider', event => { const d = event.detail; if (!d?.info?.rdns || !d.provider) return; const fresh = announced.get(d.info.rdns)?.provider !== d.provider; announced.set(d.info.rdns, d); if (fresh) walletsChanged(); });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}
const EVM_CHOICE = 'elpida:evm-wallet';
/** Asks every installed EVM wallet to announce itself again (one that loaded late answers now). */
export function requestEvmWallets() { if (typeof window !== 'undefined') window.dispatchEvent(new Event('eip6963:requestProvider')); }
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
  // The wallet's RPC lagged a block and reused a confirmed nonce: nothing was sent, and a moment later it is fine.
  if (/replacement (transaction )?underpriced|nonce too low/i.test(String(error?.message ?? error?.info?.error?.message ?? ''))) return `${name} tried to reuse the last transaction's number because its network connection is a block behind. Nothing was sent. Wait a minute, then press the button again: finished steps are kept.`;
  return null;
}
const metadataKey = (chain, factory, token) => `elpida:metadata:${chain}:${factory.toLowerCase()}:${token.toLowerCase()}`;
// New deployments: model 10 (DEX, Base Sepolia) and model 8 (basic). A pinned model 9 team deployment stays usable.
// Model 10 (DEX graduation) runs on every network with an enabled public DEX; the rest keep the beta curve.
const modelOf = (chainId, dex = false) => chainId===84532||dex?DEX_MODEL:BETA_MODEL;
/** How long a replaced RPC connection stays open so requests already sent on it can finish. */
export const RETIRE_AFTER_MS = 60000;
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
    if(saved?.reviewFixesVersion===1&&saved.model===DEX_MODEL&&(shared?.reviewFixesVersion??0)<1)return saved;
    if(saved?.partnerTiersVersion===1&&saved.model===DEX_MODEL&&(shared?.partnerTiersVersion??0)<1)return saved;
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
  /** True when this network's launchpad predates the partner-tier registry (docs/DESIGN_PARTNER_TIERS.md). */
  get partnerUpgradeAvailable(){return !!(this.model===DEX_MODEL&&this.deployment&&this.launchFeaturesChecked&&this.partnerTiersVersion===0&&!this.launchUpgradeAvailable&&!this.feeFixUpgradeAvailable);}
  /** True when this network's launchpad predates the 1 November review fixes (buyback price guard, graduation dust). */
  get reviewUpgradeAvailable(){return !!(this.model===DEX_MODEL&&this.deployment&&this.launchFeaturesChecked&&this.partnerTiersVersion>=1&&this.reviewFixesVersion===0&&!this.launchUpgradeAvailable&&!this.feeFixUpgradeAvailable);}
  get launchUpgradeAvailable(){return this.net.key==='base-sepolia'&&this.model===DEX_MODEL&&!!this.deployment&&this.launchFeaturesChecked&&!this.automaticGraduationSupported;}
  async checkLaunchFeatures(factory=this.factoryContract()){
    if(this.launchFeaturesChecked&&this._launchFeaturesFactory===factory.target)return;
    this.launchFeaturesChecked=false;this.automaticGraduationSupported=false;this.partnerTiersVersion=undefined;this.reviewFixesVersion=undefined;
    if(this.model===DEX_MODEL){
      try{this.partnerTiersVersion=Number(await new Contract(factory.target,['function PARTNER_TIERS_VERSION() pure returns(uint256)'],this.provider).PARTNER_TIERS_VERSION());}
      catch(error){if(error.code!=='CALL_EXCEPTION'||(error.data&&error.data!=='0x'))throw error;this.partnerTiersVersion=0;}
      try{this.reviewFixesVersion=Number(await new Contract(factory.target,['function REVIEW_FIXES_VERSION() pure returns(uint256)'],this.provider).REVIEW_FIXES_VERSION());}
      catch(error){if(error.code!=='CALL_EXCEPTION'||(error.data&&error.data!=='0x'))throw error;this.reviewFixesVersion=0;}
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
    // Reconnecting (a second click, a slow wallet, returning to the tab) must not cancel reads still in flight: the
    // read connection is kept while the network is the same, and a replaced one is closed only after its requests
    // have had time to finish. Destroying it at once showed "provider destroyed; cancelled request" (ITACHI, 24 Oct).
    const retire = old => { if (old) setTimeout(() => { try { old.destroy(); } catch {} }, this.retireAfterMs ?? RETIRE_AFTER_MS); };
    retire(this.signerProvider);
    this.signerProvider = new BrowserProvider(eth, undefined, { cacheTimeout: -1 });
    // Wallet RPCs often restrict historical logs, and some are slow or broken on testnets. Read, estimate gas and
    // wait for receipts through the registry's chain RPC; signatures and submissions always stay with the wallet.
    // Paced: public testnet RPCs refuse bursts (Base Sepolia allows 25 requests a second), and one refusal used to fail
    // the whole wallet read.
    if (!this.provider || this.readEndpoint !== `${net.chainId}:${net.rpcUrl}`) {
      retire(this.provider);
      const rpc=new FetchRequest(net.rpcUrl);rpc.timeout=15000;
      this.provider = new PacedJsonRpcProvider(rpc, net.chainId, { staticNetwork:true,cacheTimeout: -1, batchMaxCount: 1 }, { fallbacks: net.rpcFallbacks ?? [] });
      this.readEndpoint = `${net.chainId}:${net.rpcUrl}`;
    }
    this.signer = new PublicRpcSigner(await this.signerProvider.getSigner(), this.provider, { onSlow: message => this.onProgress?.(message) });
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
  /**
   * Testnet Ondo-style stock pairs: stops before signing when the test issuer has paused the stock or blocked this
   * wallet, or when a buy would complete (and graduate) the curve without a usable stock price.
   */
  async stockPreflight(item, action, { input = 0n, curve = null } = {}) {
    const quote = item.pair === 'xstock' ? this.qaddr(item) : null, arts = this.config.contracts;
    if (!quote || !arts?.testOndoStock || !arts?.testStockFeed) return;
    let provider; try { provider = await new Contract(quote, ['function stockProvider() view returns(string)'], this.provider).stockProvider(); } catch { return; }
    if (provider !== 'ondo-test') return;
    const stock = new Contract(quote, arts.testOndoStock.abi, this.provider), feed = new Contract(await stock.referenceFeed(), arts.testStockFeed.abi, this.provider);
    const [paused, blocked, round, status] = await Promise.all([stock.paused(), stock.blocked(this.address), feed.latestRoundData(), feed.marketStatus()]);
    let completes = false;
    if (action === 'buy' && curve && input > 0n) { try { const [sold, cap, [out]] = await Promise.all([curve.sold(), curve.SALE_CAP(), curve.quoteBuy(input)]); completes = sold + out >= cap; } catch { /* not a completing buy we can detect */ } }
    const hold = testStockHold({ provider, paused, price: formatUnits(round[1], 8), updatedAt: Number(round[3]), marketStatus: MARKET_STATUS[Number(status)] }, { action, completes, blocked }, nowSeconds());
    if (hold) throw new Error(hold);
  }
  qsym(item, wrapped = false) { return item.pair === 'native' ? (wrapped ? 'WETH' : this.net.nativeCurrency.symbol) : item.quoteSymbol ?? 'paired token'; }
  /** The creation fee in whole native coins: the factory's live value once deployed, else the configured one. */
  feeText() { return this.launchFee !== undefined ? formatUnits(this.launchFee, 18).replace(/\.0$/, '') : this.pricing.launchFee; }
  /**
   * Launchable trading assets by kind (packages/core/pairs.mjs). Native comes from the factory; oStock (Ondo) and
   * paired-token assets are the factory's approved quotes (DEX launchpads only). Native and USDC fee
   * payment remain independent of the trading pair.
   */
  pairOptions() {
    const native = this.net.nativeCurrency.symbol;
    const fee = { feeAmount: this.feeText(), feeSymbol: native };
    const approved = kind => (this.approvedQuotes ?? []).filter(a => a.kind === kind).map(a => ({ ...a, ...fee }));
    const missing = kind => !this.dex
      ? `${this.net.name} uses the basic launchpad, which supports ${native} pairs. oStock and paired-token launches need DEX graduation (Base Sepolia).`
      : !this.deployment ? 'Set up the launchpad on this network first.'
      : `No ${kind === 'xstock' ? 'oStock' : 'paired token'} is approved on ${this.net.name} yet. The launchpad operator can add the test assets.`;
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
  /** The USDC graduation adapter for this launchpad: reused from this browser if valid, else deployed (gas only, no powers). */
  async usdcAdapter(factory, usdc = this.feeUsdc) {
    const adapterKey=`elpida:usdc-adapter:${this.net.chainId}:${factory.target.toLowerCase()}`;
    let adapterAddress=localStorage.getItem(adapterKey);
    if(adapterAddress){const a=new Contract(adapterAddress,['function manager() view returns(address)','function usdc() view returns(address)','function fee() view returns(uint24)'],this.provider);if((await a.manager()).toLowerCase()!==this.dex.manager.toLowerCase()||(await a.usdc()).toLowerCase()!==usdc.toLowerCase()||await a.fee()!==10000n)throw new Error('Saved USDC adapter does not match this launchpad.');}
    else {const a=this.config.contracts.adapter;this.onProgress('Confirm the USDC graduation adapter deployment…');const adapter=await new ContractFactory(a.abi,a.bytecode,this.signer).deploy(this.dex.manager,usdc,10000);await adapter.waitForDeployment();adapterAddress=adapter.target;localStorage.setItem(adapterKey,adapterAddress);}
    return adapterAddress;
  }
  /**
   * The treasury-only setup steps still open on this launchpad (activate USD pricing; approve USDC trading), as a
   * Safe Transaction Builder batch, or null when nothing is left. Used when the treasury is a Safe.
   */
  async treasuryBatch(factory = this.factoryContract().connect(this.signer)) {
    const steps = [], usdc = this.oracle?.usdc;
    if (await factory.usdFeed() === ZeroAddress) steps.push({ to: factory.target, data: factory.interface.encodeFunctionData('configureUsdPricing', [this.oracle.feed, this.oracle.maxAge, usdc ?? ZeroAddress]) });
    if (this.dex && usdc && usdc !== ZeroAddress && (await factory.approvedQuotes(usdc)).adapter === ZeroAddress) {
      const adapter = await this.usdcAdapter(factory, usdc);
      steps.push({ to: factory.target, data: factory.interface.encodeFunctionData('approveQuote', [usdc, usdQuoteTemplate(await factory.startFdvUsd(), 6), adapter]) });
    }
    if (!steps.length) return null;
    return safeBatch({ chainId: this.net.chainId, safe: await factory.treasury(), name: `Elpida ${this.net.name} launchpad setup`, description: `Treasury-only setup for launchpad ${factory.target}: ${steps.length} step(s), activating USD pricing and approving USDC trading.`, transactions: steps });
  }
  /**
   * Operator panel only: approve a real tokenized stock as a trading pair on a mainnet launchpad, after every registry
   * gate passes (stock-approval.mjs). Deploys its graduation adapter from the connected wallet (resumable), then
   * approves it from the treasury: directly when the connected wallet is the treasury, otherwise as a Safe batch.
   */
  async approveStock({ asset }) {
    await this.checkNetwork(); const factory = (await this.verifyFactory()).connect(this.signer);
    const response = await fetch(`/api/public/tokenized-equity?network=${encodeURIComponent(this.net.key)}&provider=ondo`, { signal: AbortSignal.timeout(15000) });
    const view = response.ok ? await response.json() : null, record = view?.assets?.find(a => a.address === String(asset ?? '').toLowerCase()) ?? null;
    const gate = stockApprovalGate(record, { mainnet: !!this.net.mainnet }); if (gate) throw new Error(gate);
    if (!this.dex) throw new Error('This launchpad has no DEX graduation configured.');
    if ((await factory.approvedQuotes(record.address)).adapter !== ZeroAddress) return { message: `${record.symbol} is already an approved trading pair.` };
    const feed = new Contract(record.feed, ['function decimals() view returns(uint8)', 'function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)'], this.provider);
    const [round, feedDecimals, block] = await Promise.all([feed.latestRoundData(), feed.decimals(), this.provider.getBlock('latest')]);
    const priceUsd8 = freshFeedPrice(round, feedDecimals, { now: block.timestamp, maxAge: 4 * 86400 });
    const decimals = Number(await new Contract(record.address, ['function decimals() view returns(uint8)'], this.provider).decimals());
    const virtualQuote = stockVirtualQuote({ startFdvUsd: await factory.startFdvUsd(), decimals, priceUsd8 });
    const a = this.config.contracts.adapter, key = `elpida:stock-adapter:${this.net.chainId}:${factory.target.toLowerCase()}:${record.address}`;
    this.onProgress(`Confirm the ${record.symbol} graduation adapter deployment…`);
    const adapter = await resumeSetupDeployment({ provider: this.provider, storage: localStorage, key, from: this.address,
      matches: async address => { const c = new Contract(address, ['function usdc() view returns(address)', 'function manager() view returns(address)'], this.provider); return (await c.usdc()).toLowerCase() === record.address && (await c.manager()).toLowerCase() === this.dex.manager.toLowerCase(); },
      deploy: () => new ContractFactory(a.abi, a.bytecode, this.signer).deploy(this.dex.manager, record.address, 10000) });
    const treasury = await factory.treasury(), call = { to: factory.target, data: factory.interface.encodeFunctionData('approveQuote', [record.address, virtualQuote, adapter]) };
    const price = formatUnits(priceUsd8, 8);
    if (treasury.toLowerCase() !== this.address.toLowerCase())
      return { safeBatch: safeBatch({ chainId: this.net.chainId, safe: treasury, name: `Approve ${record.symbol} on ${this.net.name}`, description: `approveQuote(${record.symbol}) on launchpad ${factory.target}: starting valuation fixed at ${price} USD per ${record.symbol}, adapter ${adapter}.`, transactions: [call] }),
        message: `The ${record.symbol} approval file is downloading. Import it in the Safe Transaction Builder for the treasury signers. Price used: $${price}.` };
    const result = await this.wait(factory.approveQuote(record.address, virtualQuote, adapter), `Approve ${record.symbol} as a trading pair at $${price}…`);
    this.pairsScanned = undefined; this.approvedQuotes = undefined; await this.loadPairs(factory);
    return { hash: result.tx.hash, message: `${record.symbol} is an approved trading pair.` };
  }
  async setupUsdcPair(configuredFactory=null) {
    await this.checkNetwork(); const factory=(configuredFactory??await this.verifyFactory()).connect(this.signer);
    this.feeUsdc=await factory.feeUsdc();
    if(!this.dex||!this.feeUsdc||this.feeUsdc===ZeroAddress)throw new Error('A configured USDC asset and DEX adapter are required on this network.');
    if((await factory.treasury()).toLowerCase()!==this.address.toLowerCase()){const batch=await this.treasuryBatch(factory);return batch?{safeBatch:batch,message:'The treasury is a Safe: the setup file is downloading. Import it in the Safe Transaction Builder for its signers to approve.'}:{message:'Nothing left for the treasury to sign.'};}
    if((await factory.approvedQuotes(this.feeUsdc)).adapter!==ZeroAddress)return {message:'USDC trading pair is already approved.'};
    if(Number(await new Contract(this.feeUsdc,['function decimals() view returns(uint8)'],this.provider).decimals())!==6)throw new Error('The configured USDC asset must use six decimals.');
    const adapterAddress=await this.usdcAdapter(factory);
    // Model 10: start FDV x 10/9 in USDC units. Legacy model 9: $5,000 x 16/15.
    const legacy=this.model===LEGACY_DEX_MODEL,start=legacy?5000n:await factory.startFdvUsd();
    const vq=legacy?5_000_000_000n*await factory.VIRTUAL_TOKEN()/await factory.TOKEN_SUPPLY():usdQuoteTemplate(start,6);
    const result=await this.wait(factory.approveQuote(this.feeUsdc,vq,adapterAddress),`Approve USDC trading: starting valuation ${start.toLocaleString()} USDC, permanent locked-pool graduation…`);
    this.pairsScanned=undefined;this.approvedQuotes=[];await this.loadPairs(factory);
    return {hash:result.tx.hash,message:'USDC trading pair is approved. Launch-fee currency remains independently selectable.'};
  }
  /** A positive decimal string, so a blank field cannot reach parseUnits as an invalid number. */
  nativeAmount(value) {
    const text=String(value??'').trim();
    if(!/^\d+(\.\d+)?$/.test(text)||Number(text)<=0)throw new Error('Enter an amount greater than zero.');
    return text;
  }
  async getNativePairConversionQuote(body) {
    await this.checkNetwork(); await this.verifyFactory();
    const item=this.launches.get(String(body.token).toLowerCase());
    if(!item)throw new Error('Token not found. Refresh the launchpad.');
    if(item.pair==='native'||item.tax)throw new Error('Native conversion is for standard non-native pairs only.');
    const asset=this.qaddr(item),toNative=body.direction==='to-native';
    if(!['to-native','from-native'].includes(body.direction))throw new Error('Invalid conversion direction.');
    const decimals=Number(await new Contract(asset,['function decimals() view returns(uint8)'],this.provider).decimals());
    const amountIn=parseUnits(this.nativeAmount(body.amount),toNative?decimals:18);
    const result=await quoteNativePairConversion({Contract,provider:this.provider,dex:this.dex,asset,amountIn,toNative,slippageBps:100});
    return {token:body.token,direction:body.direction,amount:body.amount,minimum:result.minimum.toString(),output:formatUnits(result.amountOut,toNative?18:decimals),quotedAt:result.quotedAt};
  }
  /**
   * Launch form: what a creator purchase paid in the native coin converts into on this pair, before anything is signed.
   * { output, minimum, symbol, pending } as decimal strings; `pending` is an earlier conversion the next launch reuses.
   */
  async firstBuyConversionQuote({ quoteAsset, nativeAmount }) {
    await this.checkNetwork();
    if (this.net.mainnet) throw new Error('Paying the first purchase in the native coin is testnet-only for now.');
    const asset = (this.approvedQuotes ?? []).find(a => a.address.toLowerCase() === String(quoteAsset ?? '').toLowerCase());
    if (!asset || !this.dex) throw new Error('Choose an approved pair asset on a launchpad with DEX graduation.');
    const pending = pendingConversion(localStorage, conversionKey({ chainId: this.net.chainId, factory: this.deployment.factory, account: this.address, asset: asset.address }));
    const q = await quoteNativePairConversion({ Contract, provider: this.provider, dex: this.dex, asset: asset.address, amountIn: parseUnits(this.nativeAmount(nativeAmount), 18) });
    return { output: formatUnits(q.amountOut, asset.decimals), minimum: formatUnits(q.minimum, asset.decimals), symbol: asset.symbol, pending: pending === null ? null : formatUnits(pending, asset.decimals) };
  }
  async convertNativePair(body) {
    if(!Number.isFinite(body.quotedAt)||Date.now()-body.quotedAt>60000||body.quotedAt>Date.now())throw new Error('Conversion quote expired.');
    const fresh=await this.getNativePairConversionQuote(body),minimum=BigInt(body.minimum);
    if(minimum<=0n||BigInt(fresh.minimum)<minimum)throw new Error('Conversion price moved. Get a new quote.');
    const item=this.launches.get(String(body.token).toLowerCase()),asset=this.qaddr(item),toNative=body.direction==='to-native';
    await this.stockPreflight(item,toNative?'sell':'buy');
    const decimals=Number(await new Contract(asset,['function decimals() view returns(uint8)'],this.provider).decimals());
    const input=parseUnits(body.amount,toNative?decimals:18);
    const route=await quoteNativePairConversion({Contract,provider:this.provider,dex:this.dex,asset,amountIn:input,toNative});
    if(route.amountOut<minimum)throw new Error('Conversion price moved. Get a new quote.');
    if(toNative){const coin=new Contract(asset,this.config.contracts.quote.abi,this.signer);if(await coin.allowance(this.address,this.dex.router)<input)await this.wait(coin.approve(this.dex.router,input),'Approve only the pair-asset conversion amount...');}
    const deadline=BigInt((await this.provider.getBlock('latest')).timestamp+300);
    const data=swapCalldata(Interface,this.dex.routerVersion??2,this.dex.router,{tokenIn:route.tokenIn,tokenOut:route.tokenOut,fee:route.fee,recipient:this.address,amountIn:input,amountOutMinimum:minimum},{deadline,unwrapTo:toNative?this.address:null,refundETH:!toNative});
    const result=await this.wait(this.signer.sendTransaction({to:this.dex.router,data,value:toNative?0n:input}),'Confirm the separate native/pair conversion...');
    return {hash:result.tx.hash,message:'Conversion confirmed. Funds are in your wallet; the token trade is separate.'};
  }
  nativeRouterRecord(){
    const factory=this.deployment?.factory?.toLowerCase(),shared=this.net.nativeTradeRouter;
    if(factory&&shared?.factory?.toLowerCase()===factory)return shared;
    return read(`elpida:native-router:v1:${this.net.chainId}:${factory}`);
  }
  async nativeTradeRouter(){
    const record=this.nativeRouterRecord();if(!record?.address)return null;
    if(this.net.chainId!==11155111||this.net.mainnet||this.dex?.routerVersion!==2)throw Error('Ordinary-wallet native routing is enabled only for the Sepolia rehearsal.');
    const artifact=this.config.contracts.nativeTradeRouter,args=[this.deployment.factory,this.dex.router,this.dex.factory,this.dex.weth];
    const key=JSON.stringify([record,args,artifact.bytecode]);
    if(this.verifiedNativeRouter?.key===key&&this.verifiedNativeRouter.provider===this.provider)return this.verifiedNativeRouter.contract;
    const contract=await verifyNativeRouter({Contract,ContractFactory,provider:this.provider,artifact,record,args,chainId:this.net.chainId});this.verifiedNativeRouter={key,contract,provider:this.provider};return contract;
  }
  async deployNativeTradeRouter(){
    await this.checkNetwork();await this.verifyFactory();
    if(this.net.chainId!==11155111||this.net.mainnet||this.dex?.routerVersion!==2)throw Error('Router deployment is restricted to Ethereum Sepolia.');
    const artifact=this.config.contracts.nativeTradeRouter,args=[this.deployment.factory,this.dex.router,this.dex.factory,this.dex.weth],key=`elpida:native-router:v1:${this.net.chainId}:${this.deployment.factory.toLowerCase()}`;
    this.onProgress('Confirm the ordinary-wallet native router deployment on Ethereum Sepolia. Test gas only.');
    await resumeSetupDeployment({provider:this.provider,storage:localStorage,key,deploy:()=>new ContractFactory(artifact.abi,artifact.bytecode,this.signer).deploy(...args)});
    const router=await this.nativeTradeRouter(),record=read(key);
    return {hash:record.hash,message:`Native router verified at ${router.target}. Native trades can now use an ordinary wallet.`};
  }
  async getNativePairTradeQuote(body) {
    await this.checkNetwork();await this.verifyFactory();
    const nativeRouter=await this.nativeTradeRouter();
    if(!nativeRouter&&!await this.canBatch())throw new Error(this.net.chainId===11155111?'Native-coin trading here needs a wallet with batched transactions until the operator sets up the native router. Direct pair-asset trading remains available.':'Native trading on this network currently requires an atomic-capable wallet. Direct pair-asset trading remains available.');
    const item=this.launches.get(String(body.token).toLowerCase());
    if(!item||item.pair==='native'||item.tax)throw new Error('Atomic native trading requires a standard non-native pair.');
    if(!['buy','sell'].includes(body.side))throw new Error('Invalid native trade side.');
    const asset=this.qaddr(item),buy=body.side==='buy',input=parseUnits(this.nativeAmount(body.amount),18),market=await this.market(item);
    let route,pairAmount,output;
    if(buy){
      route=await quoteNativePairConversion({Contract,provider:this.provider,dex:this.dex,asset,amountIn:input});
      pairAmount=route.minimum;
      output=market.target.toLowerCase()===item.curve.toLowerCase()?(await market.quoteBuy(pairAmount))[0]:await this.dexQuote(item,'buy',pairAmount);
    }else{
      const pairOut=market.target.toLowerCase()===item.curve.toLowerCase()?(await market.quoteSell(input))[0]:await this.dexQuote(item,'sell',input);
      pairAmount=pairOut*9900n/10000n;
      route=await quoteNativePairConversion({Contract,provider:this.provider,dex:this.dex,asset,amountIn:pairAmount,toNative:true});
      output=route.amountOut;
    }
    const minimum=output*9900n/10000n;
    if(minimum<=0n)throw new Error('Trade amount is too small.');
    let curveNonce=null;if(nativeRouter){const deployer=await nativeRouter.curveDeployer();curveNonce=findCurveNonce(getCreateAddress,deployer,item.curve,await this.provider.getTransactionCount(deployer));await nativeRouter.market(item.curve,curveNonce);}
    return {token:body.token,side:body.side,amount:body.amount,minimum:minimum.toString(),output:formatUnits(output,18),quotedAt:Date.now(),pairAmount:pairAmount.toString(),route,market:market.target,execution:nativeRouter?'router':'batch',nativeRouter:nativeRouter?.target??null,curveNonce};
  }
  async tradeNativePair(body) {
    if(!Number.isFinite(body.quotedAt)||Date.now()-body.quotedAt>60000||body.quotedAt>Date.now())throw new Error('Native trade quote expired.');
    const q=await this.getNativePairTradeQuote(body),minimum=BigInt(body.minimum);
    if(minimum<=0n||BigInt(q.minimum)<minimum)throw new Error('Native trade price moved. Get a fresh quote.');
    const item=this.launches.get(String(body.token).toLowerCase()),buy=body.side==='buy',asset=this.qaddr(item),input=parseUnits(body.amount,18),pairAmount=BigInt(q.pairAmount);
    const original=new Contract(item.curve,this.artifacts.curve.abi,this.provider);
    await this.stockPreflight(item,body.side,{input:buy?pairAmount:input,curve:original});
    const deadline=BigInt((await this.provider.getBlock('latest')).timestamp+300),calls=[];
    if(q.execution==='router'){
      const router=await this.nativeTradeRouter();
      if(!buy){const coin=new Contract(item.address,['function allowance(address,address) view returns(uint256)','function approve(address,uint256) returns(bool)'],this.signer);if(await coin.allowance(this.address,router.target)!==input){if(await coin.allowance(this.address,router.target)>0n)await this.wait(coin.approve(router.target,0n),'Reset native sell approval…');await this.wait(coin.approve(router.target,input),'Approve this token amount for the native sell…');}}
      await this.checkNetwork();
      const request={curve:item.curve,curveNonce:q.curveNonce,conversionFee:q.route.fee,amount:input,pairMinimum:pairAmount,minimum,deadline};
      const connected=router.connect(this.signer),result=await this.wait(buy?connected.buy(request,{value:input}):connected.sell(request),'Confirm the native trade. Conversion and token trade succeed together or revert.');
      return {hash:result.tx.hash,message:'Native trade confirmed. Any unused pair asset was returned to your wallet.'};
    }
    const approval=(token,spender,amount)=>{const i=new Interface(['function approve(address,uint256) returns(bool)']);return {to:token,data:i.encodeFunctionData('approve',[spender,amount])};};
    const conversion={to:this.dex.router,value:buy?input:0n,data:swapCalldata(Interface,this.dex.routerVersion??2,this.dex.router,{tokenIn:q.route.tokenIn,tokenOut:q.route.tokenOut,fee:q.route.fee,recipient:this.address,amountIn:buy?input:pairAmount,amountOutMinimum:buy?pairAmount:minimum},{deadline,unwrapTo:buy?null:this.address,refundETH:buy})};
    if(buy)calls.push(conversion);
    const payment=buy?asset:item.address,spend=buy?pairAmount:input,onCurve=q.market.toLowerCase()===item.curve.toLowerCase(),spender=onCurve?q.market:this.dex.router;
    calls.push(approval(payment,spender,spend));
    if(onCurve){
      const i=new Interface(['function buy(uint256,uint256)','function sell(uint256,uint256)']);
      calls.push({to:q.market,data:i.encodeFunctionData(body.side,[spend,buy?minimum:pairAmount])});
    }else{
      calls.push({to:this.dex.router,data:swapCalldata(Interface,this.dex.routerVersion??2,this.dex.router,{tokenIn:payment,tokenOut:buy?item.address:asset,fee:this.dex.fee??10000,recipient:this.address,amountIn:spend,amountOutMinimum:buy?minimum:pairAmount},{deadline})});
    }
    calls.push(approval(payment,spender,0n));
    if(!buy){calls.push(approval(asset,this.dex.router,pairAmount),conversion,approval(asset,this.dex.router,0n));}
    const result=await this.sendCalls(calls,'Confirm the atomic native trade.',{atomicRequired:true});
    return {hash:result.tx.hash,message:'Atomic native trade confirmed. Any excess pair asset remains in your wallet.'};
  }
  async getUsdcConversionQuote(body) {
    await this.checkNetwork();await this.verifyFactory();
    const nativeAmount=this.nativeAmount(body?.nativeAmount);
    const slippageBps=Math.round(Number(body.slippage??'1')*100);
    const q=await quoteUsdcConversion({Contract,provider:this.provider,dex:this.dex,usdc:this.feeUsdc,amountOut:parseUnits(nativeAmount,18),slippageBps});
    return {nativeAmount:formatUnits(q.amountOut,18),usdcAmount:formatUnits(q.amountIn,6),maxUsdc:formatUnits(q.maxUsdc,6),quotedAt:q.quotedAt,fee:q.fee};
  }
  async convertUsdc(body) {
    await this.checkNetwork();await this.verifyFactory();
    if(!Number.isSafeInteger(body.quotedAt)||Date.now()-body.quotedAt>60000||body.quotedAt>Date.now())throw new Error('Conversion quote expired. Get a fresh quote.');
    const q=await quoteUsdcConversion({Contract,provider:this.provider,dex:this.dex,usdc:this.feeUsdc,amountOut:parseUnits(this.nativeAmount(body.nativeAmount),18),slippageBps:Math.round(Number(body.slippage??'1')*100)});
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
      let kind='token',faucetLimit=0n,stock=null;try{kind=await asset.pairKind()==='xstock'?'xstock':'token';}catch{}try{faucetLimit=await asset.FAUCET_LIMIT();}catch{}
      // Ondo-style test stocks describe their issuer model and their total-return feed (contracts/evm/testnet).
      if(kind==='xstock'){try{const s=new Contract(address,['function stockProvider() view returns(string)','function referenceFeed() view returns(address)'],this.provider);const provider=await s.stockProvider();if(provider==='ondo-test')stock={provider,feed:await s.referenceFeed()};}catch{}}
      if (this.feeUsdc && address.toLowerCase() === this.feeUsdc.toLowerCase()) kind='usdc';
      // Two overlapping loads (the panel redraws while pairs are read) must not list an asset twice.
      if(this.approvedQuotes.some(a=>a.address.toLowerCase()===address.toLowerCase()))return;
      this.approvedQuotes.push({id:address,address,kind,symbol,name,decimals:Number(decimals),virtualQuote:template.virtualQuote,test:faucetLimit>0n,stock,faucet:faucetLimit>0n?{label:'Get '+formatUnits(faucetLimit,decimals).replace(/\.0$/,'')+' '+symbol,action:'faucet',body:{asset:address}}:null});
    };
    if(this.pairsScanned===undefined&&this.deployment.shared){
      const response=await fetch('/api/public/quotes?network='+encodeURIComponent(this.net.key),{signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw new Error('Trading pair discovery is temporarily unavailable. Refresh shortly.');
      const data=await response.json();
      // The server's index may be a few blocks ahead of this page's public RPC; that is not a mismatch.
      if(data.factory?.toLowerCase()!==this.deployment.factory.toLowerCase()||data.chainId!==this.net.chainId||!Number.isSafeInteger(data.indexedBlock)||data.indexedBlock>latest+30||data.indexedBlock<this.deployment.block||!Array.isArray(data.assets)||data.assets.some(a=>!isAddress(a)))throw new Error('Trading pair index does not match this launchpad.');
      for(const address of new Set(data.assets))await add(address);
      this.pairsScanned=data.indexedBlock;
    }
    let from=this.pairsScanned===undefined?this.deployment.block:this.pairsScanned+1;
    if(latest-from>20000)throw new Error('This launchpad needs its public pair index to load trading assets.');
    for(;from<=latest;from+=100){const to=Math.min(from+99,latest);for(const event of await factory.queryFilter(factory.filters.QuoteApproved(),from,to))await add(event.args.asset);this.pairsScanned=to;}
  }
  /** Test pairs this launchpad has not approved yet (after loadPairs), for the owner's setup button. */
  missingTestPairs() { return this.approvedQuotes ? EVM_TEST_PAIRS.filter(t => !this.approvedQuotes.some(a => a.symbol === t.symbol && a.test)) : []; }
  /**
   * Treasury only: the test issuer's controls on an Ondo-style test stock, to rehearse the stock gate. `op` is
   * 'price' (value: USD), 'status' (open | closed | corporate-action), 'pause' (true/false) or 'block' (address, blocked).
   */
  async testStockControl({ asset, op, value, account }) {
    const quote = (this.approvedQuotes ?? []).find(a => a.address.toLowerCase() === String(asset).toLowerCase() && a.stock?.provider === 'ondo-test');
    if (!quote) throw new Error('That is not an Ondo-style test stock on this launchpad.');
    const stock = new Contract(quote.address, this.config.contracts.testOndoStock.abi, this.signer), feed = new Contract(quote.stock.feed, this.config.contracts.testStockFeed.abi, this.signer);
    if ((await stock.controller()).toLowerCase() !== this.address.toLowerCase()) throw new Error('Only the wallet that deployed the test stock (the launchpad treasury) controls it.');
    let r;
    if (op === 'price') { const usd = Number(value); if (!(usd > 0)) throw new Error('Enter a positive USD price.'); r = await this.wait(feed.post(parseUnits(String(usd), 8)), `Post a ${quote.symbol} test price of $${usd}…`); }
    else if (op === 'status') { const i = ['open', 'closed', 'corporate-action'].indexOf(value); if (i < 0) throw new Error('Unknown market status.'); r = await this.wait(feed.setMarketStatus(i), `Set the ${quote.symbol} test market to ${value}…`); }
    else if (op === 'pause') r = await this.wait(stock.setPaused(!!value), `${value ? 'Pause' : 'Unpause'} ${quote.symbol} (test issuer control)…`);
    else if (op === 'block') { if (!isAddress(account)) throw new Error('Enter a valid address.'); r = await this.wait(stock.setBlocked(account, !!value), `${value ? 'Block' : 'Unblock'} ${account.slice(0, 6)}…${account.slice(-4)} on ${quote.symbol}…`); }
    else throw new Error('Unknown test stock control.');
    return { hash: r.tx.hash, message: `${quote.symbol}: done. The token pages pick it up within about a minute.` };
  }
  async getTestStockLiquidityQuote({asset,nativeAmount='0.05'}={}) {
    await this.checkNetwork();await this.verifyFactory();
    if(this.net.chainId!==11155111||this.net.mainnet)throw Error('This rehearsal is restricted to Ethereum Sepolia.');
    const approved=(this.approvedQuotes??[]).find(a=>a.address.toLowerCase()===String(asset).toLowerCase()&&a.test&&a.stock?.provider==='ondo-test');
    if(!approved)throw Error('Choose an approved simulated Ondo-style test stock.');
    const nativeWei=parseUnits(String(nativeAmount),18),price=await this.oraclePrice();
    const plan=await prepareTestLiquidity({Contract,provider:this.provider,dex:this.dex,chainId:this.net.chainId,asset,account:this.address,nativeAmount:nativeWei,nativeUsd8:parseUnits(price.usd.toFixed(8),8)});
    return {asset,nativeAmount:String(nativeAmount),stockAmount:formatUnits(plan.stockAmount,18),quotedAt:plan.quotedAt,funded:plan.funded,pool:plan.pool,symbol:approved.symbol,account:this.address,factory:this.deployment.factory,pending:localStorage.getItem(`elpida:test-conversion:${this.net.chainId}:${String(asset).toLowerCase()}:${this.address.toLowerCase()}`)};
  }
  async setupTestStockLiquidity(body) {
    await this.checkNetwork();if(this.net.chainId!==11155111||this.net.mainnet)throw Error('This rehearsal is restricted to Ethereum Sepolia.');
    if(!Number.isFinite(body.quotedAt)||Date.now()-body.quotedAt>60000||body.quotedAt>Date.now()||String(body.account).toLowerCase()!==this.address.toLowerCase()||String(body.factory).toLowerCase()!==this.deployment.factory.toLowerCase())throw Error('Liquidity quote expired or wallet changed. Get a fresh quote.');
    const key=`elpida:test-conversion:${this.net.chainId}:${String(body.asset).toLowerCase()}:${this.address.toLowerCase()}`;
    const pending=localStorage.getItem(key);
    if(pending){const receipt=await this.provider.getTransactionReceipt(pending);if(!receipt)throw Error(`Liquidity transaction ${pending} is still pending. Check its status before retrying.`);if(receipt.status===1){const stock=new Contract(body.asset,['function allowance(address,address) view returns(uint256)','function approve(address,uint256) returns(bool)'],this.signer);if(await stock.allowance(this.address,this.dex.manager)>0n)await this.wait(stock.approve(this.dex.manager,0n),'Clear unused test stock liquidity approval…');localStorage.removeItem(key);return {hash:pending,message:'Previously submitted conversion liquidity is confirmed.'};}localStorage.removeItem(key);}
    const current=await this.getTestStockLiquidityQuote(body);
    if(current.funded)return {message:'The conversion pool is already funded. No additional liquidity was sent.'};
    if(parseUnits(current.stockAmount,18)>parseUnits(body.stockAmount,18))throw Error('Test stock funding amount increased. Get a fresh quote.');
    const stock=new Contract(body.asset,['function allowance(address,address) view returns(uint256)','function approve(address,uint256) returns(bool)'],this.signer),maximum=parseUnits(body.stockAmount,18);
    const allowance=await stock.allowance(this.address,this.dex.manager);
    if(allowance!==maximum){if(allowance>0n)await this.wait(stock.approve(this.dex.manager,0n),'Reset the test liquidity allowance…');await this.wait(stock.approve(this.dex.manager,maximum),'Approve the bounded test stock liquidity amount…');}
    // Recheck issuer state, price and pool after the approval, before spending native coin.
    const price=await this.oraclePrice(),plan=await prepareTestLiquidity({Contract,provider:this.provider,dex:this.dex,chainId:this.net.chainId,asset:body.asset,account:this.address,nativeAmount:parseUnits(body.nativeAmount,18),nativeUsd8:parseUnits(price.usd.toFixed(8),8)});
    if(plan.funded)throw Error('Pool was funded while approval was pending. No extra liquidity was sent.');
    if(plan.stockAmount>maximum)throw Error('Price moved while approval was pending. Get a new funding quote.');
    const manager=new Contract(this.dex.manager,TEST_MANAGER_ABI,this.signer);
    const tx=await manager.multicall(testLiquidityCalls(Interface,plan),{value:plan.nativeAmount});localStorage.setItem(key,tx.hash);
    const result=await this.wait(Promise.resolve(tx),'Fund the ETH/test-stock conversion pool…');
    if(await stock.allowance(this.address,this.dex.manager)>0n)await this.wait(stock.approve(this.dex.manager,0n),'Clear unused test stock liquidity approval…');
    localStorage.removeItem(key);return {hash:result.tx.hash,message:'Test conversion liquidity confirmed. The LP position stays in your wallet; underlying token pairs are unchanged.'};
  }
  /** Treasury only, DEX launchpads: deploys the labelled test assets (EVM_TEST_PAIRS) and approves them as pairs. */
  async setupTestPairs({ recoveryHash } = {}) {
    await this.checkNetwork();
    const factory = (await this.verifyFactory()).connect(this.signer);
    if (!this.dex) throw new Error('Test pairs need a launchpad with DEX graduation (Base Sepolia).');
    if ((await factory.treasury()).toLowerCase() !== this.address.toLowerCase()) throw new Error('Only the launchpad owner (its treasury wallet) can approve trading pairs.');
    await this.loadPairs(factory);
    const supply = await factory.TOKEN_SUPPLY(), vt = await factory.VIRTUAL_TOKEN();
    const deployStage = async (symbol, stage, artifact, args, matches = null) => {
      const key = `elpida:test-pair:${this.net.chainId}:${String(factory.target).toLowerCase()}:${this.address.toLowerCase()}:${symbol}:${stage}`;
      if (recoveryHash && symbol === 'TEST-STOCK' && stage === 'asset' && !localStorage.getItem(key)) {
        if (!/^0x[0-9a-f]{64}$/i.test(recoveryHash)) throw new Error('Enter a valid setup transaction hash.');
        const tx = await this.provider.getTransaction(recoveryHash);
        const expected = await new ContractFactory(artifact.abi, artifact.bytecode, this.signer).getDeployTransaction(...args);
        if (!tx || tx.to !== null || tx.from.toLowerCase() !== this.address.toLowerCase() || tx.data.toLowerCase() !== expected.data.toLowerCase() || tx.value !== 0n)
          throw new Error('Recovery transaction must be this connected account’s exact TEST-STOCK deployment on this network.');
        const receipt = await this.provider.getTransactionReceipt(recoveryHash);
        if (!receipt || receipt.status !== 1 || !receipt.contractAddress) throw new Error('Recovery deployment has not succeeded yet.');
        localStorage.setItem(key, JSON.stringify({ hash: recoveryHash, address: receipt.contractAddress }));
      }
      const address = await resumeSetupDeployment({ provider: this.provider, storage: localStorage, key, from: this.address,
        matches: matches ? address => matches(new Contract(address, artifact.abi, this.provider)) : null,
        deploy: () => new ContractFactory(artifact.abi, artifact.bytecode, this.signer).deploy(...args) });
      return new Contract(address, artifact.abi, this.signer);
    };
    // One pair per press (2 November 2026): at most four wallet confirmations at a time, so a slow or stuck wallet
    // costs one pair, not the whole set, and the button always says what comes next.
    const missing = EVM_TEST_PAIRS.filter(t => !this.approvedQuotes.some(a => a.symbol === t.symbol && a.test));
    const t = missing[0];
    if (!t) return { message: 'All test pairs are already approved on this launchpad.' };
    const i = EVM_TEST_PAIRS.indexOf(t), of = `Pair ${i + 1} of ${EVM_TEST_PAIRS.length} (${t.symbol})`;
    const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
    const art = this.config.contracts.testAsset, adapterArt = this.config.contracts.adapter;
    let asset;
    if (t.ondo) {
      // The Ondo-style test stock needs its test total-return feed first; the stock records the feed for good.
      const feedArt = this.config.contracts.testStockFeed, stockArt = this.config.contracts.testOndoStock;
      this.onProgress(`${of}: confirm the test price feed deployment (1 of 4)…`);
      const feed = await deployStage(t.symbol, 'feed', feedArt, [t.ondo.feed, parseUnits(t.ondo.price, 8)], async c => await c.description() === t.ondo.feed);
      this.onProgress(`${of}: confirm the test stock deployment (2 of 4)…`);
      asset = await deployStage(t.symbol, 'asset', stockArt, [t.name, t.symbol, BigInt(t.faucet), feed.target], async c => await c.symbol() === t.symbol && same(await c.referenceFeed(), feed.target));
    } else {
      this.onProgress(`${of}: confirm the test asset deployment (1 of 3)…`);
      asset = await deployStage(t.symbol, 'asset', art, [t.name, t.symbol, t.kind, t.decimals, BigInt(t.faucet)], async c => await c.symbol() === t.symbol && await c.name() === t.name);
    }
    this.onProgress(`${of}: confirm its ${this.dex?.name ?? 'DEX'} migration adapter (${t.ondo ? '3 of 4' : '2 of 3'})…`);
    const adapter = await deployStage(t.symbol, 'adapter', adapterArt, [this.dex.manager, asset.target, 10000], async c => same(await c.usdc(), asset.target));
    // The public index can lag the chain: read the approval itself, so a repeat press never sends a doomed approval.
    let last = null;
    if ((await factory.approvedQuotes(asset.target)).adapter === ZeroAddress) {
      const virtualQuote = parseUnits(t.startFdv, t.decimals) * vt / supply;
      last = await this.wait(factory.approveQuote(asset.target, virtualQuote, adapter.target), `${of}: approve ${t.symbol} as a trading pair (${t.ondo ? '4 of 4' : '3 of 3'})…`);
    }
    this.pairsScanned = undefined; this.approvedQuotes = undefined; await this.loadPairs(factory);
    const left = EVM_TEST_PAIRS.filter(x => !this.approvedQuotes.some(a => a.symbol === x.symbol && a.test) && x.symbol !== t.symbol);
    return { hash: last?.tx.hash, message: `${t.symbol} is now an approved test trading pair.${left.length ? ` ${left.length} more to add: ${left.map(x => x.symbol).join(', ')}. Press the button again for the next one.` : ' All test pairs are added.'}` };
  }
  factoryContract(runner = this.provider) {
    const deployment = this.deployment;
    if (!deployment || !isAddress(deployment.factory) || !Number.isSafeInteger(deployment.block) || deployment.block < 1) throw new Error('Deploy a testnet launchpad first.');
    return new Contract(deployment.factory, this.artifacts.factory.abi, runner);
  }
  async wait(pending, message) {
    this.onProgress(message);
    let tx;
    try { tx = await pending; } catch (error) { const text = walletErrorText(error, this.walletName); if (text) throw Object.assign(new Error(text), { code: error.code }); throw error; }
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
  /**
   * Steps that clear a pre-created pool blocking graduation, or none: buying a cheap band below the graduation price
   * (audit finding F-1), or selling the buyer's own tokens into quote placed above it (review finding E-2). Only for a
   * buy that would complete an automatically graduating curve and that a dry run shows failing with "pool price mismatch".
   */
  async graduationUnblock(item, curve, input, minimum) {
    const native = item.pair === 'native';
    let automatic = false; try { automatic = await curve.automaticGraduation(); } catch { /* older curves graduate separately */ }
    let quote; try { quote = await curve.completionQuote(); } catch { return []; }   // nothing left to buy (F-8)
    if (!automatic || input < quote) return [];
    try { await curve.buy.staticCall(input, minimum, { value: native ? input : 0n }); return []; }
    catch (error) { if (!blockedByPool(error)) return []; }   // any other problem is reported by the real buy
    const quoteAsset = native ? this.dex.weth : this.qaddr(item), token = item.address, tokenIsToken0 = BigInt(token) < BigInt(quoteAsset), fee = this.dex.fee ?? 10000;
    const [virtualQuote, virtualToken, saleCap, liquidityBonus] = await Promise.all([curve.virtualQuote(), curve.virtualToken(), curve.SALE_CAP(), curve.liquidityBonus()]);
    const limit = graduationSqrtPriceX96({ virtualQuote, virtualToken, saleCap, liquidityBonus, tokenIsToken0 });
    const pool = await new Contract(this.dex.factory, ['function getPool(address,address,uint24) view returns(address)'], this.provider).getPool(token, quoteAsset, fee);
    const [poolSqrtPriceX96] = await new Contract(pool, this.config.contracts.dexPool.abi, this.provider).slot0();
    const symbol = item.symbol ?? 'this token', unit = native ? this.net.nativeCurrency.symbol : this.qsym(item, true), dex = this.dex.name ?? 'DEX';
    // A UI flow that quotes, approves and then sends can take minutes on a loaded machine, and it expired its own
    // transaction at 300 s (seen in the full suite: the F-1 unblock test reverted with "Transaction too old"). The
    // swap is bounded by sqrtPriceLimitX96, so the deadline is not the safety mechanism here; give it half an hour.
    const router = this.dex.router, deadline = BigInt((await this.provider.getBlock('latest')).timestamp + 1800);
    if (!tokenCheaperInPool({ poolSqrtPriceX96, graduationSqrtPriceX96: limit, tokenIsToken0 })) {
      // Review finding E-2, the mirror of F-1: quote placed in the pool ABOVE the graduation price. Selling the token
      // into it, never below the graduation price, clears it, and the seller gets more than the curve would pay.
      const coin = new Contract(token, this.config.contracts.quote.abi, this.signer), held = await coin.balanceOf(this.address);
      if (held === 0n) throw new Error(`Graduation is waiting on ${symbol}'s ${dex} pool, which someone priced above the curve. Holders can sell into that pool at a profit, and completion works once it is back near the curve price. Nothing was sent.`);
      const steps = [];
      if (await coin.allowance(this.address, router) < held) steps.push({ to: token, data: coin.interface.encodeFunctionData('approve', [router, held]), label: `Approve selling your ${symbol} on ${dex}…` });
      // Up to everything you hold; the price limit decides how much is actually sold, and the rest stays with you.
      steps.push({ to: router, value: 0n, label: `Sell ${symbol} into its ${dex} pool, which someone priced above the curve (never below the graduation price)…`,
        data: swapCalldata(Interface, this.dex.routerVersion ?? 2, router, { tokenIn: token, tokenOut: quoteAsset, fee, recipient: this.address, amountIn: held, amountOutMinimum: 0n, sqrtPriceLimitX96: limit }, { deadline, unwrapTo: native ? this.address : null }) });
      this.onProgress(`Someone priced ${symbol}'s ${dex} pool above the curve, which would block graduation. This sells some of your ${symbol} into it first, above the curve price, then completes the curve.`);
      return steps;
    }
    // Up to the completing buy's size again; the price limit decides how much is actually spent, and the rest stays
    // with you (refunded in the same transaction for native coin).
    const budget = input;
    if (native && await this.provider.getBalance(this.address) < budget + input) throw new Error(`Someone placed cheap ${symbol} in its ${dex} pool below the curve price, which blocks graduation. Clearing it first needs up to ${formatUnits(budget, 18)} ${unit} more than this buy; you receive those tokens, at or below the curve price. Nothing was sent.`);
    const steps = [];
    if (!native) { const coin = new Contract(quoteAsset, this.config.contracts.quote.abi, this.signer); if (await coin.allowance(this.address, router) < budget) steps.push({ to: quoteAsset, data: coin.interface.encodeFunctionData('approve', [router, budget]), label: `Approve the ${dex} purchase exactly…` }); }
    steps.push({ to: router, value: native ? budget : 0n, label: `Buy the ${symbol} placed below the curve price in its ${dex} pool (never above the graduation price)…`,
      data: swapCalldata(Interface, this.dex.routerVersion ?? 2, router, { tokenIn: quoteAsset, tokenOut: token, fee, recipient: this.address, amountIn: budget, amountOutMinimum: 0n, sqrtPriceLimitX96: limit }, { deadline, refundETH: native }) });
    this.onProgress(`Someone placed cheap ${symbol} in its ${dex} pool, which would block graduation. This buy clears it first, then completes the curve.`);
    return steps;
  }
  /** Multicall3 is deployed on this chain (checked once per network). */
  async multicallAvailable() {
    const key = String(this.net?.chainId);
    if (this.multicallSupport?.key !== key) this.multicallSupport = { key, value: await this.provider.getCode(MULTICALL3).then(code => code !== '0x', () => false) };
    return this.multicallSupport.value;
  }
  /**
   * Sends permissionless, zero-value steps (fee claims) as ONE transaction through Multicall3 when the chain has it,
   * whatever the wallet; otherwise as before (an atomic batch, or the steps in order).
   */
  async sendPermissionless(steps, message) {
    if (steps.length > 1 && await this.multicallAvailable()) {
      await this.checkNetwork();
      return this.wait(this.signer.sendTransaction({ to: MULTICALL3, data: multicallData(Interface, steps), value: 0n }), `${message} One confirmation covers all ${steps.length} steps…`);
    }
    return this.sendCalls(steps, message);
  }
  async canBatch() {
    const key = `${this.address}:${this.net?.chainId}`;
    if (this.batchSupport?.key !== key) this.batchSupport = { key, value: await supportsAtomicLaunch(args => this.eth.request(args), this.address, this.net.chainId) };
    return this.batchSupport.value;
  }
  async sendCalls(calls, message, {atomicRequired=false} = {}) {
    if (!calls.length) throw new Error('Nothing to send.');
    const request = args => this.eth.request(args);
    const batchAvailable=calls.length>1&&await this.canBatch();
    if(atomicRequired&&!batchAvailable)throw new Error('Atomic wallet support is required; no transactions were submitted.');
    if (batchAvailable) {
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
  /** The test DEX and relay feed this browser deployed on the current network, if any (to send to the team). */
  savedTestDex(){return this.net?.testDex?read('elpida:test-dex:'+this.net.chainId):null;}
  /**
   * Test chains with no DEX and no Chainlink feed (Robinhood testnet): deploys, from this wallet, a labelled Elpida test
   * deployment of Uniswap v3 (Uniswap's own published bytecode) with a test WETH, and an ElpidaRelayFeed whose only
   * updater is the server's testnet price relay. Six confirmations, gas only; an interrupted setup resumes. The
   * addresses are then registered by the team (networks.mjs, uniswap.mjs) before the launchpad is set up.
   */
  async deployTestDex(){
    await this.checkNetwork();
    if(this.net.mainnet||!this.net.testDex)throw new Error('A test DEX is only for test networks that have none. Nothing was deployed.');
    if(this.dex)throw new Error(`${this.net.name} already has ${this.dex.name}. Nothing was deployed.`);
    const relay=this.config.relay,target=relay?.networks?.[this.net.key],source=target?.source;
    if(!relay?.address)throw new Error('The server price relay is not configured yet (ELPIDA_TESTNET_RELAY_KEY on Railway). Nothing was deployed.');
    if(!source?.feed||!source.chainId)throw new Error('No relay source feed is configured for this network. Nothing was deployed.');
    if(await this.provider.getBalance(this.address)===0n)throw new Error(`Get ${this.net.nativeCurrency.symbol} on ${this.net.name} from its faucet to pay deployment gas.`);
    const response=await fetch('/api/test-dex-artifacts');if(!response.ok)throw new Error('Test DEX bytecode is unavailable. Nothing was deployed.');
    const a=await response.json(),key='elpida:test-dex:'+this.net.chainId,saved={...(read(key)??{}),network:this.net.key,chainId:this.net.chainId};
    const description=`ETH / USD (Chainlink, relayed from ${source.network}; testnet only)`;
    const steps=[
      ['weth','test WETH',()=>[a.weth]],
      ['factory','Uniswap v3 factory',()=>[a.factory]],
      ['manager','Uniswap v3 position manager',()=>[a.manager,saved.factory,saved.weth,ZeroAddress]],
      ['router','Uniswap SwapRouter02',()=>[a.router,ZeroAddress,saved.factory,saved.manager,saved.weth]],
      ['quoter','Uniswap QuoterV2',()=>[a.quoter,saved.factory,saved.weth]],
      ['feed','ETH / USD relay feed',()=>[a.relayFeed,description,source.feed,source.chainId,relay.address]],
    ];
    for(const [i,[name,label,args]] of steps.entries()){
      if(saved[name]&&isAddress(saved[name])&&await this.provider.getCode(saved[name])!=='0x')continue;
      const [art,...params]=args();
      this.onProgress(`Step ${i+1} of ${steps.length}: confirm the ${label} deployment (Elpida test deployment)…`);
      const c=await new ContractFactory(art.abi,art.bytecode,this.signer).deploy(...params);await c.waitForDeployment();
      saved[name]=getAddress(c.target);saved.block??=(await c.deploymentTransaction().wait()).blockNumber;
      if(!write(key,saved))throw new Error(`Deployed the ${label} at ${saved[name]}, but this browser blocks storage. Note it down before continuing.`);
    }
    const manager=new Contract(saved.manager,['function factory() view returns(address)','function WETH9() view returns(address)'],this.provider),feed=new Contract(saved.feed,['function updater() view returns(address)'],this.provider);
    if((await manager.factory()).toLowerCase()!==saved.factory.toLowerCase()||(await manager.WETH9()).toLowerCase()!==saved.weth.toLowerCase()||(await feed.updater()).toLowerCase()!==relay.address.toLowerCase())throw new Error('The deployed test DEX does not match its configuration. Send the saved addresses to the team.');
    saved.deployer=this.address;write(key,saved);
    return {testDex:saved,message:`The ${this.net.name} test DEX and price relay feed are deployed. Send the addresses shown under "Launchpad on this network" to the team to register them; the launchpad is set up after that.`};
  }
  /**
   * `body.treasury`: optional Safe address that becomes the factory's immutable treasury (required on mainnet). The
   * connected wallet then only deploys and pays gas; the treasury-only setup comes back as a Safe batch to sign.
   */
  async deploy(body = {}) {
    await this.checkNetwork();
    const entered = String(body.treasury ?? '').trim();
    if (entered && !isAddress(entered)) throw new Error('Enter a valid treasury address (a Safe), or leave it empty to use this wallet on testnet. Nothing was deployed.');
    const treasury = entered ? getAddress(entered) : this.address, external = treasury.toLowerCase() !== this.address.toLowerCase();
    const safe = external || this.net.mainnet ? await readSafe(Contract, this.provider, treasury) : null;
    const treasuryProblem = treasuryError({ mainnet: !!this.net.mainnet, treasury, connected: this.address, safe });
    if (treasuryProblem) throw new Error(treasuryProblem);
    if (external && !this.dex) throw new Error('A multisig treasury needs the DEX launchpad on this network. Nothing was deployed.');
    if (this.deployment && !this.needsMetadataUpgrade && !this.modelUpgradeAvailable && !this.feeFixUpgradeAvailable && !this.launchUpgradeAvailable && !this.partnerUpgradeAvailable && !this.reviewUpgradeAvailable) throw new Error(`This ${this.net.name} launchpad is already set up. Use it for your launches.`);
    const previousDeployment=this.deployment;
    await this.oraclePrice();
    if (await this.provider.getBalance(this.address) === 0n) throw new Error(`Get ${this.net.nativeCurrency.symbol} on ${this.net.name} from a faucet to pay deployment gas.`);
    const artifact = this.artifacts.factory;
    let migrationAdapter;
    if(this.dex){
      const manager=new Contract(this.dex.manager,['function factory() view returns(address)','function WETH9() view returns(address)'],this.provider);
      if((await manager.factory()).toLowerCase()!==this.dex.factory.toLowerCase()||(await manager.WETH9()).toLowerCase()!==this.dex.weth.toLowerCase())throw new Error(`Unexpected ${this.dex.name??'DEX'} position manager configuration.`);
      // Native pairs graduate through an adapter whose ERC-20 side is WETH.
      const key='elpida:dex-adapter:'+this.net.chainId+':native',saved=read(key);
      if(saved&&isAddress(saved)&&await this.provider.getCode(saved)!=='0x'&&await adapterHasPartnerTiers(saved,this.provider)&&await adapterHasReviewFixes(saved,this.provider)){
        const existing=new Contract(saved,this.config.contracts.adapter.abi,this.provider);
        if((await existing.manager()).toLowerCase()!==this.dex.manager.toLowerCase()||(await existing.usdc()).toLowerCase()!==this.dex.weth.toLowerCase()||await existing.fee()!==10000n)throw new Error('Saved adapter configuration mismatch.');migrationAdapter=saved;
      }else{this.onProgress(`Step 1 of 2: confirm the ${this.dex.name??'DEX'} migration adapter deployment…`);const a=this.config.contracts.adapter,c=await new ContractFactory(a.abi,a.bytecode,this.signer).deploy(this.dex.manager,this.dex.weth,10000);await c.waitForDeployment();migrationAdapter=c.target;write(key,migrationAdapter);}
    }
    // Model 10 terms are fixed at deployment: $50 test-sized curves on testnets, $5,000 on mainnet (enforced).
    const terms=this.dex?assertDeploymentTerms(this.net,{startFdvUsd:startFdvUsdFor(this.net),graduationGrace:GRADUATION_GRACE_SECONDS}):null;
    this.onProgress(`Confirm the launchpad deployment. Oracle pricing will enforce the $10 launch fee and $${(terms?.startFdvUsd??5000).toLocaleString()} starting FDV…`);
    const contract = await new ContractFactory(artifact.abi, artifact.bytecode, this.signer).deploy(treasury, ...(this.dex?[migrationAdapter,terms.startFdvUsd,terms.graduationGrace]:[0n,1n]));
    this.onProgress('Deployment submitted. Waiting for confirmation…');
    await contract.waitForDeployment();
    const receipt = await contract.deploymentTransaction().wait();
    const record = { factory: await contract.getAddress(), block: receipt.blockNumber, hash: receipt.hash, treasury, migrationAdapter, model: modelOf(this.net.chainId, !!this.dex), metadataVersion:this.dex?1:undefined,feeAccountingVersion:this.dex?Number(await contract.FEE_ACCOUNTING_VERSION()):undefined,launchFeaturesVersion:this.dex&&this.config.contracts.atomicFactory?1:undefined,partnerTiersVersion:this.dex?Number(await contract.PARTNER_TIERS_VERSION()):undefined,reviewFixesVersion:this.dex?Number(await contract.REVIEW_FIXES_VERSION()):undefined };
    if(previousDeployment && !write('elpida:previous-factory:'+this.net.chainId+':'+previousDeployment.factory,previousDeployment))throw new Error('Factory deployed, but previous deployment could not be archived. Save the new factory '+record.factory+' manually.');
    this.launches.clear(); this.scannedBlock = undefined; this.factoryStartFdvUsd = undefined;this.pairsScanned=undefined;this.approvedQuotes=[];this.nativeVirtualQuote=undefined;this.launchFee=undefined;
    if (!write(deploymentKey(this.net.chainId, !!this.dex), record)) throw new Error(`Deployed, but this browser blocks storage. Save factory ${record.factory} (block ${record.block}) in packages/core/networks.mjs.`);
    if(external){
      this.needsMetadataUpgrade=false;this.feeAccountingVersion=record.feeAccountingVersion;
      const batch=await this.treasuryBatch(contract.connect(this.signer));
      return { hash: receipt.hash, safeBatch: batch, message: `Your ${this.net.name} launchpad is deployed with the Safe ${treasury} as its treasury (${safe.threshold} of ${safe.owners.length} signatures). The treasury setup file is downloading: import it in the Safe's Transaction Builder, then the signers approve it. Launches open once it executes.` };
    }
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
    if(version!==MODEL_VERSIONS[this.model]||(this.dex?!isDexModel(this.model):this.model!==BETA_MODEL))throw new Error('This launchpad needs the verified USD version, which its operator has not set up yet. Nothing was submitted.');
    if(this.model===DEX_MODEL&&!this.factoryStartFdvUsd)this.factoryStartFdvUsd=Number(await factory.startFdvUsd());
    if(!this.oracle?.available||(await factory.usdFeed()).toLowerCase()!==this.oracle.feed.toLowerCase()||await factory.maxPriceAge()!==BigInt(this.oracle.maxAge)||(await factory.feeUsdc()).toLowerCase()!==(this.oracle.usdc??ZeroAddress).toLowerCase())throw new Error('Launch pricing is not active on this launchpad yet. Its operator turns it on in the operator panel. Nothing was submitted.');
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
    if((await factory.treasury()).toLowerCase()!==this.address.toLowerCase()){const batch=await this.treasuryBatch(factory);return {safeBatch:batch,message:'The treasury is a Safe: the setup file is downloading. Import it in the Safe Transaction Builder for its signers to approve; launches open once it executes.'};}
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
      item = {...item,metadata:withSavedMetadata(item.metadata,await readMetadataCache(metadataKey(this.net.chainId,item.factory??this.deployment.factory,item.address)))};
      if(item.metadataURI){try{const response=await fetch('/api/metadata/resolve?uri='+encodeURIComponent(item.metadataURI));if(!response.ok)throw new Error('unavailable');item.metadata=normalizeMetadata(await response.json());item.metadataStatus='published';}catch{item.metadataStatus='unavailable';}}
      if(isV4Token(item))return v4TokenState(this,item);
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
      // A curve reopened after its graduation grace is fully sold but not complete: its completion quote reverts (audit
      // finding F-8), so it is not called. Since AIZEN was reopened (23 Oct) that revert failed every Base Sepolia read.
      const saleCap = await curve.SALE_CAP(), soldOut = !complete && !graduated && sold >= saleCap, noneLeft = complete || soldOut;
      return { ...item, ...v10, pool, graduated, complete, soldOut, liquidityLocked: graduated, quoteSymbol: this.qsym(item), quoteDecimals: d, spotPrice: Number(formatUnits(priceQ,d)) / Number(formatUnits(priceT,18)), circulatingSupply:formatUnits(circulation,18),saleCap: formatUnits(saleCap,18), remainingBuy: noneLeft ? '0' : formatUnits(await curve.completionQuote(),d), remainingBase: this.modelOf(item) !== DEX_MODEL ? undefined : noneLeft ? '0' : formatUnits(await curve.remainingAtBaseFee(),d), name, symbol, reward, reserve: formatUnits(reserve, d), sold: formatUnits(sold, 18), supply: formatUnits(supply, 18), balance: formatUnits(held, 18), protocolFees: formatUnits(protocol+p, d), creatorFees: formatUnits(creator+c, d) };
    }));
    const pairBalances = {};
    for (const a of this.approvedQuotes ?? []) { try { pairBalances[a.id] = formatUnits(await new Contract(a.address, this.config.contracts.quote.abi, this.provider).balanceOf(this.address), a.decimals); } catch {} }
    const treasury = await factory.treasury();
    // Live factory pricing and freshness are authoritative for creation.
    const pricing = { verified:true,price:this.price,launchFee: this.launchFee===undefined?'Unavailable':formatUnits(this.launchFee, 18), startFdv: this.nativeVirtualQuote===undefined?'Unavailable':formatUnits(this.model===DEX_MODEL?this.nativeVirtualQuote * 9n / 10n:this.nativeVirtualQuote * 15n / 16n, 18), symbol: native, matches:true, owner: treasury.toLowerCase() === this.address.toLowerCase() };
    const v4=v4Available(this.net)?{deployment:v4Deployment(this.net),owner:(v4Deployment(this.net)?.treasury??'').toLowerCase()===this.address.toLowerCase()}:null;
    return { wallet: this.address, v4, balance, balanceSymbol: native, pairBalances, nativeBalance: balance, nativeSymbol: native, wrappedNativeBalance:this.dex?formatUnits(await new Contract(this.dex.weth,this.config.contracts.quote.abi,this.provider).balanceOf(this.address),18):undefined, tokens, activity: [], pricing, treasuryBalance: formatUnits(await this.provider.getBalance(treasury), 18) };
  }
  /** The connected wallet's early-partner registration in this network's factory ({ buybackBps, expiresAt }), or null. */
  async partnerTier(){
    if(!this.deployment?.factory||!this.address)return null;
    try{const [bps,expiresAt]=await new Contract(this.deployment.factory,['function partners(address) view returns(uint16,uint64)'],this.provider).partners(this.address);return Number(bps)?{buybackBps:Number(bps),expiresAt:Number(expiresAt)}:null;}
    catch(e){if(['CALL_EXCEPTION','BAD_DATA'].includes(e.code))return null;throw e;}
  }
  async publicTokens(){
    const response=await fetch('/api/public/tokens?network='+encodeURIComponent(this.net.key));if(!response.ok)throw new Error('Public token discovery is unavailable.');
    const entries=await response.json();return Promise.all(entries.map(async item=>({...item,metadata:this.deployment&&!item.metadataURI?withSavedMetadata(item.metadata,await readMetadataCache(metadataKey(this.net.chainId,item.factory??this.deployment.factory,item.address))):item.metadata})));
  }
  async dexState(item,token,curve,pool,d){
    const market=new Contract(pool,this.config.contracts.dexPool.abi,this.provider),[slot,a,b,name,symbol,supply,sold,held,reward,cp,cc,locker,splitter]=await Promise.all([market.slot0(),market.token0(),market.token1(),token.name(),token.symbol(),token.totalSupply(),curve.sold(),token.balanceOf(this.address),curve.creatorRewardVault(),curve.protocolFees(),curve.creatorFees(),curve.locker(),curve.feeSplitter()]);
    const first=a.toLowerCase()===item.address.toLowerCase(),square=slot[0]*slot[0],Q=2n**192n,n=first?square:Q,den=first?Q:square,quoteAsset=first?b:a;
    const price=Number(formatUnits(n*10n**18n*10n**24n/(den*10n**BigInt(d)),24)),circulation=supply-await token.balanceOf('0x000000000000000000000000000000000000dead')-await token.balanceOf(item.curve)-await token.balanceOf(pool);
    const feeLocker=new Contract(locker,this.config.contracts.locker.abi,this.provider),manager=new Contract(await feeLocker.manager(),['function ownerOf(uint256) view returns(address)'],this.provider),positionId=await curve.positionId();
    const fees=new Contract(splitter,this.config.contracts.splitter.abi,this.provider),dexRewards=[];for(const asset of [a,b]){const isToken=asset.toLowerCase()===item.address.toLowerCase();dexRewards.push({asset,symbol:isToken?symbol:this.qsym(item,true),creator:formatUnits(await fees.claimable(asset,reward),isToken?18:d)});}
    return {...item,pool,graduated:true,complete:true,liquidityLocked:await feeLocker.locked()&&(await manager.ownerOf(positionId)).toLowerCase()===locker.toLowerCase(),locker,feeSplitter:splitter,positionId:positionId.toString(),venue:this.dex?.name??'Uniswap v3',feeBps:100,dexRewards,quoteSymbol:this.qsym(item),quoteDecimals:d,spotPrice:price,circulatingSupply:formatUnits(circulation,18),saleCap:formatUnits(await curve.SALE_CAP(),18),remainingBuy:'0',name,symbol,reward,reserve:formatUnits(await new Contract(quoteAsset,this.config.contracts.quote.abi,this.provider).balanceOf(pool),d),sold:formatUnits(sold,18),supply:formatUnits(supply,18),balance:formatUnits(held,18),protocolFees:formatUnits(cp,d),creatorFees:formatUnits(cc,d)};
  }
  async dexQuote(item,side,input){const asset=this.qaddr(item),quoter=new Contract(this.dex.quoter,this.config.contracts.quoter.abi,this.provider),result=await quoter.quoteExactInputSingle.staticCall({tokenIn:side==='buy'?asset:item.address,tokenOut:side==='buy'?item.address:asset,amountIn:input,fee:10000,sqrtPriceLimitX96:0});return result[0];}
  async dexTrade(item,side,body){
    const percent=Number(body.slippage);if(!Number.isFinite(percent)||percent<0.1||percent>5)throw new Error('Slippage must be between 0.1% and 5%.');
    const input=parseUnits(body.amount,side==='buy'?this.qd(item):18);if(input<=0n)throw new Error('Enter a positive amount.');
    const out=await this.dexQuote(item,side,input),minimum=out*(10000n-BigInt(Math.round(percent*100)))/10000n,asset=this.qaddr(item),router=this.router(this.signer),unwrap=side==='sell'&&item.pair==='native';
    const params={tokenIn:side==='buy'?asset:item.address,tokenOut:side==='buy'?item.address:asset,fee:this.dex.fee??10000,recipient:this.address,amountIn:input,amountOutMinimum:minimum};
    // An approval (only when needed: the launched token once for selling, payment assets exactly) and the swap go out
    // together: one confirmation on wallets that batch.
    const steps=[];
    if(side==='sell'||item.pair!=='native'){const payment=new Contract(params.tokenIn,this.config.contracts.quote.abi,this.signer),approval=approvalFor({allowance:await payment.allowance(this.address,router.target),input,sellingLaunchedToken:side==='sell',symbol:item.symbol});if(approval)steps.push({to:payment.target,data:payment.interface.encodeFunctionData('approve',[router.target,approval.amount]),label:approval.label});}
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
    if(isV4Token(item))return v4Quote(this,item,side,amount);
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
    // Model 11 (Uniswap v4 hook): its own factory, hook and router; never the curve launchpad below.
    if(action==='deploy-v4-pool-manager')return deployTestPoolManager(this);
    // Model 11 is retired for new launches (9 November 2026); its tokens still trade below.
    if(action==='launch'&&body?.model===V4_MODEL)throw new Error('Model 11 no longer takes new launches. Choose ELPIDA V2 (same locked Uniswap v4 pool, your own fee).');
    // ELPIDA V2.0: its own factory, hook, reward contracts and router; trades use the Model 11 path below.
    if(action==='deploy-v2')return deployV2(this,body??{});
    if(action==='approve-v2-stock')return approveV2Stock(this,body??{});
    if(action==='launch'&&body?.model===V2_MODEL)return launchV2(this,body);
    {const v4item=body?.token?this.launches.get(String(body.token).toLowerCase()):null;
      if(v4item&&isV4Token(v4item)){
        if(action==='buy'||action==='sell'){const r=await v4Trade(this,v4item,action,body);return {hash:r.tx.hash,message:`Trade confirmed on ${this.net.name} (Uniswap v4).`};}
        if(action==='withdraw'){const r=await v4WithdrawFees(this,v4item);return {hash:r.tx.hash,message:'Fees distributed to their recipient wallets.'};}
        throw new Error('This action is not available for Model 11 tokens.');
      }}
    const factory = (await this.verifyFactory()).connect(this.signer);
    let result;
    if (action === 'deploy-native-router') return this.deployNativeTradeRouter();
    if (action === 'setup-test-liquidity') return this.setupTestStockLiquidity(body);
    if (action === 'setup-pairs') return this.setupTestPairs(body);
    if (action === 'test-stock') return this.testStockControl(body ?? {});
    if (action === 'setup-usdc-pair') return this.setupUsdcPair();
    if (action === 'approve-stock') return this.approveStock(body);
    if (action === 'trade-native-pair') return this.tradeNativePair(body);
    if (action === 'convert-native-pair') return this.convertNativePair(body);
    if (action === 'convert-usdc') return this.convertUsdc(body);
    if (action === 'apply-pricing') return this.applyPricing();
    if (action === 'faucet' && body?.asset) {
      const a = (this.approvedQuotes ?? []).find(x => x.address.toLowerCase() === String(body.asset).toLowerCase() && x.test);
      if (!a) throw new Error('That asset has no test faucet.');
      const c = new Contract(a.address, ['function faucet(uint256)', 'function FAUCET_LIMIT() view returns(uint256)'], this.signer), limit = await c.FAUCET_LIMIT();
      result = await this.wait(c.faucet(limit), `Confirm the free ${a.symbol} test mint in your wallet…`);
      return { hash: result.tx.hash, message: `Added ${formatUnits(limit, a.decimals)} ${a.symbol} (test asset, no value).` };
    }
    if (action === 'faucet') throw new Error(`Get test ${this.net.nativeCurrency.symbol} from the network's public faucet.`);
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
      // First purchase paid in the native coin on a non-native pair: swapped into the pair asset first (launch-conversion.mjs).
      const payNative = body.firstBuyPayment === 'native';
      if (payNative && !paired) throw new Error('Native conversion is only for non-native trading pairs.');
      if (payNative && this.net.mainnet) throw new Error('Paying the first purchase in the native coin is testnet-only until mainnet routing is reviewed. Nothing was submitted.');
      const nativeBuy = payNative ? parseUnits(this.nativeAmount(body.nativeBuy), 18) : 0n;
      const ckey = payNative ? conversionKey({ chainId: this.net.chainId, factory: this.deployment.factory, account: this.address, asset: asset.address }) : null;
      const converted = payNative ? pendingConversion(localStorage, ckey) : null;
      // Until the swap runs, its guaranteed minimum stands in for the first buy in every check below.
      let firstBuy = payNative ? converted ?? (await quoteNativePairConversion({ Contract, provider: this.provider, dex: this.dex, asset: asset.address, amountIn: nativeBuy })).minimum : parseUnits(body.firstBuy || '0', nativePair ? 18 : asset.decimals);
      const name = body.name.trim(), symbol = body.symbol.trim().toUpperCase();
      if (firstBuy < 0n || !name || name.length > 40 || !/^[A-Z0-9]{1,10}$/.test(symbol)) throw new Error('Check the token name, symbol and creator buy.');
      if(firstBuy===0n){
        let supported=false;
        try{supported=await new Contract(this.deployment.factory,['function OPTIONAL_CREATOR_BUY_VERSION() view returns(uint256)'],this.provider).OPTIONAL_CREATOR_BUY_VERSION()>=1n;}catch(error){if(error.code!=='CALL_EXCEPTION')throw error;}
        if(!supported)throw new Error('This deployed factory requires an upgrade before zero-buy launches are available. Nothing was submitted.');
      }
      const reward = body.reward || this.address;
      if (!isAddress(reward) || reward === ZeroAddress) throw new Error('Enter a valid creator reward wallet.');
      const virtualQuote = paired ? asset.virtualQuote : await factory.nativeVirtualQuote(), virtualToken = await factory.VIRTUAL_TOKEN();
      // Model 10 partially fills a first buy larger than the curve; it then receives exactly the sale cap.
      const minimumOut = buy => { const net = buy - buy * 125n / 10000n, out = virtualToken * net / (virtualQuote + net); return this.model === DEX_MODEL && out > SALE_CAP ? SALE_CAP : out; };
      let cappedOut = minimumOut(firstBuy);
      // Native fees include a refundable 1% cap; USDC approvals are exactly ten units.
      const inUsdc=body.feeCurrency==='usdc';
      if(inUsdc && (await factory.treasury()).toLowerCase()===this.address.toLowerCase())throw new Error('This wallet is also the launchpad fee recipient. The contract cannot verify a USDC fee paid to the same wallet. Choose native payment for this test, or launch from a different funded wallet to test USDC fee collection. No launch was submitted.');
      const fee = await factory.launchFee(), value = (inUsdc?0n:(fee*101n+99n)/100n) + (nativePair ? firstBuy : 0n), native = this.net.nativeCurrency.symbol;
      const fundingError=nativeFundingError({balance:await this.provider.getBalance(this.address),value:value+(payNative&&converted===null?nativeBuy:0n),native,network:this.net.name,feeInUsdc:inUsdc});
      if(fundingError)throw new Error(fundingError);
      const pairToken = paired ? new Contract(asset.address, this.config.contracts.quote.abi, this.signer) : null;
      if (paired && !payNative && await pairToken.balanceOf(this.address) < firstBuy) throw new Error(`You need ${formatUnits(firstBuy, asset.decimals)} ${asset.symbol} for the first buy.${asset.test ? ' It is a test asset with no value.' : ''}`);
      let published;
      // Token details always go into the launch transaction, never afterwards. Where they cannot, nothing launches.
      const detailsError=launchDetailsError({chain:this.net.key,networkName:this.net.name,metadataSupported:!this.needsMetadataUpgrade,publiclyIndexed:!!this.deployment?.shared&&this.model===DEX_MODEL});
      if(detailsError)throw new Error(detailsError);
      {
        this.onProgress('Preparing public token details for the launch transaction…');
        const payload=JSON.stringify({network:this.net.key,name,symbol,...details}),proof=await prepareUploadProof(payload);
        const response=await fetch('/api/metadata/stage',{method:'POST',headers:{'Content-Type':'application/json','X-Elpida-Token':this.config.csrf,...proof},body:payload});
        published=await response.json();if(!response.ok)throw new Error(published.error??'Metadata publishing failed.');
        if(!/^ipfs:\/\//.test(published.uri)||!['public-ipfs','elpida-hosted'].includes(published.storage))throw new Error('Token details were not staged safely. No launch was submitted.');
        metadataStorage=published.storage;
        await this.checkNetwork();
      }
      if (payNative) {
        const amountText = amount => `${formatUnits(amount, asset.decimals)} ${asset.symbol}`;
        if (converted === null) this.onProgress(`Convert ${body.nativeBuy} ${native} into ${asset.symbol} for your first purchase: confirm the conversion in your wallet…`);
        const conversion = await convertForLaunch({ provider: this.provider, storage: localStorage, key: ckey, account: this.address, asset: asset.address,
          quote: () => quoteNativePairConversion({ Contract, provider: this.provider, dex: this.dex, asset: asset.address, amountIn: nativeBuy }),
          send: async route => {
            await this.checkNetwork();
            const deadline = BigInt((await this.provider.getBlock('latest')).timestamp + 300);
            const data = swapCalldata(Interface, this.dex.routerVersion ?? 2, this.dex.router, { tokenIn: route.tokenIn, tokenOut: route.tokenOut, fee: route.fee, recipient: this.address, amountIn: nativeBuy, amountOutMinimum: route.minimum }, { deadline, refundETH: true });
            return this.signer.sendTransaction({ to: this.dex.router, data, value: nativeBuy });
          },
          onSubmitted: () => this.onProgress('Conversion submitted. Waiting for the conversion to confirm…') });
        if (await pairToken.balanceOf(this.address) < conversion.amount) { localStorage.removeItem(ckey); throw new Error(`The ${amountText(conversion.amount)} converted earlier is no longer in this wallet. Press again to convert anew. Nothing was launched.`); }
        firstBuy = conversion.amount; cappedOut = minimumOut(firstBuy);
        this.onProgress(conversion.reused ? `Using the ${amountText(firstBuy)} you converted earlier. No new conversion is needed…` : `Converted into ${amountText(firstBuy)}. It is your first purchase; continue with the launch…`);
      }
      const sharedUsdc = inUsdc && paired && asset.address.toLowerCase()===this.feeUsdc?.toLowerCase();
      const approvalCalls=[],batchKey='elpida:launch-batch:'+this.net.chainId+':'+this.address.toLowerCase();
      const batchRequest=args=>this.eth.request(args);
      const atomic=await supportsAtomicLaunch(batchRequest,this.address,this.net.chainId);
      // Testnets: approve once per launchpad, then every launch is one confirmation. Mainnet: exact approvals.
      const approve=async(coin,needed,symbol,exactLabel)=>{
        const read=()=>coin.allowance(this.address,factory.target);
        const step=launchApproval({allowance:await read(),needed,mainnet:!!this.net.mainnet,symbol,exactLabel});
        if(!step)return;
        if(atomic){approvalCalls.push({to:coin.target,data:coin.interface.encodeFunctionData('approve',[factory.target,step.amount]),value:'0x0'});return;}
        await this.approvePayment(coin,factory.target,step.amount,step.label,inUsdc);
        await waitForAllowance(read,needed);
      };
      if (paired && !sharedUsdc) await approve(pairToken,firstBuy,asset.symbol,`Approve the ${asset.symbol} first buy…`);
      if(inUsdc){
        if(!this.feeUsdc||this.feeUsdc===ZeroAddress)throw new Error('USDC fee payment is unavailable on this network.');
        const coin=new Contract(this.feeUsdc,this.config.contracts.quote.abi,this.signer);
        const totalUsdc=10_000_000n+(sharedUsdc?firstBuy:0n);
        if(await coin.balanceOf(this.address)<totalUsdc)throw new Error('Add '+formatUnits(totalUsdc,6)+' USDC on this network for the launch fee'+(sharedUsdc?' and first purchase':'')+'. Native gas is separate.');
        await approve(coin,totalUsdc,'USDC','Approve exactly '+formatUnits(totalUsdc,6)+' USDC for the launch fee'+(sharedUsdc?' and first purchase':'')+'…');
      }
      await this.oraclePrice();await this.checkNetwork();
      // A factory that requires metadata reverts with "metadata required" when the URI is empty, and the URI must
      // be an ipfs:// document. Say so before the wallet is asked to sign, instead of letting the launch fail.
      if(!published?.uri){
        let required=false;
        try{required=await new Contract(factory.target,['function requiresMetadata() view returns(bool)'],this.provider).requiresMetadata();}catch{}
        if(required)throw new Error('This launchpad requires token details. Add a description or an image, then launch again.');
      }
      const args=[name,symbol,asset?.address??ZeroAddress,firstBuy,cappedOut*9950n/10000n,reward,published?.uri??'',inUsdc];
      // A separate estimate cannot simulate allowances that only exist inside the atomic batch.
      // The wallet must simulate the entire batch; ordinary launches retain the RPC estimate.
      const gas=approvalCalls.length?null:await factory.launchWithPayment.estimateGas(...args,{value});
      const gasPrice=(await this.provider.getFeeData()).maxFeePerGas??(await this.provider.getFeeData()).gasPrice??0n;
      const launchGasError=nativeFundingError({balance:await this.provider.getBalance(this.address),value,gasCost:gas===null?0n:gas*gasPrice,native,network:this.net.name,feeInUsdc:inUsdc});
      if(launchGasError)throw new Error(launchGasError);
      const confirmation='Confirm the '+(inUsdc?'10 USDC':'$10 equivalent native')+' launch fee, first purchase '+formatUnits(firstBuy,nativePair?18:asset.decimals)+' '+this.qsym({pair:kind,quoteSymbol:asset?.symbol})+(gas===null?' and wallet-estimated gas.':' and estimated gas '+formatUnits(gas*gasPrice,18)+' '+native+'.')+' '+(inUsdc?'USDC covers the launch fee; native currency covers gas.':'Native fee cap includes 1%; unused fee is refunded.');
      if(approvalCalls.length){
        const id=crypto.randomUUID(),calls=[...approvalCalls,{to:factory.target,data:factory.interface.encodeFunctionData('launchWithPayment',args),value:'0x'+value.toString(16)}];
        const record={id,chain:this.net.chainId,created:Date.now(),metadata:published?.metadata??details,uri:published?.uri,storage:metadataStorage};
        localStorage.setItem(batchKey,JSON.stringify(record));
        this.onProgress('Confirm one atomic launch in your wallet: payment approval, token details, creation and first purchase. '+confirmation);
        try{const sent=await withWalletTimeout(batchRequest({method:'wallet_sendCalls',params:[{version:'2.0.0',id,from:this.address,chainId:'0x'+BigInt(this.net.chainId).toString(16),atomicRequired:true,calls}]}),this.walletName);
          if(typeof sent?.id!=='string'||!sent.id)throw new Error('Wallet did not return a launch batch ID. Check it before retrying.');
          record.id=sent.id;localStorage.setItem(batchKey,JSON.stringify(record));
          this.onProgress('Launch batch submitted. Waiting for confirmation…');
          result=await this.confirmLaunchBatch(batchKey,record);
        }catch(error){if(error.code===4001||error.code==='ACTION_REJECTED')localStorage.removeItem(batchKey);throw error;}
      }else result=await this.wait(factory.launchWithPayment(...args,{value}),confirmation);
      const event = result.receipt.logs.map(log => {try{return factory.interface.parseLog(log);}catch{return null;}}).find(log => log?.name === 'Launched');
      launchedToken=event?.args.token;
      if (payNative && event) localStorage.removeItem(ckey);
      metadataSaved = !!event && await writeMetadataCache(metadataKey(this.net.chainId,this.deployment.factory,event.args.token),published?.metadata??details);
      if(published){metadataSaved=true;metadataPublished=true;}
    } else {
      const item = this.launches.get(body.token.toLowerCase());
      if (!item) throw new Error('Token not found.');
      if(item.tax){const result=await transactTaxMarket(this,item,action,body);return {hash:result.tx.hash,message:'Tax market transaction confirmed.'};}
      const curve = await this.market(item, this.signer);
      const original = new Contract(item.curve, this.artifacts.curve.abi, this.signer);
      if (action === 'reopen') { if (this.modelOf(item) !== DEX_MODEL) throw new Error('Only model 10 curves can be reopened.'); result = await this.wait(original.reopen(), 'Confirm reopening the curve for trading…'); }
      else if (action === 'graduate') result = await this.wait(original.graduate(), this.dex?`Confirm graduation into ${this.dex.name??'the DEX'}…`:'Confirm graduation into the locked test pool…');
      else if (action === 'withdraw') {
        await this.stockPreflight(item, 'withdraw');
        // Every step is zero-safe on-chain (withdrawFees, collectFees and claim all succeed with nothing owed), so a
        // batching wallet gets them all in ONE confirmation. Other wallets get only the steps that will move money.
        const steps = [], add = (contract, fn, label) => steps.push({ to: contract.target, data: contract.interface.encodeFunctionData(fn.name, fn.args), label });
        const batch = await this.multicallAvailable() || await this.canBatch();
        if ((await original.protocolFees()) + (await original.creatorFees()) > 0n) add(original, { name: 'withdrawFees', args: [] }, 'Claim bonding-curve fees…');
        if (await original.pool() !== ZeroAddress) {
          if (this.dex) {
            const locker = new Contract(await original.locker(), this.config.contracts.locker.abi, this.signer);
            const splitter = new Contract(await original.feeSplitter(), this.config.contracts.splitter.abi, this.signer);
            // What a collect would move right now (read-only dry run); unknown counts as "something".
            let collected = null; try { const [a0, a1] = await locker.collectFees.staticCall(); collected = new Map([[(await locker.token0()).toLowerCase(), a0], [(await locker.token1()).toLowerCase(), a1]]); } catch { collected = null; }
            const willCollect = collected === null || [...collected.values()].some(v => v > 0n);
            if (batch || willCollect) add(locker, { name: 'collectFees', args: [] }, `Collect ${this.dex.name??'DEX'} position fees…`);
            const recipients = [...new Set([(await this.factoryOf(item).treasury()).toLowerCase(), (await original.creatorRewardVault()).toLowerCase()])];
            for (const asset of [item.address, this.qaddr(item)]) {
              const incoming = collected === null ? 1n : (collected.get(String(asset).toLowerCase()) ?? 0n);
              for (const recipient of recipients) if (batch ? true : (await splitter.claimable(asset, recipient)) > 0n || incoming > 1n) add(splitter, { name: 'claim', args: [asset, recipient] }, 'Pay fees to their fixed recipient…');
            }
          } else add(curve, { name: 'withdrawFees', args: [] }, 'Claim locked-pool fees…');
        }
        if (!steps.length) throw new Error('Nothing to claim yet. Fees appear here once the curve or the pool has traded.');
        result = await this.sendPermissionless(steps, 'Claim fees to their fixed recipients.');
      }
      else if(this.dex&&await original.pool()!==ZeroAddress){await this.stockPreflight(item, action);result=await this.dexTrade(item,action,body);}
      else {
        const percent = Number(body.slippage);
        if (!Number.isFinite(percent) || percent < 0.1 || percent > 5) throw new Error('Slippage must be between 0.1% and 5%.');
        const input = parseUnits(body.amount, action === 'buy' ? this.qd(item) : 18);
        if (input <= 0n) throw new Error('Enter a positive amount.');
        await this.stockPreflight(item, action, { input, curve });
        const [out] = action === 'buy' ? await curve.quoteBuy(input) : await curve.quoteSell(input);
        const payment = action === 'buy' ? new Contract(this.qaddr(item) ?? ZeroAddress, this.config.contracts.quote.abi, this.signer) : new Contract(item.address, this.config.contracts.token.abi, this.signer);
        const marketAddress = await curve.getAddress();
        const steps = [];
        // Audit findings F-1 and E-2: a completing buy can be blocked by a pre-created pool priced away from the curve.
        // Clear it first (buy cheap tokens below, or sell into quote above, never past the graduation price), so this
        // one action still completes and graduates.
        if (action === 'buy' && this.dex) steps.push(...await this.graduationUnblock(item, original, input, out * (10000n - BigInt(Math.round(percent * 100))) / 10000n));
        if (!(action === 'buy' && item.pair === 'native')) { const approval = approvalFor({ allowance: await payment.allowance(this.address, marketAddress), input, sellingLaunchedToken: action === 'sell', symbol: item.symbol }); if (approval) steps.push({ to: payment.target, data: payment.interface.encodeFunctionData('approve', [marketAddress, approval.amount]), label: approval.label }); }
        const minimum = out * (10000n - BigInt(Math.round(percent * 100))) / 10000n;
        steps.push({ to: marketAddress, data: action === 'buy' ? curve.interface.encodeFunctionData('buy', [input, minimum]) : curve.interface.encodeFunctionData('sell', [input, minimum]), value: action === 'buy' && item.pair === 'native' ? input : 0n, label: 'Confirm the trade in your wallet…' });
        result = await this.sendCalls(steps, 'Confirm the trade.');
      }
    }
    return { hash: result.tx.hash, token:launchedToken, metadataSaved, metadataPublished, metadataStorage, message: action === 'launch' ? `Your token is live on ${this.net.name}.${metadataPublished ? (metadataStorage==='public-ipfs'?' Metadata pinned to public IPFS and linked on-chain.':' Metadata hosted by Elpida and linked on-chain; public IPFS pinning is not configured.') : metadataSaved ? ' Metadata saved in this browser.' : ' Browser metadata storage failed; keep a copy of your token details.'}` : action === 'withdraw' ? 'Fees distributed to their recipient wallets.' : `Trade confirmed on ${this.net.name}.` };
  }
}

/** A saved graduation adapter is reused only if its fee splitter has the buyback price guard (review finding E-1). */
async function adapterHasReviewFixes(address,provider){
  try{return Number(await new Contract(address,['function REVIEW_FIXES_VERSION() pure returns(uint256)'],provider).REVIEW_FIXES_VERSION())===1;}
  catch(error){if(error.code==='CALL_EXCEPTION'&&(!error.data||error.data==='0x'))return false;throw error;}
}
/** A saved graduation adapter is reused only if it passes the partner burn share to the LP fee splitter. */
async function adapterHasPartnerTiers(address,provider){
  try{return Number(await new Contract(address,['function PARTNER_TIERS_VERSION() pure returns(uint256)'],provider).PARTNER_TIERS_VERSION())===1;}
  catch(error){if(error.code==='CALL_EXCEPTION'&&(!error.data||error.data==='0x'))return false;throw error;}
}
