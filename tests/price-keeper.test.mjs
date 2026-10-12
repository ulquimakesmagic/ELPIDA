import test from 'node:test';
import assert from 'node:assert/strict';
import {PriceKeeper,validatePrice,CHAIN_ASSET} from '../apps/api/price-keeper.mjs';
test('keeper covers supported native assets, coalesces requests and preserves stale timestamps',async()=>{
 let now=1000,calls=0,fail=false;
 const fetcher=async()=>{calls++;if(fail)throw Error('offline');return{ok:true,json:async()=>({ethereum:{usd:2500,last_updated_at:now},binancecoin:{usd:700,last_updated_at:now},solana:{usd:100,last_updated_at:now}})};};
 const k=new PriceKeeper({fetcher,now:()=>now,pythApiKey:null,oracles:{}});
 const [a,b]=await Promise.all([k.refresh(),k.refresh()]);assert.equal(calls,1);assert.deepEqual(a,b);
 assert.equal(Object.keys(a).length,Object.keys(CHAIN_ASSET).length);assert.equal(a['bnb-testnet'].usd,700);assert.equal(a['solana-devnet'].usd,100);
 fail=true;now=1200;await k.refresh();assert.equal(k.snapshot()['base-sepolia'].status,'stale');assert.equal(k.snapshot()['base-sepolia'].updatedAt,1000);
});
test('invalid, negative, future, stale and missing prices cannot be used',()=>{
 for(const p of [{usd:0,updatedAt:1000},{usd:-1,updatedAt:1000},{usd:NaN,updatedAt:1000},{usd:1,updatedAt:1100},{usd:1,updatedAt:800},{usd:1},{}])assert.throws(()=>validatePrice(p,1000));
 assert.equal(validatePrice({usd:1,updatedAt:820},1000).usd,1);
});
test('Pyth identities and confidence are checked before display',async()=>{
 const ids={ETH:'a'.repeat(64),BNB:'b'.repeat(64),SOL:'c'.repeat(64)};
 const fetcher=async url=>({ok:true,json:async()=>{
   if(url.includes('/price_feeds')){const symbol=Object.keys(ids).find(s=>url.includes(s+'%2F'));return[{id:ids[symbol],attributes:{symbol:'Crypto.'+symbol+'/USD'}}];}
   if(url.includes('/updates/')){const id=Object.values(ids).find(i=>url.includes(i));return{parsed:[{id,price:{price:'250000000000',expo:-8,conf:'1',publish_time:1000}}]};}
   throw Error('unexpected fallback');
 }});
 const k=new PriceKeeper({fetcher,now:()=>1000,pythApiKey:'test-only',oracles:{}});await k.refresh();assert.equal(k.snapshot().local.source,'Pyth Hermes');assert.equal(k.snapshot().local.usd,2500);
});
test('invalid Pyth identity, confidence or freshness falls back to timestamped CoinGecko data',async()=>{
 for(const bad of ['identity','confidence','missing-confidence','freshness']){
  const id='a'.repeat(64);
  const fetcher=async url=>({ok:true,json:async()=>{
   if(url.includes('/price_feeds')){const symbol=['ETH','BNB','SOL'].find(s=>url.includes(s+'%2F'));return[{id,attributes:{symbol:'Crypto.'+symbol+'/USD'}}];}
   if(url.includes('/updates/'))return{parsed:[{id:bad==='identity'?'b'.repeat(64):id,price:{price:'250000000000',expo:-8,conf:bad==='missing-confidence'?undefined:bad==='confidence'?'250000000000':'1',publish_time:bad==='freshness'?700:1000}}]};
   return{ethereum:{usd:2500,last_updated_at:1000},binancecoin:{usd:700,last_updated_at:1000},solana:{usd:100,last_updated_at:1000}};
  }});
  const k=new PriceKeeper({fetcher,now:()=>1000,pythApiKey:'test-only',oracles:{}});await k.refresh();assert.equal(k.snapshot().local.source,'CoinGecko');assert.equal(k.snapshot().local.updatedAt,1000);
 }
});
test('fresh Pyth display references take precedence without changing on-chain fee enforcement',()=>{
 const k=new PriceKeeper({now:()=>1000,oracles:{}});k.values.ETH={usd:2500,updatedAt:1000,source:'Pyth Hermes'};k.chainValues['base-sepolia']={usd:2400,updatedAt:1000,source:'On-chain USD oracle'};
 assert.equal(k.snapshot()['base-sepolia'].source,'Pyth Hermes');k.values.ETH.updatedAt=700;assert.equal(k.snapshot()['base-sepolia'].source,'On-chain USD oracle');
});
