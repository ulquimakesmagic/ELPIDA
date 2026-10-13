const displayNative=value=>{
  const rounded=(value+999_999_999n)/1_000_000_000n;
  return `${rounded/1_000_000_000n}.${String(rounded%1_000_000_000n).padStart(9,'0')}`.replace(/0+$/,'').replace(/\.$/,'');
};
export function nativeFundingError({balance,value=0n,gasCost=0n,native,network,feeInUsdc=false,stage='launch'}) {
  const required=value+gasCost;
  if(balance>=required&&balance>0n)return null;
  if(required===0n)return `This wallet has no ${native} on ${network} for network gas. ${feeInUsdc?'Your launch fee is paid in USDC; USDC does not pay network gas. ':''}Add ${native} on this network to the connected wallet before approving or launching.`;
  const missing=required>balance?required-balance:0n;
  return `Add about ${displayNative(missing)} more ${native} on ${network} for ${stage==='approval'?'the token approval network fee':value===0n?'the launch network fee':'the native payment and launch network fee'}. ${feeInUsdc?'Your launch fee stays in USDC. ':''}Gas estimates can change before confirmation.`;
}
