import test from 'node:test';
import assert from 'node:assert/strict';
import {Contract,parseUnits} from 'ethers';
import {CreatorFeeTotals,curveCreatorEarnings} from '../apps/api/creator-fees.mjs';
import {createRuntime} from '../apps/api/curve-runtime.mjs';
import {startServer} from '../apps/api/server.mjs';

test('curve history preserves rounding and excludes the anti-snipe liquidity bonus',()=>{
 const token={virtualQuote:'1000000',virtualToken:'1000000000',expectedSold:'100'},events=[{name:'AntiSnipeFee',args:['wallet','9000','8875']},{name:'Bought',args:['payer','wallet','10000','100']},{name:'FeesWithdrawn',args:['wallet','63']}];
 assert.equal(curveCreatorEarnings(token,events),63n);
 assert.throws(()=>curveCreatorEarnings({...token,expectedSold:'101'},events),/Incomplete/);
});

test('lifetime fees include curve and both LP assets and do not fall after claims',async t=>{
 const r=await createRuntime({seed:false,dex:true});t.after(()=>r.close());const totals=new CreatorFeeTotals();t.after(()=>totals.close());
 const {token}=await r.transact('launch',{name:'Lifetime fees',symbol:'LIFE',pair:'native',firstBuy:'0.025'});
 const launchTip=r.indexer.tip();
 await r.transact('buy',{token,amount:'0.01'});await r.transact('sell',{token,amount:'1000'});
 const row=r.indexer.listings().find(t=>t.address===token),signer=await r.provider.getSigner(0),curve=new Contract(row.curve,r.config.contracts.dexCurve.abi,signer),entry={index:r.indexer,provider:r.provider};
 const historical=await totals.calculate(entry,r.indexer.tokens().find(t=>t.address===token),launchTip);assert.equal(historical.assets[0].amount,'0.00015625');
 let before=await totals.calculate(entry,r.indexer.tokens().find(t=>t.address===token),r.indexer.tip());
 assert.equal(parseUnits(before.assets[0].amount,18),await curve.creatorFees());
 await r.transact('withdraw',{token});const after=await totals.calculate(entry,r.indexer.tokens().find(t=>t.address===token),r.indexer.tip());assert.deepEqual(after.assets,before.assets);assert.equal(await curve.creatorFees(),0n);
 await r.transact('buy',{token,amount:r.indexer.snapshot(token).remainingBuy});await r.transact('graduate',{token});
 await r.transact('buy',{token,amount:'0.001'});await r.transact('sell',{token,amount:'1000'});
 before=await totals.calculate(entry,r.indexer.tokens().find(t=>t.address===token),r.indexer.tip());assert.equal(before.assets.length,2);assert.ok(before.assets.every(a=>Number(a.amount)>0));
 await r.transact('withdraw',{token});const paid=await totals.calculate(entry,r.indexer.tokens().find(t=>t.address===token),r.indexer.tip());assert.deepEqual(paid.assets,before.assets);
});

test('public lifetime endpoint loads in the background and reports indexed earned fees',async t=>{
 const app=await startServer({port:0,seed:false});t.after(()=>app.close());const launch=await app.runtime.transact('launch',{name:'Fee API',symbol:'FAPI',pair:'native',firstBuy:'0.025'});
 const url=app.url+'/api/creator-fees?network=local&token='+launch.token;
 const initial=await(await fetch(url)).json();assert.equal(initial.status,'loading');
 let result;for(let n=0;n<50;n++){result=await(await fetch(url)).json();if(result.status!=='loading')break;await new Promise(done=>setTimeout(done,20));}
 assert.equal(result.status,'ready');assert.ok(Number(result.assets[0].amount)>0);assert.ok(result.indexedBlock>0);
});
