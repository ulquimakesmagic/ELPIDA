import {Interface,id} from 'ethers';
export const NATIVE_TRADE_TOPIC=id('NativeTrade(address,address,address,bool,uint256,uint256)');
const nativeInterface=new Interface(['event NativeTrade(address indexed trader,address indexed token,address indexed curve,bool buy,uint256 nativeAmount,uint256 tokenAmount)']);
const transferInterface=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const same=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
// The existing authenticated market event supplies amounts. A router cannot relabel a trade without
// also settling that exact token amount to/from the reported account in the same transaction.
export function nativeRouterAccount({trade,curve,logs,nativeLogs}){
 const matches=[];
 for(const l of nativeLogs){try{
  if(!same(l.transactionHash,trade.hash)||!same(l.address,trade.account))continue;
  const e=nativeInterface.parseLog(l);if(!e||!same(e.args.token,trade.token)||!same(e.args.curve,curve)||e.args.buy!==(trade.side==='buy')||e.args.tokenAmount!==BigInt(trade.tokenRaw))continue;
  const settled=logs.some(t=>{try{if(!same(t.transactionHash,trade.hash)||!same(t.address,trade.token))return false;const x=transferInterface.parseLog(t);return !!x&&x.args.value===e.args.tokenAmount&&(e.args.buy?same(x.args.from,l.address)&&same(x.args.to,e.args.trader):same(x.args.from,e.args.trader)&&same(x.args.to,l.address));}catch{return false;}});
  if(settled)matches.push(e.args.trader);
 }catch{}}
 return matches.length===1?matches[0]:null;
}
