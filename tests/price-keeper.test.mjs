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

test('display prices renew before expiry instead of disappearing between refresh ticks',async()=>{
 let now=1000,calls=0;
 const fetcher=async()=>{calls++;return{ok:true,json:async()=>({ethereum:{usd:2500,last_updated_at:now},binancecoin:{usd:700,last_updated_at:now},solana:{usd:100,last_updated_at:now}})};};
 const k=new PriceKeeper({fetcher,now:()=>now,pythApiKey:null,oracles:{}});
 await k.refresh();now=1121;await k.refresh();assert.equal(calls,2);
 now=1181;assert.equal(k.snapshot()['solana-devnet'].status,'fresh');assert.equal(k.snapshot()['solana-devnet'].updatedAt,1121);
});

test('a fresh ETH oracle on another chain covers an unavailable chain without mixing native assets',()=>{
 let now=1000;const k=new PriceKeeper({now:()=>now,oracles:{}});
 k.values.ETH={usd:2500,updatedAt:700,source:'CoinGecko'};
 k.chainValues['ethereum-sepolia']={usd:2400,updatedAt:700,maxAge:180,source:'On-chain USD oracle'};
 k.chainValues['base-sepolia']={usd:2450,updatedAt:990,maxAge:1500,source:'On-chain USD oracle',feed:'verified-base-feed'};
 let p=k.snapshot();assert.equal(p['ethereum-sepolia'].status,'fresh');assert.equal(p['ethereum-sepolia'].feed,'verified-base-feed');assert.equal(p['ethereum-sepolia'].updatedAt,990);assert.equal(p['ethereum-sepolia'].referenceOnly,true);assert.equal(p['ethereum-sepolia'].sourceChain,'base-sepolia');
 assert.equal(p['bnb-testnet'].status,'unavailable');assert.equal(p['solana-devnet'].status,'unavailable');
 now=2500;p=k.snapshot();assert.equal(p['ethereum-sepolia'].status,'stale');assert.equal(p['ethereum-sepolia'].updatedAt,700);
});

test('verified on-chain SOL fallback survives a web-price outage without enabling mainnet references',async()=>{
 const {DISCRIMINATORS,PYTH_RECEIVER}=await import('../packages/solana/client.mjs');
 const {SOLANA_ORACLES}=await import('../packages/core/usd-oracles.mjs');
 const raw=Buffer.alloc(133);Buffer.from(DISCRIMINATORS.PriceUpdateV2).copy(raw);raw[40]=1;
 Buffer.from(SOLANA_ORACLES.devnet.feedId,'hex').copy(raw,41);raw.writeBigInt64LE(10000000000n,73);raw.writeBigUInt64LE(1000n,81);raw.writeInt32LE(-8,89);raw.writeBigInt64LE(1000n,93);
 let now=1000,owner=PYTH_RECEIVER,offline=false;
 const fetcher=async(url,options)=>{
  if(offline||url!=='https://api.devnet.solana.com')throw Error('source offline');
  assert.equal(JSON.parse(options.body).params[0],SOLANA_ORACLES.devnet.priceAccount);
  return{ok:true,json:async()=>({result:{value:{owner,data:[raw.toString('base64'),'base64']}}})};
 };
 const k=new PriceKeeper({fetcher,now:()=>now,pythApiKey:null,oracles:{}});await k.refresh();
 assert.equal(k.snapshot()['solana-devnet'].usd,100);assert.equal(k.snapshot()['solana-devnet'].status,'fresh');assert.equal(k.snapshot()['solana-devnet'].updatedAt,1000);assert.equal(k.snapshot()['solana-mainnet'].status,'unavailable');
 offline=true;now=1301;await k.refresh();assert.equal(k.snapshot()['solana-devnet'].status,'stale');assert.equal(k.snapshot()['solana-devnet'].updatedAt,1000);
 for(const bad of ['owner','partial','feed','confidence','stale','future','exponent']){
  const copy=Buffer.from(raw);let testOwner=PYTH_RECEIVER;
  if(bad==='owner')testOwner='wrong';if(bad==='partial')copy[40]=0;if(bad==='feed')copy[41]^=1;
  if(bad==='confidence')copy.writeBigUInt64LE(10000000000n,81);if(bad==='stale')copy.writeBigInt64LE(600n,93);if(bad==='future')copy.writeBigInt64LE(1100n,93);if(bad==='exponent')copy.writeInt32LE(1,89);
  const invalid=new PriceKeeper({now:()=>1000,oracles:{},pythApiKey:null,fetcher:async()=>({ok:true,json:async()=>({result:{value:{owner:testOwner,data:[copy.toString('base64'),'base64']}}})})});
  await assert.rejects(invalid.readSolanaOracle());assert.equal(invalid.snapshot()['solana-devnet'].status,'unavailable');
 }
});
