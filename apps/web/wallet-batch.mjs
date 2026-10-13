// Use atomic batches only when the connected wallet already advertises support.
export async function supportsAtomicLaunch(request,address,chainId){
 let timer;try{const caps=await Promise.race([request({method:'wallet_getCapabilities',params:[address,['0x'+BigInt(chainId).toString(16)]]}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Capability timeout')),2500);})]);return caps?.['0x'+BigInt(chainId).toString(16)]?.atomic?.status==='supported';}catch{return false;}finally{clearTimeout(timer);}
}
export async function waitAtomicLaunch(request,id,chainId,{sleep=ms=>new Promise(r=>setTimeout(r,ms)),attempts=80}={}){
 for(let i=0;i<attempts;i++){
  const status=await request({method:'wallet_getCallsStatus',params:[id]});
  if(!status.chainId||BigInt(status.chainId)!==BigInt(chainId)||status.id!==id)throw new Error('Wallet batch returned the wrong network or request. Do not submit another launch.');
  if(status.status===200){
   if(status.atomic!==true||!status.receipts?.length||status.receipts.some(r=>BigInt(r.status)!==1n))throw new Error('Wallet did not confirm an atomic launch. Check its batch status before retrying.');
   return status.receipts;
  }
  if(status.status>=400)throw Object.assign(new Error('Wallet launch batch failed. Check the wallet status before retrying.'),{batchFailed:status.status===400||status.status===500});
  await sleep(1500);
 }
 throw new Error('Launch batch is still pending. Open your wallet to check it; do not create another token.');
}
