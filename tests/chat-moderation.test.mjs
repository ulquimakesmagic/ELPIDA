import test from 'node:test';
import assert from 'node:assert/strict';
import {Wallet} from 'ethers';
import {HolderChat} from '../apps/api/holder-chat.mjs';
import {generateKeyPairSync,sign} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('signed reports bind room, reason, message and wallet; replay and lost holdings fail',async t=>{
 let now=2000000000000,holds=true;const chat=new HolderChat({origin:'https://example.test',holding:async()=>holds,now:()=>now});t.after(()=>chat.close());
 const a=Wallet.createRandom(),b=Wallet.createRandom(),token=Wallet.createRandom().address,body={network:'base-sepolia',token,author:a.address,text:'Original message'};
 const p=await chat.prepare(body),{id}=await chat.save({...body,nonce:p.nonce,signature:await a.signMessage(p.message)});
 const report={network:body.network,token,author:b.address,messageId:id,reason:'scam'},r=await chat.prepareReport(report),signature=await b.signMessage(r.message);
 await assert.rejects(chat.saveReport({...report,reason:'spam',nonce:r.nonce,signature}),/changed/);
 await assert.rejects(chat.saveReport({...report,nonce:r.nonce,signature:await a.signMessage(r.message)}),/selected wallet/);
 holds=false;await assert.rejects(chat.saveReport({...report,nonce:r.nonce,signature}),/Hold this token/);holds=true;
 await chat.saveReport({...report,nonce:r.nonce,signature});await assert.rejects(chat.saveReport({...report,nonce:r.nonce,signature}),/expired/);await assert.rejects(chat.prepareReport(report),/already reported/);
 await assert.rejects(chat.prepareReport({...report,token:Wallet.createRandom().address}),/Reply target/);
 assert.equal(chat.db.prepare('SELECT COUNT(*) AS n FROM chat_reports').get().n,1);
 assert.equal(JSON.stringify(chat.list(body.network,token)).includes('scam'),false);
 const expired=await chat.prepareReport({...report,author:a.address});now+=300001;await assert.rejects(chat.saveReport({...report,author:a.address,nonce:expired.nonce,signature:await a.signMessage(expired.message)}),/expired/);
});

test('moderation redacts public messages and reply quotes, restores originals, and records an audit',async t=>{
 let now=2000000000000;const chat=new HolderChat({origin:'https://example.test',holding:async()=>true,now:()=>now});t.after(()=>chat.close());const a=Wallet.createRandom(),token=Wallet.createRandom().address,body={network:'base-sepolia',token,author:a.address,text:'Original text'};
 async function post(body){const p=await chat.prepare(body);return chat.save({...body,nonce:p.nonce,signature:await a.signMessage(p.message)});}
 const {id}=await post(body);now+=15001;await post({...body,text:'Reply text',replyTo:id});
 chat.moderate(id,true,'Scam link');let page=chat.list(body.network,token);assert.equal(page.messages[0].hidden,true);assert.equal(page.messages[1].reply.hidden,true);assert.ok(!JSON.stringify(page).includes('Original text'));assert.ok(!JSON.stringify(page).includes('Scam link'));
 chat.moderate(id,false,'Appeal accepted');page=chat.list(body.network,token);assert.equal(page.messages[0].text,'Original text');assert.equal(page.messages[1].reply.text,'Original text');assert.equal(chat.db.prepare('SELECT COUNT(*) AS n FROM chat_moderation').get().n,2);assert.throws(()=>chat.moderate(id,true,''),/reason/);
});

test('spam checks apply at save time and normalize duplicate messages',async t=>{
 let now=2000000000000;const chat=new HolderChat({holding:async()=>true,now:()=>now});t.after(()=>chat.close());const a=Wallet.createRandom(),body={network:'base-sepolia',token:Wallet.createRandom().address,author:a.address,text:'Hello holders'};const first=await chat.prepare(body),second=await chat.prepare(body);await chat.save({...body,nonce:first.nonce,signature:await a.signMessage(first.message)});now+=15001;
 await assert.rejects(chat.save({...body,nonce:second.nonce,signature:await a.signMessage(second.message)}),/already posted/);await assert.rejects(chat.prepare({...body,text:'  HELLO   holders  '}),/already posted/);
 for(let n=1;n<20;n++){const b={...body,text:'Unique '+n},p=await chat.prepare(b);await chat.save({...b,nonce:p.nonce,signature:await a.signMessage(p.message)});now+=15001;}
 await assert.rejects(chat.prepare({...body,text:'One more'}),/limit reached/);now+=600001;await chat.prepare(body);
});

test('Solana reports and moderation survive restart without exposing originals publicly',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'elpida-chat-moderation-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'chat.sqlite');
 const {publicKey,privateKey}=generateKeyPairSync('ed25519'),author=new PublicKey(publicKey.export({format:'der',type:'spki'}).subarray(-32)).toBase58();let chat=new HolderChat({path,origin:'https://example.test',holding:async()=>true});
 const body={network:'solana-devnet',token:author,author,text:'Solana message'},signature=message=>sign(null,Buffer.from(message),privateKey).toString('base64');
 try{const p=await chat.prepare(body),{id}=await chat.save({...body,nonce:p.nonce,signature:signature(p.message)}),report={...body,messageId:id,reason:'spam'},r=await chat.prepareReport(report);await chat.saveReport({...report,nonce:r.nonce,signature:signature(r.message)});chat.moderate(id,true,'Spam');}finally{chat.close();}
 chat=new HolderChat({path,holding:async()=>true});try{assert.equal(chat.list(body.network,body.token).messages[0].hidden,true);assert.equal(chat.db.prepare('SELECT COUNT(*) AS n FROM chat_reports').get().n,1);assert.equal(chat.db.prepare('SELECT text FROM chat_messages').get().text,body.text);}finally{chat.close();}
});
