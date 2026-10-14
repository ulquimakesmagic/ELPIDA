import {h,icon} from './ui.mjs';
export function assetIcon(symbol){const key={ETH:'ethereum',BNB:'bnb',tBNB:'bnb',SOL:'solana',WSOL:'solana'}[symbol];return key?h('img.asset-icon',{src:`/assets/chains/${key}.${key==='ethereum'?'png':'svg'}`,alt:'',width:20,height:20}):icon('coins','icon-sm');}
export function chainIcon(key){const name=key?.startsWith('solana')?'solana':key?.startsWith('bnb')?'bnb':key?.startsWith('base')?'base':key?.startsWith('ethereum')?'ethereum':key?.startsWith('robinhood')?'robinhood':null;return name?h('img.asset-icon',{src:`/assets/chains/${name}.${['base','robinhood','ethereum'].includes(name)?'png':'svg'}`,alt:'',width:20,height:20}):icon('flask-conical','icon-sm');}
export function chainSelector({button,networks,current,onSelect}){
  const list=h('div.chain-options',{role:'listbox',id:'chain-options','aria-label':'Choose chain',hidden:true});button.after(list);button.setAttribute('aria-haspopup','listbox');button.setAttribute('aria-controls',list.id);
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
