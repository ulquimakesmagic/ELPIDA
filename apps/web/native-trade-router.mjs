// Browser verification of a fixed, non-upgradeable router deployed from this build's exact creation code.
export async function verifyNativeRouter({Contract,ContractFactory,provider,artifact,record,args,chainId}){
 if(!record?.address||!/^0x[0-9a-f]{64}$/i.test(record.hash??''))throw Error('Native router deployment proof is unavailable.');
 const [tx,receipt,code]=await Promise.all([provider.getTransaction(record.hash),provider.getTransactionReceipt(record.hash),provider.getCode(record.address)]);
 const expected=(await new ContractFactory(artifact.abi,artifact.bytecode).getDeployTransaction(...args)).data;
 if(!tx||tx.to!==null||Number(tx.chainId)!==chainId||tx.data.toLowerCase()!==expected.toLowerCase()||receipt?.status!==1||receipt.contractAddress?.toLowerCase()!==record.address.toLowerCase()||code==='0x')throw Error('Native router creation proof does not match this deployment.');
 const c=new Contract(record.address,artifact.abi,provider),values=await Promise.all([c.launchFactory(),c.swapRouter(),c.v3Factory(),c.wrappedNative(),c.VERSION()]);
 if(values.slice(0,4).some((v,i)=>v.toLowerCase()!==args[i].toLowerCase())||values[4]!==1n)throw Error('Native router identity mismatch.');
 return c;
}
export function findCurveNonce(getCreateAddress,deployer,curve,nonceLimit){
 // Bounded local derivation, no per-nonce RPC calls. The on-chain router verifies both CREATE addresses.
 const limit=Math.min(Number(nonceLimit),4096);
 for(let nonce=2;nonce<limit;nonce+=2)if(getCreateAddress({from:deployer,nonce}).toLowerCase()===curve.toLowerCase())return nonce;
 throw Error('This market’s deployment proof is not available in the bounded rehearsal lookup.');
}
