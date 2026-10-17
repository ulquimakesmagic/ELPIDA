import test from 'node:test';
import assert from 'node:assert/strict';
import {Wallet} from 'ethers';
import {auditHolderEpoch,buildHolderEpoch,holderLeaf,verifyHolderProof} from '../packages/core/holder-epochs.mjs';
import {executeHolderEpoch,persistEpochManifest} from '../apps/api/holder-epoch-keeper.mjs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const addresses=Array.from({length:36},(_,i)=>new Wallet(`0x${BigInt(i+1).toString(16).padStart(64,'0')}`).address);
const launchToken=addresses[0],payoutAsset=addresses[1],distributor=addresses[35],chainId=31337;
function manifest(count=20,epochId=1){return buildHolderEpoch({chainId,distributor,epochId,launchToken,payoutAsset,snapshotBlock:123,minimumHolding:100,rows:addresses.slice(2,2+count).map((address,i)=>({address,holding:100+i,amount:10+i}))});}
function mockContract(manifest,{failAt=0,lostReceipt=false}={}){
 const paid=new Set(),calls=[];let once=true;
 return {paid,calls,
  async epochs(){return {root:manifest.root,manifestHash:manifest.manifestHash,launchToken,payoutAsset,snapshotBlock:123n,minimumHolding:100n,budget:BigInt(manifest.budget),recipientCount:manifest.recipientCount};},
  async epochPaid(_,address){return paid.has(address.toLowerCase());},
  async distributeBatch(_id,wallets,holdings,amounts,proofs){
   calls.push([...wallets]);
   assert.ok(wallets.length<=16);assert.equal(wallets.length,proofs.length);
   for(let i=0;i<wallets.length;i++)assert.ok(verifyHolderProof(manifest,{address:wallets[i],holding:String(holdings[i]),amount:String(amounts[i]),proof:proofs[i]}));
   if(failAt===calls.length&&once){once=false;throw new Error('temporary RPC timeout');}
   return {wait:async()=>{
    for(const wallet of wallets)paid.add(wallet.toLowerCase());
    if(lostReceipt&&once){once=false;throw new Error('receipt not received');}
   }};
  },
 };
}

test('Merkle proofs commit wallet, holding, amount and epoch, including an odd leaf',()=>{
 const m=manifest(5);
 assert.equal(m.recipientCount,5);assert.equal(m.budget,'60');
 for(const row of m.entries)assert.equal(verifyHolderProof(m,row),true);
 assert.equal(verifyHolderProof(m,{...m.entries[0],amount:'999'}),false);
 assert.equal(holderLeaf({...m,epochId:2},m.entries[0])===holderLeaf(m,m.entries[0]),false);
});

test('manifest rejects duplicate wallets, zero funds and below-minimum holders',()=>{
 const base={chainId,distributor,epochId:1,launchToken,payoutAsset,snapshotBlock:123,minimumHolding:100};
 assert.throws(()=>buildHolderEpoch({...base,rows:[{address:addresses[2],holding:1,amount:1}]}),/Ineligible/);
 assert.throws(()=>buildHolderEpoch({...base,rows:[{address:addresses[2],holding:100,amount:1},{address:addresses[2],holding:100,amount:1}]}),/Duplicate/);
 assert.throws(()=>buildHolderEpoch({...base,rows:[{address:addresses[2],holding:100,amount:0}]}),/Ineligible/);
});

test('automatic keeper survives failed second batch and never replays confirmed recipients',async()=>{
 const m=manifest(23),c=mockContract(m,{failAt:2});
 await assert.rejects(executeHolderEpoch(c,m),/temporary RPC timeout/);
 assert.equal(c.paid.size,16);
 const result=await executeHolderEpoch(c,m);
 assert.equal(c.paid.size,23);assert.equal(result.alreadyPaid,16);assert.equal(result.newlyPaid,7);
 assert.equal((await executeHolderEpoch(c,m)).newlyPaid,0);
 assert.deepEqual(c.calls.map(call=>call.length),[16,7,7]);
});

test('keeper resumes mixed paid/unpaid batches by filtering paid wallets',async()=>{
 const m=manifest(4),c=mockContract(m);c.paid.add(m.entries[1].address.toLowerCase());
 const result=await executeHolderEpoch(c,m);
 assert.equal(result.alreadyPaid,1);assert.equal(result.newlyPaid,3);
 assert.equal(c.calls[0].length,3);
});

test('keeper reconciles lost receipt and rejects tampered manifest before sending',async()=>{
 const m=manifest(3),c=mockContract(m,{lostReceipt:true});
 assert.equal((await executeHolderEpoch(c,m)).newlyPaid,3);
 assert.equal(c.calls.length,1);
 await assert.rejects(executeHolderEpoch(c,{...m,root:'0x'+'11'.repeat(32)}),/manifest mismatch/);
 assert.equal(c.calls.length,1);
});

test('manifest journal survives restart and refuses accidental overwrite',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'elpida-epoch-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const path=join(dir,'epoch.json'),m=manifest(4);
 await persistEpochManifest(path,m);
 const stored=JSON.parse(await readFile(path,'utf8'));
 assert.deepEqual(stored,m);
 await assert.rejects(persistEpochManifest(path,m),{code:'EEXIST'});
});

test('Merkle proof cannot be replayed on another chain or distributor',()=>{
 const m=manifest(3),row=m.entries[0];
 assert.equal(verifyHolderProof({...m,chainId:'31338'},row),false);
 assert.equal(verifyHolderProof({...m,distributor:addresses[34]},row),false);
});

test('publisher audit checks historical balances and excluded contract addresses',async()=>{
 const m=manifest(2),lookup=new Map(m.entries.map(row=>[row.address,BigInt(row.holding)]));
 const balanceAt=async (address,block)=>{assert.equal(block,123n);return lookup.get(address);};
 assert.equal((await auditHolderEpoch(m,{balanceAt})).verifiedHolders,2);
 await assert.rejects(auditHolderEpoch(m,{balanceAt,excluded:[m.entries[0].address]}),/Excluded/);
 lookup.set(m.entries[1].address,0n);
 await assert.rejects(auditHolderEpoch(m,{balanceAt}),/Historical token balance mismatch/);
});
