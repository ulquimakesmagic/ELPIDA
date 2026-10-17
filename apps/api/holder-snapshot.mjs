import {Contract, Interface, ZeroAddress, getAddress} from 'ethers';
const abi=['event Transfer(address indexed from,address indexed to,uint256 value)','function balanceOf(address) view returns(uint256)','function totalSupply() view returns(uint256)'];
const iface=new Interface(abi);

/** Archive RPC audit for standard ERC20s. Providers must be independently operated.
 * Enumerates from genesis; supply reconciliation rejects incomplete holder discovery.
 * This is an RPC attestation, not an on-chain proof of historical state.
 */
export async function verifiedHolderSnapshot({providers,chainId,token,snapshotBlock,confirmations=64,chunkSize=2000,excluded=[]}) {
 if(!Array.isArray(providers)||providers.length!==2||providers[0]===providers[1])throw new Error('Two independent providers required');
 if(!Number.isSafeInteger(snapshotBlock)||snapshotBlock<1||!Number.isSafeInteger(confirmations)||confirmations<1||!Number.isSafeInteger(chunkSize)||chunkSize<1)throw new Error('Snapshot configuration');
 token=getAddress(token);
 const reports=[];
 for(const provider of providers){
  if((await provider.getNetwork()).chainId!==BigInt(chainId))throw new Error('Wrong snapshot chain');
  const head=await provider.getBlockNumber();
  if(head-snapshotBlock<confirmations)throw new Error('Snapshot not confirmed');
  const block=await provider.getBlock(snapshotBlock);
  if(!block?.hash)throw new Error('Missing historical block');
  const owners=new Set();
  for(let from=0;from<=snapshotBlock;from+=chunkSize){
   const logs=await provider.getLogs({address:token,topics:[iface.getEvent('Transfer').topicHash],fromBlock:from,toBlock:Math.min(snapshotBlock,from+chunkSize-1)});
   for(const log of logs){const parsed=iface.parseLog(log);for(const address of [parsed.args.from,parsed.args.to])if(address!==ZeroAddress)owners.add(getAddress(address));}
  }
  const contract=new Contract(token,abi,provider),rows=[];
  let total=0n;
  for(const address of [...owners].sort()){
   const holding=await contract.balanceOf(address,{blockTag:snapshotBlock});
   total+=holding;if(holding>0n)rows.push({address,holding:String(holding)});
  }
  if(total!==await contract.totalSupply({blockTag:snapshotBlock}))throw new Error('Incomplete snapshot supply');
  if((await provider.getBlock(snapshotBlock))?.hash!==block.hash)throw new Error('Snapshot reorg');
  reports.push({chainId:String(chainId),token,snapshotBlock,blockHash:block.hash,rows});
 }
 if(JSON.stringify(reports[0])!==JSON.stringify(reports[1]))throw new Error('Independent snapshot disagreement');
 const blocked=new Set(excluded.map(a=>getAddress(a)));
 return {...reports[0],rows:reports[0].rows.filter(row=>!blocked.has(row.address))};
}
