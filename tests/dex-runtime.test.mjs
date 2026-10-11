import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../apps/api/curve-runtime.mjs';
import {EvmIndexer} from '../packages/indexer/evm-indexer.mjs';
import {MetadataStore} from '../apps/api/metadata-store.mjs';
test('model 5 runtime indexes v3 trades, unwraps ETH sells and distributes position fees',async t=>{
 const store=new MetadataStore({jwt:null}),r=await createRuntime({dex:true,seed:false,metadataStore:store});t.after(()=>r.close());
 const launch=await r.transact('launch',{name:'DEX indexed',symbol:'DEX',pair:'native',firstBuy:'0.01',description:'Shared token details',image:'https://example.com/logo.png'}),token=launch.token;
 const uri=r.indexer.listings().find(t=>t.address===token).metadataURI;assert.match(uri,/^ipfs:\/\//);assert.equal((await store.resolve(uri)).description,'Shared token details');
 const terminal=r.indexer.snapshot(token).remainingBuy;await r.transact('buy',{token,amount:terminal});const price=Number(r.indexer.snapshot(token).spotPrice);
 await r.transact('graduate',{token});assert.ok(Math.abs(Number(r.indexer.snapshot(token).spotPrice)/price-1)<1e-6);assert.equal(r.indexer.snapshot(token).liquidityLocked,true);
 assert.ok(Number((await r.getQuote({token,side:'buy',amount:'0.1'})).out)>0);
 await r.transact('buy',{token,amount:'0.1'});const balance=await r.provider.getBalance(r.config.accounts[0].address);
 await r.transact('sell',{token,amount:'10000000'});assert.ok(await r.provider.getBalance(r.config.accounts[0].address)>balance,'native proceeds are unwrapped to ETH');
 assert.equal(r.indexer.trades(token)[0].venue,'dexPool');assert.equal(r.indexer.trades(token)[0].side,'sell');assert.equal(r.indexer.snapshot(token).priceUsd,null);
 const snap=await r.provider.send('evm_snapshot',[]),saved=r.indexer.trades(token).length;await r.transact('buy',{token,amount:'0.02'});await r.provider.send('evm_revert',[snap]);await r.indexer.sync();assert.equal(r.indexer.trades(token).length,saved,'orphan DEX swap removed');
 const replay=new EvmIndexer({provider:r.provider,factory:r.config.local.factory,contracts:r.config.contracts,fromBlock:r.indexer.fromBlock});await replay.sync();assert.deepEqual(replay.snapshot(token),r.indexer.snapshot(token));assert.deepEqual(replay.trades(token),r.indexer.trades(token));assert.equal(replay.listings().find(t=>t.address===token).metadataURI,uri);await replay.close();
 await r.transact('withdraw',{token});assert.ok(r.indexer.snapshot(token).dexRewards.every(a=>Number(a.creator)===0));assert.equal(r.indexer.status().lag,0);assert.ok(r.indexer.candles(token).length>0);
});
