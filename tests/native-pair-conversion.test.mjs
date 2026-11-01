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
 // Execute the browser's actual atomic composition from a smart wallet, then force a late failure.
 await import('./helpers/browser-modules.mjs');
 const {TestnetWallet}=await import('../apps/web/wallet.mjs');
 const {launch}=await import('./helpers/dex-fixture.mjs');
 const {ContractFactory}=await import('ethers');const solc=(await import('solc')).default;
 const source='pragma solidity ^0.8.24; contract Account {address immutable owner;constructor(){owner=msg.sender;}receive()external payable{} function execute(address[] calldata t,bytes[] calldata d,uint256[] calldata v)external{require(msg.sender==owner);for(uint i;i<t.length;i++){(bool ok,)=t[i].call{value:v[i]}(d[i]);require(ok,"batch failed");}}}';
 const artifact=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'A.sol':{content:source}},settings:{outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}}))).contracts['A.sol'].Account;
 const account=await new ContractFactory(artifact.abi,artifact.evm.bytecode.object,signer).deploy();await account.waitForDeployment();await mined(signer.sendTransaction({to:account.target,value:parseEther('.1')}));
 const l=await launch(f,{native:false,firstBuy:0n});await f.advance(61);
 const wallet=Object.create(TestnetWallet.prototype),item={address:l.token.target,curve:l.curve.target,pair:'usdc',quoteAddress:f.usdc.target,quoteDecimals:6,symbol:'HOPE'};
 Object.assign(wallet,{provider:f.provider,address:account.target,net:{chainId:31337},launches:new Map([[item.address.toLowerCase(),item]]),checkNetwork:async()=>{},verifyFactory:async()=>f.factory,canBatch:async()=>true,stockPreflight:async()=>{}});
 Object.defineProperties(wallet,{dex:{value:d.config},artifacts:{value:{curve:{abi:l.curve.interface.fragments}}}});
 let fail=false;
 wallet.sendCalls=async(calls,message,options)=>{assert.equal(options.atomicRequired,true);const txs=fail?[...calls,{to:account.target,data:'0xdeadbeef'}]:calls;const receipt=await mined(account.execute(txs.map(c=>c.to),txs.map(c=>c.data),txs.map(c=>c.value??0n)));return {tx:{hash:receipt.hash},receipt};};
 let atomicQuote=await wallet.getNativePairTradeQuote({token:item.address,side:'buy',amount:'0.0000000001'});
 await wallet.tradeNativePair(atomicQuote);assert.ok(await l.token.balanceOf(account.target)>0n);assert.equal(await f.usdc.allowance(account.target,l.curve.target),0n);
 atomicQuote=await wallet.getNativePairTradeQuote({token:item.address,side:'sell',amount:'1000000'});await wallet.tradeNativePair(atomicQuote);
 assert.equal(await l.token.allowance(account.target,l.curve.target),0n);assert.equal(await f.usdc.allowance(account.target,d.router.target),0n);
 const beforeTokens=await l.token.balanceOf(account.target),beforeQuote=await f.usdc.balanceOf(account.target),beforeNative=await f.provider.getBalance(account.target);
 atomicQuote=await wallet.getNativePairTradeQuote({token:item.address,side:'buy',amount:'0.0000000001'});fail=true;await assert.rejects(wallet.tradeNativePair(atomicQuote),/batch failed/);
 assert.equal(await l.token.balanceOf(account.target),beforeTokens);assert.equal(await f.usdc.balanceOf(account.target),beforeQuote);assert.equal(await f.provider.getBalance(account.target),beforeNative);
 fail=false;const {complete}=await import('./helpers/dex-fixture.mjs');await complete(f,l);await mined(l.curve.graduate());
 wallet.config={contracts:{quoter:{abi:d.quoter.interface.fragments},pool:{abi:[]}}};
 atomicQuote=await wallet.getNativePairTradeQuote({token:item.address,side:'buy',amount:'0.0000000001'});await wallet.tradeNativePair(atomicQuote);
 atomicQuote=await wallet.getNativePairTradeQuote({token:item.address,side:'sell',amount:'1000000'});await wallet.tradeNativePair(atomicQuote);
 assert.notEqual(await l.curve.pool(),'0x0000000000000000000000000000000000000000');
 const unsupported=Object.create(TestnetWallet.prototype);unsupported.canBatch=async()=>false;
 await assert.rejects(unsupported.sendCalls([{to:owner,data:'0x'},{to:owner,data:'0x'}],'test',{atomicRequired:true}),/no transactions were submitted/);

});
