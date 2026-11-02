import {h,icon} from './ui.mjs';
import {stockIdentity,looksLikeStock} from '/stock-catalog.mjs';
const ASSET_ICONS={ETH:'/assets/chains/ethereum.png',WETH:'/assets/chains/ethereum.png',BNB:'/assets/chains/bnb.svg',tBNB:'/assets/chains/bnb.svg',WBNB:'/assets/chains/bnb.svg',SOL:'/assets/chains/solana.svg',WSOL:'/assets/chains/solana.svg',USDC:'/assets/tokens/usdc.png',tUSDC:'/assets/tokens/usdc.png'};
/**
 * A tokenized stock's tile: its ticker on a colour of its own (or an operator-supplied logo), with a small issuer mark
 * (Ondo "on", xStocks "x", a flask for a test stand-in). `size` is 'sm' (inline, 20px), 'md' (32px) or 'lg' (44px).
 */
export function stockTile(symbol,{size='sm',provider=null,name=null,catalog=null}={}){
  const id=stockIdentity(symbol,{provider,name,catalog});
  // Ondo's own icons already carry Ondo's mark, so only a test stand-in gets a corner badge (a flask); a ticker tile
  // keeps a small issuer mark so it still reads as a tokenized stock.
  const ticker=()=>h('span.stock-tile-ticker',id.ticker);
  const mark=id.test?icon('flask-conical','stock-tile-mark-icon'):!id.logo&&id.issuer==='Ondo'?'on':!id.logo&&id.issuer==='xStocks'?'x':null;
  const tile=h('span.stock-tile',{'aria-hidden':'true','data-asset':id.symbol,'data-tone':String(id.tone),'data-size':size,'data-letters':String(Math.min(id.ticker.length,5)),'data-test':id.test?'true':undefined,'data-logo':id.logo?'true':undefined},
    id.logo?h('img.stock-tile-logo',{src:id.logo,alt:'',width:44,height:44,loading:'lazy',decoding:'async',on:{error:e=>{const t=e.currentTarget.closest('.stock-tile');t?.removeAttribute('data-logo');e.currentTarget.replaceWith(ticker());}}}):ticker(),
    mark?h('span.stock-tile-mark',{title:id.issuer??''},mark):null);
  return tile;
}
export function assetIcon(symbol,stock=false,options={}){if(stock||looksLikeStock(symbol))return stockTile(symbol,options);const src=ASSET_ICONS[symbol];return src?h('img.asset-icon',{src,alt:'',width:20,height:20,'data-asset':String(symbol).toLowerCase()}):icon('coins','icon-sm');}
export function chainIcon(key){const name=key?.startsWith('solana')?'solana':key?.startsWith('bnb')?'bnb':key?.startsWith('base')?'base':key?.startsWith('ethereum')?'ethereum':key?.startsWith('robinhood')?'robinhood':null;return name?h('img.asset-icon',{src:`/assets/chains/${name}.${['base','robinhood','ethereum'].includes(name)?'png':'svg'}`,alt:'',width:20,height:20}):icon('flask-conical','icon-sm');}
export function chainSelector({button,networks,current,onSelect,listId='chain-options'}){
  const list=h('div.chain-options',{role:'listbox',id:listId,'aria-label':'Choose chain',hidden:true});button.after(list);button.setAttribute('aria-haspopup','listbox');button.setAttribute('aria-controls',list.id);
  const close=()=>{list.hidden=true;button.setAttribute('aria-expanded','false');};
  const open=()=>{list.hidden=false;button.setAttribute('aria-expanded','true');const options=[...list.children];(options.find(o=>o.getAttribute('aria-selected')==='true')??options[0])?.focus();};
  button.addEventListener('click',()=>list.hidden?open():close());
  button.addEventListener('keydown',e=>{if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();open();}});
  list.addEventListener('keydown',e=>{const items=[...list.children],at=items.indexOf(document.activeElement);if(e.key==='Escape'){close();button.focus();}else if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();const i=e.key==='Home'?0:e.key==='End'?items.length-1:(at+(e.key==='ArrowDown'?1:-1)+items.length)%items.length;items[i].focus();}});
  document.addEventListener('click',e=>{if(!list.contains(e.target)&&!button.contains(e.target))close();});
  list.addEventListener('focusout',e=>{if(!list.contains(e.relatedTarget)&&e.relatedTarget!==button)close();});
  let rendered=null;
  return {update(disabled){const key=current(),all=[...networks(),{key:'local',name:'Simulation'}],net=all.find(n=>n.key===key),signature=JSON.stringify([key,...all.map(n=>[n.key,n.name,!!n.mainnet])]);button.disabled=disabled;if(signature===rendered){if(disabled)close();return;}rendered=signature;button.replaceChildren(chainIcon(key),h('span',net?.name??'Choose chain'),h('small',net?.mainnet?'Mainnet':key==='local'?'Demo':'Testnet'),icon('chevron-down','icon-sm'));button.setAttribute('aria-label',`Choose chain. Current: ${net?.name}`);list.replaceChildren(...all.map(n=>h('button.chain-option',{type:'button',role:'option',tabIndex:-1,'aria-selected':String(n.key===key),on:{click:()=>{close();button.focus();onSelect(n.key);}}},chainIcon(n.key),h('span',n.name),h('small',n.mainnet?'Mainnet':n.key==='local'?'Test funds':'Testnet'))));if(disabled)close();}};
}
