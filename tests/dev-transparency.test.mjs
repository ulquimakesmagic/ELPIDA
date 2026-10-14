import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../apps/api/curve-runtime.mjs';
import {devLabel,snipeLabel,currentFeeBps,supplyPercent,TOKEN_SUPPLY} from '../packages/core/curve-model.mjs';

test('the indexer records the creator first buy, the live creator holding and the anti-snipe schedule',async t=>{
 const r=await createRuntime({dex:true,seed:false});t.after(()=>r.close());
 const launch=await r.transact('launch',{name:'Open dev',symbol:'DEV',pair:'native',firstBuy:'1'});
 const listing=()=>r.indexer.listings().find(x=>x.address===launch.token);
 const first=listing();
 assert.equal(first.curveModel,10);assert.equal(first.partialFill,true);
 assert.deepEqual(first.feeSchedule,{base:125,start:9000,window:60});assert.equal(first.graduationGrace,86400);
 assert.ok(first.launchedAt>0);
 // No creator cap: a 1 ETH first buy ($2,500 on a $5,000 curve) takes a large share, and it is shown.
 assert.ok(first.devBoughtPct>10,`dev bought ${first.devBoughtPct}%`);
 assert.equal(first.devHoldingPct,first.devBoughtPct,'creator still holds the whole first buy');
 assert.equal(first.liquidityBonus,'0.0','the first buy pays no anti-snipe fee');
 // The creator sells half: the holding updates, the launch figure does not.
 const half=(BigInt(first.devBoughtRaw)/2n).toString();
 await r.transact('sell',{token:launch.token,amount:(Number(half)/1e18).toString()});
 const after=listing();
 assert.equal(after.devBoughtPct,first.devBoughtPct);
 assert.ok(after.devHoldingPct<first.devHoldingPct&&after.devHoldingPct>0);
 assert.ok(Number(after.liquidityBonus)>0,'a sell inside the first minute locks an anti-snipe surplus');
 assert.match(devLabel(after.devBoughtPct,after.devHoldingPct),/^Dev bought [\d.]+% at launch · holds [\d.]+% now$/);
});

test('fee window and supply helpers match the contract schedule',()=>{
 assert.equal(currentFeeBps(1000,1000),9000);assert.equal(currentFeeBps(1000,1030),125+Math.floor((9000-125)*30/60));assert.equal(currentFeeBps(1000,1060),125);
 assert.equal(snipeLabel(1000,1029),'Launch fee window: 47.1% → 1.25% in 31 s');assert.equal(snipeLabel(1000,1060),null);
 assert.equal(supplyPercent(TOKEN_SUPPLY/20n),5);assert.equal(supplyPercent(0n),0);
 assert.equal(devLabel(null),null);assert.equal(devLabel(4.2),'Dev bought 4.2% at launch');
});
