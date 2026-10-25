// Reentrancy evidence for the curve's `nonReentrant` guard.
//
// AUDIT_SCOPE.md dismisses 17 Slither reentrancy findings as "guarded" and the reading is correct - but nothing
// exercised it. These three cases are the ones a hostile participant can actually reach:
//
//   1. a seller that is a contract and re-enters while the curve is paying it out,
//   2. a creator reward contract that re-enters while its fees are being claimed,
//   3. an approved quote asset that re-enters from inside a transfer during a buy.
//
// Each hostile contract records the inner attempt instead of bubbling it, so the assertions can show both halves:
// the outer trade completed and the inner call was refused by the guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Contract,AbiCoder,parseEther,parseUnits} from 'ethers';
import {dexFixture,art,fixtureArt,mined,launch,parse,liabilities,quoteBalance,FEE} from './helpers/dex-fixture.mjs';
import {usdQuoteTemplate} from '../packages/core/curve-model.mjs';

/** Solidity `require(x, "reason")` reverts with Error(string); decode it, or hand back the raw bytes. */
function reason(data){
  if(typeof data==='string'&&data.startsWith('0x08c379a0')){
    try{return AbiCoder.defaultAbiCoder().decode(['string'],'0x'+data.slice(10))[0];}catch{/* fall through */}
  }
  return String(data);
}

/** Curve liabilities for a curve whose quote asset is not the fixture's own mock USDC. */
async function owed(curve){
  return await curve.realReserve()+await curve.protocolFees()+await curve.creatorFees()+await curve.liquidityBonus();
}

test('a seller that re-enters while being paid is refused, and the trade still settles exactly',async t=>{
  const f=await dexFixture(t);
  const l=await launch(f,{native:true,firstBuy:parseEther('0.01')});
  const receiver=await f.deploy(fixtureArt('ReentrantReceiver'));

  // The receiver must be a legitimate trader, so the only thing that can stop its second trade is the guard.
  await mined(l.token.connect(f.signers[0]).transfer(receiver.target,parseEther('1000')));
  await mined(receiver.execute(l.token.target,l.token.interface.encodeFunctionData('approve',[l.curve.target,parseEther('1000')]),0));
  await mined(receiver.arm(l.curve.target,l.curve.interface.encodeFunctionData('sell',[1,0])));

  await mined(receiver.execute(l.curve.target,l.curve.interface.encodeFunctionData('sell',[parseEther('100'),0]),0));

  assert.equal(await receiver.attempted(),true,'the payout reached the hostile recipient');
  assert.equal(await receiver.innerSucceeded(),false,'the re-entrant sell was refused');
  assert.match(reason(await receiver.lastRevert()),/reentrancy/);
  assert.ok(await receiver.received()>0n,'the outer payout was paid');
  assert.equal(await quoteBalance(f,l),await liabilities(l),'the curve is still exactly backed');
});

test('a creator reward contract cannot re-enter while its fees are being claimed',async t=>{
  const f=await dexFixture(t);
  const receiver=await f.deploy(fixtureArt('ReentrantReceiver'));
  const l=await launch(f,{native:true,firstBuy:parseEther('0.01'),reward:receiver.target});

  await mined(l.token.connect(f.signers[0]).transfer(receiver.target,parseEther('1000')));
  await mined(receiver.execute(l.token.target,l.token.interface.encodeFunctionData('approve',[l.curve.target,parseEther('1000')]),0));
  await mined(receiver.arm(l.curve.target,l.curve.interface.encodeFunctionData('sell',[1,0])));

  const fee=await l.curve.creatorFees();
  assert.ok(fee>0n,'the launch accrued creator fees');

  await mined(l.curve.withdrawFees());

  assert.equal(await l.curve.creatorFees(),0n,'the creator ledger is settled');
  assert.equal(await receiver.received(),fee,'the creator was paid in full');
  assert.equal(await receiver.attempted(),true);
  assert.equal(await receiver.innerSucceeded(),false,'the re-entrant call was refused mid-payout');
  assert.match(reason(await receiver.lastRevert()),/reentrancy/);
  assert.equal(await quoteBalance(f,l),await liabilities(l));
});

test('an approved quote asset cannot re-enter the curve from inside a transfer',async t=>{
  const f=await dexFixture(t);
  const quote=await f.deploy(fixtureArt('ReentrantQuote'));
  // Only the treasury may approve a quote, so this is the "the approved asset turned hostile" case.
  const quoteAdapter=await f.deploy(art('ElpidaV3MigrationAdapter'),f.dex.manager.target,quote.target,10000);
  await mined(f.factory.connect(f.signers[2]).approveQuote(quote.target,usdQuoteTemplate(f.startFdvUsd,6),quoteAdapter.target));

  await mined(quote.mint(f.addresses[0],parseUnits('1000',6)));
  await mined(quote.connect(f.signers[0]).approve(f.factory.target,parseUnits('100',6)));
  const receipt=await mined(f.factory.connect(f.signers[0]).launchPaired('Quote','QTE',quote.target,parseUnits('100',6),0,f.addresses[0],{value:FEE}));
  const [event]=parse(f.factory,receipt,'Launched');
  const curve=new Contract(event.args.curve,art('ElpidaDexCurve').abi,f.signers[0]);

  await mined(quote.arm(curve.target,curve.interface.encodeFunctionData('sell',[1,0])));
  await mined(quote.connect(f.signers[0]).approve(curve.target,parseUnits('10',6)));
  await mined(curve.buy(parseUnits('10',6),0));

  assert.equal(await quote.attempted(),true,'the buy moved the hostile quote');
  assert.equal(await quote.innerSucceeded(),false,'the re-entrant call from transfer was refused');
  assert.match(reason(await quote.lastRevert()),/reentrancy/);
  assert.equal(await quote.balanceOf(curve.target),await owed(curve),'the paired curve is still exactly backed');
});
