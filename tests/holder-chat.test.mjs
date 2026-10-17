import test from 'node:test';
import assert from 'node:assert/strict';
import {Wallet} from 'ethers';
import {generateKeyPairSync,sign} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HolderChat} from '../apps/api/holder-chat.mjs';
import {filterTrades} from '../apps/web/trade-filter.mjs';

const origin='https://elpida.example';
test('trade-side dropdown filters preserve chronological order and input rows',()=>{
 const rows=[{side:'sell',id:3},{side:'buy',id:2},{side:'sell',id:1}];
 assert.deepEqual(filterTrades(rows,'buy').map(r=>r.id),[2]);assert.deepEqual(filterTrades(rows,'sell').map(r=>r.id),[3,1]);assert.equal(filterTrades(rows,'all'),rows);assert.equal(rows.length,3);assert.throws(()=>filterTrades(rows,'other'));
});

test('chat verifies holder signatures, prevents replay and rejects body or reply tampering',async t=>{
 let now=2000000000000,holds=true;
 const store=new HolderChat({origin,now:()=>now,holding:async()=>holds});t.after(()=>store.close());
 const a=Wallet.createRandom(),b=Wallet.createRandom(),token=Wallet.createRandom().address;
 const body={network:'base-sepolia',token,author:a.address,text:'Hello holders!'},p=await store.prepare(body),signature=await a.signMessage(p.message);
 assert.match(p.message,/Site: https:\/\/elpida.example/);
 await assert.rejects(store.save({...body,text:'Changed',nonce:p.nonce,signature}),/expired or changed/);
 await assert.rejects(store.save({...body,nonce:p.nonce,signature:await b.signMessage(p.message)}),/selected wallet/);
 holds=false;await assert.rejects(store.save({...body,nonce:p.nonce,signature}),/no longer hold/);holds=true;
 const saved=await store.save({...body,nonce:p.nonce,signature});
 await assert.rejects(store.save({...body,nonce:p.nonce,signature}),/expired or changed/);
 await assert.rejects(store.prepare(body),/15 seconds/);
 now+=15001;
 const reply={...body,author:b.address,text:'Replying to you',replyTo:saved.id},r=await store.prepare(reply);
 await assert.rejects(store.save({...reply,replyTo:null,nonce:r.nonce,signature:await b.signMessage(r.message)}),/expired or changed/);
 await store.save({...reply,nonce:r.nonce,signature:await b.signMessage(r.message)});
 const page=store.list(body.network,token);assert.equal(page.messages.length,2);assert.equal(page.messages[1].reply.author,a.address.toLowerCase());
 const otherRoom={...body,token:Wallet.createRandom().address,replyTo:saved.id};await assert.rejects(store.prepare(otherRoom),/Reply target/);
 holds=false;await assert.rejects(store.prepare({...body,author:Wallet.createRandom().address}),/Hold this token/);
});

test('chat pagination, persistent history, expiry and quotas stay bounded',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'elpida-chat-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 let now=2000000000000;const path=join(dir,'chat.sqlite'),wallet=Wallet.createRandom(),body={network:'base-sepolia',token:Wallet.createRandom().address,author:wallet.address,text:'Message'};
 let store=new HolderChat({path,origin,holding:async()=>true,now:()=>now,maxMessages:3});
 try{
  const old=await store.prepare(body);now+=300001;await assert.rejects(store.save({...body,nonce:old.nonce,signature:await wallet.signMessage(old.message)}),/expired/);
  for(let n=0;n<3;n++){now+=15001;const p=await store.prepare({...body,text:'Message '+n});await store.save({...body,text:'Message '+n,nonce:p.nonce,signature:await wallet.signMessage(p.message)});}
  const first=store.list(body.network,body.token,{limit:2});assert.deepEqual(first.messages.map(m=>m.text),['Message 1','Message 2']);assert.ok(first.nextBefore);
  const older=store.list(body.network,body.token,{before:first.nextBefore,limit:2});assert.deepEqual(older.messages.map(m=>m.text),['Message 0']);
  now+=15001;await assert.rejects(store.prepare(body),/storage is full/);
  store.close();store=new HolderChat({path,origin,holding:async()=>true});assert.equal(store.list(body.network,body.token).messages.length,3);
  assert.throws(()=>store.list(body.network,body.token,{before:-1}),/Invalid chat page/);
 }finally{store.close();}
});

test('Solana chat uses Ed25519 signatures and a separate room identity',async t=>{
 const {publicKey,privateKey}=generateKeyPairSync('ed25519'),author=new PublicKey(publicKey.export({format:'der',type:'spki'}).subarray(-32)).toBase58();
 const store=new HolderChat({origin,holding:async()=>true});t.after(()=>store.close());
 const body={network:'solana-devnet',token:author,author,text:'Solana holder message'},p=await store.prepare(body),signature=sign(null,Buffer.from(p.message),privateKey).toString('base64');
 await assert.rejects(store.save({...body,network:'solana-mainnet',nonce:p.nonce,signature}),/changed/);
 await store.save({...body,nonce:p.nonce,signature});assert.equal(store.list(body.network,body.token).messages[0].author,author);
});

test('chat messages enter public backups without persisting unsigned draft text',async t=>{
 const {createPublicBackup,restorePublicBackup}=await import('../apps/api/storage-operations.mjs');
 const root=mkdtempSync(join(tmpdir(),'elpida-chat-backup-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const wallet=Wallet.createRandom(),body={network:'base-sepolia',token:Wallet.createRandom().address,author:wallet.address,text:'Published message'};
 const store=new HolderChat({path:join(root,'live','public-holder-chat.sqlite'),origin,holding:async()=>true});
 try{
  const p=await store.prepare(body);await store.save({...body,nonce:p.nonce,signature:await wallet.signMessage(p.message)});
  const unsigned={...body,author:Wallet.createRandom().address,text:'Unsigned draft must not be stored as text'};await store.prepare(unsigned);
  assert.ok(!store.db.prepare('PRAGMA table_info(chat_challenges)').all().some(c=>['text','message'].includes(c.name)));
  const manifest=await createPublicBackup(join(root,'live'),join(root,'backup'));assert.ok(manifest.files.some(f=>f.path==='public-holder-chat.sqlite'));
  restorePublicBackup(join(root,'backup'),join(root,'restored'));
  const restored=new HolderChat({path:join(root,'restored','public-holder-chat.sqlite'),origin,holding:async()=>true});
  try{assert.equal(restored.list(body.network,body.token).messages[0].text,body.text);}finally{restored.close();}
 }finally{store.close();}
});
