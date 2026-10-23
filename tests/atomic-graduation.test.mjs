import test from 'node:test';
import assert from 'node:assert/strict';
import {Contract,ZeroAddress,parseEther} from 'ethers';
import {dexFixture,launch,complete,art,FEE,mined,parse,TEST_URI} from './helpers/dex-fixture.mjs';
for(const native of [true,false])test('final purchase graduates and locks real V3 liquidity in the same transaction: '+(native?'native':'USDC'),async t=>{
 const f=await dexFixture(t,{factoryName:'ElpidaAtomicDexFactory'});
 const l=await launch(f,{native,firstBuy:0n});
 assert.equal(await l.curve.sold(),0n);assert.equal(await l.token.balanceOf(f.addresses[0]),0n);
 assert.equal(await l.curve.automaticGraduation(),true);
 await complete(f,l);
 const pool=await l.curve.pool();assert.notEqual(pool,ZeroAddress);assert.equal(await l.curve.realReserve(),0n);
 const locker=new Contract(await l.curve.locker(),art('ElpidaV3FeeLocker').abi,f.provider);
 assert.equal(await locker.locked(),true);
 assert.equal(await f.dex.manager.ownerOf(await l.curve.positionId()),locker.target);
 await assert.rejects(l.curve.graduate.staticCall(),/already migrated/);
});
test('creator can complete and migrate atomically at launch; zero buy does not bypass slippage or fee checks',async t=>{
 const f=await dexFixture(t,{factoryName:'ElpidaAtomicDexFactory',startFdvUsd:50});
 await assert.rejects(f.factory.launchWithMetadata.staticCall('Zero','ZERO',0,1,f.addresses[0],TEST_URI,{value:FEE}),/empty first buy/);
 const l=await launch(f,{firstBuy:parseEther('1')});assert.notEqual(await l.curve.pool(),ZeroAddress);
 assert.equal(parse(l.curve,l.receipt,'Graduated').length,1);
});
test('a failed DEX migration rolls back the final buy instead of leaving a frozen completed curve',async t=>{
 const f=await dexFixture(t,{factoryName:'ElpidaAtomicDexFactory'}),l=await launch(f);await f.advance(61);
 const sold=await l.curve.sold(),reserve=await l.curve.realReserve(),held=await l.token.balanceOf(f.addresses[0]),gross=await l.curve.remainingAtBaseFee();
 await f.provider.send('hardhat_setCode',[f.nativeAdapter.target,'0x60006000fd']);
 await assert.rejects(mined(l.curve.buy(gross,1,{value:gross,gasLimit:15000000})));
 assert.equal(await l.curve.complete(),false);assert.equal(await l.curve.sold(),sold);assert.equal(await l.curve.realReserve(),reserve);assert.equal(await l.token.balanceOf(f.addresses[0]),held);
});
