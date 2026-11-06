// Discovery never requests accounts or signatures. Only the selected wallet connects.
const walletAssets={metamask:'metamask',phantom:'phantom',solflare:'solflare',trust:'trust',trustwallet:'trust',rabby:'rabby',zerion:'zerion',coinbase:'coinbase',coinbasewallet:'coinbase',brave:'brave',bravewallet:'brave',rainbow:'rainbow',okx:'okx',okxwallet:'okx',backpack:'backpack',bitget:'bitget',bitgetwallet:'bitget',bitkeep:'bitget',binance:'binance',binancewallet:'binance',ledger:'ledger',ledgerlive:'ledger'};
export const browserWalletCatalog=Object.freeze([
 {name:'MetaMask',url:'https://metamask.io/',chains:['evm']},
 {name:'Trust Wallet',url:'https://trustwallet.com/',chains:['evm','solana']},
 {name:'Phantom',url:'https://phantom.com/',chains:['evm','solana']},
 {name:'Zerion',url:'https://zerion.io/',chains:['evm']},
 {name:'Rabby',url:'https://rabby.io/',chains:['evm']},
 {name:'Coinbase Wallet',url:'https://www.coinbase.com/wallet',chains:['evm','solana']},
 {name:'Brave Wallet',url:'https://brave.com/wallet/',chains:['evm']},
 {name:'Rainbow',url:'https://rainbow.me/',chains:['evm']},
 {name:'OKX Wallet',url:'https://www.okx.com/web3',chains:['evm','solana']},
 {name:'Backpack',url:'https://backpack.app/',chains:['evm','solana']},
 {name:'Bitget Wallet',url:'https://web3.bitget.com/',chains:['evm','solana']},
 {name:'Binance Wallet',url:'https://www.binance.com/en/web3wallet',chains:['evm']},
 {name:'Solflare',url:'https://solflare.com/',chains:['solana']},
]);
export function walletIcon(name,icon=''){
 if(typeof icon==='string'&&/^data:image\/(png|webp|jpeg|gif|svg\+xml)[;,]/i.test(icon))return icon;
 const key=walletAssets[String(name).toLowerCase().replace(/[^a-z0-9]/g,'')];
 return key?`/assets/wallets/${key}.svg`:'';
}
/**
 * A wallet Elpida has no entry for still names itself through its own provider flag (isFoxWallet, isXDEFI, …): any
 * `is…: true` flag besides the generic ones is turned into its name. Better than calling every unknown "Browser wallet".
 */
const GENERIC_FLAGS=new Set(['isMetaMask','isConnected','isUnlocked','isEIP1193','isEip1193','isWalletConnect','isInjected','isReady','isDefault','isStandalone']);
export function flagName(p){
 if(!p||typeof p!=='object')return null;
 for(const key in p){
  if(!/^is[A-Z0-9]/.test(key)||GENERIC_FLAGS.has(key))continue;
  let value;try{value=p[key];}catch{continue;}
  if(value!==true)continue;
  const words=key.slice(2).replace(/([a-z0-9])([A-Z])/g,'$1 $2').trim();
  if(words)return words;
 }
 return null;
}
function evmName(p){
 return knownEvmName(p)??flagName(p)??(p.isMetaMask?'MetaMask':'Browser wallet');
}
function knownEvmName(p){
 return p.isRabby?'Rabby':p.isZerion?'Zerion':p.isTrust||p.isTrustWallet?'Trust Wallet':p.isCoinbaseWallet?'Coinbase Wallet':p.isBraveWallet?'Brave Wallet':p.isOkxWallet||p.isOKExWallet?'OKX Wallet':p.isPhantom?'Phantom':p.isBackpack?'Backpack':p.isRainbow?'Rainbow':p.isBitKeep||p.isBitgetWallet?'Bitget Wallet':p.isBinance||p.isBinanceWallet?'Binance Wallet':p.isTokenPocket?'TokenPocket':p.isFrame?'Frame':null;
}
export function injectedEvmWallets(win,announced=[]){
 const result=[],seen=new Set();
 const add=(id,name,provider,icon='',legacy=false)=>{
  if(typeof provider?.request!=='function'||seen.has(provider))return;
  // A wallet that announced itself (EIP-6963) often also injects a separate legacy object: one entry per wallet.
  if(legacy&&name!=='Browser wallet'&&result.some(w=>w.name.toLowerCase()===name.toLowerCase()))return;
  seen.add(provider);result.push({id,name,provider,icon:walletIcon(name,icon)});
 };
 for(const d of announced)if(d?.info?.rdns&&typeof d.info.name==='string')add(d.info.rdns,d.info.name,d.provider,d.info.icon);
 // Named namespaces also work inside mobile wallet browsers. Prefer the EVM member
 // of multichain namespaces so an EVM connect never invokes a Solana provider.
 const sources=[['rabby',win.rabby],['zerion',win.zerion?.ethereum??win.zerion],['coinbase',win.coinbaseWalletExtension],['okx',win.okxwallet?.ethereum??win.okxwallet],['trust',win.trustwallet?.ethereum??win.trustwallet],['phantom-evm',win.phantom?.ethereum],['backpack-evm',win.backpack?.ethereum],['rainbow',win.rainbow],['bitget',win.bitkeep?.ethereum??win.bitgetWallet?.ethereum],['binance',win.binancew3w?.ethereum??win.BinanceChain],['tokenpocket',win.tokenpocket?.ethereum]];
 const labels={rabby:'Rabby',zerion:'Zerion',coinbase:'Coinbase Wallet',okx:'OKX Wallet',trust:'Trust Wallet','phantom-evm':'Phantom','backpack-evm':'Backpack',rainbow:'Rainbow',bitget:'Bitget Wallet',binance:'Binance Wallet',tokenpocket:'TokenPocket'};
 for(const [id,p] of sources)add(id,labels[id],p,'',true);
 const providers=Array.isArray(win.ethereum?.providers)?win.ethereum.providers:[];
 for(const [i,p] of providers.entries())add('injected-'+i,evmName(p??{}),p,'',true);
 // An aggregate window.ethereum proxy is not an extra installed wallet.
 if(!providers.length)add('injected',evmName(win.ethereum??{}),win.ethereum,'',true);
 return result;
}

export function injectedSolanaWallets(win){
 const result=[],seen=new Set();
 const add=(id,name,p)=>{
  if(typeof p?.connect!=='function'||typeof p?.signTransaction!=='function'||seen.has(p))return;
  seen.add(p);result.push({id,name,provider:p,icon:walletIcon(name)});
 };
 for(const [id,name,p] of [
  ['phantom','Phantom',win.phantom?.solana],['solflare','Solflare',win.solflare],['backpack','Backpack',win.backpack?.solana??win.backpack],['trust','Trust Wallet',win.trustwallet?.solana],['okx','OKX Wallet',win.okxwallet?.solana],['coinbase','Coinbase Wallet',win.coinbaseSolana],['bitget','Bitget Wallet',win.bitkeep?.solana??win.bitgetWallet?.solana]
 ])add(id,name,p);
 const p=win.solana;
 add(p?.isPhantom?'phantom':p?.isTrust||p?.isTrustWallet?'trust':p?.isBackpack?'backpack':'injected',p?.isPhantom?'Phantom':p?.isTrust||p?.isTrustWallet?'Trust Wallet':p?.isBackpack?'Backpack':flagName(p)??'Solana wallet',p);
 return result;
}

/**
 * Wallets appear on their own schedule: an EIP-6963 announcement, a wallet-standard registration, or a legacy injection
 * a moment after the page loads. Every one of them fires this, so an open wallet picker redraws itself instead of
 * saying "No wallet found" until a reload.
 */
const changes=typeof EventTarget==='function'?new EventTarget():null;
export function onWalletsChanged(listener){if(!changes)return()=>{};changes.addEventListener('change',listener);return()=>changes.removeEventListener('change',listener);}
export function walletsChanged(){changes?.dispatchEvent(new Event('change'));}
if(typeof window!=='undefined'){
 window.addEventListener('ethereum#initialized',walletsChanged);
 for(const ms of [300,1000,2500,5000])setTimeout(walletsChanged,ms);
}

const standard = new Map(), adapters = new Map();
export function registerStandard(...wallets) {
  for (const wallet of wallets) if(wallet?.name && wallet.features?.['standard:connect']?.connect && wallet.features?.['solana:signTransaction']?.signTransaction) standard.set('standard:'+wallet.name,wallet);
  walletsChanged();
  return () => {for(const w of wallets)standard.delete('standard:'+w.name);walletsChanged();};
}
if(typeof window!=='undefined'){
  const api=Object.freeze({register:registerStandard});
  window.addEventListener('wallet-standard:register-wallet',e=>{if(typeof e.detail==='function')e.detail(api);});
  window.dispatchEvent(new CustomEvent('wallet-standard:app-ready',{detail:api}));
}
export function standardSolanaWallets(chain='solana:devnet') {
  return [...standard].filter(([,w])=>w.chains?.includes(chain)&&w.features['solana:signTransaction'].supportedTransactionVersions?.includes('legacy')).map(([id,w])=>({id,name:w.name,icon:walletIcon(w.name,w.icon)}));
}
export function standardSolanaProvider(id,web3,chain='solana:devnet') {
  const wallet=standard.get(id); if(!wallet || !standardSolanaWallets(chain).some(w=>w.id===id))return null;
  const key=id+chain;if(adapters.has(key))return adapters.get(key);
  let account=null;
  const valid=a=>a.chains?.includes(chain)&&a.features?.includes('solana:signTransaction');
  const provider={
    get publicKey(){return account?new web3.PublicKey(account.publicKey):null;},
    get isConnected(){return !!account;},
    async connect(opts={}){const result=await wallet.features['standard:connect'].connect({silent:!!opts.onlyIfTrusted});account=result.accounts?.find(valid);if(!account)throw new Error(wallet.name+' has no signing account for '+chain+'. Choose another wallet.');return {publicKey:provider.publicKey};},
    async signTransaction(tx){
      if(!account||!wallet.accounts.some(a=>a.address===account.address&&valid(a)))throw new Error('Your wallet account changed. Connect again.');
      const [result]=await wallet.features['solana:signTransaction'].signTransaction({account,chain,transaction:tx.serialize({requireAllSignatures:false,verifySignatures:false})});
      if(!result?.signedTransaction)throw new Error('The wallet did not return a signed transaction.');
      return web3.Transaction.from(result.signedTransaction);
    }
  };
  if(typeof wallet.features['solana:signMessage']?.signMessage==='function')provider.signMessage=async message=>{
    if(!account||!wallet.accounts.some(a=>a.address===account.address&&valid(a)&&a.features?.includes('solana:signMessage')))throw new Error('Your wallet account changed or cannot sign messages. Connect again.');
    const [result]=await wallet.features['solana:signMessage'].signMessage({account,message});
    if(result?.signature?.length!==64||result?.signedMessage?.length!==message.length||!message.every((byte,i)=>byte===result.signedMessage[i]))throw new Error('Wallet did not sign the exact requested message.');
    return {signature:result.signature};
  };
  adapters.set(key,provider);return provider;
}
