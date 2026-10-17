import {link,mkdir,rm,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname} from 'node:path';
import {getAddress,keccak256,toUtf8Bytes} from 'ethers';
import {verifyHolderProof} from '../../packages/core/holder-epochs.mjs';

/**
 * Write an immutable, public epoch manifest before publishing its hash on-chain.
 * This contains entitlements and no wallet private keys. Store it redundantly.
 */
export async function persistEpochManifest(path,manifest){
 await mkdir(dirname(path),{recursive:true});
 const temp=`${path}.tmp-${randomUUID()}`;
 await writeFile(temp,JSON.stringify(manifest,null,2)+'\n',{mode:0o600,flag:'wx'});
 try {await link(temp,path);} finally {await rm(temp,{force:true});}
}

/** Permissionless, restart-safe payer: no in-memory cursor; chain paid state wins. */
export async function executeHolderEpoch(contract,manifest,{batchSize=16}={}){
 if(!Number.isInteger(batchSize)||batchSize<1||batchSize>16)throw new Error('Batch size 1..16');
 const epoch=await contract.epochs(manifest.epochId);
 const expectedHash=keccak256(toUtf8Bytes(JSON.stringify(Object.fromEntries(
  Object.entries(manifest).filter(([key])=>key!=='manifestHash')
 ))));
 if(expectedHash.toLowerCase()!==manifest.manifestHash.toLowerCase()||
    epoch.root.toLowerCase()!==manifest.root.toLowerCase()||
    epoch.manifestHash.toLowerCase()!==manifest.manifestHash.toLowerCase()||
    getAddress(epoch.launchToken)!==getAddress(manifest.launchToken)||
    getAddress(epoch.payoutAsset)!==getAddress(manifest.payoutAsset)||
    BigInt(epoch.snapshotBlock)!==BigInt(manifest.snapshotBlock)||
    BigInt(epoch.minimumHolding)!==BigInt(manifest.minimumHolding)||
    BigInt(epoch.budget)!==BigInt(manifest.budget)||
    Number(epoch.recipientCount)!==manifest.recipientCount||
    manifest.recipientCount!==manifest.entries.length)throw new Error('On-chain epoch / manifest mismatch');
 if(manifest.entries.some(row=>!verifyHolderProof(manifest,row)))throw new Error('Invalid manifest proof');
 const results={alreadyPaid:0,newlyPaid:0,transactions:0};
 for(let offset=0;offset<manifest.entries.length;offset+=batchSize){
  const slice=manifest.entries.slice(offset,offset+batchSize);
  const statuses=await Promise.all(slice.map(row=>contract.epochPaid(manifest.epochId,row.address)));
  const unpaid=slice.filter((_,index)=>!statuses[index]);
  results.alreadyPaid+=slice.length-unpaid.length;
  if(!unpaid.length)continue;
  try {
   await (await contract.distributeBatch(manifest.epochId,
    unpaid.map(x=>x.address),unpaid.map(x=>BigInt(x.holding)),
    unpaid.map(x=>BigInt(x.amount)),unpaid.map(x=>x.proof))).wait();
  } catch(error){
   const check=await Promise.all(unpaid.map(row=>contract.epochPaid(manifest.epochId,row.address)));
   if(!check.every(Boolean))throw error;
  }
  results.newlyPaid+=unpaid.length;
  results.transactions++;
 }
 return results;
}
