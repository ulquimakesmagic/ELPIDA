import test from 'node:test';
import assert from 'node:assert/strict';
import {Contract,parseUnits,parseEther,ZeroAddress} from 'ethers';
import {v3Artifacts} from '../packages/core/uniswap.mjs';
import {VIRTUAL_TOKEN,SALE_CAP,TOKEN_SUPPLY,BASE_FEE_BPS,currentFeeBps as feeModel} from '../packages/core/curve-model.mjs';
import {dexFixture,launch,complete,mined,art,fixtureArt,FEE,parse,poolPrice,sortPair,quoteBalance,liabilities} from './helpers/dex-fixture.mjs';

async function attackerLiquidity(f,l,{priceMultiple,quoteAmount}){
 // The attacker creates the graduation pool first, at `priceMultiple` x the terminal price (quote per token),
 // with real full-range liquidity holding `quoteAmount` of the quote asset and the matching tokens.
 const {tokenFirst,a,b}=sortPair(l.token.target,l.quote),attacker=f.signers[1],S=10n**36n;
 const terminal=(await l.curve.virtualQuote()+await l.curve.realReserve())*S/(await l.curve.virtualToken()-await l.curve.sold());
 const price=terminal*BigInt(Math.round(priceMultiple*1e6))/1000000n; // quote raw per token raw, x1e36
 const tokens=quoteAmount*S/price;
 assert.ok(await l.token.balanceOf(await attacker.getAddress())>=tokens,'attacker holds enough tokens for the attack');
 const ratio=(tokenFirst?price:S*S/price)*(1n<<192n)/S;let s=ratio,y=(s+1n)/2n;while(y<s){s=y;y=(s+ratio/s)/2n;}
 await mined(f.dex.manager.connect(attacker).createAndInitializePoolIfNecessary(a,b,10000,s));
 if(l.native){await mined(f.dex.weth.connect(attacker).deposit({value:quoteAmount}));await mined(f.dex.weth.connect(attacker).approve(f.dex.manager.target,quoteAmount));}
 else await mined(f.usdc.connect(attacker).approve(f.dex.manager.target,quoteAmount));
 await mined(l.token.connect(attacker).approve(f.dex.manager.target,tokens));
 const amount0=tokenFirst?tokens:quoteAmount,amount1=tokenFirst?quoteAmount:tokens;
 await mined(f.dex.manager.connect(attacker).mint({token0:a,token1:b,fee:10000,tickLower:-887200,tickUpper:887200,amount0Desired:amount0,amount1Desired:amount1,amount0Min:0,amount1Min:0,recipient:await attacker.getAddress(),deadline:(await f.now())+3600}));
 return {tokenFirst};
}
/** The attacker (signer 1) buys tokens on the curve before it completes (after the anti-snipe minute by default). */
async function attackerBuys(f,l,amount,{early=false}={}){
 const attacker=f.signers[1];
 if(!early){const launched=Number(await l.curve.launchedAt()),now=await f.now();if(now<launched+61)await f.advance(launched+61-now);}
 if(!l.native)await mined(f.usdc.connect(attacker).approve(l.curve.target,amount));
 await mined(l.curve.connect(attacker).buy(amount,0,{value:l.native?amount:0n}));
}
const terminalPrice=async l=>(await l.curve.virtualQuote()+await l.curve.realReserve())*10n**30n/(await l.curve.virtualToken()-await l.curve.sold());
const close=(x,y,ppm=1n)=>(x>y?x-y:y-x)*1000000n<=y*ppm;

test('model 10 curve uses the Solana shape: $5,000 start, 10x end, unsold supply matches the terminal price',async t=>{
 const f=await dexFixture(t),l=await launch(f);
 assert.equal(await f.factory.MODEL_VERSION(),10n);assert.equal(await l.curve.MODEL_VERSION(),10n);
 assert.equal(await f.factory.VIRTUAL_TOKEN(),VIRTUAL_TOKEN);assert.equal(await l.curve.SALE_CAP(),SALE_CAP);assert.equal(await l.curve.virtualToken(),VIRTUAL_TOKEN);
 // Starting FDV: virtualQuote x supply / virtualToken, in ETH at $2,500.
 const vq=await l.curve.virtualQuote(),startUsd=Number(vq*TOKEN_SUPPLY/VIRTUAL_TOKEN)/1e18*2500;
 assert.ok(Math.abs(startUsd-5000)<0.01,`start FDV ${startUsd}`);
 const start=vq*10n**30n/VIRTUAL_TOKEN;
 await complete(f,l);
 const end=await terminalPrice(l);
 assert.ok(Math.abs(Number(end*1000000n/start)/1e6-10)<1e-6,'graduates at 10x the starting price');
 assert.equal(await l.curve.sold(),SALE_CAP);assert.equal(await l.curve.complete(),true);
 // LP allocation at the terminal price equals the unsold supply (within the 1 ppm migration-rounding bound).
 const q=await l.curve.realReserve(),lp=q*(VIRTUAL_TOKEN-SALE_CAP)/(vq+q),remaining=TOKEN_SUPPLY-SALE_CAP;
 assert.ok(close(lp,remaining),`lp ${lp} vs remaining ${remaining}`);
 await mined(l.curve.graduate());
 assert.ok(await l.token.balanceOf('0x000000000000000000000000000000000000dEaD')*1000000n<=remaining,'at most 1 ppm of the unsold supply is burned');
});

test('test-sized $50 factory and constructor guards',async t=>{
 const f=await dexFixture(t,{startFdvUsd:50,grace:120}),l=await launch(f,{native:false,firstBuy:parseUnits('1',6)});
 assert.equal(await f.factory.startFdvUsd(),50n);assert.equal(await f.factory.graduationGrace(),120n);assert.equal(await l.curve.graduationGrace(),120n);
 assert.equal(await l.curve.virtualQuote(),55_555_556n,'USDC template is $50 x 10/9');
 const raised=await complete(f,l);assert.ok(raised<parseUnits('130',6),`a full test-sized curve costs ~$120, not ${raised}`);
 await mined(l.curve.graduate());assert.notEqual(await l.curve.pool(),ZeroAddress);
 const F=art('ElpidaDexFactory');
 for(const [start,grace,error] of [[0,86400,/start FDV/],[5000,59,/grace/],[5000,8*86400,/grace/]])
  await assert.rejects(f.deploy(F,f.addresses[2],f.nativeAdapter.target,start,grace),error);
});

for(const native of [true,false])test(`a griefer's tiny mismatched pool no longer blocks graduation (${native?'ETH':'USDC'})`,async t=>{
 const f=await dexFixture(t),l=await launch(f,{native});
 await attackerBuys(f,l,native?parseEther('0.01'):parseUnits('10',6));
 await complete(f,l);
 const terminal=await terminalPrice(l);
 // ETH: pool 1000x too expensive (corrected by selling tokens). USDC: 1000x too cheap (corrected by buying tokens).
 const {tokenFirst}=await attackerLiquidity(f,l,native?{priceMultiple:1000,quoteAmount:parseEther('0.0004')}:{priceMultiple:0.001,quoteAmount:10_000n});
 const before=await quoteBalance(f,l);
 const receipt=await mined(l.curve.graduate());
 const adapter=native?f.nativeAdapter:f.adapter;
 assert.equal(receipt.logs.filter(x=>x.address===adapter.target&&adapter.interface.parseLog(x)?.name==='PoolRebalanced').length,1,'pool was rebalanced');
 const pool=new Contract(await l.curve.pool(),v3Artifacts.pool.abi,f.provider);
 assert.ok(close(await poolPrice(pool,tokenFirst),terminal),'pool opens at the terminal price');
 assert.equal(await f.dex.manager.ownerOf(await l.curve.positionId()),await l.curve.locker());
 assert.ok(before>0n);
});

test('a pool mispriced by an attacker holding ~1% of the reserve is rebalanced within the 2% budget',async t=>{
 const f=await dexFixture(t),l=await launch(f,{native:false});
 await attackerBuys(f,l,parseUnits('1000',6));
 await complete(f,l);
 const terminal=await terminalPrice(l),reserve=await l.curve.realReserve();
 const {tokenFirst}=await attackerLiquidity(f,l,{priceMultiple:2,quoteAmount:reserve/100n});
 const receipt=await mined(l.curve.graduate());
 const [rebalanced]=parse(f.adapter,receipt,'PoolRebalanced');assert.ok(rebalanced);
 const spentToken=tokenFirst?rebalanced.args.amount0:rebalanced.args.amount1;
 assert.ok(spentToken>0n&&spentToken<=(TOKEN_SUPPLY-SALE_CAP)*200n/10000n,'spend stays within MAX_REBALANCE_BPS');
 const pool=new Contract(await l.curve.pool(),v3Artifacts.pool.abi,f.provider);
 assert.ok(close(await poolPrice(pool,tokenFirst),terminal));
});

test('a griefer beyond the budget cannot graduate the curve, but after 24 h anyone can reopen it and every holder can sell',async t=>{
 const f=await dexFixture(t),l=await launch(f,{native:false});
 await attackerBuys(f,l,parseUnits('3000',6));
 await complete(f,l);
 const reserve=await l.curve.realReserve();
 await attackerLiquidity(f,l,{priceMultiple:3,quoteAmount:reserve/2n});
 await assert.rejects(l.curve.graduate.staticCall(),/pool price mismatch/);
 const failed=await l.curve.graduate({gasLimit:12_000_000});await assert.rejects(failed.wait(),/revert/);
 assert.equal(await l.curve.pool(),ZeroAddress);assert.equal(await l.curve.realReserve(),reserve);
 assert.equal(await f.usdc.balanceOf(l.curve.target),await liabilities(l),'reserves and fees intact');
 // No trading while complete; reopen is refused before the grace period ends.
 await assert.rejects(l.curve.quoteSell.staticCall(1n),/complete/);
 await assert.rejects(l.curve.reopen.staticCall(),/not reopenable/);
 const completedAt=await l.curve.completedAt();
 await f.advance(Number(completedAt)+86400-await f.now()-5);
 await assert.rejects(l.curve.reopen.staticCall(),/not reopenable/);
 await f.advance(10);
 const receipt=await mined(l.curve.connect(f.signers[3]).reopen());
 assert.equal(parse(l.curve,receipt,'CurveReopened').length,1);assert.equal(await l.curve.complete(),false);assert.equal(await l.curve.completedAt(),0n);
 // Every holder, including the griefer, can now sell back into the curve.
 for(const s of [f.signers[0],f.signers[1]]){
  const balance=await l.token.balanceOf(await s.getAddress()),before=await f.usdc.balanceOf(await s.getAddress());
  const [out]=await l.curve.quoteSell(balance/2n);
  await mined(l.token.connect(s).approve(l.curve.target,balance/2n));await mined(l.curve.connect(s).sell(balance/2n,out));
  assert.equal(await f.usdc.balanceOf(await s.getAddress())-before,out);
  assert.equal(await f.usdc.balanceOf(l.curve.target),await liabilities(l));
 }
});

test('reserve and fee conservation through complete -> reopen -> trade -> complete -> graduate',async t=>{
 const f=await dexFixture(t),l=await launch(f,{native:true});
 const check=async label=>assert.equal(await quoteBalance(f,l),await liabilities(l),label);
 // Early buys pay the anti-snipe fee into the liquidity bonus.
 await attackerBuys(f,l,parseEther('0.05'),{early:true});await check('after an anti-snipe buy');assert.ok(await l.curve.liquidityBonus()>0n);
 await attackerBuys(f,l,parseEther('1.5'));await check('after a normal buy');
 await complete(f,l);await check('complete');
 // Block graduation with a large mispriced pool, then reopen after the grace period.
 await attackerLiquidity(f,l,{priceMultiple:4,quoteAmount:parseEther('3')});
 await f.advance(86400+1);await mined(l.curve.reopen());await check('reopened');
 const balance=await l.token.balanceOf(f.addresses[0]);await mined(l.token.approve(l.curve.target,balance/3n));await mined(l.curve.sell(balance/3n,0));await check('sold');
 await mined(l.curve.withdrawFees());await check('fees withdrawn');
 await complete(f,l);await check('completed again');
 // The griefer's pool is still there; it cannot block the curve forever, and holders were never stuck.
 await assert.rejects(l.curve.graduate.staticCall(),/pool price mismatch/);
 assert.equal(await l.curve.complete(),true);
});

test('anti-snipe fee: 90% decaying to 1.25% over 60 s; the creator first buy pays only 1.25%; the surplus is locked',async t=>{
 const f=await dexFixture(t),l=await launch(f,{native:true,firstBuy:parseEther('1')});
 const launchedAt=Number(await l.curve.launchedAt()),first=parse(l.curve,l.receipt,'Bought')[0];
 assert.equal(await l.curve.liquidityBonus(),0n,'creator first buy pays no anti-snipe fee');
 assert.equal(await l.curve.protocolFees()+await l.curve.creatorFees(),parseEther('1')*125n/10000n);
 assert.ok(first.args.tokensOut*100n>TOKEN_SUPPLY*10n,'no creator cap: a 1 ETH first buy takes over 10% of supply');
 for(const elapsed of [1,15,30,59,60,61]){
  await f.at(launchedAt+elapsed);await f.provider.send('evm_mine',[]);
  assert.equal(Number(await l.curve.currentFeeBps()),feeModel(launchedAt,launchedAt+elapsed),`fee at ${elapsed}s`);
 }
 assert.equal(Number(await l.curve.currentFeeBps()),BASE_FEE_BPS);
});

test('anti-snipe buys and sells lock the surplus; graduation adds it to liquidity so the pool opens above the curve',async t=>{
 const f=await dexFixture(t),l=await launch(f,{native:false});
 const launchedAt=Number(await l.curve.launchedAt()),trader=f.signers[1],gross=parseUnits('1000',6);
 await mined(f.usdc.connect(trader).approve(l.curve.target,gross));
 await f.at(launchedAt+30);
 const receipt=await mined(l.curve.connect(trader).buy(gross,0));
 const feeBps=BigInt(feeModel(launchedAt,launchedAt+30)),fee=gross*feeBps/10000n,base=gross*125n/10000n;
 const [snipe]=parse(l.curve,receipt,'AntiSnipeFee');
 assert.equal(snipe.args.feeBps,feeBps);assert.equal(snipe.args.lockedAmount,fee-base);
 assert.equal(await l.curve.liquidityBonus(),fee-base);
 const tokens=await l.token.balanceOf(await trader.getAddress());
 await mined(l.token.connect(trader).approve(l.curve.target,tokens));await mined(l.curve.connect(trader).sell(tokens,0));
 assert.ok(await l.curve.liquidityBonus()>fee-base,'the sell inside the window also locked a surplus');
 assert.equal(await f.usdc.balanceOf(l.curve.target),await liabilities(l));
 const bonus=await l.curve.liquidityBonus();
 await complete(f,l);
 const terminal=await terminalPrice(l),q=await l.curve.realReserve(),{tokenFirst}=sortPair(l.token.target,l.usdc??f.usdc.target);
 await mined(l.curve.graduate());
 const pool=new Contract(await l.curve.pool(),v3Artifacts.pool.abi,f.provider),price=await poolPrice(pool,tokenFirst);
 const expected=terminal*(q+bonus)/q;
 assert.ok(price>terminal,'pool opens above the terminal curve price');
 assert.ok(close(price,expected,10n),`pool price ${price} vs ${expected}`);
 assert.equal(await l.curve.liquidityBonus(),0n);
});

test('a reward address that rejects ETH cannot block protocol fees; either side can be claimed alone',async t=>{
 const f=await dexFixture(t),rejecter=await f.deploy(fixtureArt('RejectingReceiver'));
 const l=await launch(f,{native:true,reward:rejecter.target,firstBuy:parseEther('0.4')});
 const protocolOwed=await l.curve.protocolFees(),creatorOwed=await l.curve.creatorFees();
 assert.ok(protocolOwed>0n&&creatorOwed>0n);
 const before=await f.provider.getBalance(f.addresses[2]);
 const receipt=await mined(l.curve.connect(f.signers[3]).withdrawFees());
 assert.equal(await f.provider.getBalance(f.addresses[2])-before,protocolOwed,'protocol paid');
 assert.equal(await l.curve.protocolFees(),0n);assert.equal(await l.curve.creatorFees(),creatorOwed,'creator side stays owed');
 assert.equal(parse(l.curve,receipt,'FeePayoutFailed')[0].args.recipient,rejecter.target);
 assert.equal(await f.provider.getBalance(l.curve.target),await liabilities(l));
 // Single-side claims: protocol works on its own, a failing creator claim returns false and keeps the balance.
 await f.advance(61);await mined(l.curve.buy(parseEther('0.1'),0,{value:parseEther('0.1')}));
 assert.equal(await l.curve.claimFees.staticCall(rejecter.target),false);
 await mined(l.curve.claimFees(f.addresses[2]));assert.equal(await l.curve.protocolFees(),0n);
 await assert.rejects(l.curve.claimFees.staticCall(f.addresses[1]),/fee recipient/);
});

test('a failing ERC-20 quote transfer keeps both fee balances owed instead of reverting',async t=>{
 const f=await dexFixture(t),l=await launch(f,{native:false});
 const p=await l.curve.protocolFees(),c=await l.curve.creatorFees();
 await mined(f.usdc.setFailTransfers(true));
 await mined(l.curve.withdrawFees());
 assert.equal(await l.curve.protocolFees(),p);assert.equal(await l.curve.creatorFees(),c);
 await mined(f.usdc.setFailTransfers(false));await mined(l.curve.withdrawFees());
 assert.equal(await l.curve.protocolFees()+await l.curve.creatorFees(),0n);
});

test('the rebalance swap callback only pays the pool being rebalanced during a migration',async t=>{
 const f=await dexFixture(t);
 for(const adapter of [f.adapter,f.nativeAdapter]){
  await assert.rejects(adapter.uniswapV3SwapCallback.staticCall(1n,0n,'0x'),/rebalance callback/);
  await assert.rejects(adapter.uniswapV3SwapCallback.staticCall(0n,0n,'0x'),/rebalance callback/);
 }
 assert.equal(await f.adapter.MAX_REBALANCE_BPS(),200n);
});

test('no creator cap: a first buy larger than the whole curve buys it out and refunds the unused funds',async t=>{
 for(const native of [true,false]){
  const f=await dexFixture(t),creator=f.addresses[0];
  const buy=native?parseEther('20'):parseUnits('30000',6);
  const before=native?await f.provider.getBalance(creator):await f.usdc.balanceOf(creator);
  const l=await launch(f,{native,firstBuy:buy});
  assert.equal(await l.curve.sold(),SALE_CAP);assert.equal(await l.curve.complete(),true);
  assert.equal(await l.token.balanceOf(creator),SALE_CAP,'the creator holds the whole sale');
  const [bought]=parse(l.curve,l.receipt,'Bought');assert.ok(bought.args.quoteIn<buy,'only the needed amount was charged');
  if(native){const gas=l.receipt.gasUsed*l.receipt.gasPrice,spent=before-await f.provider.getBalance(creator)-gas;assert.equal(spent,FEE+bought.args.quoteIn);}
  else assert.equal(before-await f.usdc.balanceOf(creator),bought.args.quoteIn);
  assert.equal(await quoteBalance(f,l),await liabilities(l));
  await mined(l.curve.graduate());assert.notEqual(await l.curve.pool(),ZeroAddress);
 }
});
