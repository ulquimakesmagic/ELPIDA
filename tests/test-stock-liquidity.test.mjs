import test from 'node:test';
import assert from 'node:assert/strict';
import {Contract as EthersContract,Interface,parseEther,parseUnits} from 'ethers';
import {prepareTestLiquidity,testLiquidityAmounts,testLiquidityCalls,TEST_MANAGER_ABI,TEST_LIQUIDITY_CAP} from '../apps/web/test-stock-liquidity.mjs';
import {quoteNativePairConversion} from '../apps/web/usdc-conversion.mjs';
import {dexFixture,mined,compiled} from './helpers/dex-fixture.mjs';
const asset='0x0000000000000000000000000000000000000001',weth='0x0000000000000000000000000000000000000002';
test('liquidity budget and initial price use integer units in either token order',()=>{
 const args={nativeAmount:parseEther('.05'),nativeUsd8:2500n*10n**8n,stockUsd8:180n*10n**8n,asset,weth};
 const p=testLiquidityAmounts(args);assert.equal(p.stockAmount,parseEther('.05')*2500n/180n);assert.equal(p.amount0,p.stockAmount);
 const r=testLiquidityAmounts({...args,asset:weth,weth:asset});assert.equal(r.amount1,r.stockAmount);assert.ok(r.sqrtPriceX96>0n);
 for(const nativeAmount of [0n,TEST_LIQUIDITY_CAP+1n])assert.throws(()=>testLiquidityAmounts({...args,nativeAmount}),/budget/);
});
test('mainnet is rejected before contract access',async()=>{await assert.rejects(prepareTestLiquidity({chainId:1}),/restricted/);});
test('real test stock liquidity enables native quotes and rejects unsafe setup',async t=>{
 const f=await dexFixture(t),owner=f.addresses[0],signer=f.signers[0],d=f.dex;
 const testArt=name=>compiled['contracts/evm/testnet/'+name+'.sol'][name];
 const feed=await f.deploy(testArt('ElpidaTestStockFeed'),'Simulated stock',180n*10n**8n),stock=await f.deploy(testArt('ElpidaTestOndoStock'),'Test stock','tNVDAon',25n,feed.target);
 await mined(stock.faucet(parseEther('25')));
 // The fixture executes on localTest; guard behavior is exercised separately above.
 class Contract{constructor(a,abi){return new EthersContract(a,abi,f.provider);}}
 const provider={getNetwork:async()=>({chainId:11155111n}),getBlock:(...a)=>f.provider.getBlock(...a),getBalance:(...a)=>f.provider.getBalance(...a)};
 const args={Contract,provider,dex:d.config,chainId:11155111,asset:stock.target,account:owner,nativeAmount:parseEther('.05'),nativeUsd8:2500n*10n**8n};
 let p=await prepareTestLiquidity(args);assert.equal(p.funded,false);
 await mined(stock.approve(d.manager.target,p.stockAmount));
 const manager=new EthersContract(d.manager.target,TEST_MANAGER_ABI,signer);
 await mined(manager.multicall(testLiquidityCalls(Interface,p),{value:p.nativeAmount}));
 p=await prepareTestLiquidity(args);assert.equal(p.funded,true);
 const quoted=await quoteNativePairConversion({Contract:EthersContract,provider:f.provider,dex:d.config,asset:stock.target,amountIn:parseEther('.001')});assert.ok(quoted.amountOut>0n);assert.equal(quoted.fee,3000);
 assert.ok(await f.provider.getBalance(d.manager.target)===0n,'unused ETH refunded');
 await assert.rejects(prepareTestLiquidity({...args,account:f.addresses[1]}),/controller/);
 await assert.rejects(prepareTestLiquidity({...args,dex:{...d.config,manager:stock.target}}));
 await assert.rejects(prepareTestLiquidity({...args,provider:{getNetwork:async()=>({chainId:1n})}}),/restricted/);
 await mined(stock.setBlocked(p.pool,true));await assert.rejects(prepareTestLiquidity(args),/blocked/);await mined(stock.setBlocked(p.pool,false));
 await mined(stock.setPaused(true));await assert.rejects(prepareTestLiquidity(args),/controls/);await mined(stock.setPaused(false));
 await mined(feed.setMarketStatus(2));await assert.rejects(prepareTestLiquidity(args),/controls/);await mined(feed.setMarketStatus(0));
 const other=await f.deploy(testArt('ElpidaTestOndoStock'),'Other test stock','OTHER',25n,feed.target);await mined(other.faucet(parseEther('25')));
 const ordered=[other.target,d.weth.target].sort((a,b)=>BigInt(a)<BigInt(b)?-1:1);await mined(manager.createAndInitializePoolIfNecessary(...ordered,3000,2n**96n));
 await assert.rejects(prepareTestLiquidity({...args,asset:other.target}),/price differs/);
 await f.advance(172801);await assert.rejects(prepareTestLiquidity(args),/feed/);
});

test('actual wallet setup uses bounded approvals, journals a submitted mint and resumes without duplicate funding',async t=>{
 await import('./helpers/browser-modules.mjs');const {TestnetWallet}=await import('../apps/web/wallet.mjs');
 const f=await dexFixture(t),owner=f.addresses[0],signer=f.signers[0],d=f.dex;
 const testArt=name=>compiled['contracts/evm/testnet/'+name+'.sol'][name],feed=await f.deploy(testArt('ElpidaTestStockFeed'),'Simulated stock',180n*10n**8n),stock=await f.deploy(testArt('ElpidaTestOndoStock'),'Test stock','tNVDAon',25n,feed.target);await mined(stock.faucet(parseEther('25')));
 const provider=new Proxy(f.provider,{get(target,prop){if(prop==='getNetwork')return async()=>({chainId:11155111n});const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;}});
 const storage=new Map(),old=globalThis.localStorage;globalThis.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};t.after(()=>{if(old===undefined)delete globalThis.localStorage;else globalThis.localStorage=old;});
 const wallet=Object.create(TestnetWallet.prototype);Object.assign(wallet,{provider,signer,address:owner,net:{chainId:11155111,key:'ethereum-sepolia'},approvedQuotes:[{address:stock.target,symbol:'tNVDAon',test:true,stock:{provider:'ondo-test'}}],checkNetwork:async()=>{},verifyFactory:async()=>{},oraclePrice:async()=>({usd:2500}),onProgress:()=>{}});Object.defineProperties(wallet,{dex:{value:d.config},deployment:{value:{factory:f.factory.target}}});
 let q=await wallet.getTestStockLiquidityQuote({asset:stock.target,nativeAmount:'0.05'});assert.equal(q.funded,false);
 await assert.rejects(wallet.setupTestStockLiquidity({...q,quotedAt:Date.now()-61000}),/expired/);
 await assert.rejects(wallet.getTestStockLiquidityQuote({asset:f.usdc.target,nativeAmount:'0.05'}),/approved/);
 const wait=wallet.wait.bind(wallet);wallet.wait=async(pending,message)=>{const tx=await pending;if(message.startsWith('Fund the ETH'))throw Error('Simulated interrupted receipt wait');return wait(Promise.resolve(tx),message);};
 await assert.rejects(wallet.setupTestStockLiquidity(q),/interrupted/);assert.equal(storage.size,1);
 wallet.wait=wait;const resumed=await wallet.setupTestStockLiquidity(q);assert.match(resumed.message,/Previously/);assert.equal(storage.size,0);
 q=await wallet.getTestStockLiquidityQuote({asset:stock.target,nativeAmount:'0.05'});assert.equal(q.funded,true);assert.match((await wallet.setupTestStockLiquidity(q)).message,/already funded/);
 assert.equal(await stock.allowance(owner,d.manager.target),0n);
});
