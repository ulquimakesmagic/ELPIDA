import test from 'node:test';
import assert from 'node:assert/strict';
import {Contract,ZeroAddress,id,parseUnits} from 'ethers';
import {createRuntime} from '../apps/api/curve-runtime.mjs';
test('reward treasury runs wallet allocations, identity escrow, holder payouts, conversion and vesting',async t=>{
 const r=await createRuntime({seed:false,dex:true});t.after(()=>r.close());
 const creator=r.config.accounts[0].address,trader=r.config.accounts[1].address;
 // Native pricing: launches pair with ETH (the creator half of the 1.25% first-buy fee funds the vault).
 const launch=(symbol,policy)=>r.transact('launch',{name:symbol,symbol,pair:'native',firstBuy:'0.2',rewardPolicy:policy});
 await t.test('wallet funds accrue separately from an unverified domain and cannot be stolen',async()=>{
  const {token}=await launch('SPLIT',{mode:'exclusive',recipients:[{kind:'wallet',target:creator,percent:70},{kind:'domain',target:'community.org',percent:30}]});
  const v=r.rewards.record(token).vault,asset=ZeroAddress;
  assert.equal(await v.claimable(creator,asset),875000000000000n);assert.equal(await v.identityBalance(id('domain:community.org'),asset),375000000000000n);
  await assert.rejects(v.claimIdentity.staticCall(id('domain:community.org'),asset),/unverified/);
  await assert.rejects(v.connect(await r.provider.getSigner(0)).bindIdentity.staticCall(id('domain:community.org'),trader),/verification/);
  await r.transact('reward-claim',{token,index:0,asset});assert.equal(await v.claimable(creator,asset),0n);assert.equal(await v.identityBalance(id('domain:community.org'),asset),375000000000000n);
  await assert.rejects(r.transact('reward-challenge',{token,index:1,wallet:ZeroAddress}),/valid claim wallet/);
  const challenge=await r.transact('reward-challenge',{token,index:1,wallet:creator});
  const signature=await(await r.provider.getSigner(0)).signMessage(challenge.message);
  r.rewards.dnsResolver=async()=>[['wrong-proof']];await assert.rejects(r.transact('reward-verify',{nonce:challenge.nonce,signature}),/DNS TXT/);
  const wrong=await(await r.provider.getSigner(1)).signMessage(challenge.message);await assert.rejects(r.transact('reward-verify',{nonce:challenge.nonce,signature:wrong}),/does not match/);
  r.rewards.dnsResolver=async()=>[[challenge.txt]];await r.transact('reward-verify',{nonce:challenge.nonce,signature});
  assert.equal((await v.verifiedWallet(id('domain:community.org'))).toLowerCase(),creator.toLowerCase());
  await r.transact('reward-claim',{token,index:1,asset});assert.equal(await v.identityBalance(id('domain:community.org'),asset),0n);
  await assert.rejects(r.transact('reward-verify',{nonce:challenge.nonce,signature}),/expired/);

 });
 await t.test('threshold distributions pay eligible holders and exclude the curve',async()=>{
  const {token}=await launch('HOLD',{mode:'holders',threshold:'0.002',minimumHolding:'1000'});
  assert.equal(r.rewards.record(token).epochs,0);
  await r.transact('buy',{token,account:'1',amount:'0.2'});
  const record=r.rewards.record(token);assert.equal(record.epochs,1);
  assert.equal(record.events[0].holders,2);assert.equal(record.events[0].budget,'2500000000000000');
  assert.equal(await record.vault.strategyBalance(ZeroAddress),0n);
 });
 await t.test('paired rewards purchase and automatically deliver the simulated stock',async()=>{
  const stock=r.rewards.stock;const before=await stock.balanceOf(creator);
  const {token}=await launch('STOCK',{mode:'paired',rewardToken:stock.target,threshold:'0.001',minimumHolding:'1'});
  assert.ok(await stock.balanceOf(creator)>before);assert.equal(r.rewards.record(token).epochs,1);
  assert.equal(await stock.balanceOf(r.rewards.record(token).vault.target),0n);
 });
 await t.test('buybacks create linear vesting, claim only unlocked tokens and do not replay',async()=>{
  const {token}=await launch('VEST',{mode:'buyback',threshold:'0.001',minimumHolding:'1',vestingDays:30});
  const v=r.rewards.record(token).vault;assert.equal(await v.grantCount(),1n);const grant=await v.grants(0);assert.ok(grant.total>0n);
  const asset=new Contract(token,r.config.contracts.token.abi,r.provider),before=await asset.balanceOf(creator);
  await r.provider.send('evm_increaseTime',[15*86400]);await r.provider.send('evm_mine',[]);
  await r.transact('reward-claim',{token,grant:0});const midway=await asset.balanceOf(creator)-before;
  assert.ok(midway>grant.total*49n/100n&&midway<grant.total*51n/100n);
  await r.provider.send('evm_increaseTime',[16*86400]);await r.provider.send('evm_mine',[]);await r.transact('reward-claim',{token,grant:0});
  assert.equal((await v.grants(0)).claimed,grant.total);assert.equal(await asset.balanceOf(creator)-before,grant.total);
  await r.transact('reward-claim',{token,grant:0});assert.equal(await asset.balanceOf(creator)-before,grant.total);
 });
 // Time travel for vesting also expires the pricing feed; the simulated keeper must publish again.
 await r.updatePrice(2500);
 await t.test('Elpida token rewards buy the selected same-source curve token',async()=>{
  const a=await r.transact('launch',{name:'Paired token',symbol:'PAIR',pair:'native',firstBuy:'0.025'}),asset=new Contract(a.token,r.config.contracts.token.abi,r.provider),before=await asset.balanceOf(creator);
  const b=await launch('PAIRHOLD',{mode:'paired',rewardToken:a.token,threshold:'0.001',minimumHolding:'1'});
  assert.equal(r.rewards.record(b.token).epochs,1);assert.ok(await asset.balanceOf(creator)>before);
 });
 await t.test('custom Elpida and simulated-stock trading pairs use their actual quote assets',async()=>{
  const pair=await r.transact('launch',{name:'Pair source',symbol:'SOURCE',pair:'native',firstBuy:'0.025'});
  await r.transact('buy',{token:pair.token,amount:r.indexer.snapshot(pair.token).remainingBuy});await r.transact('graduate',{token:pair.token});
  const launched=await r.transact('launch',{name:'Custom pair',symbol:'CUSTOM',pair:'token',quoteToken:pair.token,firstBuy:'200',rewardPolicy:{mode:'paired',rewardToken:pair.token,threshold:'1',minimumHolding:'1'}});
  const snap=r.indexer.listings().find(t=>t.address===launched.token);assert.equal(snap.quoteAddress.toLowerCase(),pair.token);assert.equal(snap.quoteSymbol,'SOURCE');assert.equal(snap.pair,'token');assert.equal(snap.priceUsd,null);
  assert.equal(r.rewards.record(launched.token).epochs,1);
  await r.transact('buy',{token:launched.token,amount:'20'});assert.ok((await r.getQuote({token:launched.token,side:'sell',amount:'1'})).out);
  await r.transact('buy',{token:launched.token,amount:r.indexer.snapshot(launched.token).remainingBuy});await r.transact('graduate',{token:launched.token});
  assert.equal(r.indexer.snapshot(launched.token).venue,'Uniswap v3');assert.equal(r.indexer.snapshot(launched.token).liquidityLocked,true);
  const epochs=r.rewards.record(launched.token).epochs;await r.transact('buy',{token:launched.token,amount:'10000'});assert.ok(r.rewards.record(launched.token).epochs>epochs,'post-migration position fees reach the holder treasury');

  await r.transact('reward-stock-faucet',{});
  const stockPair=await r.transact('launch',{name:'Stock pair',symbol:'XPAIR',pair:'xstock',quoteToken:r.rewards.stock.target,firstBuy:'0.01',rewardPolicy:{mode:'holders',threshold:'0.00001',minimumHolding:'1'}});
  assert.equal(r.indexer.listings().find(t=>t.address===stockPair.token).quoteSymbol,'TEST-STOCK');assert.equal(r.indexer.listings().find(t=>t.address===stockPair.token).pair,'xstock');
  await assert.rejects(r.transact('launch',{name:'Wrong kind',symbol:'WRONG',pair:'token',quoteToken:r.rewards.stock.target,firstBuy:'0.01'}),/graduated Elpida token/);assert.equal(r.rewards.record(stockPair.token).epochs,1);
 });
 const dashboard=await r.rewards.dashboard();assert.equal(dashboard.rows.length,7);assert.equal(dashboard.localOnly,true);assert.equal(dashboard.xVerificationConfigured,false);
});
