import { nowSeconds, syncClock } from './clock.mjs';
import { devLabel } from '/curve-model.mjs';
import { usdReferenceFor } from '/pairs.mjs';
import { exploreHash } from './discovery.mjs';
import { createExplore, exploreSkeleton } from './explore-view.mjs';
import { assetIcon, chainIcon, chainSelector } from './chain-ui.mjs';
import { renderAnalytics } from './analytics-view.mjs';
// Elpida web app shell: environment (local simulation or public testnet), wallets, routing, discovery,
// portfolio and the network/test-funds panel. Views live in launch-flow.mjs, token-page.mjs and
// rewards-view.mjs and receive the shared `ctx` object below.
import { TestnetWallet, evmWallets, chosenEvmWallet } from './wallet.mjs';
import { SolanaWallet, solanaWallets, chosenSolanaWallet } from './solana-wallet.mjs';
import { browserWalletCatalog, walletIcon } from './wallet-discovery.mjs';
import { storage, $, $$, h, icon, short, number, compact, avatar, bar, pricing, fmtPrice, fmtValue, progressOf, lifecycle, usdRate, toast, errorText, closeOnBackdrop, callout } from './ui.mjs';
import { renderLaunch } from './launch-flow.mjs';
import { renderDocs } from './docs-view.mjs';
import { renderToken } from './token-page.mjs';
import { renderRewards } from './rewards-view.mjs';
import { portfolioView } from './portfolio-view.mjs';
import { circleFundingPanel } from './circle-funding.mjs';
import { initShell, renderLastSale, syncSearch } from './shell.mjs';
import { startResilience } from './resilience.mjs';

let config, evmWallet, solWallet, wallet;
let mode = 'local', account = '0', state = null, busy = false, refreshRevision = 0, progressHook = null;
let allTokens = [], discoveryErrors = [], chainControls = [], connecting=false, recentBuys = [];

async function api(path, body, renewed = false) {
  const response = await fetch(`/api/${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Elpida-Token': config.csrf }, body: JSON.stringify({ ...body, account }) } : {signal:AbortSignal.timeout(15000)});
  let result = {}; try { result = await response.json(); } catch {}
  // This rejection occurs before any operation is executed. Retry only this explicit
  // session-expiry response, never an uncertain transaction or other server error.
  if (body && !renewed && response.status === 403 && result.error === 'Refresh this page before submitting.') {
    const fresh = await fetch('/api/config', { cache: 'no-store' });
    if (fresh.ok) {
      const settings = await fresh.json();
      config.csrf = settings.csrf;
      return api(path, body, true);
    }
  }
  if (!response.ok) throw new Error(result.error ?? 'The local launchpad did not respond. Check that npm run dev is running.');
  return result;
}
const onWalletProgress = message => (progressHook ? progressHook(message) : toast(message));
const networks = () => [...config.testnets, config.solana];
const networkByKey = key => networks().find(net => net.key === key);
const currentChain = () => (mode === 'local' ? 'local' : wallet.net.key);
const txLink = hash => (hash && mode === 'testnet' ? { href: wallet.txUrl(hash), label: 'View transaction' } : undefined);

/** Runs a launchpad action in the current environment. Throws on failure so callers keep their drafts. */
async function run(action, body = {}, { quiet = false, onProgress } = {}) {
  if (busy) throw new Error('Another request is still in progress.');
  busy = true; updateChrome(); document.body.dataset.busy = 'true'; progressHook = onProgress ?? null;
  try {
    const result = action === 'deploy' ? await wallet.deploy(body) : action === 'deploy-test-dex' ? await wallet.deployTestDex() : mode === 'local' ? await api(action, body) : await wallet.transact(action, body);
    if (!quiet) toast(result.message ?? 'Done.', { kind: 'success', link: txLink(result.hash) });
    try { await refresh(); } catch {}
    return result;
  } catch(error){api('client-error',{stage:action,code:error.code??error.name??'UNKNOWN'}).catch(()=>{});throw error;
  } finally { busy = false; delete document.body.dataset.busy; progressHook = null; updateChrome(); }
}
/** Saves a Safe Transaction Builder file when an action returns the treasury's setup batch (multisig treasury). */
function downloadSafeBatch(result) {
  if (!result?.safeBatch) return result;
  const url = URL.createObjectURL(new Blob([JSON.stringify(result.safeBatch, null, 2)], { type: 'application/json' }));
  const link = h('a', { href: url, download: `elpida-treasury-setup-${result.safeBatch.chainId}.json` });
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  return result;
}
/** Same as run, but reports errors as notifications (for one-click actions). */
async function act(action, body, opts) { try { return await run(action, body, opts); } catch (error) { toast(errorText(error), { kind: 'error' }); return null; } }

let pendingRefresh=null,pendingRefreshKey=null;
function refresh(options={}){
  options={...options,walletRead:options.walletRead??!['explore','analytics'].includes(currentRoute.name)};
  const key=mode+':'+currentChain()+':'+(wallet.address??account)+':'+options.walletRead;
  if(pendingRefresh&&pendingRefreshKey===key)return pendingRefresh;
  pendingRefreshKey=key;
  const task=refreshNow(options).finally(()=>{if(pendingRefresh===task){pendingRefresh=null;pendingRefreshKey=null;}});
  pendingRefresh=task;return task;
}
async function refreshNow({ preserveInput = false,walletRead=false } = {}) {
  const revision = ++refreshRevision;
  try{const latest=await api('prices');config.prices=latest;}catch{}
  if(mode==='local'){try{const c=await api('config');config.local=c.local;config.pricing=c.pricing;}catch{}}
  let next;
  if (mode === 'testnet' && (!wallet.address || !walletRead)) {
    let tokens=[],discoveryError=false;
    try{tokens=await wallet.publicTokens();}catch{discoveryError=true;}
    next = { ...state, wallet:wallet.address, balance:state?.balance??'0', nativeBalance:state?.nativeBalance??'0', tokens, activity: [], disconnected: !wallet.address,discoveryError };
  }
  else if(mode==='local')next=await api(`state?account=${account}`);
  else{try{next=await wallet.state();}catch(error){
    if(wallet.net.kind==='evm'?!wallet.net.shared?.factory:!wallet.deployment)throw error;
    api('client-error',{stage:'wallet-state',code:error.code??error.name??'UNKNOWN',rpcMethod:error.payload?.method??error.info?.payload?.method,rpcCode:error.error?.code??error.info?.error?.code}).catch(()=>{});
    next={wallet:wallet.address,balance:'0',nativeBalance:'0',tokens:await wallet.publicTokens(),activity:[],disconnected:true,walletReadError:true};
  }}
  if (revision !== refreshRevision) return state;
  const reference=config.prices?.[currentChain()]??wallet.price;
  for(const t of next.tokens??[])t.usdReference=usdReferenceFor(t,reference,nowSeconds());
  state = next; updateChrome(); rerender(preserveInput ? 'background' : 'data');
  if(mode==='testnet'){
    const results=await Promise.allSettled(config.testnets.map(async net=>(await api(`public/tokens?network=${encodeURIComponent(net.key)}`)).map(t=>({...t,network:net.key,usdReference:usdReferenceFor(t,config.prices?.[net.key],nowSeconds())}))));
    if(revision!==refreshRevision)return state;
    discoveryErrors=results.flatMap((r,i)=>r.status==='rejected'?[config.testnets[i].name]:[]);
    if(next.discoveryError)discoveryErrors.push(wallet.net.name);
    const indexed=results.flatMap(r=>r.status==='fulfilled'?r.value:[]);
    const merged=new Map(indexed.map(t=>[`${t.network}:${t.address.toLowerCase()}`,t]));
    for(const t of next.tokens??[]){const key=`${currentChain()}:${t.address.toLowerCase()}`,publicToken=merged.get(key);merged.set(key,{...publicToken,...t,priceChange24h:publicToken?.priceChange24h??t.priceChange24h,network:currentChain()});}
    if(solWallet.deployment&&wallet!==solWallet){try{for(const t of await solWallet.publicTokens())merged.set(`${solWallet.net.key}:${t.address}`,{...t,network:solWallet.net.key,usdReference:usdReferenceFor({...t,usdReference:null},config.prices?.[solWallet.net.key],nowSeconds())});}catch{discoveryErrors.push(solWallet.net.name);}}
    allTokens=[...merged.values()];
    if(currentRoute.name==='explore'||currentRoute.name==='portfolio')rerender('background');
    refreshLastSale();
  }else{allTokens=next.tokens;refreshLastSale();}
  return state;
}
async function chooseChain(key){
  if(busy)throw new Error('Wait for the current request to finish.');
  if(key==='local')return useLocal();
  if(mode==='testnet'&&currentChain()===key)return;
  wallet=key===config.solana.key?solWallet:evmWallet;
  wallet.select(key);wallet.address=null;wallet.signer=null;
  mode='testnet';state=null;
  try{localStorage.setItem('elpida:network',key);}catch{}
  updateChrome();await refresh();
}
async function connect(key, walletId, {silent=false}={}) {
  connecting=true;updateChrome();
  const previousWallet = wallet, previousKey = wallet.net.key;
  let connected = false;
  try {
    wallet = key === config.solana.key ? solWallet : evmWallet;
    wallet.select(key);
    await wallet.connect(walletId,{silent}); connected = true; mode = 'testnet';
    try { localStorage.setItem('elpida:network', key); } catch {}
    state = { ...(previousWallet === wallet && previousKey === key ? state : null), wallet: wallet.address, balance: previousWallet === wallet && previousKey === key ? state?.balance ?? '0' : '0', tokens: previousWallet === wallet && previousKey === key ? state?.tokens ?? [] : [], activity: [] };
    await refresh({walletRead:true});
    return true;
  } catch (error) {
    if (!connected) { wallet = previousWallet; try { if (wallet.net.key !== previousKey) wallet.select(previousKey); } catch {} }
    throw error;
  } finally { connecting=false;updateChrome(); }
}
async function useLocal() {
  mode = 'local'; state = null; recentBuys = []; refreshLastSale();
  try { localStorage.setItem('elpida:network', 'local'); } catch {}
  await refresh(); return true;
}
/**
 * One button per installed wallet of the network's kind, so the person picks which extension opens
 * (several extensions compete for window.ethereum; the wrong one never shows a prompt for some chains).
 */
function walletButtons(net, { onDone = () => {}, onError = () => {} } = {}) {
  const solana = net.kind === 'solana';
  const list = solana ? solanaWallets(net.mainnet?'solana:mainnet':'solana:devnet') : evmWallets();
  const chosen = solana ? chosenSolanaWallet() : chosenEvmWallet();
  if (!list.length) return h('p.small.muted', solana ? 'No Solana wallet found. Install Phantom, Solflare or Backpack, then reload this page.' : 'No Ethereum wallet found. Install MetaMask or another browser wallet, then reload this page.');
  const sorted = [...list].sort((a, b) => Number(b.id === chosen) - Number(a.id === chosen));
  return h('div.wallet-choices',h('p.small.muted','Connecting lets you interact—it does not give us access to your funds.'), sorted.map((w, i) => h(`button.btn.${i === 0 ? 'btn-primary' : 'btn-secondary'}`, { type: 'button', 'data-busy-disable': '', on: { click: async event => {
    const button = event.currentTarget, text = button.lastChild, label = text.textContent; button.disabled = true; text.textContent = `Waiting for ${w.name}…`;
    // A wallet that never shows its prompt (a queued request, a locked extension) must not leave the button stuck.
    let timer; const quiet = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${w.name} has not answered for a minute. Open the ${w.name} extension: approve or reject any pending request (connect or switch to ${net.name}), then try again. Reloading the page also clears it.`)), 60000); });
    try { await Promise.race([connect(net.key, w.id), quiet]); toast(`Connected to ${net.name} with ${w.name}.`, { kind: 'success' }); onDone(); }
    catch (e) { onError(e); }
    finally { clearTimeout(timer); button.disabled = false; text.textContent = label; }
  } } }, w.icon && (/^data:image\//.test(w.icon)||/^\/assets\/wallets\//.test(w.icon)) ? h('img.wallet-icon', { src: w.icon, alt: '', width: 18, height: 18 }) : icon('wallet', 'icon-sm'), h('span', list.length > 1 ? w.name : `Connect ${w.name}`))));
}
const ctx = {
  get config() { return config; }, get state() { return state; }, get mode() { return mode; }, get wallet() { return wallet; }, get account() { return account; },
  get busy() { return busy; }, get solWallet() { return solWallet; }, api, run, act, refresh, connect, useLocal, chooseChain, currentChain, networks, networkByKey, txLink, walletButtons,
  /** The EVM provider for signatures outside a launch (ownership verification): the chosen wallet. */
  evmProvider: () => evmWallet.eth,
  navigate: hash => { if (location.hash === hash) route(); else location.hash = hash; },
  /** Tokens from every network (Explore's merged list), for the cross-chain Portfolio. */
  allTokens: () => allTokens,
  envLabel, isCreatorOf: token => !!state?.wallet && [token.creator, token.reward].some(a => a?.toLowerCase() === state.wallet.toLowerCase()),
};

function envLabel() { return mode === 'local' ? (config?.hostedSimulation ? 'Shared simulation' : 'Local simulation') : `${wallet.net.name} · ${wallet.net.mainnet ? 'mainnet beta' : 'testnet'}`; }
function updateChrome() {
  for (const button of [$('#env-button'), $('#env-button-mobile')]) if (button) button.dataset.env = mode;
  for (const control of chainControls) control.update(busy||connecting);
  $('#account-label').textContent = mode === 'local' ? (config?.accounts?.[Number(account)]?.name ? `Demo ${config.accounts[Number(account)].name.toLowerCase()}` : 'Demo account') : wallet.address ? short(wallet.address) : 'Connect wallet';
  $('#account-button').toggleAttribute('data-connected', mode === 'local' || !!wallet?.address);
  $('#account-button').toggleAttribute('data-address', mode === 'testnet' && !!wallet?.address);
  $('#account-button').setAttribute('aria-label', mode === 'testnet' && !wallet.address ? 'Connect wallet' : `${$('#account-label').textContent}. Open account and network settings.`);
  $$('[data-busy-disable]').forEach(button => { button.disabled = busy; });
}
/* ---------- Routing ---------- */
let currentRoute = { name: 'explore' }, pendingSearchReveal=false;
function parseRoute() {
  const [hash,query] = (location.hash.replace(/^#/, '') || '/').split('?');
  const doc = hash.match(/^\/docs\/([a-z-]+)$/);
  if (doc) return { name: 'docs', section: doc[1] };
  const token = hash.match(/^\/token\/([A-Za-z0-9]{32,64})$/);
  if (token) return { name: 'token', address: token[1],network:new URLSearchParams(query).get('network') };
  return { name: { '/': 'explore', '': 'explore', '/portfolio': 'portfolio', '/rewards': 'rewards', '/launch': 'launch', '/analytics': 'analytics', '/docs': 'docs' }[hash] ?? 'notfound' };
}
function route() {
  const next = parseRoute(); const changed = next.name !== currentRoute.name || next.address !== currentRoute.address;
  currentRoute = next;
  document.body.dataset.route = next.name; // lets token pages drop the desktop top bar (token.css)

  if(next.network&&networkByKey(next.network)&&next.network!==currentChain()){chooseChain(next.network).catch(e=>toast(errorText(e),{kind:'error'}));return;}
  $$('[data-nav]').forEach(link => { if (link.dataset.nav === next.name) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
  document.title = { explore: 'Explore tokens across chains | Elpida', portfolio: 'Portfolio | Elpida', rewards: 'Creator rewards | Elpida', launch: 'Create a token | Elpida', token: 'Token | Elpida', analytics: 'Analytics — Launches, volume & fees | Elpida', docs: 'Docs | Elpida', notfound: 'Page not found | Elpida' }[next.name];
  rerender('route');
  { const v = $('#view'); v.classList.remove('view-enter'); void v.offsetWidth; v.classList.add('view-enter'); }
  if(changed&&wallet?.address&&!['explore','analytics'].includes(next.name))refresh({preserveInput:true,walletRead:true}).catch(e=>toast(errorText(e),{kind:'error'}));
  if (changed) { window.scrollTo({ top: 0 }); if (next.name !== 'launch'&&!['top-search-input','sheet-search-input'].includes(document.activeElement?.id)) $('#main').focus({ preventScroll: true }); }
  if(next.name==='explore'&&pendingSearchReveal&&exploreView){pendingSearchReveal=false;exploreView.setQuery(exploreView.query,{reveal:true});}
}
let launchView = null, analyticsView = null, exploreView = null;
const freshPrice = p => !!p && p.status === 'fresh' && Number.isFinite(p.usd) && nowSeconds() - p.updatedAt <= (p.maxAge ?? 180);
/** What the Explore view reads from the app; it never touches wallets or routing directly. */
const exploreSource = {
  tokens: () => (mode === 'local' ? state?.tokens ?? [] : allTokens),
  networks: () => (mode === 'local' ? [] : networks()),
  mode: () => mode,
  errors: () => (mode === 'local' ? [] : discoveryErrors),
  tokenHref: t => `#/token/${t.address}${t.network && mode === 'testnet' ? '?network=' + encodeURIComponent(t.network) : ''}`,
  nativeSymbol: t => { const net = networkByKey(t.network); return net?.nativeCurrency?.symbol ?? (net?.kind === 'solana' ? 'SOL' : state?.nativeSymbol ?? 'ETH'); },
  networkName: t => networkByKey(t.network)?.name ?? 'the simulation',
  prices: () => {
    if (mode === 'local') { const p = config.prices?.local; return p ? [{ symbol: p.symbol ?? 'ETH', usd: freshPrice(p) ? p.usd : null, source: p.source ?? 'Simulated price', updatedAt: p.updatedAt }] : []; }
    return ['ETH', 'BNB', 'SOL'].map(symbol => { const p = Object.values(config.prices ?? {}).find(p => p.symbol === symbol && !p.simulation && freshPrice(p)); return { symbol, usd: p?.usd ?? null, source: p?.source, updatedAt: p?.updatedAt }; });
  },
  onQuery: query => syncSearch(query),
};
function closeExplore() { exploreView?.dispose(); exploreView = null; }
function rerender(reason) {
  const view = $('#view'); view.setAttribute('aria-busy', state ? 'false' : 'true');
  if (!config) return;
  const r = currentRoute;
  if(r.name==='analytics'){
    view.setAttribute('aria-busy','false');
    if(!analyticsView||!view.contains(analyticsView.root)){analyticsView=renderAnalytics({api});view.replaceChildren(analyticsView.root);}
    return;
  }
  analyticsView?.dispose();analyticsView=null;
  if (r.name !== 'explore') closeExplore();
  if(r.name==='notfound'){view.setAttribute('aria-busy','false');view.replaceChildren(notFoundView());return;}
  if (r.name === 'launch') {
    // The launch flow owns its own state; a data refresh only updates balances and connection status.
    if (!launchView || reason === 'route' && !view.contains(launchView.root)) { launchView = renderLaunch(ctx); view.replaceChildren(launchView.root); }
    else launchView.update?.();
    return;
  }
  launchView = null;
  if(r.name==='rewards'&&(mode!=='testnet'||!wallet.address)){view.replaceChildren(h('div.empty',h('h1',r.name==='rewards'?'Rewards':'Portfolio'),h('p','Connect your wallet to see your '+r.name+'.'),h('p.small.muted','Connecting lets you interact—it does not give us access to your funds.'),h('button.btn.btn-primary',{type:'button',on:{click:connectCurrent}},'Connect wallet')));return;}
  if (!state) { closeExplore(); view.replaceChildren(loadingView()); return; }
  if (r.name === 'token') {
    // Keep the editor and wallet-signing state intact while a holder is writing.
    const previous = reason === 'background' ? {
      side: view.querySelector('[data-side][role=tab][aria-selected=true]')?.dataset.side,
      amount: view.querySelector('#trade-amount')?.value,
      slippage: view.querySelector('#trade-slippage')?.value,
      focused: document.activeElement?.id,
    } : null;
    view.replaceChildren(renderToken(ctx, r.address));
    if (previous) {
      if (previous.side === 'sell') view.querySelector('[data-side=sell]')?.click();
      const input = view.querySelector('#trade-amount'), slippage = view.querySelector('#trade-slippage');
      if (slippage && previous.slippage) slippage.value = previous.slippage;
      if (input && previous.amount) { input.value = previous.amount; input.dispatchEvent(new Event('input')); }
      if (previous.focused) document.getElementById(previous.focused)?.focus({ preventScroll: true });
    }
  }
  else if (r.name === 'portfolio') view.replaceChildren(portfolioView(ctx, { connect: connectCurrent, rerender: () => rerender('route') }));
  else if (r.name === 'rewards') view.replaceChildren(renderRewards(ctx));
  else if (r.name === 'docs') view.replaceChildren(renderDocs(ctx, r.section));
  else if (!exploreView || !view.contains(exploreView.root)) {
    // One Explore controller per visit: later refreshes update its cards in place.
    closeExplore(); exploreView = createExplore(exploreSource); view.replaceChildren(exploreView.root); exploreView.setTrades(recentBuys);
  }
  else if (reason === 'route') exploreView.readUrl();
  else exploreView.update();
}
function notFoundView() { return h('section.not-found', h('h1', 'Page not found.'), h('p', 'That page doesn’t exist. Every token, launch and chart starts from Explore.'), h('a.btn-accent', { href: '#/' }, icon('compass', 'icon-sm'), 'Explore tokens')); }
function loadingView() { return currentRoute.name === 'explore' ? exploreSkeleton() : h('div', h('div.page-head', h('div', h('h1', 'Loading…'), h('p', 'Loading the launchpad…'))), h('div.token-grid', [1, 2, 3].map(() => h('div.skeleton', { 'aria-hidden': 'true' })))); }

/* Portfolio lives in portfolio-view.mjs. */

/* ---------- Network and test funds ---------- */
/** Wallet picker for the current network: one row per wallet this browser announces. */
function openWalletDialog(net = wallet.net) {
  const dialog = $('#wallet-dialog'), body = $('#wallet-body'), error = h('p.error-text', { role: 'alert' });
  if (dialog.open) return;
  let connecting = false, refreshTimer;
  $('#wallet-intro').textContent = `Choose your wallet to connect on ${net.name}.`;
  const draw = () => {
    const solana = net.kind === 'solana';
    const list = solana ? solanaWallets(net.mainnet ? 'solana:mainnet' : 'solana:devnet') : evmWallets();
    const chosen = solana ? chosenSolanaWallet() : chosenEvmWallet();
    const sorted = [...list].sort((a, b) => Number(b.id === chosen) - Number(a.id === chosen));
    const again = h('button.round-button', { type: 'button', 'aria-label': 'Look for wallets again', on: { click: () => { window.dispatchEvent(new Event('eip6963:requestProvider')); setTimeout(draw, 250); } } }, icon('refresh-cw', 'icon-sm'));
    const row = w => h('button.wallet-row', { type: 'button', 'data-busy-disable': '', on: { click: async event => {
      const button = event.currentTarget, note = button.querySelector('small');
      if (connecting) return;
      connecting = true;
      body.querySelectorAll('button').forEach(b => { b.disabled = true; });
      note.textContent = `Waiting for ${w.name}…`; error.textContent = '';
      try { await connect(net.key, w.id); dialog.close(); toast(`Connected to ${net.name} with ${w.name}.`, { kind: 'success' }); }
      catch (e) { error.textContent = errorText(e); note.textContent = w.id === chosen ? 'Last used' : 'Detected'; }
      finally { connecting = false; body.querySelectorAll('button').forEach(b => { b.disabled = false; }); }
    } } },
      h('span.wallet-logo', w.icon && (/^data:image\//.test(w.icon) || /^\/assets\/wallets\//.test(w.icon)) ? h('img', { src: w.icon, alt: '', width: 28, height: 28 }) : icon('wallet')),
      h('span', h('strong', w.name), h('small', w.id === chosen ? 'Last used' : 'Detected')), icon('chevron-right'));
    body.replaceChildren(h('div.wallet-list-head', h('span', 'Available in this browser'), again),
      ...(sorted.length ? sorted.map(row) : [h('p.wallet-empty', solana ? 'No Solana wallet found. Open Elpida in your wallet’s browser, or install a compatible browser extension, then look again.' : 'No Ethereum wallet found. Open Elpida in your wallet’s browser, or install a compatible browser extension, then look again.')]),
      error,
      h('details.wallet-more', { open: !sorted.length }, h('summary', 'Get a compatible wallet'),
        h('div.wallet-catalog', browserWalletCatalog.filter(w => w.chains.includes(solana ? 'solana' : 'evm')).map(w =>
          h('a.wallet-install', { href: w.url, target: '_blank', rel: 'noopener noreferrer' },
            h('img', { src: walletIcon(w.name), alt: '', width: 24, height: 24 }), h('span', w.name), icon('external-link', 'icon-sm')))),
        h('p.hint', 'Already installed? Unlock your wallet, enable it for this site, then look again.')));
  };
  draw();
  const discovered = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { if (dialog.open && !connecting) draw(); }, 100);
  };
  window.addEventListener('eip6963:announceProvider', discovered);
  window.addEventListener('wallet-standard:register-wallet', discovered);
  dialog.addEventListener('close', () => {
    clearTimeout(refreshTimer);
    window.removeEventListener('eip6963:announceProvider', discovered);
    window.removeEventListener('wallet-standard:register-wallet', discovered);
  }, { once: true });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  if (!dialog.open) dialog.showModal();
}
async function connectCurrent() { openWalletDialog(wallet.net); }

/* ---------- Last sale strip ---------- */
// Recent buys feed the top bar strip (public networks only) and the Explore Live feed (the simulation's
// own buys in the simulation).
async function refreshLastSale() {
  const local = mode !== 'testnet', asked = mode;
  if (local) renderLastSale([], { href: () => '#/' });
  let trades = [];
  try { trades = await api(local ? 'recent-trades?limit=20' : 'public/recent-trades?limit=20'); } catch { return; }
  if (mode !== asked) return;
  recentBuys = Array.isArray(trades) ? trades : [];
  if (!local) renderLastSale(recentBuys, { href: t => `#/token/${t.address}?network=${encodeURIComponent(t.network)}` });
  exploreView?.setTrades(recentBuys);
}
async function openTools() {
  const body = $('#tools-body'); const error = h('p.error-text', { role: 'alert' });
  const fail = e => { error.textContent = errorText(e); };
  const local = mode === 'local';
  if(!local&&wallet.address&&wallet.deployment){try{await wallet.checkFeeAccounting?.();await wallet.checkLaunchFeatures?.();}catch(e){fail(e);}}
  const envSection = h('section.tools-section', h('h4', 'Environment'),
    h('p.small.muted', 'Local simulation uses simulated balances on a private test chain. Public testnets use your own wallet and free test funds.'),
    h('div.choice-grid', [{ key: 'local', name: 'Local simulation', note: 'Demo accounts, instant test funds', env: 'sim' }, ...networks().map(net => ({ key: net.key, name: net.name, note: net.kind === 'solana' ? 'Phantom, Solflare or Backpack' : 'Browser wallet such as MetaMask', env: 'testnet', mainnet: !!net.mainnet }))].map(item =>
      h('button.choice', { type: 'button', 'data-busy-disable': '', 'aria-pressed': String(currentChain() === item.key), on: { click: async () => { error.textContent = ''; try { if (item.key === 'local') await useLocal(); else await connect(item.key); $('#tools-dialog').close(); toast(`Switched to ${item.key === 'local' ? 'the local simulation' : item.name}.`, { kind: 'success' }); } catch (e) { fail(e); } } } },
        h('span.choice-title', item.name, currentChain() === item.key ? h('span.chip.chip-positive', 'Current') : null), h('p', item.note), h(`span.chip.chip-${item.env}`, item.env === 'sim' ? 'Simulated funds' : item.mainnet ? 'Mainnet beta · real funds' : 'Public testnet')))));
  const funds = h('section.tools-section', h('h4', 'Test funds'));
  if (local) {
    funds.append(h('div.field', h('label', { for: 'demo-account' }, 'Demo account'),
      h('select.select#demo-account', { on: { change: async e => { account = e.target.value; await refresh(); updateChrome(); } } }, config.accounts.map(a => h('option', { value: a.id, selected: a.id === account }, `${a.name} · ${short(a.address)}`))),
      h('p.hint', 'Switch accounts to try trading against your own launches.')),
      h('p.small.muted', `Demo accounts hold simulated local ETH. Each launch pays a ${config.local?.launchFee ?? ''} ETH creation fee, the simulated oracle equivalent of $10. USDC fee payment is also available.`));
  } else {
    const net = wallet.net;
    // A free faucet for every test pair asset (the test xStock and the test paired token).
    let pairs = null; try { pairs = wallet.address ? wallet.pairOptions?.() : null; } catch {}
    const faucets = Object.values(pairs ?? {}).flatMap(group => group.assets).filter(a => a.faucet && !a.faucet.href);
    if (faucets.length) funds.append(h('div.wallet-choices', faucets.map(a => h('button.btn.btn-secondary', { type: 'button', 'data-busy-disable': '', on: { click: async () => { error.textContent = ''; try { await run(a.faucet.action, a.faucet.body); } catch (e) { fail(e); } } } }, icon('droplet'), a.faucet.label))),
      h('p.hint', 'Test assets are free and have no value. TEST-STOCK is a simulated stock, not an issued xStock.'));
    const links = net.gasFaucet ? [[`${net.nativeCurrency.symbol} faucet (network fees, creation fees and ${net.nativeCurrency.symbol}-paired launches)`, net.gasFaucet]] : [];
    funds.append(h('div.links', links.map(([label, href]) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label, icon('external-link', 'icon-sm')))));
    if (!wallet.address) funds.append(h('h4', 'Connect a wallet'), walletButtons(net, { onDone: () => openTools(), onError: fail }));
    else funds.append(h('p.small.muted', `Connected${/^your/i.test(wallet.walletName ?? 'your') ? '' : ' with ' + wallet.walletName}: ${wallet.address}`), h('details.small', h('summary', 'Use a different wallet'), walletButtons(net, { onDone: () => openTools(), onError: fail })));
    if (net.kind !== 'solana') {
      const deployed = !!wallet.deployment;
      // The treasury is immutable: on mainnet it must be a Safe; on testnet it defaults to this wallet.
      const treasuryInput = !deployed && wallet.dex && wallet.address ? h('input.input', { placeholder: net.mainnet ? '0x… Safe address (required)' : '0x… Safe address (optional; empty = this wallet)', spellcheck: false, autocomplete: 'off', 'aria-label': 'Treasury Safe address' }) : null;
      // A test chain with no DEX and no Chainlink feed: the owner first deploys the labelled test DEX and relay feed.
      const savedDex = net.testDex && !wallet.dex ? wallet.savedTestDex?.() : null, dexDone = !!savedDex?.feed;
      if (net.testDex && !wallet.dex) funds.append(h('div.tools-section', h('h4', 'Test DEX and price feed'),
        h('p.small.muted', `${net.name} has no Uniswap v3 and no Chainlink price feed yet. Tokens here graduate into an Elpida test deployment of Uniswap v3 (Uniswap's own published contracts, with a test WETH), and launches are priced by Chainlink ETH / USD relayed from ${config.relay?.networks?.[net.key]?.source?.network ?? 'another test network'} by the Elpida server, with Chainlink's own timestamps. Testnet only: mainnet uses the real Uniswap and Chainlink.`),
        dexDone ? h('div.stack', h('p.small', 'Deployed from this browser. Send these addresses to the team to register them, then set up the launchpad:'), h('pre.small.selectable', JSON.stringify(savedDex, null, 2))) : null,
        !dexDone && wallet.address ? (config.relay?.address ? h('button.btn.btn-secondary', { type: 'button', 'data-busy-disable': '', on: { click: async () => { error.textContent = ''; try { await run('deploy-test-dex', {}); openTools(); } catch (e) { fail(e); } } } }, savedDex ? 'Finish the test DEX setup' : 'Set up test DEX and price feed (6 confirmations)') : h('p.small.muted', 'The server price relay is not configured yet, so the price feed cannot be deployed.')) : null));
      funds.append(h('div.tools-section', h('h4', 'Launchpad on this network'),
        deployed&&wallet.dex&&wallet.feeUsdc&&!/^0x0{40}$/i.test(wallet.feeUsdc)&&state?.pricing?.owner&&pairs?.usdc?.unavailable?h('div.stack',h('p.small.muted','Approve the configured USDC asset for trading. This creates its graduation adapter and fixes the starting valuation in USDC at the launchpad\u2019s starting FDV. Existing tokens are unchanged.'),h('button.btn.btn-secondary',{type:'button',on:{click:()=>act('setup-usdc-pair',{}).then(r=>{downloadSafeBatch(r);openTools();})}},'Enable USDC trading pair')):null,
        h('p.small.muted', deployed ? `${wallet.deployment.shared ? 'Shared team' : 'Your'} launchpad: ${short(wallet.deployment.factory)}.${wallet.modelUpgradeAvailable ? ' This is the older model 9 launchpad. Model 10 adds launch protection, the 10x curve and the graduation escape hatch; existing tokens keep trading on model 9.' : wallet.needsMetadataUpgrade ? ' A newer version with shared token metadata is available.' : ''}` : 'Each public testnet needs a one-time launchpad setup from your wallet before the first token.'),
        treasuryInput ? h('label.field', h('span.small.muted', 'Treasury: receives launch fees and alone can finish the setup. It can never be changed. Use a Safe multisig for anything beyond testing.'), treasuryInput) : null,
        (!deployed || wallet.needsMetadataUpgrade || wallet.modelUpgradeAvailable || wallet.feeFixUpgradeAvailable || wallet.launchUpgradeAvailable) && wallet.address ? h('button.btn.btn-secondary', { type: 'button', 'data-busy-disable': '', on: { click: async () => { error.textContent = ''; try { downloadSafeBatch(await run('deploy', { treasury: treasuryInput?.value ?? '' })); openTools(); } catch (e) { fail(e); } } } }, wallet.launchUpgradeAvailable?'Deploy automatic-graduation launchpad':wallet.feeFixUpgradeAvailable?'Deploy corrected Base Sepolia launchpad':deployed ? 'Set up the newer launchpad' : 'Set up launchpad') : null,
        wallet.feeFixUpgradeAvailable?h('p.small.muted','The current Model 10 factory predates the shared-recipient fee fix. Deploy a corrected testnet factory using test ETH for gas. Pricing stays unchanged. Existing tokens keep their original contracts. After deployment, share the factory address so it can be registered for all visitors.'):null,
        deployed ? h('div.stack', h('p.small.muted', state?.pricing?.verified ? `$10 launch fee, converted by the on-chain price feed at execution. Starting FDV: $${Number(wallet.startFdvUsd ?? 5000).toLocaleString()} before the first purchase.` : 'USD pricing must be activated before launching.'), !state?.pricing?.verified ? h('button.btn.btn-secondary',{type:'button',on:{click:()=>act('apply-pricing',{}).then(r=>{downloadSafeBatch(r);openTools();})}},wallet.deployment?.treasury&&wallet.deployment.treasury.toLowerCase()!==String(wallet.address).toLowerCase()?'Download the Safe setup file':'Activate price feed') : null) : null,
        deployed && wallet.dex && wallet.address && pairs && (pairs.xstock.unavailable || pairs.token.unavailable) ? h('div.stack', h('p.small.muted', 'xStock and paired-token launches need approved assets. The launchpad owner can deploy the labelled test assets (TEST-STOCK and TEST-MEME) and approve them: six confirmations, gas only.'),
          h('button.btn.btn-secondary', { type: 'button', 'data-busy-disable': '', on: { click: async () => { error.textContent = ''; try { await run('setup-pairs', {}); openTools(); } catch (e) { fail(e); } } } }, 'Add test xStock and token pairs')) : null));
    } else funds.append(h('p.small.muted', wallet.deployment ? `Solana program: ${short(wallet.deployment.programId)}.${state?.pricing ? ` Creation fee ${number(state.pricing.launchFee, 6)} SOL. New USD-priced launches are pending a verified-oracle program upgrade.` : ''}` : 'The Solana program is not deployed. Run npm.cmd run solana:deploy in the elpida-v1 folder, then restart npm run dev.'));
  }
  body.replaceChildren(envSection, funds, circleFundingPanel({ config: config.circle, csrf: config.csrf, connected: mode === 'testnet' ? { address: wallet.address, network: wallet.net.key } : null }), error);
  $('#tools-intro').textContent = local ? 'You are using the local simulation. Choose a network when you create a token, or switch here.' : `You are connected to ${wallet.net.name}.`;
  updateChrome();
  if (!$('#tools-dialog').open) $('#tools-dialog').showModal();
}

/* ---------- Start ---------- */
async function init() {
  const configSent = Date.now();
  config = await api('config');
  syncClock(config.serverTime, configSent);
  // Background refresh. Also on returning to the tab: timers do not run while it is hidden, and a dollar reference
  // older than 3 minutes is shown as stale (values fall back to the pair's own unit) until prices are re-read.
  const backgroundRefresh=()=>{if(!busy&&document.visibilityState==='visible'&&!(currentRoute.name==='rewards'&&document.activeElement?.closest('form')))refresh({preserveInput:true}).catch(()=>{});};
  setInterval(backgroundRefresh,60000);
  document.addEventListener('visibilitychange',backgroundRefresh);
  // The trade strip polls faster than the full refresh: it is one small request, and it is what a trader watches.
  setInterval(()=>{if(document.visibilityState==='visible')refreshLastSale();},8000);
  if (config.solana?.mainnet) {
    $('#footer-note').textContent = 'Solana mainnet beta: real funds, new contracts. Other networks are test networks with no monetary value.';
    $('#how-network-note').textContent = 'Solana runs as a mainnet beta with real funds and new, unaudited contracts; launching is invite-only while the beta gate is on. The other networks are test networks.';
  }
  evmWallet = new TestnetWallet(config, onWalletProgress);
  solWallet = new SolanaWallet(config, onWalletProgress);
  wallet = evmWallet;
  let saved = null; try { saved = localStorage.getItem('elpida:network'); } catch {}
  if (saved === config.solana.key) wallet = solWallet; else if (saved && saved !== 'local') { try { evmWallet.select(saved); } catch {} }
  // Public markets can be browsed without granting wallet access.
  if(saved!=='local'){mode='testnet';}
  if (location.pathname === '/analytics') history.replaceState({}, '', '/#/analytics');
  if (location.pathname === '/launch') history.replaceState({}, '', '/#/launch');
  $$('dialog').forEach(d => { closeOnBackdrop(d); d.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => d.close())); });
  const selectChain=key=>chooseChain(key).catch(e=>{toast(errorText(e),{kind:'error'});updateChrome();});
  chainControls=[['#env-button','chain-options'],['#env-button-mobile','chain-options-mobile']].filter(([id])=>$(id)).map(([id,listId])=>chainSelector({button:$(id),listId,networks,current:()=>mode==='local'?'local':currentChain(),onSelect:selectChain}));
  $('#account-button').addEventListener('click', () => (mode === 'testnet' && !wallet.address ? connectCurrent() : openTools()));
  startResilience();
  initShell({ onHow: () => { location.hash = '#/docs'; }, onSearch: (query,{submit=false}={}) => { if(currentRoute.name==='explore'&&exploreView)exploreView.setQuery(query,{reveal:submit});else if(query||submit||currentRoute.name==='explore'){pendingSearchReveal=submit;location.hash=exploreHash({query});} } });
  window.addEventListener('hashchange', route);
  updateChrome(); route();
  // Return to the testnet used last time, but only silently: wallets that already trust Elpida reconnect
  // without a prompt. Anything else shows the local simulation first, so the page never waits on a popup.
  // Show the public index before slow wallet/RPC reads; browsing must not wait for reconnection.
  if (mode === 'testnet') { try { await refresh({ walletRead: false }); } catch {} }
  const previous = saved && saved !== 'local' ? networkByKey(saved) : null;
  if (previous) {
    let trusted = false;
    try {
      // Give EIP-6963 wallets a moment to announce themselves before asking the chosen one.
      await new Promise(resolve => setTimeout(resolve, 150));
      if (previous.kind === 'solana') { const provider = solWallet.provider; trusted = !!provider && (provider.isConnected && !!provider.publicKey || !!(await Promise.race([provider.connect({ onlyIfTrusted: true }), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 2500))]))); }
      else trusted = ((await Promise.race([evmWallet.eth?.request({ method: 'eth_accounts' }), new Promise(resolve => setTimeout(() => resolve([]), 2500))])) ?? []).length > 0;
    } catch {}
    if (trusted) { try { await connect(previous.key,undefined,{silent:true}); } catch { trusted = false; } }
    if (!trusted) { wallet = previous.kind === 'solana' ? solWallet : evmWallet; mode='testnet';state=null;toast(`Browsing ${previous.name}. Connect your wallet to trade.`, { kind: 'info' }); }
  }
  try { if (!state) await refresh(); }
  catch (error) { $('#view').replaceChildren(h('div.page-head', h('div', h('h1', 'Elpida'))), callout('error', 'circle-alert', h('strong', 'The launchpad could not load. '), errorText(error), ' ', h('button.link-button', { type: 'button', on: { click: () => location.reload() } }, 'Try again'))); }
}
init().catch(error => { $('#view').replaceChildren(callout('error', 'circle-alert', h('strong', 'Elpida could not start. '), errorText(error))); });

export { ctx };
