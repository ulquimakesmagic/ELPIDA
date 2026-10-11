// Basic launchpad (ElpidaBetaFactory, model 6): native pairs only, creation fee in the native coin,
// pricing set by the treasury for future launches.
import test from 'node:test';
import assert from 'node:assert/strict';
import {network} from 'hardhat';
import {BrowserProvider,Contract,ContractFactory,ZeroAddress,parseEther} from 'ethers';
import {compileContracts} from '../scripts/compile.mjs';
const compiled=compileContracts({includeMocks:true});
const artifact=n=>compiled[`contracts/evm/src/${n}.sol`][n];
const mined=async p=>(await p).wait();
const FEE=parseEther('0.004'),VQ=2133333333333333334n;
async function setup(t) {
 const connection=await network.create('localTest'); const provider=new BrowserProvider(connection.provider,undefined,{cacheTimeout:-1});provider.pollingInterval=10;
 t.after(async()=>{provider.destroy();await connection.close();});
 const signers=await Promise.all([0,1,2,3].map(i=>provider.getSigner(i)));const addresses=await Promise.all(signers.map(s=>s.getAddress()));
 const a=artifact('ElpidaBetaFactory');const factory=await new ContractFactory(a.abi,a.evm.bytecode.object,signers[0]).deploy(addresses[2],FEE,VQ);await factory.waitForDeployment();
 const feedA=compiled['tests/fixtures/MockUsdFeed.sol'].MockUsdFeed,feed=await new ContractFactory(feedA.abi,feedA.evm.bytecode.object,signers[0]).deploy(2500n*10n**8n);await feed.waitForDeployment();
 await mined(factory.connect(signers[2]).configureUsdPricing(feed.target,86400,ZeroAddress));
 return {provider,signers,addresses,factory,feed};
}
async function launch(f,{buy=parseEther('0.01'),fee}={}) {
 fee??=await f.factory.launchFee();
 const receipt=await mined(f.factory.launch('Curve Garden','CURVE',buy,1n,f.addresses[3],{value:fee+buy}));
 const event=receipt.logs.map(l=>{try{return f.factory.interface.parseLog(l);}catch{return null;}}).find(l=>l?.name==='Launched');
 return {buy,receipt,curve:new Contract(event.args.curve,artifact('ElpidaBetaCurve').abi,f.signers[0]),token:new Contract(event.args.token,artifact('ElpidaToken').abi,f.signers[0]),event};
}
async function backing(f,c) {
 assert.equal(await f.provider.getBalance(await c.getAddress()),await c.realReserve()+await c.protocolFees()+await c.creatorFees());
}
test('Native launch pays the creation fee in the native coin and seeds nothing else',async t=>{
 const f=await setup(t),treasuryBefore=await f.provider.getBalance(f.addresses[2]);
 const {curve,token,buy,event}=await launch(f);
 assert.equal(event.args.nativePair,true);
 assert.equal(await f.provider.getBalance(f.addresses[2])-treasuryBefore,FEE,'treasury received the native creation fee');
 assert.equal(await f.provider.getBalance(await f.factory.getAddress()),0n,'factory keeps nothing');
 assert.equal(await curve.quote(),ZeroAddress);
 assert.equal(await curve.virtualQuote(),VQ);
 assert.equal(await curve.realReserve(),buy-buy*125n/10000n);
 assert.equal(await token.balanceOf(f.addresses[0]),await curve.sold());
 await backing(f,curve);
 // The exact fee plus first buy is required, so a fee change between signing and mining reverts.
 await assert.rejects(f.factory.launch.staticCall('X','X',buy,1n,f.addresses[3],{value:buy}),/FeeQuoteMoved/);
 assert.ok(await f.factory.launch.staticCall('X','X',buy,1n,f.addresses[3],{value:FEE+buy+1n}),'excess fee is refunded');
 const held=await token.balanceOf(f.addresses[0]);await mined(token.approve(await curve.getAddress(),held));
 const [out]=await curve.quoteSell(held);await mined(curve.sell(held,out));
 assert.equal(await curve.sold(),0n);await backing(f,curve);
});
test('Native graduation preserves backing and terminal price; existing holders can sell',async t=>{
 const f=await setup(t),{curve,token}=await launch(f);
 await assert.rejects(curve.graduate.staticCall(),/not complete/);
 const completion=await curve.completionQuote();
 await assert.rejects(curve.quoteBuy(completion+1n),/exceeds curve remaining/);
 const [out]=await curve.quoteBuy(completion);
 await mined(curve.buy(completion,out,{value:completion}));
 assert.equal(await curve.sold(),await curve.SALE_CAP());assert.equal(await curve.complete(),true);
 await assert.rejects(curve.sell.staticCall(1n,0n),/complete/);
 const q=await curve.realReserve(),v=await curve.virtualQuote(),remaining=await curve.virtualToken()-await curve.sold();
 const protocol=await curve.protocolFees(),creator=await curve.creatorFees();
 await mined(curve.connect(f.signers[1]).graduate());
 const pool=new Contract(await curve.pool(),artifact('ElpidaLockedPool').abi,f.signers[0]);
 const lp=await pool.tokenReserve();
 assert.ok(lp > 199999999n*10n**18n && lp <= 200000000n*10n**18n);
 // Constant product over (v, 16/15 supply): selling 800M leaves a quarter of the virtual tokens, so the
 // reserve quadruples (raised = 3v) and the price ends at 16x the start.
 assert.ok(q >= v*3n*999n/1000n && q <= v*3n*1001n/1000n,'raised reserve matches the fixed curve shape');
 const startPrice=Number(v)/Number(await curve.virtualToken()),endPrice=Number(v+q)/Number(remaining);
 assert.ok(Math.abs(endPrice/startPrice-16)<0.01,'graduates at 16x the starting FDV');
 assert.equal(await pool.realReserve(),q);assert.equal(await pool.liquidityLocked(),true);
 assert.equal(await curve.realReserve(),0n);
 assert.equal(await curve.protocolFees(),protocol);assert.equal(await curve.creatorFees(),creator);
 assert.ok(q*remaining-lp*(v+q)>=0n && q*remaining-lp*(v+q)<=(v+q)*remaining/1000000000n+(v+q),'price matches within bounded terminal quote rounding');
 assert.equal(await token.balanceOf('0x000000000000000000000000000000000000dEaD'),(await token.totalSupply()-await curve.SALE_CAP())-lp);
 await backing(f,curve);await backing(f,pool);
 await assert.rejects(curve.graduate.staticCall(),/already migrated/);
 const sell=await token.balanceOf(f.addresses[0])/10n;
 await mined(token.approve(await pool.getAddress(),sell));const [net]=await pool.quoteSell(sell);
 await mined(pool.sell(sell,net));await backing(f,pool);
 const reserve=await pool.realReserve();await mined(pool.connect(f.signers[1]).withdrawFees());assert.equal(await pool.realReserve(),reserve);
 await mined(curve.withdrawFees());await backing(f,curve);await backing(f,pool);
});
test('A failed first buy rolls back the native creation fee',async t=>{
 const f=await setup(t),before=await f.provider.getBalance(f.addresses[2]);
 await assert.rejects(mined(f.factory.launch('Fail','FAIL',parseEther('1'),10n**40n,f.addresses[3],{value:FEE+parseEther('1'),gasLimit:12000000})),/revert/);
 assert.equal(await f.provider.getBalance(f.addresses[2]),before);
});
test('Manual repricing is disabled; feed updates affect new curves only',async t=>{
 const f=await setup(t),{curve:old}=await launch(f);
 await assert.rejects(f.factory.connect(f.signers[2]).setPricing.staticCall(1n,VQ),/PricingFixed/);
 const b=await f.provider.getBlock('latest');await mined(f.feed.set(1250n*10n**8n,b.timestamp,2,2));
 assert.equal(await f.factory.launchFee(),FEE*2n);
 assert.equal(await old.virtualQuote(),VQ);
 await assert.rejects(f.factory.launch.staticCall('Late','LATE',parseEther('0.01'),1n,f.addresses[3],{value:FEE+parseEther('0.01')}),/FeeQuoteMoved/);
 const {curve}=await launch(f);assert.equal(await curve.virtualQuote(),4266666666666666667n);
});
