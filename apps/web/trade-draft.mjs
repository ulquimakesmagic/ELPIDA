// Restore amount only after restoring its side/currency and matching wallet, chain and token.
export function restoreTradeDraft(previous,{input,slippage,panel}){
 if(!previous||!input||previous.context!==input.dataset.context)return false;
 panel?.selectSide?.(previous.side==='sell'?'sell':'buy',{focus:false});
 panel?.selectCurrency?.(previous.settlement==='native'?'native':'pair');
 if(slippage&&!slippage.disabled&&previous.slippage){slippage.value=previous.slippage;slippage.dispatchEvent(new Event('change'));}
 if(previous.amount){input.value=previous.amount;input.dispatchEvent(new Event('input'));}
 return true;
}
