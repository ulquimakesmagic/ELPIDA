import test from 'node:test';
import assert from 'node:assert/strict';
import {Contract,ContractFactory,parseUnits} from 'ethers';
import solc from 'solc';
import {createRuntime} from '../apps/api/curve-runtime.mjs';
import {MetadataStore} from '../apps/api/metadata-store.mjs';
import {quoteUsdcConversion,conversionCalls} from '../apps/web/usdc-conversion.mjs';

test('USDC fees, paired trades and bounded conversion execute against local contracts',async t=>{
 const r=await createRuntime({dex:true,seed:false,metadataStore:new MetadataStore({jwt:null})});t.after(()=>r.close());
 const owner=r.config.accounts[0].address;
 const coin=new Contract(r.config.local.feeUsdc,r.config.contracts.quote.abi,r.provider);
 const before=await coin.balanceOf(owner);
 const launch=await r.transact('launch',{name:'USDC test',symbol:'USDCT',description:'Metadata bound by the launch transaction',pair:'usdc',firstBuy:'25',feeCurrency:'usdc',rewardPolicy:{mode:'creator',recipients:[{kind:'wallet',target:owner,percent:'100'}]}});
 const created=r.indexer.listings().find(x=>x.address.toLowerCase()===launch.token);
 assert.match(created.metadataURI,/^ipfs:\/\//,'metadata URI is recorded by the same launch transaction');
 // Exercise the same approve + launch calldata used by an atomic-capable wallet.
 const source='pragma solidity ^0.8.24; contract BatchWallet { address public immutable owner; constructor(){owner=msg.sender;} function execute(address[] calldata targets,bytes[] calldata payloads) external {require(msg.sender==owner);for(uint i;i<targets.length;i++){(bool ok,)=targets[i].call(payloads[i]);require(ok,"atomic call failed");}}}';
 const compiled=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'BatchWallet.sol':{content:source}},settings:{outputSelection:{'*':{'*':['abi','evm.bytecode']}}}}))).contracts['BatchWallet.sol'].BatchWallet;
 const signer=await r.provider.getSigner(0),batch=await new ContractFactory(compiled.abi,compiled.evm.bytecode.object,signer).deploy();await batch.waitForDeployment();
 const factory=new Contract(r.config.local.factory,r.config.contracts.dexFactory.abi,signer);
 await(await coin.connect(signer).mint(batch.target,15_000_000n)).wait();
 const approval=coin.interface.encodeFunctionData('approve',[factory.target,15_000_000n]);
 const args=['Single confirmation','ONE',coin.target,5_000_000n,0n,owner,created.metadataURI,true];
 const launchCall=factory.interface.encodeFunctionData('launchWithPayment',args);
 const receipt=await(await batch.execute([coin.target,factory.target],[approval,launchCall])).wait();
 const events=receipt.logs.filter(l=>l.address.toLowerCase()===factory.target.toLowerCase()).map(l=>{try{return factory.interface.parseLog(l);}catch{return null;}});
 assert.equal(events.find(e=>e?.name==='Launched').args.creator,batch.target);
 assert.equal(events.find(e=>e?.name==='MetadataPublished').args.uri,created.metadataURI);
 assert.equal(await coin.balanceOf(batch.target),0n,'fee and first buy are paid inside one wallet transaction');
 assert.equal(await coin.allowance(batch.target,factory.target),0n,'bounded approval is consumed by the same transaction');
 await(await coin.connect(signer).mint(batch.target,15_000_000n)).wait();
 const invalid=factory.interface.encodeFunctionData('launchWithPayment',[...args.slice(0,4),2n**255n,...args.slice(5)]);
 await assert.rejects(batch.execute([coin.target,factory.target],[approval,invalid]));
 assert.equal(await coin.allowance(batch.target,factory.target),0n,'failed launch rolls back its approval');
 assert.equal(await coin.balanceOf(batch.target),15_000_000n,'failed batch spends no USDC');
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
 // Finish the curve after the one-minute anti-snipe window, at the base fee.
 await r.provider.send('evm_increaseTime',[61]);await r.provider.send('evm_mine',[]);await r.indexer.sync();
 await r.transact('buy',{token:launch.token,amount:r.indexer.snapshot(launch.token).remainingBuy});
 await r.transact('graduate',{token:launch.token});
 assert.equal(r.indexer.snapshot(launch.token).liquidityLocked,true,'USDC graduation locks the position permanently');
 await r.transact('buy',{token:launch.token,amount:'10'});
 assert.equal(r.indexer.trades(launch.token)[0].venue,'dexPool');
 const beforeDexSell=await coin.balanceOf(owner);
 await r.transact('sell',{token:launch.token,amount:'1000000'});
 assert.ok(await coin.balanceOf(owner)>beforeDexSell,'post-graduation selling returns USDC');
 assert.equal(r.indexer.trades(launch.token)[0].side,'sell');
 await r.transact('withdraw',{token:launch.token});
 const graduated=r.indexer.snapshot(launch.token);
 assert.equal(graduated.liquidityLocked,true,'collecting fees never unlocks liquidity');
 assert.ok(graduated.dexRewards.every(a=>Number(a.creator)===0),'position creator fees are paid out');
 assert.equal(parseUnits(graduated.creatorFees,6),0n,'curve creator fees are paid out');
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
