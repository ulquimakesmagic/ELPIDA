import {AbiCoder, ZeroAddress, concat, getAddress, keccak256, toUtf8Bytes} from 'ethers';

const coder=AbiCoder.defaultAbiCoder();
const uint=value=>{
 const n=BigInt(value);
 if(n<0n)throw new Error('Negative epoch value');
 return n;
};

// OZ double-hashed leaf encoding; uses ordered Merkle sibling pairs.
export function holderLeaf({chainId,distributor,epochId,launchToken,payoutAsset,snapshotBlock},row){
 const wallet=getAddress(row.address),holding=uint(row.holding),amount=uint(row.amount);
 return keccak256(concat([keccak256(coder.encode(
  ['uint256','address','uint256','address','address','uint256','address','uint256','uint256'],
  [uint(chainId),getAddress(distributor),uint(epochId),getAddress(launchToken),getAddress(payoutAsset),uint(snapshotBlock),wallet,holding,amount]
 ))]));
}
const pairHash=(a,b)=>keccak256(concat(a.toLowerCase()<b.toLowerCase()?[a,b]:[b,a]));
export function buildHolderEpoch({chainId,distributor,epochId,launchToken,payoutAsset,snapshotBlock,minimumHolding,rows}){
 if(!Array.isArray(rows)||!rows.length)throw new Error('Epoch requires eligible holders');
 const config={chainId:String(uint(chainId)),distributor:getAddress(distributor),epochId:String(uint(epochId)),launchToken:getAddress(launchToken),payoutAsset:getAddress(payoutAsset),snapshotBlock:String(uint(snapshotBlock)),minimumHolding:String(uint(minimumHolding))};
 if(uint(config.chainId)===0n||uint(config.epochId)===0n||uint(config.snapshotBlock)===0n||uint(config.minimumHolding)===0n)throw new Error('Invalid epoch configuration');
 if(config.distributor===ZeroAddress||config.launchToken===ZeroAddress||config.payoutAsset===ZeroAddress)throw new Error('Use real ERC20 assets');
 const unique=new Set();let budget=0n;
 const entitlements=rows.map(row=>{
  const address=getAddress(row.address),holding=uint(row.holding),amount=uint(row.amount);
  if(address===ZeroAddress||unique.has(address.toLowerCase()))throw new Error('Duplicate or zero holder');
  if(holding<uint(config.minimumHolding)||amount<=0n)throw new Error('Ineligible holder');
  unique.add(address.toLowerCase());budget+=amount;
  return {address,holding:String(holding),amount:String(amount)};
 }).sort((a,b)=>a.address.toLowerCase().localeCompare(b.address.toLowerCase()));
 const leaves=entitlements.map(row=>holderLeaf(config,row));
 const layers=[leaves];
 while(layers.at(-1).length>1){
  const current=layers.at(-1),next=[];
  for(let i=0;i<current.length;i+=2)next.push(i+1<current.length?pairHash(current[i],current[i+1]):current[i]);
  layers.push(next);
 }
 const entries=entitlements.map((row,index)=>{
  let current=index;const proof=[];
  for(let level=0;level<layers.length-1;level++){
   const sibling=current^1;if(sibling<layers[level].length)proof.push(layers[level][sibling]);
   current=Math.floor(current/2);
  }
  return {...row,proof};
 });
 const manifest={...config,budget:String(budget),recipientCount:entries.length,root:layers.at(-1)[0],entries};
 // A second commitment to the entire public immutable manifest (including proofs).
 return {...manifest,manifestHash:keccak256(toUtf8Bytes(JSON.stringify(manifest)))};
}
export function verifyHolderProof(manifest,row){
 let hashed=holderLeaf(manifest,row);
 for(const sibling of row.proof)hashed=pairHash(hashed,sibling);
 return hashed.toLowerCase()===manifest.root.toLowerCase();
}

/**
 * Pre-publication sanity check against a historical, finalized RPC block.
 * This cannot prove that the publisher discovered *all* holders or that an RPC
 * endpoint is honest; use independent RPCs and publish the full manifest.
 */
export async function auditHolderEpoch(manifest,{balanceAt,excluded=[]}={}){
 if(typeof balanceAt!=='function')throw new Error('Historical balance reader required');
 const rebuilt=buildHolderEpoch({...manifest,rows:manifest.entries});
 if(rebuilt.root.toLowerCase()!==manifest.root.toLowerCase()||rebuilt.manifestHash.toLowerCase()!==manifest.manifestHash.toLowerCase())throw new Error('Manifest commitment mismatch');
 const blocked=new Set(excluded.map(address=>getAddress(address).toLowerCase()));
 for(const row of manifest.entries){
  if(blocked.has(row.address.toLowerCase()))throw new Error('Excluded wallet in distribution');
  const historical=uint(await balanceAt(row.address,BigInt(manifest.snapshotBlock)));
  if(historical!==uint(row.holding))throw new Error(`Historical token balance mismatch for ${row.address}`);
 }
 return {verifiedHolders:manifest.entries.length,budget:manifest.budget,snapshotBlock:manifest.snapshotBlock};
}
