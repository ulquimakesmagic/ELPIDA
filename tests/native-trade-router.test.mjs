import test from 'node:test';
import assert from 'node:assert/strict';
import {Contract,ContractFactory,Interface,parseEther,parseUnits,getCreateAddress,MaxUint256,ZeroAddress} from 'ethers';
import {dexFixture,launch,complete,art,mined} from './helpers/dex-fixture.mjs';
import {quoteNativePairConversion} from '../apps/web/usdc-conversion.mjs';
import {sqrtInteger} from '../apps/web/test-stock-liquidity.mjs';
import {nativeRouterAccount} from '../packages/indexer/native-router-attribution.mjs';
import {findCurveNonce,verifyNativeRouter} from '../apps/web/native-trade-router.mjs';
async function setup(t){
 const f=await dexFixture(t,{factoryName:'ElpidaAtomicDexFactory'}),d=f.dex,owner=f.addresses[0];
 const native=parseEther('20'),asset=parseUnits('50000',6);await mined(d.weth.deposit({value:native}));await mined(d.weth.approve(d.manager.target,native));await mined(f.usdc.approve(d.manager.target,asset));
 const [token0,token1]=[d.weth.target,f.usdc.target].sort((a,b)=>BigInt(a)<BigInt(b)?-1:1),amount0=token0===d.weth.target?native:asset,amount1=token0===d.weth.target?asset:native;
 await mined(d.manager.createAndInitializePoolIfNecessary(token0,token1,3000,sqrtInteger((amount1<<192n)/amount0)));
 await mined(d.manager.mint({token0,token1,fee:3000,tickLower:-887220,tickUpper:887220,amount0Desired:amount0,amount1Desired:amount1,amount0Min:0,amount1Min:0,recipient:owner,deadline:BigInt(await f.now()+300)}));
 const l=await launch(f,{native:false,firstBuy:0n});await f.advance(61);
 const r=await f.deploy(art('ElpidaNativeTradeRouter'),f.factory.target,d.router.target,d.factory.target,d.weth.target);
 return {...f,l,r,owner};
}
async function quote(f,buy,amount){
 const {l,dex:d}=f,pool=await l.curve.pool(),onCurve=pool===ZeroAddress;
 const marketOut=async(input)=>onCurve?(await l.curve[buy?'quoteBuy':'quoteSell'](input))[0]:(await d.quoter.quoteExactInputSingle.staticCall({tokenIn:buy?f.usdc.target:l.token.target,tokenOut:buy?l.token.target:f.usdc.target,amountIn:input,fee:10000,sqrtPriceLimitX96:0}))[0];
 let pairMinimum,minimum;
 if(buy){const c=await quoteNativePairConversion({Contract,provider:f.provider,dex:d.config,asset:f.usdc.target,amountIn:amount});pairMinimum=c.minimum;minimum=await marketOut(pairMinimum)*99n/100n;}
 else{pairMinimum=await marketOut(amount)*99n/100n;const c=await quoteNativePairConversion({Contract,provider:f.provider,dex:d.config,asset:f.usdc.target,amountIn:pairMinimum,toNative:true});minimum=c.minimum;}
 return {curve:l.curve.target,curveNonce:2,conversionFee:3000,amount,pairMinimum,minimum,deadline:BigInt(await f.now()+300)};
}
test('ordinary EOA buys and sells atomically before and after graduation; balances and approvals stay scoped',async t=>{
 const f=await setup(t),{l,r,dex:d,owner}=f;
 for(const nonce of [0n,1n,2n,127n,128n,255n,256n,65535n,65536n,2n**64n-1n])assert.equal(await r.createdAddress(nonce),getCreateAddress({from:await f.factory.deployer(),nonce}));
 assert.equal(findCurveNonce(getCreateAddress,await f.factory.deployer(),l.curve.target,3),2);
 let q=await quote(f,true,parseEther('.001')),receipt=await mined(r.buy(q,{value:q.amount}));assert.ok(await l.token.balanceOf(owner)>=q.minimum);
 const nativeLogs=receipt.logs.filter(x=>x.address===r.target),bought=receipt.logs.map(x=>{try{return l.curve.interface.parseLog(x);}catch{return null;}}).find(x=>x?.name==='Bought');
 const baseFee=bought.args.quoteIn*125n/10000n;assert.equal(await l.curve.protocolFees(),baseFee/2n);assert.equal(await l.curve.creatorFees(),baseFee-baseFee/2n);
 assert.equal(nativeRouterAccount({trade:{hash:receipt.hash,token:l.token.target,account:r.target,side:'buy',tokenRaw:bought.args.tokensOut.toString()},curve:l.curve.target,logs:receipt.logs,nativeLogs}),owner);
 // Unrelated donated assets must not be swept by later callers.
 await mined(f.usdc.transfer(r.target,17n));await mined(l.token.transfer(r.target,7n));await mined(d.weth.deposit({value:13n}));await mined(d.weth.transfer(r.target,13n));
 const sellAmount=await l.token.balanceOf(owner)/3n;await mined(l.token.approve(r.target,sellAmount));q=await quote(f,false,sellAmount);const ethBefore=await f.provider.getBalance(owner);receipt=await mined(r.sell(q));
 assert.ok(await f.provider.getBalance(owner)+receipt.gasUsed*receipt.gasPrice>=ethBefore+q.minimum);
 assert.equal(await f.usdc.balanceOf(r.target),17n);assert.equal(await l.token.balanceOf(r.target),7n);assert.equal(await d.weth.balanceOf(r.target),13n);
 for(const [coin,spender] of [[l.token,l.curve.target],[f.usdc,l.curve.target],[f.usdc,d.router.target],[d.weth,d.router.target]])assert.equal(await coin.allowance(r.target,spender),0n);
 assert.equal(await l.token.allowance(owner,r.target),0n);
 await complete(f,l);assert.notEqual(await l.curve.pool(),ZeroAddress,'completing buy migrated atomically');
 q=await quote(f,true,parseEther('.0001'));await mined(r.buy(q,{value:q.amount}));
 const sell2=await l.token.balanceOf(owner)/100n;await mined(l.token.approve(r.target,sell2));q=await quote(f,false,sell2);await mined(r.sell(q));
 assert.equal(await f.usdc.balanceOf(r.target),17n);assert.equal(await l.token.balanceOf(r.target),7n);assert.equal(await d.weth.balanceOf(r.target),13n);
 const {EvmIndexer}=await import('../packages/indexer/evm-indexer.mjs'),{v3Artifacts}=await import('../packages/core/uniswap.mjs');
 const contracts={factory:{abi:art('ElpidaAtomicDexFactory').abi},curve:{abi:art('ElpidaDexCurve').abi},token:{abi:art('ElpidaToken').abi},pool:{abi:art('ElpidaLockedPool').abi},dexPool:{abi:v3Artifacts.pool.abi},locker:{abi:art('ElpidaV3FeeLocker').abi},splitter:{abi:art('ElpidaFeeSplitter').abi}};
 const indexer=new EvmIndexer({provider:f.provider,factory:f.factory.target,contracts,fromBlock:(await f.factory.deploymentTransaction().wait()).blockNumber});t.after(()=>indexer.close());await indexer.sync();
 const routed=indexer.trades(l.token.target.toLowerCase()).filter(x=>x.accountBasis==='router settlement matched to token transfer');assert.equal(routed.length,4);assert.ok(routed.every(x=>x.account.toLowerCase()===owner.toLowerCase()));
});
test('invalid proofs, deadlines, zero minimums and final-hop failures cannot move funds',async t=>{
 const f=await setup(t),{r,l,dex:d,owner}=f;const q=await quote(f,true,parseEther('.001'));
 await assert.rejects(r.market(l.curve.target,4),/curve proof/);await assert.rejects(r.market(f.usdc.target,2),/curve proof/);
 for(const changed of [{deadline:0n},{minimum:0n},{pairMinimum:0n},{amount:0n}])await assert.rejects(r.buy.staticCall({...q,...changed},{value:q.amount}));
 const assetBefore=await f.usdc.balanceOf(owner),tokenBefore=await l.token.balanceOf(owner),pool=await d.factory.getPool(d.weth.target,f.usdc.target,3000),poolBefore=await f.usdc.balanceOf(pool);
 await assert.rejects(mined(r.buy({...q,minimum:MaxUint256},{value:q.amount,gasLimit:12000000})));
 assert.equal(await f.usdc.balanceOf(owner),assetBefore);assert.equal(await l.token.balanceOf(owner),tokenBefore);assert.equal(await f.usdc.balanceOf(pool),poolBefore);
 await assert.rejects(r.buy.staticCall(q,{value:q.amount-1n}),/native amount/);
 await assert.rejects(new ContractFactory(art('ElpidaNativeTradeRouter').abi,art('ElpidaNativeTradeRouter').evm.bytecode.object,f.signers[0]).deploy(f.factory.target,d.router.target,d.factory.target,f.usdc.target),/DEX identity/);
 // Exact constructor provenance is required by the browser, not just spoofable getters.
 const tx=r.deploymentTransaction(),record={address:r.target,hash:tx.hash},artifact={abi:art('ElpidaNativeTradeRouter').abi,bytecode:'0x'+art('ElpidaNativeTradeRouter').evm.bytecode.object},args=[f.factory.target,d.router.target,d.factory.target,d.weth.target];
 assert.equal((await verifyNativeRouter({Contract,ContractFactory,provider:f.provider,artifact,record,args,chainId:31337})).target,r.target);
 await assert.rejects(verifyNativeRouter({Contract,ContractFactory,provider:f.provider,artifact,record,args:[...args.slice(0,3),f.usdc.target],chainId:31337}),/proof/);
});
test('native quote and trade use the actual ordinary-wallet path, with one buy transaction and bounded sell approval',async t=>{
 const f=await setup(t);await import('./helpers/browser-modules.mjs');const {TestnetWallet}=await import('../apps/web/wallet.mjs');
 const wallet=Object.create(TestnetWallet.prototype),item={address:f.l.token.target,curve:f.l.curve.target,pair:'usdc',quoteAddress:f.usdc.target,quoteDecimals:6,symbol:'HOPE'};
 Object.assign(wallet,{provider:f.provider,signer:f.signers[0],address:f.owner,net:{chainId:31337},launches:new Map([[item.address.toLowerCase(),item]]),checkNetwork:async()=>{},verifyFactory:async()=>f.factory,canBatch:async()=>false,nativeTradeRouter:async()=>f.r,stockPreflight:async()=>{},onProgress:()=>{}});Object.defineProperties(wallet,{dex:{value:f.dex.config},artifacts:{value:{curve:{abi:art('ElpidaDexCurve').abi}}}});
 const q=await wallet.getNativePairTradeQuote({token:item.address,side:'buy',amount:'0.001'});assert.equal(q.execution,'router');assert.equal(q.curveNonce,2);await wallet.tradeNativePair(q);
 assert.ok(await f.l.token.balanceOf(f.owner)>0n);const amount=(await f.l.token.balanceOf(f.owner)/3n).toString();const sell=await wallet.getNativePairTradeQuote({token:item.address,side:'sell',amount:(Number(amount)/1e18).toFixed(18)});await wallet.tradeNativePair(sell);assert.equal(await f.l.token.allowance(f.owner,f.r.target),0n);
});

test('a partially filled completing native buy refunds unused quote and locks graduation liquidity',async t=>{
 const f=await setup(t),q=await quote(f,true,parseEther('10')),before=await f.usdc.balanceOf(f.owner);
 await mined(f.r.buy(q,{value:q.amount}));assert.notEqual(await f.l.curve.pool(),ZeroAddress);assert.ok(await f.usdc.balanceOf(f.owner)>before,'unused converted quote returned');
 assert.equal(await f.usdc.balanceOf(f.r.target),0n);assert.equal(await f.l.token.balanceOf(f.r.target),0n);assert.equal(await f.dex.weth.balanceOf(f.r.target),0n);assert.equal(await f.usdc.allowance(f.r.target,f.l.curve.target),0n);
 const locker=new Contract(await f.l.curve.locker(),art('ElpidaV3FeeLocker').abi,f.provider);assert.equal(await locker.locked(),true);
});

test('native payout rejection rolls back both hops; payout callbacks cannot reenter the router',async t=>{
 const f=await setup(t),solc=(await import('solc')).default;
 const source='pragma solidity ^0.8.24; contract Receiver {address owner=msg.sender;bool public reject;bool public blocked;address target;bytes attack;function configure(bool r,address t,bytes calldata d)external{require(msg.sender==owner);reject=r;target=t;attack=d;}function execute(address t,bytes calldata d)external payable{require(msg.sender==owner);(bool ok,)=t.call{value:msg.value}(d);require(ok,"execute");}receive()external payable{require(!reject,"reject");if(attack.length>0){(bool ok,bytes memory result)=target.call(attack);blocked=!ok&&bytes4(result)==bytes4(keccak256("ReentrancyGuardReentrantCall()"));require(blocked,"guard");}}}';
 const a=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'R.sol':{content:source}},settings:{outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}}))).contracts['R.sol'].Receiver;
 const receiver=await new ContractFactory(a.abi,a.evm.bytecode.object,f.signers[0]).deploy();await receiver.waitForDeployment();
 let q=await quote(f,true,parseEther('.001'));await mined(receiver.execute(f.r.target,f.r.interface.encodeFunctionData('buy',[q]),{value:q.amount}));
 const amount=await f.l.token.balanceOf(receiver.target)/3n;q=await quote(f,false,amount);await mined(receiver.execute(f.l.token.target,f.l.token.interface.encodeFunctionData('approve',[f.r.target,amount])));
 const sell=f.r.interface.encodeFunctionData('sell',[q]),before=await f.l.token.balanceOf(receiver.target),sold=await f.l.curve.sold();await mined(receiver.configure(true,f.r.target,'0x'));
 await assert.rejects(mined(receiver.execute(f.r.target,sell,{gasLimit:12000000})));assert.equal(await f.l.token.balanceOf(receiver.target),before);assert.equal(await f.l.curve.sold(),sold);
 await mined(receiver.configure(false,f.r.target,sell));await mined(receiver.execute(f.r.target,sell));assert.equal(await receiver.blocked(),true);assert.ok(await f.provider.getBalance(receiver.target)>=q.minimum);
});
test('trade attribution refuses spoofed emitters, missing settlement, different amounts and ambiguous events',()=>{
 const trader='0x0000000000000000000000000000000000000001',token='0x0000000000000000000000000000000000000002',curve='0x0000000000000000000000000000000000000003',router='0x0000000000000000000000000000000000000004',hash='tx';
 const n=new Interface(['event NativeTrade(address indexed trader,address indexed token,address indexed curve,bool buy,uint256 nativeAmount,uint256 tokenAmount)']),x=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
 const native={...n.encodeEventLog(n.getEvent('NativeTrade'),[trader,token,curve,true,1n,100n]),address:router,transactionHash:hash},transfer={...x.encodeEventLog(x.getEvent('Transfer'),[router,trader,100n]),address:token,transactionHash:hash},trade={hash,token,account:router,side:'buy',tokenRaw:'100'},args={trade,curve,logs:[transfer],nativeLogs:[native]};
 assert.equal(nativeRouterAccount(args),trader);
 assert.equal(nativeRouterAccount({...args,logs:[]}),null);assert.equal(nativeRouterAccount({...args,trade:{...trade,tokenRaw:'101'}}),null);
 assert.equal(nativeRouterAccount({...args,nativeLogs:[{...native,address:trader}]}),null);assert.equal(nativeRouterAccount({...args,nativeLogs:[native,native]}),null);
});

test('router verification is repeated after the public read provider changes',async t=>{
 const f=await setup(t);await import('./helpers/browser-modules.mjs');const {TestnetWallet}=await import('../apps/web/wallet.mjs');
 const artifact={abi:art('ElpidaNativeTradeRouter').abi,bytecode:'0x'+art('ElpidaNativeTradeRouter').evm.bytecode.object},record={address:f.r.target,hash:f.r.deploymentTransaction().hash};
 const wrapper=()=>({getTransaction:async h=>({...await f.provider.getTransaction(h),chainId:11155111n}),getTransactionReceipt:h=>f.provider.getTransactionReceipt(h),getCode:a=>f.provider.getCode(a),call:tx=>f.provider.call(tx)});
 const wallet=Object.create(TestnetWallet.prototype);Object.assign(wallet,{provider:wrapper(),net:{chainId:11155111},config:{contracts:{nativeTradeRouter:artifact}},nativeRouterRecord:()=>record});Object.defineProperties(wallet,{dex:{value:f.dex.config},deployment:{value:{factory:f.factory.target}}});
 const original=await wallet.nativeTradeRouter();assert.equal(await wallet.nativeTradeRouter(),original);wallet.provider=wrapper();const replacement=await wallet.nativeTradeRouter();assert.notEqual(replacement,original);assert.equal(replacement.runner,wallet.provider);
});

test('a fresh browser uses the registered router only for its verified factory and keeps private deployments isolated',async()=>{
 await import('./helpers/browser-modules.mjs');const {TestnetWallet}=await import('../apps/web/wallet.mjs');const {testnets}=await import('../packages/core/networks.mjs');
 // A router is bound to one factory: when one is pinned, it must be the pinned launchpad's.
 for(const n of testnets.filter(n=>n.nativeTradeRouter))assert.equal(n.nativeTradeRouter.factory.toLowerCase(),n.shared.factory.toLowerCase(),n.key);
 const base=testnets.find(n=>n.key==='ethereum-sepolia');
 const net={...base,nativeTradeRouter:base.nativeTradeRouter??{factory:base.shared.factory,address:'0x0000000000000000000000000000000000000033',hash:'0x'+'b'.repeat(64)}},shared=net.nativeTradeRouter;
 const w=Object.create(TestnetWallet.prototype);w.net=net;Object.defineProperty(w,'deployment',{value:{factory:net.shared.factory},configurable:true});
 const old=globalThis.localStorage,values=new Map();globalThis.localStorage={getItem:key=>values.get(key)??null};
 try{
  assert.equal(w.nativeRouterRecord(),shared); // No browser-local record required.
  const privateFactory='0x0000000000000000000000000000000000000011';Object.defineProperty(w,'deployment',{value:{factory:privateFactory},configurable:true});assert.equal(w.nativeRouterRecord(),null);
  const record={address:'0x0000000000000000000000000000000000000022',hash:'0x'+'a'.repeat(64)};values.set(`elpida:native-router:v1:11155111:${privateFactory}`,JSON.stringify(record));assert.deepEqual(w.nativeRouterRecord(),record);
  w.net={...net,chainId:84532};assert.equal(w.nativeRouterRecord(),null);
 }finally{if(old===undefined)delete globalThis.localStorage;else globalThis.localStorage=old;}
});
