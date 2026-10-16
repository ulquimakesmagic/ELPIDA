import {createHash} from 'node:crypto';
import {mkdirSync,existsSync,readFileSync,writeFileSync,readdirSync,statSync,renameSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {normalizeMetadata} from '../web/metadata.mjs';
export const validCid = value => typeof value === 'string' && /^(b[a-z2-7]{30,100}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/.test(value);
const base32 = bytes => {let result='',bits=0,value=0;for(const byte of bytes){value=(value<<8)|byte;bits+=8;while(bits>=5){bits-=5;result+='abcdefghijklmnopqrstuvwxyz234567'[(value>>>bits)&31];}}if(bits)result+='abcdefghijklmnopqrstuvwxyz234567'[(value<<(5-bits))&31];return result;};
export const rawCid = bytes => 'b'+base32(Buffer.concat([Buffer.from([1,0x55,0x12,0x20]),createHash('sha256').update(bytes).digest()]));
export const DEFAULT_IPFS_GATEWAY='https://ipfs.io/ipfs/';
/** Normalizes the optional gateway setting. A missing scheme or /ipfs/ path is added; anything still
 * unsafe falls back to the public gateway with a warning, so an optional typo cannot stop the server. */
export function ipfsGateway(value,{warn=message=>console.warn(JSON.stringify({event:'ipfs_gateway_invalid',message}))}={}){
  let text=String(value??'').trim();if(!text)return DEFAULT_IPFS_GATEWAY;
  if(!/^[a-z][a-z0-9+.-]*:\/\//i.test(text))text='https://'+text;
  let url=null;try{url=new URL(text);}catch{}
  if(!url||url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!url.hostname.includes('.')){warn('ELPIDA_IPFS_GATEWAY must be an HTTPS gateway address such as https://NAME.mypinata.cloud/ipfs/ (no credentials or query parameters). Using '+DEFAULT_IPFS_GATEWAY+' instead.');return DEFAULT_IPFS_GATEWAY;}
  if(url.pathname==='/')url.pathname='/ipfs/';
  return url.href.replace(/\/?$/,'/');
}
export class MetadataStore {
  constructor({path=null,jwt=process.env.PINATA_JWT,gateway=process.env.ELPIDA_IPFS_GATEWAY,fetcher=fetch,maxBytes=512*1024*1024,maxPendingBytes=100*1024*1024,pendingAge=7*86400000,now=Date.now,chainBound=false}={}) {
    for(const n of [maxBytes,maxPendingBytes,pendingAge])if(!Number.isSafeInteger(n)||n<=0)throw new Error('Invalid metadata storage limits.');
    this.path=path?resolve(path):null;this.jwt=jwt;this.fetcher=fetcher;this.cache=new Map();this.maxBytes=maxBytes;this.maxPendingBytes=maxPendingBytes;this.pendingAge=pendingAge;this.now=now;this.chainBound=chainBound;this.records=new Map();this.retention={};
    this.gateway=ipfsGateway(gateway);if(this.path){mkdirSync(this.path,{recursive:true});this.ledger=join(this.path,'retention.json');if(existsSync(this.ledger))this.retention=JSON.parse(readFileSync(this.ledger,'utf8'));for(const f of readdirSync(this.path)){const cid=f.replace(/\.json$/,'');if(f.endsWith('.json')&&validCid(cid))this.records.set(cid,statSync(join(this.path,f)).size);}}
  }
  status(){return {publicEnabled:!!this.jwt,provider:this.jwt?'Pinata':'local',gateway:this.gateway,storage:{bytes:[...this.records.values()].reduce((a,b)=>a+b,0),pendingBytes:[...this.records].reduce((a,[cid,size])=>a+(this.retention[cid]?.state==='pending'?size:0),0),expiredPendingBytes:[...this.records].reduce((a,[cid,size])=>a+(this.retention[cid]?.state==='pending'&&this.now()-this.retention[cid].createdAt>this.pendingAge?size:0),0),maxBytes:this.maxBytes,maxPendingBytes:this.maxPendingBytes,pendingAge:this.pendingAge}};}
  saveRetention(){if(this.ledger){writeFileSync(this.ledger+'.tmp',JSON.stringify(this.retention));renameSync(this.ledger+'.tmp',this.ledger);}}
  // An old upload may belong to a delayed/pending launch. Never delete it by age alone.
  remember(cid,record){this.cache.delete(cid);this.cache.set(cid,record);while(this.path&&[...this.cache.values()].reduce((sum,r)=>sum+r.data.length,0)>16*1024*1024)this.cache.delete(this.cache.keys().next().value);}
  file(cid){if(!validCid(cid))throw new Error('Invalid IPFS content identifier.');return this.path?join(this.path,cid+'.json'):null;}
  get(cid){const file=this.file(cid);if(this.cache.has(cid))return this.cache.get(cid);if(file&&existsSync(file)){const record=JSON.parse(readFileSync(file,'utf8'));if(cid.startsWith('bafkre')&&rawCid(Buffer.from(record.data,'base64'))!==cid)throw new Error('Stored IPFS content integrity check failed.');this.remember(cid,record);return record;}return null;}
  put(cid,bytes,type,provisional=false){provisional=provisional||this.chainBound;const record={type,data:Buffer.from(bytes).toString('base64')},encoded=JSON.stringify(record),size=Buffer.byteLength(encoded),file=this.file(cid);if(!this.records.has(cid)){const s=this.status().storage;if(s.bytes+size>this.maxBytes||provisional&&s.pendingBytes+size>this.maxPendingBytes)throw Object.assign(new Error('Metadata storage limit reached. No launch was submitted. Retry after storage capacity is restored.'),{code:'METADATA_QUOTA'});this.retention[cid]={state:provisional?'pending':'retained',createdAt:this.now()};this.saveRetention();if(file){writeFileSync(file+'.tmp',encoded);renameSync(file+'.tmp',file);}this.records.set(cid,size);}else if(!provisional&&this.retention[cid]?.state==='pending'){this.retention[cid].state='retained';this.saveRetention();}this.remember(cid,record);return cid;}
  retainPublished(uri){if(typeof uri!=='string'||!uri.startsWith('ipfs://'))throw new Error('Invalid published metadata reference.');const cid=uri.slice(7),record=this.get(cid);if(!record)return;const ids=[cid];if(record.type==='application/json'){const image=JSON.parse(Buffer.from(record.data,'base64').toString()).image;if(typeof image==='string'&&image.startsWith('ipfs://')&&validCid(image.slice(7)))ids.push(image.slice(7));}let changed=false;for(const id of ids)if(this.retention[id]?.state==='pending'){this.retention[id].state='retained';changed=true;}if(changed)this.saveRetention();}
  async publishBytes(bytes,type,name,publicMode,provisional=false){
    let cid=rawCid(bytes);
    if(publicMode){
      if(!this.jwt)throw new Error('Public metadata publishing is not configured. Set PINATA_JWT on the server first.');
      const form=new FormData();form.append('network','public');form.append('file',new Blob([bytes],{type}),name);form.append('name',name);form.append('cid_version','v1');
      let response;try{response=await this.fetcher('https://uploads.pinata.cloud/v3/files',{method:'POST',headers:{Authorization:'Bearer '+this.jwt},body:form,signal:AbortSignal.timeout(30000)});}catch{throw new Error('IPFS upload could not finish. No launch was submitted.');}
      if(!response.ok)throw new Error('IPFS provider rejected the upload. Check its server key and quota. No launch was submitted.');
      cid=(await response.json()).data?.cid;if(!validCid(cid))throw new Error('IPFS provider returned an invalid content identifier.');
    }
    this.put(cid,bytes,type,provisional);return 'ipfs://'+cid;
  }
  async publish(body,publicMode=false,{provisional=false}={}){
    provisional=provisional||this.chainBound;
    const details=normalizeMetadata(body),name=String(body.name??'').trim(),symbol=String(body.symbol??'').trim().toUpperCase();
    if(!name||name.length>40||!/^[A-Z0-9]{1,10}$/.test(symbol))throw new Error('Check the token name and ticker.');
    if(publicMode && !this.jwt)throw new Error('Public metadata publishing is not configured. Set PINATA_JWT on the server first.');
    const storage=this.status().storage;if(storage.bytes+Buffer.byteLength(JSON.stringify(body))+20000>this.maxBytes||provisional&&storage.pendingBytes+Buffer.byteLength(JSON.stringify(body))+20000>this.maxPendingBytes)throw Object.assign(new Error('Metadata storage limit reached. No launch was submitted.'),{code:'METADATA_QUOTA'});
    if(details.image.startsWith('data:')){const [head,data]=details.image.split(',');details.image=await this.publishBytes(Buffer.from(data,'base64'),head.slice(5,head.indexOf(';')),'logo.'+head.slice(11,head.indexOf(';')),publicMode,provisional);}
    // A hosted URL remains an external asset; only uploaded logos are pinned immutably.
    const document={schema:'elpida-token-v1',name,symbol,...details};
    const uri=await this.publishBytes(Buffer.from(JSON.stringify(document)),'application/json','token.json',publicMode,provisional);
    return {uri,public:publicMode,metadata:await this.resolve(uri)};
  }
  async resolve(uri){
    if(typeof uri!=='string'||!uri.startsWith('ipfs://')||!validCid(uri.slice(7)))throw new Error('Only an IPFS metadata content identifier is supported.');
    const cid=uri.slice(7);let record=this.get(cid);
    if(!record){
      const response=await this.fetcher(this.gateway+cid,{redirect:'error',signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw new Error('Token metadata is temporarily unavailable.');
      const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>20000)throw new Error('Token metadata document is too large.');chunks.push(chunk);}
      const bytes=Buffer.concat(chunks);if(cid.startsWith('bafkre')&&rawCid(bytes)!==cid)throw new Error('IPFS metadata integrity check failed.');
      record={type:'application/json',data:bytes.toString('base64')};
    }
    if(record.type!=='application/json')throw new Error('The content is not token metadata.');
    const document=JSON.parse(Buffer.from(record.data,'base64').toString());
    if(document.schema!=='elpida-token-v1')throw new Error('Unsupported token metadata format.');
    let image=document.image??'';
    if(image.startsWith('ipfs://')){const imageCid=image.slice(7);if(!validCid(imageCid))throw new Error('Invalid image content identifier.');image=this.get(imageCid)?'/api/content/'+imageCid:this.gateway+imageCid;}
    // Local content links are generated here, never accepted from an untrusted document.
    const details=normalizeMetadata({...document,image:image.startsWith('/api/content/')?'':image});
    return {...details,image,name:String(document.name??'').slice(0,40),symbol:String(document.symbol??'').slice(0,10)};
  }
}
