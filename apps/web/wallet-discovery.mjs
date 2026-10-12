// Discovery never requests accounts or signatures. Only the explicit selected wallet connects.
export function injectedEvmWallets(win, announced = []) {
  const result = [], seen = new Set();
  const add = (id, name, provider, icon = '') => {
    if (!provider?.request || seen.has(provider)) return;
    seen.add(provider); result.push({id, name, provider, icon:icon||({MetaMask:'/assets/wallets/metamask.svg',Phantom:'/assets/wallets/phantom.svg'}[name]??'')});
  };
  for (const d of announced) add(d.info.rdns, d.info.name, d.provider, d.info.icon);
  const name = p => p.isRabby?'Rabby':p.isCoinbaseWallet?'Coinbase Wallet':p.isBraveWallet?'Brave Wallet':p.isTrust?'Trust Wallet':p.isOkxWallet?'OKX Wallet':p.isPhantom?'Phantom':p.isMetaMask?'MetaMask':'Browser wallet';
  for (const [id,p] of [['rabby',win.rabby],['coinbase',win.coinbaseWalletExtension],['okx',win.okxwallet],['trust',win.trustwallet],['phantom-evm',win.phantom?.ethereum],['backpack-evm',win.backpack?.ethereum],...(win.ethereum?.providers??[]).map((p,i)=>['injected-'+i,p]),['injected',win.ethereum]]) add(id,name(p??{}),p);
  return result;
}

const standard = new Map(), adapters = new Map();
export function registerStandard(...wallets) {
  for (const wallet of wallets) if(wallet?.name && wallet.features?.['standard:connect']?.connect && wallet.features?.['solana:signTransaction']?.signTransaction) standard.set('standard:'+wallet.name,wallet);
  return () => {for(const w of wallets)standard.delete('standard:'+w.name);};
}
if(typeof window!=='undefined'){
  const api=Object.freeze({register:registerStandard});
  window.addEventListener('wallet-standard:register-wallet',e=>{if(typeof e.detail==='function')e.detail(api);});
  window.dispatchEvent(new CustomEvent('wallet-standard:app-ready',{detail:api}));
}
export function standardSolanaWallets(chain='solana:devnet') {
  return [...standard].filter(([,w])=>w.chains?.includes(chain)&&w.features['solana:signTransaction'].supportedTransactionVersions?.includes('legacy')).map(([id,w])=>({id,name:w.name,icon:w.icon}));
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
  };adapters.set(key,provider);return provider;
}
