const zero='0x0000000000000000000000000000000000000000';
const abi=['function recipients(uint256) view returns(address)','function shares(uint256) view returns(uint16)','function accounted(address) view returns(uint256)','function claimable(address,address) view returns(uint256)'];
export async function creatorRecipients(Contract,provider,address,call={}){
 const allocation=new Contract(address,abi,provider),rows=[];let total=0;
 for(let i=0;i<8;i++){
  try{const [address,bps]=await Promise.all([allocation.recipients(i,call),allocation.shares(i,call)]);rows.push({address,bps:Number(bps)});total+=Number(bps);if(total===10000)break;}
  catch(error){if(error.code==='CALL_EXCEPTION'&&error.data?.startsWith('0x4e487b71')&&error.data.endsWith('32'))break;throw error;}
 }
 if(!rows.length||total!==10000)throw new Error('Creator allocation recipients unavailable.');return rows;
}
export async function allocationStatus({Contract,formatUnits,provider,address,owner,quoteAsset=zero,quoteDecimals=18,token,curve,curveFees=0n,recipients}){
 const height=await provider.getBlockNumber(),call={blockTag:height};
 if(curve)curveFees=await new Contract(curve,['function creatorFees() view returns(uint256)'],provider).creatorFees(call);
 recipients??=await creatorRecipients(Contract,provider,address,call);
 const allocation=new Contract(address,abi,provider),index=recipients.findIndex(r=>r.address.toLowerCase()===owner.toLowerCase());
 const pending=async(asset,incoming=0n)=>{
  if(index<0)return 0n;
  const [held,accounted,credited]=await Promise.all([asset.toLowerCase()===zero?provider.getBalance(address,height):new Contract(asset,['function balanceOf(address) view returns(uint256)'],provider).balanceOf(address,call),allocation.accounted(asset,call),allocation.claimable(asset,owner,call)]);
  if(held<accounted)throw new Error('Allocation asset is not fully backed.');
  const fresh=held-accounted+incoming;let assigned=0n;
  for(let i=0;i<recipients.length;i++){const part=i+1===recipients.length?fresh-assigned:fresh*BigInt(recipients[i].bps)/10000n;assigned+=part;if(i===index)return credited+part;}
 };
 return {creatorRecipients:recipients,creatorAllocation:address,creatorAllocationFees:formatUnits(await pending(quoteAsset,curveFees),quoteDecimals),creatorTokenFees:formatUnits(await pending(token),18)};
}
