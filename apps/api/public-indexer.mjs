import { JsonRpcProvider, Contract, verifyMessage, keccak256, toUtf8Bytes } from 'ethers';
import { join } from 'node:path';
import { readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { EvmIndexer } from '../../packages/indexer/evm-indexer.mjs';
import { normalizeMetadata } from '../web/metadata.mjs';
import { isDexModel, MODEL_VERSIONS } from '../../packages/core/curve-model.mjs';

// A read-only worker per configured deployment. Never accepts user RPCs or private keys.
export class PublicIndexer {
  constructor({networks,contracts,dataDir,metadataStore,providerFactory=rpc=>new JsonRpcProvider(rpc,undefined,{cacheTimeout:-1,batchMaxCount:1}),log=console.log}){
    this.entries=new Map();this.metadataStore=metadataStore;this.log=log;this.stopping=false;
    for(const net of networks.filter(n=>n.shared?.factory)){
      const provider=providerFactory(process.env['ELPIDA_RPC_'+net.chainId]??net.rpcUrl);
      const dex=isDexModel(net.shared.model);
      const index=new EvmIndexer({provider,factory:net.shared.factory,contracts:{...contracts,factory:dex?contracts.dexFactory:contracts.legacyFactory,curve:dex?contracts.dexCurve:contracts.legacyCurve,...(!dex?{dexPool:undefined}:{})},path:join(dataDir,`public-${net.chainId}-${net.shared.factory.toLowerCase()}.sqlite`),chainId:net.chainId,fromBlock:net.shared.block,confirmations:2,nativeSymbol:net.nativeCurrency.symbol,batchSize:100});
      const metadataPath=join(dataDir,`public-metadata-${net.chainId}-${net.shared.factory.toLowerCase()}.json`);
      const metadata=new Map(existsSync(metadataPath)?Object.entries(JSON.parse(readFileSync(metadataPath,'utf8'))):[]);
      this.entries.set(net.key,{net,index,provider,metadata,metadataPath,validated:false,error:null,lastSuccess:null});
    }
  }
  async tick(){
    if(this.running||this.stopping)return;this.running=true;
    try{for(const e of this.entries.values()){
      try{
        if(!e.validated){const chain=Number((await e.provider.getNetwork()).chainId),v=Number(await new Contract(e.net.shared.factory,['function MODEL_VERSION() view returns(uint256)'],e.provider).MODEL_VERSION());if(chain!==e.net.chainId||v!==MODEL_VERSIONS[e.net.shared.model])throw new Error('Deployment identity mismatch');e.validated=true;}
        await e.index.sync();e.error=null;e.lastSuccess=new Date().toISOString();
        for(const t of e.index.tokens())if(t.metadataURI){
          // Only factory events synchronized by the validated chain index authorize retention.
          try{this.metadataStore.retainPublished(t.metadataURI);if(!e.metadata.has(t.address))e.metadata.set(t.address,normalizeMetadata(await this.metadataStore.resolve(t.metadataURI)));}catch{/* IPFS outage does not discard chain history. */}
        }
        this.log(JSON.stringify({event:'public_indexer_synced',network:e.net.key,...e.index.status(),error:null}));
      }catch(error){e.error='Indexing unavailable; retrying.';this.log(JSON.stringify({event:'public_indexer_error',network:e.net.key,code:String(error.code??error.name??'INDEX_ERROR').replace(/[^a-zA-Z0-9_]/g,'').slice(0,64),message:e.error}));}
    }}finally{this.running=false;}
  }
  start(){this.job=this.tick();this.timer=setInterval(()=>{this.job=this.tick();},15000);this.timer.unref();return this;}
  status(key){const e=this.entries.get(key);return e?{...e.index.status(),error:e.error,lastSuccess:e.lastSuccess,enabled:true}: {enabled:false,network:key,reason:'No public factory is configured for this network.'};}
  quotes(key){const e=this.entries.get(key);if(!e)return null;const status=e.index.status();if(!e.validated||status.indexedBlock==null)return null;return {factory:e.net.shared.factory,chainId:e.net.chainId,indexedBlock:status.indexedBlock,assets:e.index.db.prepare("SELECT data FROM events WHERE json_extract(data,'$.name')='QuoteApproved' ORDER BY height,idx").all().map(r=>JSON.parse(r.data)).filter(r=>r.kind==='factory'&&r.address.toLowerCase()===e.net.shared.factory.toLowerCase()).map(r=>r.args[0])};}
  listings(key){const e=this.entries.get(key);return e?e.index.listings().map(t=>({...t,metadata:e.metadata.get(t.address)??{},metadataStatus:t.metadataURI?'published':e.metadata.has(t.address)?'creator-signed':'browser-only',balance:'0',url:e.net.explorer+'/token/'+t.address,network:key})):[];}
  metadataMessage(body){
    const e=this.entries.get(body.network),token=e?.index.tokens().find(t=>t.address===String(body.token).toLowerCase());
    if(!token||token.metadataURI)throw new Error('Only indexed tokens without on-chain metadata can publish this signed fallback.');
    // Token details are final once published (D11): the signed fallback can be used once, never to edit.
    if(e.metadata.has(token.address))throw new Error('Token details are already published and cannot be changed.');
    if(!Number.isSafeInteger(body.expires)||body.expires<Date.now()/1000||body.expires>Date.now()/1000+300)throw new Error('Metadata signature expired. Prepare it again.');
    const metadata=normalizeMetadata(body.metadata),digest=keccak256(toUtf8Bytes(JSON.stringify(metadata)));
    return {e,token,metadata,message:`Elpida public token metadata\nChain: ${e.net.chainId}\nFactory: ${e.net.shared.factory.toLowerCase()}\nToken: ${token.address}\nMetadata hash: ${digest}\nExpires: ${body.expires}\nThis signature publishes token details to Elpida. It does not authorize a transfer.`};
  }
  saveMetadata(body){const {e,token,metadata,message}=this.metadataMessage(body);if(verifyMessage(message,body.signature).toLowerCase()!==token.creator.toLowerCase())throw new Error('Only the on-chain creator can publish these token details.');
    const updated=new Map(e.metadata);updated.set(token.address,metadata);writeFileSync(e.metadataPath+'.tmp',JSON.stringify(Object.fromEntries(updated)));renameSync(e.metadataPath+'.tmp',e.metadataPath);e.metadata=updated;return {saved:true};
  }
  detail(key,address,kind,interval=60){const e=this.entries.get(key),token=this.listings(key).find(t=>t.address===address.toLowerCase());if(!token)return null;return kind==='trades'?e.index.trades(address):kind==='candles'?e.index.candles(address,interval):kind==='holders'?e.index.holders(address):token;}
  async close(){this.stopping=true;clearInterval(this.timer);while(this.running)await new Promise(r=>setTimeout(r,100));for(const e of this.entries.values()){await e.index.close();e.provider.destroy();}}
}
