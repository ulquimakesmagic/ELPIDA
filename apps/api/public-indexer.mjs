import { JsonRpcProvider, Contract, verifyMessage, keccak256, toUtf8Bytes } from 'ethers';
import { join } from 'node:path';
import { readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { EvmIndexer } from '../../packages/indexer/evm-indexer.mjs';
import { normalizeMetadata } from '../web/metadata.mjs';
import { isDexModel, MODEL_VERSIONS } from '../../packages/core/curve-model.mjs';

// A read-only worker per configured deployment. Never accepts user RPCs or private keys.
export class PublicIndexer {
  constructor({networks,contracts,dataDir,metadataStore,providerFactory=rpc=>new JsonRpcProvider(rpc,undefined,{cacheTimeout:-1,batchMaxCount:1}),log=console.log}){
    this.entries=new Map();this.legacy=new Map();this.metadataStore=metadataStore;this.log=log;this.stopping=false;
    for(const net of networks.filter(n=>n.shared?.factory)){
      const provider=providerFactory(process.env['ELPIDA_RPC_'+net.chainId]??net.rpcUrl);
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
  entryFor(key,address){const a=String(address).toLowerCase();return this.all(key).find(e=>e.index.tokens().some(t=>t.address===a))??null;}
  /** Trade rows across every deployment on the network, in timestamp order. */
  tradeRows(key){
    const entries=this.all(key);if(entries.length<2)return entries[0]?.index.db.prepare('SELECT data FROM trades ORDER BY timestamp').iterate()??[];
    return entries.flatMap(e=>e.index.db.prepare('SELECT timestamp,data FROM trades').all()).sort((a,b)=>a.timestamp-b.timestamp);
  }
  async tick(){
    if(this.running||this.stopping)return;this.running=true;
    try{for(const e of [...this.entries.keys()].flatMap(key=>this.all(key))){
      try{
        if(!e.validated){const d=deploymentOf(e),chain=Number((await e.provider.getNetwork()).chainId),v=Number(await new Contract(d.factory,['function MODEL_VERSION() view returns(uint256)'],e.provider).MODEL_VERSION());if(chain!==e.net.chainId||v!==MODEL_VERSIONS[d.model])throw new Error('Deployment identity mismatch');e.validated=true;}
        await e.index.sync();e.error=null;e.lastSuccess=new Date().toISOString();
        for(const t of e.index.tokens())if(t.metadataURI){
          // Only factory events synchronized by the validated chain index authorize retention.
          try{this.metadataStore.retainPublished(t.metadataURI);if(!e.metadata.has(t.address))e.metadata.set(t.address,normalizeMetadata(await this.metadataStore.resolve(t.metadataURI)));}catch{/* IPFS outage does not discard chain history. */}
        }
        this.log(JSON.stringify({event:'public_indexer_synced',network:e.net.key,...(e.legacy?{factory:deploymentOf(e).factory}:{}),...e.index.status(),error:null}));
      }catch(error){e.error='Indexing unavailable; retrying.';this.log(JSON.stringify({event:'public_indexer_error',network:e.net.key,...(e.legacy?{factory:deploymentOf(e).factory}:{}),code:String(error.code??error.name??'INDEX_ERROR').replace(/[^a-zA-Z0-9_]/g,'').slice(0,64),message:e.error}));}
    }}finally{this.running=false;}
  }
  start(){this.job=this.tick();this.timer=setInterval(()=>{this.job=this.tick();},15000);this.timer.unref();return this;}
  status(key){const e=this.entries.get(key);return e?{...e.index.status(),error:e.error,lastSuccess:e.lastSuccess,enabled:true}: {enabled:false,network:key,reason:'No public factory is configured for this network.'};}
  quotes(key){const e=this.entries.get(key);if(!e)return null;const status=e.index.status();if(!e.validated||status.indexedBlock==null)return null;const factory=deploymentOf(e).factory;return {factory,chainId:e.net.chainId,indexedBlock:status.indexedBlock,assets:e.index.db.prepare("SELECT data FROM events WHERE json_extract(data,'$.name')='QuoteApproved' ORDER BY height,idx").all().map(r=>JSON.parse(r.data)).filter(r=>r.kind==='factory'&&r.address.toLowerCase()===factory.toLowerCase()).map(r=>r.args[0])};}
  /** Tokens from every deployment on the network. `extra(entry, token)` adds per-deployment fields. */
  listings(key,extra){return this.all(key).flatMap(e=>{const d=deploymentOf(e);return e.index.listings().map(t=>({...t,metadata:e.metadata.get(t.address)??{},metadataStatus:t.metadataURI?'published':e.metadata.has(t.address)?'creator-signed':'browser-only',balance:'0',url:e.net.explorer+'/token/'+t.address,network:key,factory:d.factory,deploymentModel:d.model,legacyDeployment:!!e.legacy,...(extra?.(e,t)??{})}));});}
  // No post-launch metadata path: details are published only in the launch transaction. Details a creator signed
  // before this rule (22-23 Oct 2026 testnet) are still loaded from metadata.json and shown as before.
  /** Latest trades on every indexed network, each with the token's public name, symbol and image. */
  recentTrades(limit=20){const out=[];for(const key of this.entries.keys()){const tokens=new Map(this.listings(key).map(t=>[t.address.toLowerCase(),t]));for(const e of this.all(key))for(const trade of e.index.recentTrades(limit)){const t=tokens.get(String(trade.token).toLowerCase());if(t)out.push(recentTrade(key,t,trade));}}return out.sort((a,b)=>b.timestamp-a.timestamp).slice(0,limit);}
  detail(key,address,kind,interval=60){const e=this.entryFor(key,address),token=this.listings(key).find(t=>t.address===address.toLowerCase());if(!token)return null;return kind==='trades'?e.index.trades(address):kind==='candles'?e.index.candles(address,interval):kind==='holders'?e.index.holders(address):token;}
  async close(){this.stopping=true;clearInterval(this.timer);while(this.running)await new Promise(r=>setTimeout(r,100));const providers=new Set();for(const e of [...this.entries.keys()].flatMap(key=>this.all(key))){await e.index.close();providers.add(e.provider);}for(const p of providers)p.destroy();}
}

const deploymentOf=e=>e.deployment??e.net.shared;
/** A trade for public display: no amounts or accounts, only what the "Last sale" strip shows. */
export const recentTrade=(network,token,trade)=>({network,address:token.address,name:token.metadata?.name??token.name,symbol:token.metadata?.symbol??token.symbol,image:token.metadata?.image??null,side:trade.side,timestamp:Number(trade.timestamp)});
function openEntry({net,deployment,provider,contracts,dataDir,legacy=false}){
  const tax=deployment.model==='curve-tax-v10',dex=isDexModel(deployment.model)||tax,factory=deployment.factory.toLowerCase();
  const taxPair={abi:['function token0() view returns(address)','function token1() view returns(address)','function getReserves() view returns(uint112,uint112,uint32)','function totalSupply() view returns(uint256)','function balanceOf(address) view returns(uint256)','event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)']};
  const index=new EvmIndexer({provider,factory:deployment.factory,contracts:{...contracts,factory:tax?contracts.taxFactory:dex?contracts.dexFactory:contracts.legacyFactory,curve:tax?contracts.taxCurve:dex?contracts.dexCurve:contracts.legacyCurve,...(!dex?{dexPool:undefined}:{}),...(tax?{tax:true,token:contracts.taxToken,dexPool:taxPair,pool:taxPair}:{})},path:join(dataDir,`public-${net.chainId}-${factory}.sqlite`),chainId:net.chainId,fromBlock:deployment.block,confirmations:2,nativeSymbol:net.nativeCurrency.symbol,batchSize:100});
  const metadataPath=join(dataDir,`public-metadata-${net.chainId}-${factory}.json`);
  const metadata=new Map(existsSync(metadataPath)?Object.entries(JSON.parse(readFileSync(metadataPath,'utf8'))):[]);
  return {net,deployment,legacy,index,provider,metadata,metadataPath,validated:false,error:null,lastSuccess:null};
}
