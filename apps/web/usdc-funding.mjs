import { h, number, errorText } from './ui.mjs';
const sessions=new Map();

// An explicit funding step: conversion never silently submits the later launch/trade.
export function usdcFunding(ctx, { amount, symbol, context='launch', onComplete = () => {} }) {
  const available=ctx.mode==='local'?!!ctx.config.dex:!!ctx.wallet?.dex&&!!ctx.wallet?.feeUsdc;
  if(!available)return null;
  const key=[ctx.mode,ctx.currentChain(),ctx.state?.wallet??ctx.account,context].join(':');
  if(!sessions.has(key))sessions.set(key,{quoted:null,pending:false,requestedAmount:null,open:false,message:'',error:''});
  const session=sessions.get(key);
  const status=h('p.small',{role:'status','aria-live':'polite'}),error=h('p.error-text',{role:'alert'});
  const confirm=h('button.btn.btn-secondary.btn-sm',{type:'button',hidden:true,on:{click:async()=>{
    if(session.pending||!session.quoted)return;
    if(amount()!==session.requestedAmount){session.error='The purchase amount changed. Get a new conversion quote.';session.quoted=null;session.draw();return;}
    session.pending=true;session.error='';session.draw();
    try{const result=await ctx.run('convert-usdc',{...session.quoted,slippage:'1'});session.message=`${result.nativeAmount} ${symbol} is now in your wallet. Continue with your launch or purchase. If you cancel it, these funds stay in your wallet.`;session.quoted=null;onComplete(result);}
    catch(e){session.error=errorText(e);}
    finally{session.pending=false;session.draw();}
  }}},'Confirm USDC conversion');
  const quote=h('button.btn.btn-secondary.btn-sm',{type:'button',on:{click:async()=>{
    if(session.pending)return;session.error='';session.quoted=null;session.pending=true;session.draw();
    try{session.requestedAmount=amount();const body={nativeAmount:session.requestedAmount,slippage:'1'};const quoted=ctx.mode==='local'?await ctx.api('conversion-quote',body):await ctx.wallet.getUsdcConversionQuote(body);session.quoted=quoted;session.message=`Receive ${number(quoted.nativeAmount,8)} ${symbol}. Estimated cost ${number(quoted.usdcAmount,6)} USDC; maximum ${number(quoted.maxUsdc,6)} USDC with 1% slippage. Approve USDC, then confirm the swap. Native gas is required. The later launch or buy is separate.`;}
    catch(e){session.error=errorText(e);}finally{session.pending=false;session.draw();}
  }}},'Get USDC conversion quote');
  session.draw=()=>{status.textContent=session.message;error.textContent=session.error;confirm.hidden=!session.quoted;confirm.disabled=session.pending;quote.disabled=session.pending;};session.draw();
  return h('details',{open:session.open,on:{toggle:e=>{session.open=e.target.open;}}},h('summary','Fund this native purchase with USDC'),h('div.stack',h('p.small.muted',`Convert USDC into the ${symbol} amount entered above. Your token keeps its native trading pair. This does not pay the launch fee or submit a purchase.`),quote,status,confirm,error));
}
