import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Exercise the real dialog function against its DOM boundary. Native replaceChildren
// coerces array arguments into text; this double deliberately preserves that rule.
const source=readFileSync(new URL('../apps/web/app.mjs',import.meta.url),'utf8');
const fn=source.slice(source.indexOf('function openWalletDialog('),source.indexOf('async function connectCurrent()'));
function fixture(wallets=[]){
 const children=[],listeners=new Map(),requests=[];
 const body={children,replaceChildren(...nodes){children.splice(0,children.length,...nodes.map(n=>Array.isArray(n)?String(n):n));},querySelectorAll(){return children.filter(n=>n.spec?.startsWith('button'));}};
 const dialog={open:false,showModal(){this.open=true;},close(){this.open=false;listeners.get('close')?.();},addEventListener(name,handler){listeners.set(name,handler);}};
 const errorNodes=[];
 const h=(spec,...args)=>{const node={spec,args,disabled:false,textContent:'',querySelector(){return this.note??={textContent:'Detected'};},toString(){return '[object HTMLButtonElement]';}};if(spec==='p.error-text')errorNodes.push(node);return node;};
 const window={addEventListener(){},removeEventListener(){},dispatchEvent(){}};
 const net={key:'base-sepolia',name:'Base Sepolia'};
 const context={h,icon:()=>({spec:'svg'}),$:id=>id==='#wallet-dialog'?dialog:id==='#wallet-body'?body:{textContent:''},evmWallets:()=>wallets,solanaWallets:()=>wallets,chosenEvmWallet:()=>null,chosenSolanaWallet:()=>null,browserWalletCatalog:[],walletIcon:()=>'',window,Event:class{},setTimeout:()=>0,clearTimeout(){},errorText:e=>e.message,toast(){},connect:async(key,id)=>{requests.push([key,id]);},wallet:{net}};
 vm.runInNewContext(fn+'\nopenWalletDialog();',context);
 return {body,dialog,requests,errorNodes,context};
}

test('wallet chooser passes actual wallet buttons to replaceChildren, never an array',()=>{
 const f=fixture([{id:'trust',name:'Trust Wallet',icon:'/assets/wallets/trust.svg'},{id:'zerion',name:'Zerion',icon:'/assets/wallets/zerion.svg'},{id:'rabby',name:'Rabby',icon:'/assets/wallets/rabby.svg'}]);
 assert.equal(f.dialog.open,true);
 const rows=f.body.children.filter(n=>n.spec==='button.wallet-row');
 assert.equal(rows.length,3);
 assert.ok(f.body.children.every(n=>typeof n!=='string'),'no stringified HTMLButtonElement list');
});

test('wallet chooser prompts only the explicit selection and permits only one pending request',async()=>{
 const f=fixture([{id:'trust',name:'Trust Wallet'},{id:'rabby',name:'Rabby'}]);
 const rows=f.body.children.filter(n=>n.spec==='button.wallet-row');
 let release;
 f.context.connect=async(key,id)=>{f.requests.push([key,id]);await new Promise(resolve=>{release=resolve;});};
 const pending=rows[0].args[0].on.click({currentTarget:rows[0]});
 await rows[1].args[0].on.click({currentTarget:rows[1]});
 assert.deepEqual(f.requests,[['base-sepolia','trust']]);
 assert.equal(rows[0].disabled,true);assert.equal(rows[1].disabled,true);
 release();await pending;assert.equal(f.dialog.open,false);
});

test('failed wallet connection leaves chooser open and restores buttons for retry',async()=>{
 const f=fixture([{id:'rabby',name:'Rabby'}]);
 f.context.connect=async()=>{throw new Error('Request rejected');};
 const row=f.body.children.find(n=>n.spec==='button.wallet-row');
 await row.args[0].on.click({currentTarget:row});
 assert.equal(f.dialog.open,true);assert.equal(row.disabled,false);
 assert.equal(f.errorNodes[0].textContent,'Request rejected');
});
