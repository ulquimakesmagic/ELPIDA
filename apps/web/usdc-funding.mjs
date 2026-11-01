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
    try{session.requestedAmount=String(amount()??'').trim();
      // An empty or non-numeric field reached parseUnits() and surfaced as "invalid FixedNumber string value".
      if(!/^\d+(\.\d+)?$/.test(session.requestedAmount)||Number(session.requestedAmount)<=0)throw new Error('Enter the amount you want to fund first.');
      const body={nativeAmount:session.requestedAmount,slippage:'1'};const quoted=ctx.mode==='local'?await ctx.api('conversion-quote',body):await ctx.wallet.getUsdcConversionQuote(body);session.quoted=quoted;session.message=`Receive ${number(quoted.nativeAmount,8)} ${symbol}. Estimated cost ${number(quoted.usdcAmount,6)} USDC; maximum ${number(quoted.maxUsdc,6)} USDC with 1% slippage. Approve USDC, then confirm the swap. Native gas is required. The later launch or buy is separate.`;}
    catch(e){session.error=errorText(e);}finally{session.pending=false;session.draw();}
  }}},'Get USDC conversion quote');
  session.draw=()=>{status.textContent=session.message;error.textContent=session.error;confirm.hidden=!session.quoted;confirm.disabled=session.pending;quote.disabled=session.pending;};session.draw();
  return h('details',{open:session.open,on:{toggle:e=>{session.open=e.target.open;}}},h('summary','Fund this native purchase with USDC'),h('div.stack',h('p.small.muted',`Convert USDC into the ${symbol} amount entered above. Your token keeps its native trading pair. This does not pay the launch fee or submit a purchase.`),quote,status,confirm,error));
}

export function nativePairFunding(ctx,token){
  if(token.pair==='native'||ctx.mode!=='testnet')return null;
  const native=ctx.wallet.net.nativeCurrency?.symbol??'SOL',asset=token.quoteSymbol??'pair asset';
  if(typeof ctx.wallet.getNativePairConversionQuote!=='function')return h('p.hint',`Native funding/cash-out for ${asset} requires a verified ${native} conversion route. Direct pair-asset trading remains available; native routing is not configured on this network yet.`);
  let quote=null,busy=false;
  const amount=h('input',{type:'number',min:'0',step:'any','aria-label':'Native/pair conversion amount'});
  const direction=h('select',{'aria-label':'Native/pair conversion direction'},h('option',{value:'from-native'},`${native} to ${asset} (fund a buy)`),h('option',{value:'to-native'},`${asset} to ${native} (cash out)`));
  const status=h('p.small',{role:'status'}),error=h('p.error-text',{role:'alert'});
  const invalidate=()=>{quote=null;confirm.hidden=true;status.textContent='';};
  amount.addEventListener('input',invalidate);direction.addEventListener('change',invalidate);
  const confirm=h('button.btn.btn-secondary',{type:'button',hidden:true,on:{click:async()=>{
    if(busy||!quote)return;if(quote.amount!==amount.value||quote.direction!==direction.value){invalidate();error.textContent='Conversion changed. Get a fresh quote.';return;}busy=true;confirm.disabled=true;error.textContent='';
    try{await ctx.run('convert-native-pair',quote);status.textContent='Converted funds are in your wallet. Continue with your token trade separately.';quote=null;confirm.hidden=true;}
    catch(e){error.textContent=errorText(e);}finally{busy=false;confirm.disabled=false;}
  }}},'Confirm separate conversion');
  const getQuote=h('button.btn.btn-secondary',{type:'button',on:{click:async()=>{
    if(busy)return;busy=true;getQuote.disabled=true;error.textContent='';invalidate();
    try{const requested={token:token.address,direction:direction.value,amount:amount.value};const result=await ctx.wallet.getNativePairConversionQuote(requested);if(requested.amount!==amount.value||requested.direction!==direction.value)return;quote=result;status.textContent=`Estimated output: ${number(quote.output,8)} ${direction.value==='to-native'?native:asset}. Conversion slippage: 1%. Expires in 60 seconds. Token trading is separate.`;confirm.hidden=false;}
    catch(e){error.textContent=errorText(e);}finally{busy=false;getQuote.disabled=false;}
  }}},'Get native/pair conversion quote');
  return h('details',h('summary',`Fund with ${native} / cash out to ${native}`),h('div.stack',h('p.hint',`Your token stays paired with ${asset}. Convert native coin into the pair asset before buying; after selling, convert the pair asset back to native coin. Each step has separate fees and confirmation. Cancelling a later step leaves earlier proceeds in your wallet. Routes require funded liquidity and issuer permission.`),direction,amount,getQuote,status,confirm,error));
}

export function atomicNativeTrade(ctx,token){
  if(ctx.mode!=='testnet'||token.pair==='native'||typeof ctx.wallet.getNativePairTradeQuote!=='function')return null;
  let q=null,busy=false;
  const native=ctx.wallet.net.nativeCurrency.symbol,side=h('select',{'aria-label':'Atomic native trade side'},h('option',{value:'buy'},`Buy with ${native}`),h('option',{value:'sell'},`Sell for ${native}`));
  const amount=h('input',{type:'number',min:'0',step:'any','aria-label':'Atomic native trade amount'}),status=h('p.small',{role:'status'}),error=h('p.error-text',{role:'alert'});
  const clear=()=>{q=null;confirm.hidden=true;status.textContent='';};amount.addEventListener('input',clear);side.addEventListener('change',clear);
  const confirm=h('button.btn.btn-secondary',{type:'button',hidden:true,on:{click:async()=>{
    if(busy||!q)return;if(q.amount!==amount.value||q.side!==side.value){clear();return;}busy=true;confirm.disabled=true;
    try{await ctx.run('trade-native-pair',q);clear();status.textContent='Atomic native trade confirmed.';}catch(e){error.textContent=errorText(e);}finally{busy=false;confirm.disabled=false;}
  }}},'Confirm atomic native trade');
  const quote=h('button.btn.btn-secondary',{type:'button',on:{click:async()=>{
    if(busy)return;busy=true;quote.disabled=true;error.textContent='';clear();
    try{const request={token:token.address,side:side.value,amount:amount.value},result=await ctx.wallet.getNativePairTradeQuote(request);if(request.amount!==amount.value||request.side!==side.value)return;q=result;status.textContent=`Estimated output: ${number(q.output,8)} ${q.side==='buy'?token.symbol:native}. Both hops have 1% slippage protection; any excess pair asset stays in your wallet. Expires in 60 seconds.`;confirm.hidden=false;}catch(e){error.textContent=errorText(e);}finally{busy=false;quote.disabled=false;}
  }}},'Quote atomic native trade');
  return h('details',h('summary',`Atomic buy/sell with ${native}`),h('div.stack',h('p.hint',`Buy amount is in ${native}; sell amount is in ${token.symbol}. Requires an atomic-capable wallet and funded native/pair liquidity. All steps succeed together or revert. The underlying pair stays unchanged. Any excess intermediate pair asset remains in your wallet.`),side,amount,quote,status,confirm,error));
}
