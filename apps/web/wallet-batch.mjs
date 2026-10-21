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

// ---------- general batches: trades and fee claims (21 Oct 2026) ----------
// One wallet confirmation instead of one per step, when the wallet supports atomic batches (EIP-5792). Every call in
// the batch must be safe to run even when it has nothing to do, because the whole batch succeeds or fails together.

/** Waits for a non-launch atomic batch; same checks as a launch, with wording that fits trades and claims. */
export async function waitAtomicBatch(request,id,chainId,{sleep=ms=>new Promise(r=>setTimeout(r,ms)),attempts=80}={}){
 for(let i=0;i<attempts;i++){
  const status=await request({method:'wallet_getCallsStatus',params:[id]});
  if(!status.chainId||BigInt(status.chainId)!==BigInt(chainId)||status.id!==id)throw new Error('Wallet batch returned the wrong network or request. Check your wallet before retrying.');
  if(status.status===200){
   if(status.atomic!==true||!status.receipts?.length||status.receipts.some(r=>BigInt(r.status)!==1n))throw new Error('Wallet did not confirm the batch as one atomic transaction. Check your wallet before retrying.');
   return status.receipts;
  }
  if(status.status>=400)throw Object.assign(new Error('The wallet batch failed and nothing was changed. Check your wallet, then try again.'),{batchFailed:status.status===400||status.status===500});
  await sleep(1500);
 }
 throw new Error('The batch is still pending. Open your wallet to check it before trying again.');
}

/** Encodes calls for wallet_sendCalls v2 with atomicity required. `calls` are {to, data, value?}. */
export function atomicBatchRequest({from,chainId,calls,id}){
 if(!calls.length)throw new Error('Nothing to send.');
 return {method:'wallet_sendCalls',params:[{version:'2.0.0',id,from,chainId:'0x'+BigInt(chainId).toString(16),atomicRequired:true,calls:calls.map(c=>({to:c.to,data:c.data,value:'0x'+BigInt(c.value??0).toString(16)}))}]};
}
