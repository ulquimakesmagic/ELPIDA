import test from 'node:test';
import assert from 'node:assert/strict';
import {quoteNativePairConversion} from '../apps/web/usdc-conversion.mjs';
const addr=n=>'0x'+String(n).padStart(40,'0');
function fixture({mismatch=false,empty=false}={}){
 const dex={router:addr(1),quoter:addr(2),factory:addr(3),weth:addr(4)},asset=addr(5),seen=[];
 class Contract {constructor(a){
  if(a===dex.router||a===dex.quoter)return {factory:async()=>mismatch?addr(99):dex.factory,WETH9:async()=>dex.weth,quoteExactInputSingle:{staticCall:async q=>{seen.push(q);return [q.fee===500?200n:100n];}}};
  if(a===dex.factory)return {getPool:async(a,b,fee)=>!empty&&[500,3000].includes(fee)?addr(fee):addr(0)};
  return {token0:async()=>asset,token1:async()=>dex.weth,factory:async()=>dex.factory,fee:async()=>Number(a.slice(-4)),liquidity:async()=>100n};
 }}
 return {Contract,dex,asset,seen};
}
test('native conversion quotes both directions, chooses best executable pool and bounds output',async()=>{
 const f=fixture();const q=await quoteNativePairConversion({...f,amountIn:1000n});
 assert.equal(q.fee,500);assert.equal(q.minimum,198n);assert.equal(q.tokenIn,f.dex.weth);assert.equal(q.tokenOut,f.asset);
 const r=await quoteNativePairConversion({...f,amountIn:1000n,toNative:true});assert.equal(r.tokenOut,f.dex.weth);assert.equal(r.tokenIn,f.asset);
});
test('missing liquidity, untrusted routing and invalid budgets cannot quote',async()=>{
 await assert.rejects(quoteNativePairConversion({...fixture({empty:true}),amountIn:1n}),/No funded/);
 await assert.rejects(quoteNativePairConversion({...fixture({mismatch:true}),amountIn:1n}),/do not match/);
 for(const args of [{amountIn:0n},{amountIn:1n,slippageBps:501},{amountIn:1n,slippageBps:0}])await assert.rejects(quoteNativePairConversion({...fixture(),...args}),/Invalid/);
});

test('real V3 liquidity converts native to a pair asset and cashes it back out with bounded minimums',async t=>{
 const {Contract,Interface,parseEther}=await import('ethers');
 const {dexFixture,mined}=await import('./helpers/dex-fixture.mjs');
 const {swapCalldata}=await import('../packages/core/dex-router.mjs');
 const f=await dexFixture(t),signer=f.signers[0],owner=f.addresses[0],d=f.dex;
 const amount=parseEther('2');await mined(d.weth.connect(signer).deposit({value:amount}));await mined(f.usdc.mint(owner,amount));
 for(const coin of [d.weth,f.usdc])await mined(coin.connect(signer).approve(d.manager.target,amount));
 const [token0,token1]=[d.weth.target,f.usdc.target].sort((a,b)=>BigInt(a)<BigInt(b)?-1:1);
 await mined(d.manager.createAndInitializePoolIfNecessary(token0,token1,10000,2n**96n));
 const deadline=BigInt(await f.now()+300);
 await mined(d.manager.mint({token0,token1,fee:10000,tickLower:-887200,tickUpper:887200,amount0Desired:amount,amount1Desired:amount,amount0Min:0,amount1Min:0,recipient:owner,deadline}));
 const q=await quoteNativePairConversion({Contract,provider:f.provider,dex:d.config,asset:f.usdc.target,amountIn:parseEther('.01')});
 const before=await f.usdc.balanceOf(owner);
 const data=swapCalldata(Interface,2,d.router.target,{tokenIn:q.tokenIn,tokenOut:q.tokenOut,fee:q.fee,recipient:owner,amountIn:q.amountIn,amountOutMinimum:q.minimum},{deadline,refundETH:true});
 await mined(signer.sendTransaction({to:d.router.target,data,value:q.amountIn}));
 const received=await f.usdc.balanceOf(owner)-before;assert.ok(received>=q.minimum);
 const reverse=await quoteNativePairConversion({Contract,provider:f.provider,dex:d.config,asset:f.usdc.target,amountIn:received,toNative:true});
 await mined(f.usdc.connect(signer).approve(d.router.target,received));
 const back=swapCalldata(Interface,2,d.router.target,{tokenIn:reverse.tokenIn,tokenOut:reverse.tokenOut,fee:reverse.fee,recipient:owner,amountIn:received,amountOutMinimum:reverse.minimum},{deadline,unwrapTo:owner});
 const nativeBefore=await f.provider.getBalance(owner);
 const receipt=await mined(signer.sendTransaction({to:d.router.target,data:back}));
 assert.ok(await f.provider.getBalance(owner)+receipt.gasUsed*receipt.gasPrice>=nativeBefore+reverse.minimum);
 assert.equal(await f.usdc.allowance(owner,d.router.target),0n);
});
