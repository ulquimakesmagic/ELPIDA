import test from 'node:test';
import assert from 'node:assert/strict';
import {network} from 'hardhat';
import {BrowserProvider,Contract,ContractFactory,ZeroAddress} from 'ethers';
import {compileContracts} from '../scripts/compile.mjs';
const compiled=compileContracts({includeMocks:true});
const art=n=>compiled[`contracts/evm/src/${n}.sol`][n];
const mined=async p=>(await p).wait();
async function setup(t){const connection=await network.create('localTest'),provider=new BrowserProvider(connection.provider,undefined,{cacheTimeout:-1});provider.pollingInterval=10;
 t.after(async()=>{provider.destroy();await connection.close();});
 const signers=await Promise.all([0,1,2,3].map(i=>provider.getSigner(i))),addresses=await Promise.all(signers.map(s=>s.getAddress()));
 const deploy=async(a,...args)=>{const c=await new ContractFactory(a.abi,a.evm.bytecode.object,signers[0]).deploy(...args);await c.waitForDeployment();return c;};
 return {signers,addresses,deploy,provider};}
test('permanent v3 locker collects only fees and splitter pays fixed beneficiaries without moving principal',async t=>{
 const f=await setup(t),mock=compiled['tests/fixtures/MockUSDC.sol'].MockUSDC;
 const tokens=[await f.deploy(mock),await f.deploy(mock)];tokens.sort((a,b)=>BigInt(a.target)<BigInt(b.target)?-1:1);
 const [a,b]=tokens,manager=await f.deploy(compiled['tests/fixtures/MockPositionManager.sol'].MockPositionManager,a.target,b.target);
 const locker=await f.deploy(art('ElpidaV3FeeLocker'),manager.target,f.addresses[0],a.target,b.target,3000,60,f.addresses[2],f.addresses[3]);
 await assert.rejects(manager.connect(f.signers[1]).deliver.staticCall(locker.target,-887220,887220),/position source/);
 await assert.rejects(manager.deliver.staticCall(locker.target,-600,600),/position config/);
 await mined(manager.deliver(locker.target,-887220,887220));assert.equal(await locker.locked(),true);
 await assert.rejects(manager.deliver.staticCall(locker.target,-887220,887220),/position source/);
 await mined(a.mint(manager.target,101));await mined(b.mint(manager.target,80));await mined(manager.accrue(101,80));
 await mined(locker.connect(f.signers[1]).collectFees());
 assert.equal(await manager.ownerOf(1),locker.target);assert.equal(await manager.liquidity(),1000n);
 await assert.rejects(manager.decreaseLiquidity.staticCall(),/owner/);
 for(const method of ['decreaseLiquidity','transferFrom','approve','rescue','upgradeTo'])assert.equal(locker.interface.fragments.some(x=>x.name===method),false);
 const splitter=new Contract(await locker.splitter(),art('ElpidaFeeSplitter').abi,f.signers[1]);
 assert.equal(await splitter.claimable(a.target,f.addresses[2]),50n);assert.equal(await splitter.claimable(a.target,f.addresses[3]),51n);
 await assert.rejects(splitter.claim.staticCall(a.target,f.addresses[1]),/beneficiary/);
 await mined(a.setFailTransfers(true));await assert.rejects(splitter.claim.staticCall(a.target,f.addresses[3]),/token payout/);assert.equal(await splitter.claimable(a.target,f.addresses[3]),51n);
 await mined(a.setFailTransfers(false));await mined(splitter.claim(a.target,f.addresses[3]));assert.equal(await a.balanceOf(f.addresses[3]),51n);
 await mined(splitter.claim(a.target,f.addresses[3]));assert.equal(await a.balanceOf(f.addresses[3]),51n);
 await mined(splitter.claim(a.target,f.addresses[2]));assert.equal(await a.balanceOf(f.addresses[2]),50n);
 assert.equal(await manager.liquidity(),1000n);assert.equal(await a.allowance(locker.target,splitter.target),0n);
});
test('native fee claims isolate a rejecting recipient and same-wallet split remains backed',async t=>{
 const f=await setup(t),reject=await f.deploy(compiled['tests/fixtures/MockPositionManager.sol'].RejectNativeFees);
 const splitter=await f.deploy(art('ElpidaFeeSplitter'),f.addresses[2],reject.target);
 await mined(splitter.depositNative({value:101n}));await assert.rejects(splitter.claim.staticCall(ZeroAddress,reject.target),/native payout/);
 await mined(splitter.connect(f.signers[1]).claim(ZeroAddress,f.addresses[2]));assert.equal(await f.provider.getBalance(splitter.target),51n);
 const same=await f.deploy(art('ElpidaFeeSplitter'),f.addresses[3],f.addresses[3]);await mined(same.depositNative({value:101n}));
 assert.equal(await same.claimable(ZeroAddress,f.addresses[3]),101n);await mined(same.claim(ZeroAddress,f.addresses[3]));assert.equal(await f.provider.getBalance(same.target),0n);
});

test('curve restores both shared ledgers if native payout fails and still isolates distinct recipients',async t=>{
 const f=await setup(t),reject=await f.deploy(compiled['tests/fixtures/MockPositionManager.sol'].RejectNativeFees);
 const token=await f.deploy(compiled['tests/fixtures/MockUSDC.sol'].MockUSDC);
 for(const treasury of [reject.target,f.addresses[0]]){
  const curve=await f.deploy(art('ElpidaDexCurve'),ZeroAddress,token.target,f.addresses[0],treasury,reject.target,10n**18n,2_000_000_000n*10n**18n,token.target,60);
  await mined(token.mint(curve.target,1_000_000_000n*10n**18n));
  await mined(curve.buy(10n**16n,0,{value:10n**16n}));
  const p=await curve.protocolFees(),c=await curve.creatorFees(),reserve=await curve.realReserve();assert.ok(p>0n&&c>0n);
  assert.equal(await curve.claimFees.staticCall(reject.target),false);
  await mined(curve.claimFees(reject.target));assert.equal(await curve.protocolFees(),p);assert.equal(await curve.creatorFees(),c);
  await mined(curve.withdrawFees());assert.equal(await curve.creatorFees(),c);assert.equal(await curve.protocolFees(),treasury===reject.target?p:0n);assert.equal(await curve.realReserve(),reserve);
 }
});
