import test from 'node:test';
import assert from 'node:assert/strict';
import {protocolAnalytics} from '../apps/api/protocol-analytics.mjs';
const now=2000000000;
const token={address:'TokenCase',name:'Example',pair:'native',quoteSymbol:'ETH',created:(now-100)*1000,reserve:'2',creatorFees:'0.02',protocolFees:'0.01'};
const trade={token:'TokenCase',timestamp:now-50,account:'Wallet',quoteAmount:'1',tokenAmount:'100'};
const source={key:'base',name:'Base',status:{enabled:true},tokens:[token],trades:[trade]};
const prices={base:{status:'fresh',usd:2000,updatedAt:now,maxAge:180}};
test('all trades beyond page history limits are counted; launches, reserve and unclaimed fees stay separate',()=>{
 const r=protocolAnalytics({sources:[{...source,trades:Array.from({length:601},()=>trade)}],prices,now});
 assert.equal(r.totals.trades,601);assert.equal(r.totals.volumeUsd,1202000);assert.equal(r.totals.launches,1);assert.equal(r.totals.addresses,1);assert.equal(r.assets[0].creatorFees,0.02);assert.equal(r.assets[0].reserve,2);assert.equal(r.series.reduce((n,b)=>n+b.trades,0),601);
});
test('stale pricing leaves native volume visible and excludes it from USD totals',()=>{
 const r=protocolAnalytics({sources:[source],prices:{base:{...prices.base,updatedAt:now-181}},now});assert.equal(r.totals.volumeUsd,0);assert.equal(r.totals.unpricedTrades,1);assert.equal(r.assets[0].volume,1);assert.equal(r.assets[0].priced,false);
});
test('time and chain filters exclude older and other-chain activity without merging case-sensitive mints',()=>{
 const r=protocolAnalytics({sources:[{...source,tokens:[token,{...token,address:'tokencase'}],trades:[trade,{...trade,token:'tokencase',account:'Other'},{...trade,timestamp:now-90000}]},{...source,key:'sol'}],prices,period:'24h',network:'base',now});assert.equal(r.totals.trades,2);assert.equal(r.topTokens.length,2);assert.equal(r.totals.addresses,2);assert.equal(r.coverage.length,1);
});
test('empty and unavailable networks remain distinguishable; no zero-size trades or future data',()=>{
 const r=protocolAnalytics({sources:[{...source,status:{enabled:false},tokens:[],trades:[]}],prices,period:'all',now});assert.equal(r.totals.trades,0);assert.equal(r.coverage[0].enabled,false);assert.equal(r.series.length,1);
 const invalid=protocolAnalytics({sources:[{...source,trades:[{...trade,quoteAmount:'0'},{...trade,timestamp:now+1}]}],prices,now});assert.equal(invalid.totals.trades,0);
 assert.throws(()=>protocolAnalytics({sources:[source],prices,period:'bad',now}));assert.throws(()=>protocolAnalytics({sources:[source],prices,network:'bad',now}));
});
