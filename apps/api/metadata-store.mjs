import {createHash} from 'node:crypto';
import {mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {normalizeMetadata} from '../web/metadata.mjs';
export const validCid = value => typeof value === 'string' && /^(b[a-z2-7]{30,100}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/.test(value);
const base32 = bytes => {let result='',bits=0,value=0;for(const byte of bytes){value=(value<<8)|byte;bits+=8;while(bits>=5){bits-=5;result+='abcdefghijklmnopqrstuvwxyz234567'[(value>>>bits)&31];}}if(bits)result+='abcdefghijklmnopqrstuvwxyz234567'[(value<<(5-bits))&31];return result;};
export const rawCid = bytes => 'b'+base32(Buffer.concat([Buffer.from([1,0x55,0x12,0x20]),createHash('sha256').update(bytes).digest()]));
export class MetadataStore {
  constructor({path=null,jwt=process.env.PINATA_JWT,gateway=process.env.ELPIDA_IPFS_GATEWAY??'https://ipfs.io/ipfs/',fetcher=fetch}={}) {
    this.path=path;this.jwt=jwt;this.fetcher=fetcher;this.cache=new Map();
    const url=new URL(gateway);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('Use an HTTPS IPFS gateway without credentials or query parameters.');
    this.gateway=url.href.replace(/\/?$/,'/');if(path)mkdirSync(path,{recursive:true});
  }
  status(){return {publicEnabled:!!this.jwt,provider:this.jwt?'Pinata':'local',gateway:this.gateway};}
  file(cid){if(!validCid(cid))throw new Error('Invalid IPFS content identifier.');return this.path?join(this.path,cid+'.json'):null;}
  get(cid){const file=this.file(cid);if(this.cache.has(cid))return this.cache.get(cid);if(file&&existsSync(file)){const record=JSON.parse(readFileSync(file,'utf8'));if(cid.startsWith('bafkre')&&rawCid(Buffer.from(record.data,'base64'))!==cid)throw new Error('Stored IPFS content integrity check failed.');this.cache.set(cid,record);return record;}return null;}
  put(cid,bytes,type){const record={type,data:Buffer.from(bytes).toString('base64')};const file=this.file(cid);if(file&&!existsSync(file))writeFileSync(file,JSON.stringify(record),{flag:'wx'});this.cache.set(cid,record);return cid;}
  async publishBytes(bytes,type,name,publicMode){
    let cid=rawCid(bytes);
    if(publicMode){
      if(!this.jwt)throw new Error('Public metadata publishing is not configured. Set PINATA_JWT on the server first.');
      const form=new FormData();form.append('network','public');form.append('file',new Blob([bytes],{type}),name);form.append('name',name);form.append('cid_version','v1');
      let response;try{response=await this.fetcher('https://uploads.pinata.cloud/v3/files',{method:'POST',headers:{Authorization:'Bearer '+this.jwt},body:form,signal:AbortSignal.timeout(30000)});}catch{throw new Error('IPFS upload could not finish. No launch was submitted.');}
      if(!response.ok)throw new Error('IPFS provider rejected the upload. Check its server key and quota. No launch was submitted.');
      cid=(await response.json()).data?.cid;if(!validCid(cid))throw new Error('IPFS provider returned an invalid content identifier.');
    }
    this.put(cid,bytes,type);return 'ipfs://'+cid;
  }
  async publish(body,publicMode=false){
    const details=normalizeMetadata(body),name=String(body.name??'').trim(),symbol=String(body.symbol??'').trim().toUpperCase();
    if(!name||name.length>40||!/^[A-Z0-9]{1,10}$/.test(symbol))throw new Error('Check the token name and ticker.');
    if(publicMode && !this.jwt)throw new Error('Public metadata publishing is not configured. Set PINATA_JWT on the server first.');
    if(details.image.startsWith('data:')){const [head,data]=details.image.split(',');details.image=await this.publishBytes(Buffer.from(data,'base64'),head.slice(5,head.indexOf(';')),'logo.'+head.slice(11,head.indexOf(';')),publicMode);}
    // A hosted URL remains an external asset; only uploaded logos are pinned immutably.
    const document={schema:'elpida-token-v1',name,symbol,...details};
    const uri=await this.publishBytes(Buffer.from(JSON.stringify(document)),'application/json','token.json',publicMode);
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
