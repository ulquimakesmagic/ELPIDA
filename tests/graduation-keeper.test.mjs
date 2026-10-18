import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Wallet,Interface,ZeroAddress,parseEther,Transaction} from 'ethers';
import {GraduationKeeper,configuredGraduationKeeper} from '../apps/api/graduation-keeper.mjs';
import {evaluateOperations} from '../apps/api/operations-health.mjs';

const factory='0x0000000000000000000000000000000000000010',curve='0x0000000000000000000000000000000000000020',token='0x0000000000000000000000000000000000000030';
function harness(t){
 const dir=mkdtempSync(join(tmpdir(),'graduation-'));
 const wallet=Wallet.createRandom(),sent=[];let time=1000000;
 const state={chainId:84532,balance:parseEther('1'),receipt:null,latest:0,pending:0,failBroadcast:false,origin:true,complete:true,pool:ZeroAddress,estimateFails:false};
 const provider={getNetwork:async()=>({chainId:BigInt(state.chainId)}),getFeeData:async()=>state.fees??({gasPrice:1000000n}),getBalance:async()=>state.balance,getTransactionCount:async(a,tag)=>tag==='pending'?state.pending:state.latest,getTransactionReceipt:async()=>state.receipt,getBlock:async()=>({hash:'canonical'}),getBlockNumber:async()=>12,broadcastTransaction:async raw=>{sent.push(raw);if(state.failBroadcast)throw new Error('secret RPC data');return {hash:'sent'};}};
 const signer={getAddress:async()=>wallet.address,populateTransaction:async tx=>({...tx,chainId:84532,nonce:0}),signTransaction:tx=>wallet.signTransaction(tx)};
 const graduate=Object.assign(async()=>{}, {estimateGas:async()=>{if(state.estimateFails)throw new Error('revert');return 100000n;},populateTransaction:async()=>({to:curve,data:new Interface(['function graduate()']).encodeFunctionData('graduate')})});
 const contract=address=>address===factory?{MODEL_VERSION:async()=>10n,isElpidaToken:async()=>state.origin}:{factory:async()=>factory,token:async()=>token,complete:async()=>state.complete,pool:async()=>state.pool,graduate};
 let rows=[{address:token,curve,factory,complete:true,graduated:false}];
 const options={provider,signer,candidates:async()=>rows,path:join(dir,'state.sqlite'),factory,contract,now:()=>time,log:()=>{}};
 const keepers=[];const open=()=>{const k=new GraduationKeeper(options);keepers.push(k);return k;};
 t.after(async()=>{for(const k of keepers)if(!k.stopping)await k.close();rmSync(dir,{recursive:true,force:true});});
 return {state,sent,options,open,advance:()=>{time+=61000;},rows:value=>{rows=value;}};
}
test('automatic graduation persists before broadcast and resumes identical signed transaction after restart',async t=>{
 const h=harness(t);h.state.failBroadcast=true;const first=h.open();await first.tick();
 assert.equal(h.sent.length,1);assert.equal(first.status().state,'submitted');
 const original=h.sent[0];assert.equal(Transaction.from(original).value,0n);
 await first.close();h.state.failBroadcast=false;const resumed=h.open();await resumed.tick();
 assert.equal(h.sent[1],original);assert.equal(resumed.db.prepare('SELECT count(*) n FROM graduation_tx').get().n,1);
 h.state.receipt={status:1,blockNumber:11,blockHash:'canonical'};await resumed.tick();
 assert.equal(resumed.status().state,'graduated');assert.equal(h.sent.length,2);
});
test('wrong chain, unverified origin, low balance, simulation failure and busy nonce never broadcast',async t=>{
 for(const [field,value,reason] of [['chainId',1,'chain_mismatch'],['origin',false,'origin_mismatch'],['balance',0n,'needs_gas'],['estimateFails',true,'rpc_or_simulation_failed'],['pending',1,'signer_busy']]){
  await t.test(field,async t=>{const h=harness(t);h.state[field]=value;const k=h.open();await k.tick();assert.equal(h.sent.length,0);assert.equal(k.status().reason,reason);});
 }
});
test('reverts back off, confirmed transactions count toward daily gas budget, leases exclude concurrent workers',async t=>{
 const h=harness(t),k=h.open(),other=h.open();
 k.db.prepare('UPDATE graduation_lock SET owner=?,expires=? WHERE id=1').run('other',2000000);
 await other.tick();assert.equal(h.sent.length,0);
 k.db.prepare('UPDATE graduation_lock SET expires=0').run();
 await k.tick();h.state.receipt={status:0,blockNumber:11,blockHash:'canonical'};await k.tick();await k.tick();assert.equal(h.sent.length,1);
 h.advance();h.state.receipt=null;k.dailyBudget=120000000000n;
 await k.tick();assert.equal(k.status().reason,'daily_budget');assert.equal(h.sent.length,1);
});
test('incomplete, already migrated, and foreign factories are ignored; unconfigured keeper has no signer',async t=>{
 const h=harness(t),k=h.open();h.rows([{address:token,curve,factory,complete:false},{address:token,curve,factory,complete:true,graduated:true},{address:token,curve,factory:curve,complete:true}]);await k.tick();assert.equal(h.sent.length,0);
 assert.equal(configuredGraduationKeeper({env:{}}).status().enabled,false);
 assert.throws(()=>new GraduationKeeper({...h.options,chainId:1}),/testnet/);
});
test('noncanonical receipt is not finalized and unexpected consumed nonce blocks new spending',async t=>{
 const h=harness(t),k=h.open();await k.tick();h.state.receipt={status:1,blockNumber:11,blockHash:'fork'};await k.tick();
 assert.equal(k.db.prepare("SELECT status FROM graduation_tx").get().status,'pending');
 h.state.receipt=null;h.state.latest=1;await k.tick();assert.equal(k.status().reason,'nonce_conflict');assert.equal(h.sent.length,1);
});
test('funding failures remain visible during cooldown and become operations incidents',async t=>{
 const h=harness(t),k=h.open();h.state.balance=0n;await k.tick();await k.tick();
 assert.equal(k.status().reason,'needs_gas');
 assert.ok(evaluateOperations({graduation:k.status()}).incidents.some(i=>i.code==='graduation_delayed'&&i.severity==='critical'));
 assert.ok(evaluateOperations({graduation:{enabled:false}}).incidents.some(i=>i.code==='graduation_disabled'));
 h.state.balance=parseEther('1');h.advance();await k.tick();assert.equal(k.status().reason,undefined);assert.equal(h.sent.length,1);
});
test('EIP-1559 signed costs respect the transaction ceiling before any broadcast',async t=>{
 const h=harness(t),k=h.open();h.state.fees={maxFeePerGas:2000000n,maxPriorityFeePerGas:100000n};
 k.maxCost=1n;await k.tick();assert.equal(k.status().reason,'cost_limit');assert.equal(h.sent.length,0);
 k.maxCost=parseEther('0.001');h.advance();await k.tick();const tx=Transaction.from(h.sent[0]);
 assert.equal(tx.type,2);assert.equal(tx.maxFeePerGas,2000000n);assert.equal(tx.maxPriorityFeePerGas,100000n);
 assert.ok(tx.gasLimit*tx.maxFeePerGas<=k.maxCost);
});
