import test from 'node:test';
import assert from 'node:assert/strict';
import {runRewardBatches} from '../apps/api/reward-engine.mjs';

function mockVault({failSecondOnce=false,lostReceiptOnce=false}={}){
 const paid=new Set();const calls=[];let failed=false,lost=false;
 return {
  calls,paid,
  async epochPaid(asset,snapshot,address){return paid.has(`${asset}:${snapshot}:${address}`);},
  async distribute(asset,addresses,amounts,_duration,snapshot){
   calls.push([...addresses]);
   if(failSecondOnce&&calls.length===2&&!failed){failed=true;throw new Error('network timeout');}
   return {wait:async()=>{
    for(const address of addresses)paid.add(`${asset}:${snapshot}:${address}`);
    if(lostReceiptOnce&&!lost){lost=true;throw new Error('receipt lost after confirmed transaction');}
   }};
  },
 };
}

function plan(count){return {asset:'ETH',snapshot:123,duration:0,budget:String(count),nextBatch:0,
 allocations:Array.from({length:count},(_,i)=>({address:`holder${i}`,amount:'1'}))};}

test('automated holder payouts resume the second 64-wallet batch without replaying the first',async()=>{
 const vault=mockVault({failSecondOnce:true}),epoch=plan(70);
 await assert.rejects(runRewardBatches(vault,epoch),/network timeout/);
 assert.equal(epoch.nextBatch,64);
 assert.equal(vault.paid.size,64);
 await runRewardBatches(vault,epoch);
 assert.equal(epoch.nextBatch,70);
 assert.equal(vault.paid.size,70);
 assert.deepEqual(vault.calls.map(x=>x.length),[64,6,6]);
 await runRewardBatches(vault,epoch);
 assert.equal(vault.calls.length,3);
});

test('a lost transaction receipt is reconciled using on-chain epochPaid',async()=>{
 const vault=mockVault({lostReceiptOnce:true}),epoch=plan(4);
 await runRewardBatches(vault,epoch);
 assert.equal(epoch.nextBatch,4);
 assert.equal(vault.paid.size,4);
 assert.equal(vault.calls.length,1);
});

test('mixed already-paid and unpaid wallet states halt for manual reconciliation',async()=>{
 const vault=mockVault(),epoch=plan(3);
 vault.paid.add('ETH:123:holder0');
 await assert.rejects(runRewardBatches(vault,epoch),/manual reconciliation/);
 assert.equal(epoch.nextBatch,0);
 assert.equal(vault.calls.length,0);
});
