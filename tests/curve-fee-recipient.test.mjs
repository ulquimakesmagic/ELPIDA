import test from 'node:test';
import assert from 'node:assert/strict';
import {Contract} from 'ethers';
import {createRuntime} from '../apps/api/curve-runtime.mjs';

test('curve claims clear both ledgers for a shared beneficiary and preserve separate recipients',async t=>{
 const runtime=await createRuntime({seed:false,dex:true});t.after(()=>runtime.close());
 const creator=runtime.config.accounts[0].address,other=runtime.config.accounts[1].address;
 const payer=await runtime.provider.getSigner(2);
 assert.equal(await new Contract(runtime.indexer.factory,runtime.config.contracts.dexFactory.abi,payer).FEE_ACCOUNTING_VERSION(),1n);
 for(const reward of [creator,other]){
  const launch=await runtime.transact('launch',{name:'Fee recipients',symbol:'FEES',pair:'native',firstBuy:'0.025',reward});
  const listing=runtime.indexer.listings().find(row=>row.address.toLowerCase()===launch.token.toLowerCase());
  const curve=new Contract(listing.curve,runtime.config.contracts.dexCurve.abi,payer);
  const treasury=await curve.protocolTreasury(),beneficiary=await curve.creatorRewardVault();
  assert.equal(beneficiary.toLowerCase(),reward.toLowerCase());
  const protocol=await curve.protocolFees(),creatorFees=await curve.creatorFees();assert.ok(protocol>0n&&creatorFees>0n);
  const reserve=await curve.realReserve(),before=await runtime.provider.getBalance(beneficiary);
  await(await curve.claimFees(beneficiary)).wait();
  const shared=treasury.toLowerCase()===beneficiary.toLowerCase();
  assert.equal(await runtime.provider.getBalance(beneficiary)-before,creatorFees+(shared?protocol:0n));
  assert.equal(await curve.creatorFees(),0n);assert.equal(await curve.protocolFees(),shared?0n:protocol);
  await(await curve.withdrawFees()).wait();assert.equal(await curve.creatorFees(),0n);assert.equal(await curve.protocolFees(),0n);assert.equal(await curve.realReserve(),reserve);
  const after=await runtime.provider.getBalance(beneficiary);await(await curve.withdrawFees()).wait();assert.equal(await runtime.provider.getBalance(beneficiary),after);
 }
});
