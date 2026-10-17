import {link,mkdir,rm,writeFile,readFile} from 'node:fs/promises';
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

function assertEpochMatches(epoch,manifest){
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
}

/** Permissionless, restart-safe payer: no in-memory cursor; chain paid state wins. */
export async function executeHolderEpoch(contract,manifest,{batchSize=16}={}){
 if(!Number.isInteger(batchSize)||batchSize<1||batchSize>16)throw new Error('Batch size 1..16');
 if(contract.runner?.provider){
  if((await contract.runner.provider.getNetwork()).chainId!==BigInt(manifest.chainId)||getAddress(await contract.getAddress())!==getAddress(manifest.distributor))throw new Error('Wrong distributor domain');
 }
 assertEpochMatches(await contract.epochs(manifest.epochId),manifest);
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

/** Persist and independently audit before atomic vault funding. No deployment or key loading. */
export async function publishFundedHolderEpoch(vault,distributor,manifest,{manifestPath,snapshotOptions}={}){
 const {verifiedHolderSnapshot}=await import('./holder-snapshot.mjs');
 const {auditHolderEpoch}=await import('../../packages/core/holder-epochs.mjs');
 if(typeof manifestPath!=='string'||!manifestPath.trim())throw new Error('Manifest path required');
 const provider=distributor.runner.provider;
 if((await vault.runner.provider.getNetwork()).chainId!==BigInt(manifest.chainId))throw new Error('Wrong vault chain');
 if((await provider.getNetwork()).chainId!==BigInt(manifest.chainId)||getAddress(await distributor.getAddress())!==getAddress(manifest.distributor))throw new Error('Wrong distributor domain');
 if(getAddress(await vault.holderDistributor())!==getAddress(manifest.distributor)||getAddress(await distributor.publisher())!==getAddress(await vault.getAddress())||getAddress(await vault.mainToken())!==getAddress(manifest.launchToken))throw new Error('Vault binding mismatch');
 const excluded=[await vault.getAddress(),manifest.distributor,manifest.launchToken,await vault.mainCurve(),...(snapshotOptions?.excluded??[])];
 const snapshot=await verifiedHolderSnapshot({...snapshotOptions,excluded,chainId:manifest.chainId,token:manifest.launchToken,snapshotBlock:Number(manifest.snapshotBlock)});
 const balances=new Map(snapshot.rows.map(row=>[row.address,row.holding]));
 const eligible=snapshot.rows.filter(row=>BigInt(row.holding)>=BigInt(manifest.minimumHolding));
 if(eligible.length!==manifest.entries.length)throw new Error('Incomplete eligible recipient set');
 await auditHolderEpoch(manifest,{balanceAt:address=>{if(!balances.has(address))throw new Error('Unknown snapshot holder');return balances.get(address);}});
 for(const [path,data] of [[manifestPath+'.snapshot.json',snapshot],[manifestPath,manifest]]){
  try {await persistEpochManifest(path,data);} catch(error){
   if(error.code!=='EEXIST'||await readFile(path,'utf8')!==JSON.stringify(data,null,2)+'\n')throw error;
  }
 }
 // Recheck the block immediately before sending; reorgs after submission remain an operational risk.
 for(const rpc of [vault.runner.provider,provider,...snapshotOptions.providers]){
  if((await rpc.getBlock(snapshot.snapshotBlock))?.hash!==snapshot.blockHash)throw new Error('Snapshot reorg or provider fork');
 }
 const reconcile=async()=>{
  const epoch=await distributor.epochs(manifest.epochId);
  if(BigInt(epoch.budget)===0n)return false;
  assertEpochMatches(epoch,manifest);return true;
 };
 if(await reconcile())return {alreadyPublished:true,receipt:null};
 try {
  const tx=await vault.fundHolderEpoch(manifest.epochId,manifest.payoutAsset,manifest.snapshotBlock,manifest.minimumHolding,manifest.root,manifest.manifestHash,manifest.budget,manifest.recipientCount);
  const receipt=await tx.wait();
  if(!receipt||receipt.status!==1)throw new Error('Publication receipt not successful');
  return {alreadyPublished:false,receipt};
 } catch(error){
  if(await reconcile())return {alreadyPublished:true,receipt:null};
  throw error;
 }
}
