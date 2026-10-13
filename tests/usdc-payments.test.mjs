import test from 'node:test';
import assert from 'node:assert/strict';
import {Contract,parseUnits} from 'ethers';
import {createRuntime} from '../apps/api/curve-runtime.mjs';
import {quoteUsdcConversion,conversionCalls} from '../apps/web/usdc-conversion.mjs';

test('USDC fees, paired trades and bounded conversion execute against local contracts',async t=>{
 const r=await createRuntime({dex:true,seed:false});t.after(()=>r.close());
 const owner=r.config.accounts[0].address;
 const coin=new Contract(r.config.local.feeUsdc,r.config.contracts.quote.abi,r.provider);
 const before=await coin.balanceOf(owner);
 const launch=await r.transact('launch',{name:'USDC test',symbol:'USDCT',pair:'usdc',firstBuy:'25',feeCurrency:'usdc',rewardPolicy:{mode:'creator',recipients:[{kind:'wallet',target:owner,percent:'100'}]}});
 assert.equal(before-await coin.balanceOf(owner),35_000_000n,'fee and first buy share one bounded approval');
 assert.equal(await coin.allowance(owner,r.config.local.factory),0n);
 await r.rewards.tick();
 const rewards=(await r.rewards.dashboard()).rows.find(x=>x.token===launch.token);
 const feeBalance=rewards.recipients[0].balances.find(x=>x.symbol==='USDC');
 assert.equal(feeBalance.decimals,6);
 assert.equal(feeBalance.claimable,'0.15625','creator fees preserve USDC precision');
 assert.equal(r.indexer.listings().find(x=>x.address.toLowerCase()===launch.token).pair,'usdc');
 assert.ok(Number((await r.getQuote({token:launch.token,side:'buy',amount:'25'})).out)>0);
 await r.transact('buy',{token:launch.token,amount:'25'});
 const beforeSell=await coin.balanceOf(owner);
 await r.transact('sell',{token:launch.token,amount:'1000000'});
 assert.ok(await coin.balanceOf(owner)>beforeSell);
 const native=await r.transact('launch',{name:'Native test',symbol:'NAT',pair:'native',firstBuy:'0.01',feeCurrency:'usdc'});
 const quote=await r.getConversionQuote({nativeAmount:'0.01',slippage:'1'});
 const beforeConversion=await coin.balanceOf(owner),nativeBefore=await r.provider.getBalance(owner);
 await assert.rejects(r.transact('convert-usdc',{...quote,maxUsdc:'0.000001'}),/exceeds your USDC maximum/);
 assert.equal(await coin.balanceOf(owner),beforeConversion,'rejected budget spends nothing');
 const result=await r.transact('convert-usdc',{...quote,slippage:'1'});
 assert.equal(result.nativeAmount,'0.01');
 assert.ok(nativeBefore<await r.provider.getBalance(owner),'output is unwrapped into native funds');
 const spent=beforeConversion-await coin.balanceOf(owner);
 assert.ok(spent>0n&&spent<=parseUnits(quote.maxUsdc,6));
 await r.transact('buy',{token:native.token,amount:'0.01'});
 await(await coin.connect(await r.provider.getSigner(0)).mint(owner,25_000_000_000n)).wait();
 await r.transact('buy',{token:launch.token,amount:r.indexer.snapshot(launch.token).remainingBuy});
 await r.transact('graduate',{token:launch.token});
 assert.equal(r.indexer.snapshot(launch.token).liquidityLocked,true,'USDC graduation locks the position permanently');
 await r.transact('buy',{token:launch.token,amount:'10'});
 assert.equal(r.indexer.trades(launch.token)[0].venue,'dexPool');
});

test('conversion refuses absent routes, bad slippage and expired quotes',async()=>{
 await assert.rejects(quoteUsdcConversion({dex:null,amountOut:1n}),/not configured/);
 await assert.rejects(quoteUsdcConversion({dex:{},usdc:'usdc',amountOut:1n,slippageBps:501}),/slippage/);
 assert.throws(()=>conversionCalls({quote:{quotedAt:Date.now()-61000}}),/expired/);
 class FakeContract {
  constructor(address){if(address==='router')return {factory:async()=> 'wrong',WETH9:async()=> 'weth'};}
 }
 await assert.rejects(quoteUsdcConversion({Contract:FakeContract,dex:{router:'router',factory:'factory',weth:'weth'},usdc:'usdc',amountOut:1n}),/does not match/);
});
