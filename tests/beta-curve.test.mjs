import test from 'node:test';
import assert from 'node:assert/strict';
import {network} from 'hardhat';
import {BrowserProvider,Contract,ContractFactory,ZeroAddress} from 'ethers';
import {compileContracts} from '../scripts/compile.mjs';
const compiled=compileContracts({includeMocks:true});
const artifact=n=>compiled[`contracts/evm/src/${n}.sol`][n];
const mined=async p=>(await p).wait();
async function setup(t,native=false,decimals=6) {
 const connection=await network.create('localTest'); const provider=new BrowserProvider(connection.provider,undefined,{cacheTimeout:-1});provider.pollingInterval=10;
 t.after(async()=>{provider.destroy();await connection.close();});
 const signers=await Promise.all([0,1,2,3].map(i=>provider.getSigner(i)));const addresses=await Promise.all(signers.map(s=>s.getAddress()));
 const deploy=async(a,...args)=>{const c=await new ContractFactory(a.abi,a.evm.bytecode.object,signers[0]).deploy(...args);await c.waitForDeployment();return c;};
 const usdc=await deploy(compiled['tests/fixtures/MockUSDC.sol'].MockUSDC);await mined(usdc.setDecimals(decimals));
 const u=10n**BigInt(decimals),scale=native?10n**18n:u;
 const factory=await deploy(artifact('ElpidaBetaFactory'),await usdc.getAddress(),addresses[2],2133333333333333333n);
 await mined(usdc.mint(addresses[0],200000n*u));await mined(usdc.approve(await factory.getAddress(),200000n*u));
 return {provider,signers,addresses,usdc,factory,u,scale,native};
}
async function launch(f) {
 const buy=f.native?f.scale/100n:25n*f.u;
 const receipt=await mined(f.factory.launch('Curve Garden','CURVE',f.native,buy,1n,f.addresses[3],{value:f.native?buy:0n}));
 const event=receipt.logs.map(l=>{try{return f.factory.interface.parseLog(l);}catch{return null;}}).find(l=>l?.name==='Launched');
 return {buy,curve:new Contract(event.args.curve,artifact('ElpidaBetaCurve').abi,f.signers[0]),token:new Contract(event.args.token,artifact('ElpidaToken').abi,f.signers[0])};
}
async function backing(f,c) {
 const actual=f.native?await f.provider.getBalance(await c.getAddress()):await f.usdc.balanceOf(await c.getAddress());
 assert.equal(actual,await c.realReserve()+await c.protocolFees()+await c.creatorFees());
}
for(const native of [false,true]) test(`${native?'Native':'USDC'} launch has no seed deposit and keeps the USDC fee separate`,async t=>{
 const f=await setup(t,native),{curve,token,buy}=await launch(f);
 assert.equal(await f.usdc.balanceOf(f.addresses[2]),10n*f.u);
 assert.equal(await f.usdc.balanceOf(f.addresses[0]),200000n*f.u-10n*f.u-(native?0n:buy));
 assert.equal(await curve.quote(),native?ZeroAddress:await f.usdc.getAddress());
 assert.equal(await curve.realReserve(),buy-buy*125n/10000n);
 assert.equal(await curve.pool(),ZeroAddress);assert.equal(await curve.complete(),false);
 assert.equal(await token.balanceOf(f.addresses[0]),await curve.sold());
 assert.equal(await f.usdc.balanceOf(await f.factory.getAddress()),0n);
 await backing(f,curve);
 const before=await curve.realReserve();
 await assert.rejects(curve.buy.staticCall(f.scale,0n,{value:native?0n:1n}),/native value/);
 assert.equal(await curve.realReserve(),before);
 const held=await token.balanceOf(f.addresses[0]);await mined(token.approve(await curve.getAddress(),held));
 const [out]=await curve.quoteSell(held);await mined(curve.sell(held,out));
 assert.equal(await curve.sold(),0n);await backing(f,curve);
});
for(const native of [false,true]) test(`${native?'Native':'USDC'} graduation preserves backing and terminal price; existing holders can sell`,async t=>{
 const f=await setup(t,native),{curve,token}=await launch(f);
 await assert.rejects(curve.graduate.staticCall(),/not complete/);
 const completion=await curve.completionQuote();
 await assert.rejects(curve.quoteBuy(completion+1n),/exceeds curve remaining/);
 if(!native)await mined(f.usdc.approve(await curve.getAddress(),completion));
 const [out]=await curve.quoteBuy(completion);
 await mined(curve.buy(completion,out,{value:native?completion:0n}));
 assert.equal(await curve.sold(),await curve.SALE_CAP());assert.equal(await curve.complete(),true);
 await assert.rejects(curve.sell.staticCall(1n,0n),/complete/);
 const q=await curve.realReserve(),v=await curve.virtualQuote(),remaining=await curve.virtualToken()-await curve.sold();
 const protocol=await curve.protocolFees(),creator=await curve.creatorFees();
 await mined(curve.connect(f.signers[1]).graduate());
 const pool=new Contract(await curve.pool(),artifact('ElpidaLockedPool').abi,f.signers[0]);
 const lp=await pool.tokenReserve();
 assert.ok(lp > 199999999n*10n**18n && lp <= 200000000n*10n**18n);
 if(!native) assert.ok(q >= 15999999n*f.u/1000n && q <= 16000001n*f.u/1000n);
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
test('failed native first buy rolls back USDC creation fee; 18-decimal USDC pairing works',async t=>{
 const f=await setup(t,false,18);
 await assert.rejects(mined(f.factory.launch('Fail','FAIL',true,f.scale,10n**40n,f.addresses[3],{value:f.scale,gasLimit:12000000})),/revert/);
 assert.equal(await f.usdc.balanceOf(f.addresses[2]),0n);
 const {curve}=await launch(f);assert.equal(await f.factory.LAUNCH_FEE(),10n*f.u);await backing(f,curve);
});
