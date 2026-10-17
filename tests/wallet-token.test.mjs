import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {watchEvmToken,walletImageURL,tokenWalletImage} from '../apps/web/wallet-token.mjs';
import {walletTokenEntries,WalletTokenLists} from '../apps/api/wallet-tokenlist.mjs';
const address='0x0000000000000000000000000000000000000001';
const cid='bafkrei'+'a'.repeat(52),origin='https://elpida.example';
const token={address,name:'Example',symbol:'EX',metadata:{image:'/api/content/'+cid}};

test('wallet image URLs expose public content and reject browser-only or arbitrary relative paths',()=>{
 assert.equal(walletImageURL(token.metadata.image,origin),origin+token.metadata.image);
 assert.equal(walletImageURL('ipfs://'+cid,origin),'https://ipfs.io/ipfs/'+cid);
 for(const input of ['data:image/png;base64,a','javascript:alert(1)','/api/config','//evil.example/logo.png','https://user:secret@example.com/a','https://127.0.0.1/logo.png','https://10.0.0.1/logo.png'])assert.equal(walletImageURL(input,origin),null);
});

test('add-to-wallet commits chain, address, canonical symbol, decimals and image without requesting accounts',async()=>{
 const calls=[];const provider={request:async q=>{calls.push(q);return q.method==='eth_chainId'?'0x14a34':true;}};
 assert.equal((await watchEvmToken({provider,chainId:84532,token,origin})).status,'added');
 assert.deepEqual(calls.map(q=>q.method),['eth_chainId','wallet_watchAsset']);
 assert.deepEqual(calls[1].params.options,{address,chainId:84532,symbol:'EX',decimals:18,image:origin+token.metadata.image});
 calls.length=0;
 await assert.rejects(watchEvmToken({provider,chainId:1,token,origin}),/Switch your wallet/);assert.equal(calls.length,1);
});

test('unsupported and rejected wallet requests do not claim a token was added',async()=>{
 for(const [code,status] of [[4200,'unsupported'],[-32601,'unsupported'],[4001,'declined']]){
  const provider={request:async q=>{if(q.method==='eth_chainId')return '0x1';throw Object.assign(new Error('Not accepted'),{code});}};
  assert.equal((await watchEvmToken({provider,chainId:1,token,origin})).status,status);
 }
});

test('token lists separate identical addresses by chain and persist monotonic revisions',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'elpida-tokenlist-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const networks=[{key:'base',chainId:8453},{key:'eth',chainId:1}];
 const tokens=walletTokenEntries(networks,()=>[token,token],origin);
 assert.equal(tokens.length,2);assert.equal(tokens[0].chainId,1);assert.equal(tokens[0].logoURI,origin+token.metadata.image);
 const path=join(dir,'lists.json'),lists=new WalletTokenLists({path});
 const first=lists.publish('all',tokens);assert.deepEqual(first.version,{major:1,minor:0,patch:0});
 assert.deepEqual(lists.publish('all',tokens),first);
 const updated=tokens.map(t=>({...t,logoURI:'https://example.com/new.png'}));
 const second=new WalletTokenLists({path}).publish('all',updated);assert.equal(second.version.patch,1);
 const removed=new WalletTokenLists({path}).publish('all',updated.slice(0,1));assert.equal(removed.version.major,2);
});

test('only published legacy image bytes get a public, chain-scoped wallet image URL',()=>{
 const legacy={...token,network:'base-sepolia',metadataStatus:'creator-signed',metadata:{image:'data:image/png;base64,iVBORw0KGgo='}};
 assert.equal(tokenWalletImage(legacy,origin),origin+'/api/wallet-logo/base-sepolia/'+address);
 assert.equal(tokenWalletImage({...legacy,metadataStatus:'browser-only'},origin),null);
 assert.equal(tokenWalletImage({...legacy,network:'../api/config'},origin),null);
 const rows=walletTokenEntries([{key:'base-sepolia',chainId:84532}],()=>[legacy],origin);
 assert.equal(rows[0].logoURI,origin+'/api/wallet-logo/base-sepolia/'+address);
});
