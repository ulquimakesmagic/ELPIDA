import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {network} from 'hardhat';
import {BrowserProvider,ContractFactory,parseUnits,formatUnits} from 'ethers';
import {compileContracts} from '../../scripts/compile.mjs';
import {buildHolderEpoch} from '../../packages/core/holder-epochs.mjs';
import {verifiedHolderSnapshot} from './holder-snapshot.mjs';
import {publishFundedHolderEpoch,executeHolderEpoch} from './holder-epoch-keeper.mjs';

let artifacts;
const mined=async tx=>(await tx).wait();
/** Private, non-forked Hardhat chain only. No RPC URL, wallet or key is accepted. */
export class HolderRehearsal {
 constructor(){this.phase='empty';this.events=[];this.checks={};}
 log(message){this.events.push({time:new Date().toISOString(),message});}
 require(...phases){if(!phases.includes(this.phase))throw new Error('Complete the preceding rehearsal step first.');}
 async setup(){
  this.require('empty');
  artifacts??=compileContracts({includeMocks:true});
  this.connection=await network.create('localTest');
  this.provider=new BrowserProvider(this.connection.provider,undefined,{cacheTimeout:-1});this.provider.pollingInterval=10;
  assert.equal((await this.provider.getNetwork()).chainId,31337n);
  const signers=await Promise.all([0,1,2,3,4,5,6].map(i=>this.provider.getSigner(i)));
  [this.executor,this.treasury,...this.holders]=signers.slice(0,5);this.claimant=signers[5];this.keeper=signers[6];
  const deploy=async(file,name,args=[])=>{const a=artifacts[file][name],c=await new ContractFactory(a.abi,a.evm.bytecode.object,this.executor).deploy(...args);await c.waitForDeployment();return c;};
  this.quote=await deploy('tests/fixtures/MockUSDC.sol','MockUSDC');
  const supply=parseUnits('1000000000',18);
  this.token=await deploy('contracts/evm/src/ElpidaToken.sol','ElpidaToken',['Rehearsal token','RHR',supply,this.executor.address]);
  const vaultArgs=[this.executor.address,this.executor.address];
  this.vault=await deploy('contracts/evm/src/ElpidaRewardVault.sol','ElpidaRewardVault',[...vaultArgs,[],[],[]]);
  // A code-bearing adapter stub is sufficient because this rehearsal never graduates.
  this.curve=await deploy('contracts/evm/src/ElpidaDexCurve.sol','ElpidaDexCurve',[await this.quote.getAddress(),await this.token.getAddress(),this.executor.address,this.treasury.address,await this.vault.getAddress(),50_000_000n*10n/9n,supply*10n/9n,await this.quote.getAddress(),86400]);
  await mined(this.token.transfer(await this.curve.getAddress(),supply));
  await mined(this.vault.initialize(await this.token.getAddress(),await this.curve.getAddress(),await this.quote.getAddress()));
  this.dist=await deploy('contracts/evm/src/ElpidaHolderEpochs.sol','ElpidaHolderEpochs',[await this.vault.getAddress(),60]);
  await mined(this.vault.configureHolderDistributor(await this.dist.getAddress()));
  this.protected=await deploy('contracts/evm/src/ElpidaRewardVault.sol','ElpidaRewardVault',[...vaultArgs,['0x'+'00'.repeat(32)],[this.claimant.address],[10000]]);
  await mined(this.protected.initialize(await this.token.getAddress(),await this.curve.getAddress(),await this.quote.getAddress()));
  const protectedDist=await deploy('contracts/evm/src/ElpidaHolderEpochs.sol','ElpidaHolderEpochs',[await this.protected.getAddress(),60]);
  await mined(this.protected.configureHolderDistributor(await protectedDist.getAddress()));
  await mined(this.quote.mint(await this.protected.getAddress(),100_000_000n));await mined(this.protected.sync(await this.quote.getAddress()));
  for(const holder of this.holders){await mined(this.quote.mint(holder.address,100_000_000n));await mined(this.quote.connect(holder).approve(await this.curve.getAddress(),100_000_000n));}
  await this.connection.provider.request({method:'evm_increaseTime',params:[61]});await this.connection.provider.request({method:'evm_mine',params:[]});
  this.directory=await mkdtemp(join(tmpdir(),'elpida-rehearsal-'));
  const adapter=()=>({getNetwork:()=>this.provider.getNetwork(),getBlockNumber:()=>this.provider.getBlockNumber(),getBlock:n=>this.provider.getBlock(n),getLogs:q=>this.provider.getLogs(q),call:q=>this.provider.call(q)});
  this.snapshotOptions={providers:[adapter(),adapter()],confirmations:1,excluded:[await this.curve.getAddress(),await this.vault.getAddress(),await this.dist.getAddress(),await this.token.getAddress(),this.executor.address]};
  this.phase='initialized';this.log('Private chain 31337 ready. All tokens are simulated. Publication delay: 60 seconds.');
 }
 async act(action){
  if(action==='setup'){await this.setup();return this.state();}
  if(action==='trade'){
   this.require('initialized');
   for(const [i,holder] of this.holders.entries())await mined(this.curve.connect(holder).buy(BigInt(i+1)*10_000_000n,1));
   assert.equal(await this.curve.MODEL_VERSION(),10n);assert.equal(await this.curve.creatorFees(),375_000n);
   this.phase='traded';this.checks.model10Fees=true;this.log('Three Model 10 buys generated 0.375 simulated USDC in creator fees (1.25% total fee, split 50/50).');
  }else if(action==='sync'){
   this.require('traded');await mined(this.curve.withdrawFees());await mined(this.vault.sync(await this.quote.getAddress()));
   assert.equal(await this.vault.strategyBalance(await this.quote.getAddress()),375_000n);
   const cutoff=await this.provider.getBlockNumber();await this.connection.provider.request({method:'evm_mine',params:[]});
   await mined(this.vault.distribute(await this.quote.getAddress(),[this.claimant.address],[100_000n],3600,cutoff));
   this.phase='synced';this.log('Collected 0.375 simulated USDC. Reserved 0.1 for a vested grant in the same vault; 0.275 remains available to holders.');
  }else if(action==='snapshot'){
   this.require('synced');this.snapshotBlock=await this.provider.getBlockNumber();
   // Change current holdings after the cutoff to exercise actual historical reads.
   await mined(this.token.connect(this.holders[0]).transfer(this.holders[1].address,parseUnits('1',18)));
   this.snapshot=await verifiedHolderSnapshot({...this.snapshotOptions,chainId:31337,token:await this.token.getAddress(),snapshotBlock:this.snapshotBlock});
   const rows=this.snapshot.rows.filter(r=>BigInt(r.holding)>=parseUnits('1',18));
   assert.equal(rows.length,3);
   const total=rows.reduce((sum,r)=>sum+BigInt(r.holding),0n),budget=await this.vault.strategyBalance(await this.quote.getAddress());let allocated=0n;
   this.manifest=buildHolderEpoch({chainId:31337,distributor:await this.dist.getAddress(),epochId:1,launchToken:await this.token.getAddress(),payoutAsset:await this.quote.getAddress(),snapshotBlock:this.snapshotBlock,minimumHolding:parseUnits('1',18),rows:rows.map((r,i)=>{const amount=i===rows.length-1?budget-allocated:budget*BigInt(r.holding)/total;allocated+=amount;return {...r,amount};})});
   this.before=new Map(await Promise.all(this.holders.map(async h=>[h.address,await this.quote.balanceOf(h.address)])));
   this.phase='verified';this.checks.historicalSnapshot=true;this.log('Historical snapshot reconciled with total supply using two local readers; three eligible holders. These readers share one simulated chain, not independent production RPCs.');
  }else if(action==='fund'){
   this.require('verified');
   const vault={runner:this.vault.runner,getAddress:()=>this.vault.getAddress(),holderDistributor:()=>this.vault.holderDistributor(),mainToken:()=>this.vault.mainToken(),mainCurve:()=>this.vault.mainCurve(),fundHolderEpoch:async(...args)=>{const tx=await this.vault.fundHolderEpoch(...args);return {wait:async()=>{await tx.wait();throw new Error('Simulated lost publication receipt');}};}};
   const result=await publishFundedHolderEpoch(vault,this.dist,this.manifest,this.publicationOptions());
   assert.equal(result.alreadyPublished,true);this.checks.publicationRecovery=true;
   const row=this.manifest.entries[0];
   await assert.rejects(this.dist.distributeBatch.staticCall(1,[row.address],[row.holding],[row.amount],[row.proof]),/epoch not ready/);
   this.checks.publicationDelay=true;this.phase='funded';this.log('Vault funded and published atomically. Lost receipt reconciled; early payout rejected.');
  }else if(action==='advance'){
   this.require('funded');await this.connection.provider.request({method:'evm_increaseTime',params:[60]});await this.connection.provider.request({method:'evm_mine',params:[]});
   this.phase='ready';this.log('Advanced only the simulated chain clock through the publication delay.');
  }else if(action==='pay'){
   this.require('ready','partial');
   const contract=this.dist.connect(this.keeper);
   if(this.phase==='ready'){
    let batches=0;
    const interrupted={runner:contract.runner,getAddress:()=>contract.getAddress(),epochs:id=>contract.epochs(id),epochPaid:(...a)=>contract.epochPaid(...a),distributeBatch:(...a)=>{if(++batches===2)throw new Error('Simulated RPC interruption');return contract.distributeBatch(...a);}};
    await assert.rejects(executeHolderEpoch(interrupted,this.manifest,{batchSize:2}),/Simulated RPC interruption/);
    assert.equal((await this.dist.epochs(1)).paidCount,2n);this.phase='partial';this.log('First two holders paid. Injected RPC interruption before the second batch; on-chain progress retained.');
   }else{
    const result=await executeHolderEpoch(contract,this.manifest,{batchSize:2});assert.equal(result.alreadyPaid,2);assert.equal(result.newlyPaid,1);
    this.phase='complete';this.checks.keeperRecovery=true;this.log('Resumed from on-chain paid state; remaining holder paid without replay.');
   }
  }else if(action==='retry'){
   this.require('complete');
   const publication=await publishFundedHolderEpoch(this.vault,this.dist,this.manifest,this.publicationOptions());assert.equal(publication.alreadyPublished,true);
   const result=await executeHolderEpoch(this.dist.connect(this.keeper),this.manifest);assert.equal(result.newlyPaid,0);assert.equal(result.alreadyPaid,3);
   assert.equal(await this.dist.reserved(await this.quote.getAddress()),0n);assert.equal(await this.vault.strategyBalance(await this.quote.getAddress()),0n);
   assert.equal(await this.vault.accounted(this.manifest.payoutAsset),100_000n);
   assert.equal(await this.quote.balanceOf(await this.vault.getAddress()),100_000n);
   const grant=await this.vault.grants(0);assert.equal(grant.total,100_000n);assert.equal(grant.claimed,0n);
   await assert.rejects(this.vault.fundHolderEpoch.staticCall(2,this.manifest.payoutAsset,this.snapshotBlock,1,this.manifest.root,this.manifest.manifestHash,1,3));
   await assert.rejects(this.protected.fundHolderEpoch.staticCall(1,this.manifest.payoutAsset,this.snapshotBlock,1,this.manifest.root,this.manifest.manifestHash,1,3),/holder budget/);
   assert.equal(await this.protected.claimable(this.claimant.address,this.manifest.payoutAsset),100_000_000n);
   for(const row of this.manifest.entries)assert.equal(await this.quote.balanceOf(row.address)-this.before.get(row.address),BigInt(row.amount));
   this.checks.noDoublePayment=true;this.checks.claimsProtected=true;this.log('Retries sent no new funds. Exact holder balances match the manifest; 0.1 USDC of vested grants remain in the same vault and 100 USDC of direct claims remain protected in the allocation vault.');
  }else throw new Error('Unknown rehearsal action.');
  return this.state();
 }
 publicationOptions(){return {manifestPath:join(this.directory,'epoch-1.json'),snapshotOptions:this.snapshotOptions};}
 async state(){
  const result={phase:this.phase,chainId:31337,simulated:true,checks:this.checks,events:this.events};
  if(!this.quote)return result;
  const asset=await this.quote.getAddress(),epoch=await this.dist.epochs(1);
  result.balances={creatorFees:formatUnits(await this.curve.creatorFees(),6),strategy:formatUnits(await this.vault.strategyBalance(asset),6),accounted:formatUnits(await this.vault.accounted(asset),6),reserved:formatUnits(await this.dist.reserved(asset),6),protectedClaims:formatUnits(await this.protected.claimable(this.claimant.address,asset),6),paid:formatUnits(epoch.paidAmount,6)};
  result.contracts={token:await this.token.getAddress(),curve:await this.curve.getAddress(),vault:await this.vault.getAddress(),distributor:await this.dist.getAddress()};
  result.holders=await Promise.all((this.manifest?.entries??[]).map(async row=>({address:row.address,snapshotHolding:formatUnits(row.holding,18),currentHolding:formatUnits(await this.token.balanceOf(row.address),18),entitlement:formatUnits(row.amount,6),received:formatUnits(await this.quote.balanceOf(row.address)-this.before.get(row.address),6),paid:await this.dist.epochPaid(1,row.address)})));
  result.manifest=this.manifest??null;result.snapshotHash=this.snapshot?.blockHash??null;
  return result;
 }
 async close(){this.provider?.destroy();await this.connection?.close();}
}
