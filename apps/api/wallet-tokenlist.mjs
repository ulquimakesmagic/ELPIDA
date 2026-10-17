import {getAddress} from 'ethers';
import {readFileSync,existsSync,writeFileSync,renameSync} from 'node:fs';
import {tokenWalletImage} from '../web/wallet-token.mjs';

export function walletTokenEntries(networks,records,origin){
 const base=new URL(origin);if(base.protocol!=='https:')throw new Error('Public HTTPS origin required');
 const seen=new Set(),tokens=[];
 for(const net of networks){
  if(!Number.isSafeInteger(net.chainId)||net.chainId<1)continue;
  for(const t of records(net.key)){
   let address;try{address=getAddress(t.address);}catch{continue;}
   const identity=net.chainId+':'+address.toLowerCase();
   if(/^0x0{40}$/i.test(address)||seen.has(identity)||typeof t.name!=='string'||!t.name.trim()||t.name.length>40||typeof t.symbol!=='string'||!/^[A-Za-z0-9]{1,10}$/.test(t.symbol))continue;
   seen.add(identity);
   // All launch-factory ERC20s are ElpidaToken, with immutable 18 decimals.
   const logoURI=tokenWalletImage({...t,network:net.key},origin);
   tokens.push({chainId:net.chainId,address,name:t.name,symbol:t.symbol,decimals:18,...(logoURI?{logoURI}:{})});
  }
 }
 return tokens.sort((a,b)=>a.chainId-b.chainId||a.address.toLowerCase().localeCompare(b.address.toLowerCase()));
}

/** Persist revisions so consumers see stable, monotonic token-list versions. */
export class WalletTokenLists {
 constructor({path=null,now=()=>new Date()}={}){this.path=path;this.now=now;this.scopes=path&&existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};}
 publish(scope,tokens){
  const previous=this.scopes[scope];
  if(previous&&JSON.stringify(previous.tokens)===JSON.stringify(tokens))return previous;
  let version={major:1,minor:0,patch:0};
  if(previous){
   const ids=rows=>new Set(rows.map(t=>t.chainId+':'+t.address.toLowerCase()));
   const old=ids(previous.tokens),next=ids(tokens);
   version=[...old].some(k=>!next.has(k))?{major:previous.version.major+1,minor:0,patch:0}:[...next].some(k=>!old.has(k))?{...previous.version,minor:previous.version.minor+1,patch:0}:{...previous.version,patch:previous.version.patch+1};
  }
  const list={name:'Elpida launched tokens',timestamp:this.now().toISOString(),version,tokens};
  const scopes={...this.scopes,[scope]:list};
  if(this.path){writeFileSync(this.path+'.tmp',JSON.stringify(scopes));renameSync(this.path+'.tmp',this.path);}
  this.scopes=scopes;return list;
 }
}
