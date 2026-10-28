import { JsonRpcProvider, Contract, verifyMessage, keccak256, toUtf8Bytes } from 'ethers';
import { join } from 'node:path';
import { readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { EvmIndexer, mapLimit } from '../../packages/indexer/evm-indexer.mjs';
import { normalizeMetadata } from '../web/metadata.mjs';
import { isDexModel, MODEL_VERSIONS } from '../../packages/core/curve-model.mjs';
import { testnetDexes } from '../../packages/core/uniswap.mjs';

// A read-only worker per configured deployment. Never accepts user RPCs or private keys.
// How often the public indexes poll, and how many networks sync at once. A trade is visible to the API once the
// network that carries it has been read, so the interval is the freshness of every trade endpoint.
// The EVM networks expose no WebSocket endpoint, so a block is seen no sooner than one poll. 3 s is the floor that
// stays inside the public RPCs' rate limits for four chains; ELPIDA_INDEX_INTERVAL_MS tunes it per deployment.
const TICK_MS=Math.max(1500,Math.min(60000,Number(process.env.ELPIDA_INDEX_INTERVAL_MS)||3000));
const TICK_CONCURRENCY=Math.max(1,Math.min(8,Number(process.env.ELPIDA_INDEX_CONCURRENCY)||3));
// One token's inline data: image made every listing 1.1 MB. A listing ships the URL instead; the bytes are
// served once by /api/wallet-logo and cached by the browser.
const INLINE_IMAGE=/^data:image\//i;
export const publicMetadata=(entry,token)=>{
  const metadata=entry.metadata.get(token.address)??{};
  const image=typeof metadata.image==='string'?metadata.image:'';
  return INLINE_IMAGE.test(image)?{...metadata,image:`/api/wallet-logo/${entry.net.key}/${token.address}`,imageInline:true}:metadata;
};
export class PublicIndexer {
  constructor({networks,contracts,dataDir,metadataStore,onTrades,providerFactory=rpc=>new JsonRpcProvider(rpc,undefined,{cacheTimeout:-1,batchMaxCount:1}),log=console.log}){
    this.entries=new Map();this.legacy=new Map();this.metadataStore=metadataStore;this.log=log;this.stopping=false;
    this.providerFactory=providerFactory;this.rpcs=new Map();this.onTrades=onTrades??null;
    for(const net of networks.filter(n=>n.shared?.factory)){
      // An operator override is used alone; otherwise the network's RPC, then its server-side fallbacks.
      const override=process.env['ELPIDA_RPC_'+net.chainId],list=override?[override]:[net.rpcUrl,...(net.rpcFallbacks??[])];
      this.rpcs.set(net.key,{list,index:0,failures:0});
      const provider=providerFactory(list[0]);
      this.entries.set(net.key,openEntry({net,deployment:net.shared,provider,contracts,dataDir}));
      // Earlier team factories on the same network stay indexed, so their tokens remain listed and tradable.
      const older=(net.legacy??[]).filter(d=>d?.factory&&d.factory.toLowerCase()!==net.shared.factory.toLowerCase());
      this.legacy.set(net.key,older.map(deployment=>openEntry({net,deployment,provider,contracts,dataDir,legacy:true})));
      if(net.taxDeployment?.factory)this.legacy.get(net.key).push(openEntry({net,deployment:{...net.taxDeployment,model:'curve-tax-v10'},provider,contracts,dataDir}));
    }
  }
  /** The current deployment first, then any legacy deployments on the same network. */
  all(key){const e=this.entries.get(key);return e?[e,...(this.legacy?.get(key)??[])]:[];}
  /** The deployment entry that indexed `address` on network `key`, or null. */
  /** The stored image, including an inline data: URI, for the one route that serves it. */
  rawImage(key,address){const entry=this.entryFor(key,address);const image=entry?.metadata?.get(String(address).toLowerCase())?.image;return typeof image==='string'?image:null;}
  entryFor(key,address){const a=String(address).toLowerCase();return this.all(key).find(e=>Boolean(e.index.tokenAt(a)))??null;}
  /** Trade rows across every deployment on the network, in timestamp order. */
  tradeRows(key){
    const entries=this.all(key);if(entries.length<2)return entries[0]?.index.db.prepare('SELECT data FROM trades ORDER BY timestamp').iterate()??[];
    return entries.flatMap(e=>e.index.db.prepare('SELECT timestamp,data FROM trades').all()).sort((a,b)=>a.timestamp-b.timestamp);
  }
  /**
   * One pass over every deployment (or only network `only`). Each deployment has its own in-flight flag, so a slow or
   * failing network never holds the others back: the next pass starts whatever is idle.
   */
  async tick(only=null){
    if(this.stopping)return;
    const due=[...this.entries.keys()].filter(key=>!only||key===only).flatMap(key=>this.all(key)).filter(e=>!e.busy);
    if(!due.length)return;
    for(const e of due)e.busy=true;
    this.inFlight=(this.inFlight??0)+due.length;
    try{await mapLimit(due,TICK_CONCURRENCY,async e=>{
      try{
        if(!e.validated){const d=deploymentOf(e),chain=Number((await e.provider.getNetwork()).chainId),v=Number(await new Contract(d.factory,['function MODEL_VERSION() view returns(uint256)'],e.provider).MODEL_VERSION());if(chain!==e.net.chainId||v!==MODEL_VERSIONS[d.model])throw new Error('Deployment identity mismatch');e.validated=true;}
        await e.index.sync();e.error=null;e.errorCode=null;e.lastSuccess=new Date().toISOString();
        this.publishFresh(e);
        if(!e.legacy){const r=this.rpcs?.get(e.net.key);if(r)r.failures=0;}
        for(const t of e.index.tokens())if(t.metadataURI){
          // Only factory events synchronized by the validated chain index authorize retention.
          try{this.metadataStore.retainPublished(t.metadataURI);if(!e.metadata.has(t.address))e.metadata.set(t.address,normalizeMetadata(await this.metadataStore.resolve(t.metadataURI)));}catch{/* IPFS outage does not discard chain history. */}
        }
        this.log(JSON.stringify({event:'public_indexer_synced',network:e.net.key,...(e.legacy?{factory:deploymentOf(e).factory}:{}),...e.index.status(),error:null}));
      }catch(error){
        e.error='Indexing unavailable; retrying.';e.errorCode=errorCode(error);
        this.log(JSON.stringify({event:'public_indexer_error',network:e.net.key,...(e.legacy?{factory:deploymentOf(e).factory}:{}),code:e.errorCode,rpc:rpcHost(this.rpcs?.get(e.net.key)),message:e.error}));
        if(!e.legacy)this.failover(e.net.key);
      }finally{e.busy=false;this.inFlight--;}
    });}catch{/* each deployment reports its own error above */}
  }
  get running(){return (this.inFlight??0)>0;}
  /**
   * Hands the trades this pass added to the live feed. The first pass after a restart only records the tip, so a
   * deploy does not replay the whole history to every open stream.
   */
  publishFresh(e){
    if(!this.onTrades)return;
    const tip=e.index.tip()?.height;
    if(tip==null)return;
    if(e.pushedHeight==null||tip<e.pushedHeight){e.pushedHeight=tip;return;}
    if(tip===e.pushedHeight)return;
    const fresh=e.index.tradesSince(e.pushedHeight);
    e.pushedHeight=tip;
    if(fresh.length)this.onTrades(e.net.key,fresh);
  }
  /**
   * After repeated failures on one public RPC (a node that refuses the server's address, rate-limits it or has pruned
   * the state), move every deployment on that network to the next configured RPC. Reads only; nothing is signed.
   */
  failover(key){
    const r=this.rpcs?.get(key);if(!r)return;r.failures++;
    if(r.failures<PublicIndexer.FAILOVER_AFTER||r.list.length<2)return;
    const from=rpcHost(r);r.index=(r.index+1)%r.list.length;r.failures=0;
    const provider=this.providerFactory(r.list[r.index]),old=new Set();
    for(const e of this.all(key)){old.add(e.provider);e.provider=provider;e.index.provider=provider;e.validated=false;}
    for(const p of old)p.destroy?.();
    this.log(JSON.stringify({event:'public_indexer_rpc_failover',network:key,from,to:rpcHost(r)}));
  }
  static FAILOVER_AFTER=3;
  start(){this.job=this.tick();this.timer=setInterval(()=>{this.job=this.tick();},TICK_MS);this.timer.unref();return this;}
  status(key){const e=this.entries.get(key);return e?{...e.index.status(),error:e.error,errorCode:e.errorCode??null,rpc:rpcHost(this.rpcs?.get(key)),lastSuccess:e.lastSuccess,enabled:true,
    // Earlier launchpads on the same network have their own index; a stuck one must be visible too.
    legacy:(this.legacy?.get(key)??[]).map(l=>{const s=l.index.status();return {factory:deploymentOf(l).factory,indexedBlock:s.indexedBlock,lag:s.lag,error:l.error??null,errorCode:l.errorCode??null,lastSuccess:l.lastSuccess??null};})}: {enabled:false,network:key,reason:'No public factory is configured for this network.'};}
  quotes(key){const e=this.entries.get(key);if(!e)return null;const status=e.index.status();if(!e.validated||status.indexedBlock==null)return null;const factory=deploymentOf(e).factory;return {factory,chainId:e.net.chainId,indexedBlock:status.indexedBlock,assets:e.index.db.prepare("SELECT data FROM events WHERE json_extract(data,'$.name')='QuoteApproved' ORDER BY height,idx").all().map(r=>JSON.parse(r.data)).filter(r=>r.kind==='factory'&&r.address.toLowerCase()===factory.toLowerCase()).map(r=>r.args[0])};}
  /** Tokens from every deployment on the network. `extra(entry, token)` adds per-deployment fields. */
  /** The listing row for a single token; `listings(key)` exists for the market list, not for one page. */
  listing(key,address,extra){
    const e=this.entryFor(key,address),t=e?.index.tokenAt(address);if(!t)return null;
    const d=deploymentOf(e),s=e.index.snapshot(t.address)??{};
    return {...t,...s,metadata:publicMetadata(e,t),metadataStatus:t.metadataURI?'published':e.metadata.has(t.address)?'creator-signed':'browser-only',balance:'0',url:e.net.explorer+'/token/'+t.address,network:key,factory:d.factory,deploymentModel:d.model,legacyDeployment:!!e.legacy,...(extra?.(e,t)??{})};
  }
  listings(key,extra){return this.all(key).flatMap(e=>{const d=deploymentOf(e);return e.index.listings().map(t=>({...t,metadata:publicMetadata(e,t),metadataStatus:t.metadataURI?'published':e.metadata.has(t.address)?'creator-signed':'browser-only',balance:'0',url:e.net.explorer+'/token/'+t.address,network:key,factory:d.factory,deploymentModel:d.model,legacyDeployment:!!e.legacy,...(extra?.(e,t)??{})}));});}
  // No post-launch metadata path: details are published only in the launch transaction. Details a creator signed
  // before this rule (22-23 Oct 2026 testnet) are still loaded from metadata.json and shown as before.
  /** Latest trades on every indexed network, each with the token's public name, symbol and image. */
  /** A wallet's balances on one network, across every deployment indexed there. Skips entries that are not validated. */
  balancesOf(key,owner){return this.all(key).filter(e=>e.validated&&!e.error).flatMap(e=>e.index.balancesOf(owner).map(b=>({...b,network:key})));}
  recentTrades(limit=20){const out=[];for(const key of this.entries.keys()){const tokens=new Map(this.listings(key).map(t=>[t.address.toLowerCase(),t]));for(const e of this.all(key))for(const trade of e.index.recentTrades(limit)){const t=tokens.get(String(trade.token).toLowerCase());if(t)out.push(recentTrade(key,t,trade));}}return out.sort((a,b)=>b.timestamp-a.timestamp).slice(0,limit);}
  detail(key,address,kind,interval=60){const e=this.entryFor(key,address),token=this.listing(key,address);if(!token)return null;return kind==='trades'?e.index.trades(address):kind==='candles'?e.index.candles(address,interval):kind==='holders'?e.index.holders(address):token;}
  async close(){this.stopping=true;clearInterval(this.timer);while(this.running)await new Promise(r=>setTimeout(r,100));const providers=new Set();for(const e of [...this.entries.keys()].flatMap(key=>this.all(key))){await e.index.close();providers.add(e.provider);}for(const p of providers)p.destroy();}
}

const deploymentOf=e=>e.deployment??e.net.shared;
/** A short, safe error code for logs and the public status (letters, digits and _ only; never a message or URL). */
const errorCode=error=>String(error?.code??error?.name??'INDEX_ERROR').replace(/[^a-zA-Z0-9_]/g,'').slice(0,64)||'INDEX_ERROR';
/** The RPC host in use, without path or query, so keys in operator-supplied URLs never leak. */
const rpcHost=r=>{try{return new URL(r.list[r.index]).host;}catch{return null;}};
/** A trade for public display: no amounts or accounts, only what the "Last sale" strip shows. */
export const recentTrade=(network,token,trade)=>({network,address:token.address,name:token.metadata?.name??token.name,symbol:token.metadata?.symbol??token.symbol,image:token.metadata?.image??null,side:trade.side,timestamp:Number(trade.timestamp),tx:trade.hash??trade.tx??null,height:Number(trade.blockNumber??trade.slot??trade.height??0)||null,index:Number(trade.index??trade.idx??0)});
/**
 * A trade row from either index (EVM: hash, index, blockNumber; Solana: hash, idx, slot) in the live feed's shape:
 * what the strip, the Explore feed and the token page's trades table render. Rows of unknown tokens are dropped.
 */
export function feedTrades(network,rows,listings){
  const tokens=new Map((listings??[]).map(t=>[String(t.address).toLowerCase(),t]));
  return (rows??[]).flatMap(row=>{
    const token=tokens.get(String(row?.token??'').toLowerCase());
    if(!token||!(row.hash??row.tx))return [];
    return [{...recentTrade(network,token,row),priceQuote:Number(row.priceQuote)||null,quoteSymbol:token.quoteSymbol??row.quoteSymbol??null,quoteAmount:row.quoteAmount??null,tokenAmount:row.tokenAmount??null,account:row.account??null,venue:row.venue??null,launch:Boolean(row.launch)}];
  });
}
function openEntry({net,deployment,provider,contracts,dataDir,legacy=false}){
  const tax=deployment.model==='curve-tax-v10',dex=isDexModel(deployment.model)||tax,factory=deployment.factory.toLowerCase();
  const taxPair={abi:['function token0() view returns(address)','function token1() view returns(address)','function getReserves() view returns(uint112,uint112,uint32)','function totalSupply() view returns(uint256)','function balanceOf(address) view returns(uint256)','event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)']};
  const index=new EvmIndexer({provider,factory:deployment.factory,contracts:{...contracts,factory:tax?contracts.taxFactory:dex?contracts.dexFactory:contracts.legacyFactory,curve:tax?contracts.taxCurve:dex?contracts.dexCurve:contracts.legacyCurve,...(!dex?{dexPool:undefined}:{}),...(tax?{tax:true,token:contracts.taxToken,dexPool:taxPair,pool:taxPair}:{})},path:join(dataDir,`public-${net.chainId}-${factory}.sqlite`),chainId:net.chainId,fromBlock:deployment.block,confirmations:1,nativeSymbol:net.nativeCurrency.symbol,batchSize:100,dexName:testnetDexes[net.key]?.name??'Uniswap v3',fullRefreshMs:60000});
  const metadataPath=join(dataDir,`public-metadata-${net.chainId}-${factory}.json`);
  const metadata=new Map(existsSync(metadataPath)?Object.entries(JSON.parse(readFileSync(metadataPath,'utf8'))):[]);
  return {net,deployment,legacy,index,provider,metadata,metadataPath,validated:false,error:null,lastSuccess:null};
}
