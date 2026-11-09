import {h,errorText} from './ui.mjs';
export function testLiquidityTools(wallet,run) {
  if(wallet.net.chainId!==11155111||!wallet.address)return null;
  const stocks=(wallet.approvedQuotes??[]).filter(a=>a.test&&a.stock?.provider==='ondo-test');if(!stocks.length)return null;
  let quoted=null,busy=false;
  const asset=h('select.select',{'aria-label':'Test conversion stock'},stocks.map(a=>h('option',{value:a.address},`${a.symbol} · ${a.address.slice(0,6)}…${a.address.slice(-4)}`))),amount=h('input.input',{type:'number',min:'0.001',max:'0.1',step:'0.01',value:'0.05','aria-label':'Test ETH liquidity budget'}),message=h('p.hint',{role:'status'}),error=h('p.error-text',{role:'alert'});
  const clear=()=>{quoted=null;confirm.hidden=true;message.textContent='';};asset.addEventListener('change',clear);amount.addEventListener('input',clear);
  const confirm=h('button.btn.btn-secondary',{type:'button',hidden:true,on:{click:async()=>{
    if(busy||!quoted)return;if(quoted.asset!==asset.value||quoted.nativeAmount!==amount.value){clear();return;}
    busy=true;confirm.disabled=true;error.textContent='';
    try{const result=await run('setup-test-liquidity',quoted);message.textContent=result.message;quoted=null;confirm.hidden=true;}catch(e){error.textContent=errorText(e);}finally{busy=false;confirm.disabled=false;}
  }}},'Confirm test liquidity funding');
  const quote=h('button.btn.btn-secondary',{type:'button',on:{click:async()=>{
    if(busy)return;busy=true;quote.disabled=true;error.textContent='';clear();
    try{const request={asset:asset.value,nativeAmount:amount.value},result=await wallet.getTestStockLiquidityQuote(request);if(request.asset!==asset.value||request.nativeAmount!==amount.value)return;quoted=result;message.textContent=result.pending?'A previous setup transaction is recorded. Confirm to check its receipt and clear unused approval; no duplicate mint will be sent.':result.funded?'This conversion pool is already funded.':`Supply at most ${result.nativeAmount} test ETH and ${result.stockAmount} ${result.symbol} to a 0.3% Uniswap v3 conversion pool. Exact stock approval, then pool funding. The LP NFT stays in your wallet and is not permanently locked. Unused native funds are refunded. Quote expires in 60 seconds.`;confirm.hidden=result.funded&&!result.pending;}
    catch(e){error.textContent=errorText(e);}finally{busy=false;quote.disabled=false;}
  }}},'Preview test conversion liquidity');
  return h('details',h('summary','ETH/test-stock conversion liquidity (Sepolia only)'),h('div.stack',h('p.hint','Rehearsal liquidity only; assets have no monetary value. This creates the conversion route, not the launched token’s underlying pool. Maximum 0.1 test ETH per setup. Requires the stock controller wallet.'),asset,amount,quote,message,confirm,error));
}
