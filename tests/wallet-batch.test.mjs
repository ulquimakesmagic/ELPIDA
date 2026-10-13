import test from 'node:test';
import assert from 'node:assert/strict';
import {supportsAtomicLaunch,waitAtomicLaunch} from '../apps/web/wallet-batch.mjs';
test('only already-supported atomic wallets enable batched approvals',async()=>{
 for(const status of ['supported','ready','unsupported'])assert.equal(await supportsAtomicLaunch(async()=>({'0x14a34':{atomic:{status}}}),'account',84532),status==='supported');
 assert.equal(await supportsAtomicLaunch(async()=>{throw new Error('Unsupported method');},'account',84532),false);
});
test('batch completion requires the same request, chain, atomic execution and successful receipts',async()=>{
 const base={id:'batch',chainId:'0x14a34',status:200,atomic:true,receipts:[{status:'0x1',transactionHash:'hash'}]},options={attempts:1,sleep:async()=>{}};
 assert.deepEqual(await waitAtomicLaunch(async()=>base,'batch',84532,options),base.receipts);
 for(const change of [{id:'other'},{chainId:'0x1'},{atomic:false},{receipts:[]},{receipts:[{status:'0x0'}]},{status:100},{status:500}])await assert.rejects(waitAtomicLaunch(async()=>({...base,...change}),'batch',84532,options));
});
