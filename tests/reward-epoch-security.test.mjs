import test from 'node:test';
import assert from 'node:assert/strict';
import {ZeroAddress} from 'ethers';
import {createRuntime} from '../apps/api/curve-runtime.mjs';

test('an on-chain holder cannot be paid twice for the same asset and snapshot',async t=>{
 const runtime=await createRuntime({seed:false,dex:false});
 t.after(()=>runtime.close());
 const creator=runtime.config.accounts[0].address;
 const trader=runtime.config.accounts[1].address;
 const {token}=await runtime.transact('launch',{
  name:'Replay Check',symbol:'REPLAY',pair:'native',firstBuy:'0.2',
  rewardPolicy:{mode:'holders',threshold:'100',minimumHolding:'1'},
 });
 const vault=runtime.rewards.record(token).vault;
 const asset=ZeroAddress;
 const snapshot=await runtime.provider.getBlockNumber();
 const starting=await vault.strategyBalance(asset);
 assert.ok(starting>2n);
 const first=starting/2n;
 await (await vault.distribute(asset,[creator],[first],0,snapshot)).wait();
 assert.equal(await vault.epochPaid(asset,snapshot,creator),true);
 await assert.rejects(vault.distribute.staticCall(asset,[creator],[1n],0,snapshot),/duplicate epoch holder/);
 await assert.rejects(vault.distribute.staticCall(asset,[trader,trader],[1n,1n],0,snapshot),/duplicate epoch holder/);
 assert.equal(await vault.epochPaid(asset,snapshot,trader),false);
 await (await vault.distribute(asset,[trader],[starting-first],0,snapshot)).wait();
 assert.equal(await vault.strategyBalance(asset),0n);
 // A new, independently funded snapshot can pay the same address again.
 await runtime.transact('buy',{token,account:'1',amount:'0.02'});
 const nextSnapshot=await runtime.provider.getBlockNumber();
 const renewed=await vault.strategyBalance(asset);
 assert.ok(renewed>0n);
 await (await vault.distribute(asset,[creator],[renewed],0,nextSnapshot)).wait();
 assert.equal(await vault.epochPaid(asset,nextSnapshot,creator),true);
});
