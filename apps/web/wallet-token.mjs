/** Public image URLs for wallet metadata. Never export browser-only data URLs. */
export function walletImageURL(image,origin){
 if(typeof image!=='string'||!image)return null;
 try {
  const base=new URL(origin);
  if(base.protocol!=='https:'&&!(base.protocol==='http:'&&['localhost','127.0.0.1'].includes(base.hostname)))return null;
  let url;
  if(/^\/api\/content\/(b[a-z2-7]{30,100}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/.test(image))url=new URL(image,base.origin);
  else if(/^ipfs:\/\/(b[a-z2-7]{30,100}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/.test(image))url=new URL('https://ipfs.io/ipfs/'+image.slice(7));
  else {
   url=new URL(image);if(url.protocol!=='https:')return null;
   const host=url.hostname.toLowerCase();
   if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||/^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)||host.startsWith('['))return null;
  }
  if(url.username||url.password)return null;
  return url.href;
 }catch{return null;}
}

/** Signed legacy metadata may contain a raster data URI. Serve that public image
 * by chain and token, rather than passing browser-only bytes to a wallet. */
export function tokenWalletImage(token,origin){
 const direct=walletImageURL(token.metadata?.image,origin);if(direct)return direct;
 if(!['creator-signed','published'].includes(token.metadataStatus)||!/^data:image\/(png|jpeg|webp|gif|avif|bmp);base64,/.test(token.metadata?.image??'')||!/^[a-z0-9-]+$/.test(token.network??'')||!/^0x[0-9a-fA-F]{40}$/.test(token.address))return null;
 try {const base=new URL(origin);return base.protocol==='https:'?base.origin+'/api/wallet-logo/'+token.network+'/'+token.address.toLowerCase():null;}catch{return null;}
}

/** User-initiated EIP-747 request; never switches chains or requests accounts. */
export async function watchEvmToken({provider,chainId,token,origin}){
 if(typeof provider?.request!=='function')throw new Error('Connect an Ethereum wallet first.');
 if(!Number.isSafeInteger(chainId)||chainId<1||!/^0x[0-9a-fA-F]{40}$/.test(token.address)||/^0x0{40}$/i.test(token.address))throw new Error('Invalid token or network.');
 const decimals=token.decimals??18;
 if(!Number.isInteger(decimals)||decimals<0||decimals>255||typeof token.symbol!=='string'||!token.symbol||token.symbol.length>11)throw new Error('Invalid token metadata.');
 if(BigInt(await provider.request({method:'eth_chainId'}))!==BigInt(chainId))throw new Error('Switch your wallet to this token’s network first.');
 const image=tokenWalletImage(token,origin);
 try {
  const accepted=await provider.request({method:'wallet_watchAsset',params:{type:'ERC20',options:{address:token.address,chainId,symbol:token.symbol,decimals,...(image?{image}:{})}}});
  return {status:accepted===true?'added':'declined',image};
 }catch(error){
  const code=error?.code??error?.info?.error?.code;
  if([4200,-32601].includes(code))return {status:'unsupported',image};
  if(code===4001)return {status:'declined',image};
  throw error;
 }
}
