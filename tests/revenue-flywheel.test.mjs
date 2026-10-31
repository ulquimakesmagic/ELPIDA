import test from 'node:test';
import assert from 'node:assert/strict';
import {planRevenueFlywheel} from '../packages/core/revenue-flywheel.mjs';
const base={chain:'base',asset:'ETH',now:1000,receipts:[{id:'r1',chain:'base',asset:'ETH',kind:'protocol-fee-received',amount:10000n}]};
const token=(id,cap)=>({id,chain:'base',budgetAsset:'ETH',verified:true,burnSupported:true,routeReady:true,issuerAllowed:true,marketCap:BigInt(cap),observedAt:990});
test('10% of received protocol fees selects ten by market cap and never enables execution',()=>{
 const p=planRevenueFlywheel({...base,tokens:Array.from({length:12},(_,i)=>token('t'+i,i+1))});
 assert.equal(p.budget,1000n);assert.equal(p.orders.length,10);assert.equal(p.orders[0].token,'t11');assert.ok(p.orders.every(x=>x.maximumSpend===100n));assert.equal(p.executionEnabled,false);
});
test('unfilled slots stay unallocated; stale or restricted tokens are excluded; receipts cannot mix or duplicate',()=>{
 const p=planRevenueFlywheel({...base,tokens:[token('ok',10),{...token('stale',99),observedAt:1},{...token('blocked',100),issuerAllowed:false}]});assert.equal(p.orders.length,1);assert.equal(p.unallocated,900n);
 assert.equal(planRevenueFlywheel({...base,usedReceiptIds:['r1'],tokens:[]}).budget,0n);
 assert.throws(()=>planRevenueFlywheel({...base,receipts:[...base.receipts,...base.receipts],tokens:[]}),/Duplicate/);
 assert.throws(()=>planRevenueFlywheel({...base,receipts:[{...base.receipts[0],kind:'creator-fee'}],tokens:[]}),/Not a received/);
});
