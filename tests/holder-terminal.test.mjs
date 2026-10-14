import test from 'node:test';
import assert from 'node:assert/strict';
import {Wallet} from 'ethers';
import {generateKeyPairSync,sign} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {positionSummary} from '../packages/core/position.mjs';
import {HolderTheses} from '../apps/api/holder-theses.mjs';
test('weighted average cost keeps remaining basis and realized P&L across partial sells',()=>{
 const p=positionSummary({trades:[{side:'buy',tokenAmount:'100',quoteAmount:'10'},{side:'buy',tokenAmount:'100',quoteAmount:'30'},{side:'sell',tokenAmount:'50',quoteAmount:'15'}],balance:'150',price:'0.3',supply:'1000000000'});
 assert.equal(p.basisKnown,true);assert.equal(p.costQuote,'30.0');assert.equal(p.entryMarketCapQuote,'200000000.0');assert.equal(p.realizedQuote,'5.0');assert.equal(p.unrealizedQuote,'15.0');assert.equal(p.unrealizedPercent,'50.0');
});
test('transfers, missing buys and router attribution never fabricate an entry or P&L',()=>{
 const base={trades:[{side:'buy',tokenAmount:'1',quoteAmount:'0.000000000000000001'}],balance:'1',price:0.00000001,supply:'1000000000'};assert.equal(positionSummary(base).basisKnown,true);assert.equal(positionSummary({...base,untrackedTransfers:true}).entryMarketCapQuote,null);assert.equal(positionSummary({...base,balance:'2'}).unrealizedQuote,null);assert.equal(positionSummary({...base,trades:[{...base.trades[0],account:'a',sender:'router',accountBasis:'pool recipient'}]}).basisKnown,false);
});
test('wallet-signed theses reject tampering, spoofing, replay and lost holdings; revisions survive restart',async t=>{
 const root=mkdtempSync(join(tmpdir(),'elpida-theses-'));t.after(()=>rmSync(root,{recursive:true,force:true}));let now=2000000000000,holds=true;const path=join(root,'public-theses.sqlite'),wallet=Wallet.createRandom(),other=Wallet.createRandom(),token=Wallet.createRandom().address,body={network:'base-sepolia',token,author:wallet.address,text:'My initial view.'};
 let store=new HolderTheses({path,origin:'https://elpida.example',now:()=>now,holding:async()=>holds});const prepared=await store.prepare(body),signature=await wallet.signMessage(prepared.message);await assert.rejects(store.save({...body,text:'Changed',nonce:prepared.nonce,signature}),/changed/);await assert.rejects(store.save({...body,nonce:prepared.nonce,signature:await other.signMessage(prepared.message)}),/selected wallet/);await store.save({...body,nonce:prepared.nonce,signature});await assert.rejects(store.save({...body,nonce:prepared.nonce,signature}),/expired or changed/);await assert.rejects(store.prepare(body),/one minute/);
 now+=60001;const updated={...body,text:'Updated view with new risks.'},p2=await store.prepare(updated);holds=false;await assert.rejects(store.save({...updated,nonce:p2.nonce,signature:await wallet.signMessage(p2.message)}),/no longer hold/);holds=true;await store.save({...updated,nonce:p2.nonce,signature:await wallet.signMessage(p2.message)});store.close();store=new HolderTheses({path,holding:async()=>holds});const i={network:body.network,token:token.toLowerCase(),author:wallet.address.toLowerCase()};assert.equal(store.list(i.network,i.token).length,1);assert.equal(store.history(i).length,2);assert.equal(store.latest(i).text,updated.text);store.close();
});
test('Solana holder messages use verified Ed25519 signatures',async()=>{
 const {publicKey,privateKey}=generateKeyPairSync('ed25519'),author=new PublicKey(publicKey.export({format:'der',type:'spki'}).subarray(-32)).toBase58(),store=new HolderTheses({holding:async()=>true}),body={network:'solana-devnet',token:author,author,text:'A Solana thesis.'};const p=await store.prepare(body);await store.save({...body,nonce:p.nonce,signature:sign(null,Buffer.from(p.message),privateKey).toString('base64')});assert.equal(store.history(body).length,1);store.close();
});
