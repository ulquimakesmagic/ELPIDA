import { nowSeconds, syncClock } from './clock.mjs';
import { devLabel } from '/curve-model.mjs';
import { discoveryTokens } from './discovery.mjs';
import { assetIcon, chainIcon, chainSelector } from './chain-ui.mjs';
import { renderAnalytics } from './analytics-view.mjs';
// Elpida web app shell: environment (local simulation or public testnet), wallets, routing, discovery,
// portfolio and the network/test-funds panel. Views live in launch-flow.mjs, token-page.mjs and
// rewards-view.mjs and receive the shared `ctx` object below.
import { TestnetWallet, evmWallets, chosenEvmWallet } from './wallet.mjs';
import { SolanaWallet, solanaWallets, chosenSolanaWallet } from './solana-wallet.mjs';
import { $, $$, h, icon, short, number, compact, avatar, bar, pricing, fmtPrice, fmtValue, progressOf, lifecycle, usdRate, toast, errorText, closeOnBackdrop, callout } from './ui.mjs';
import { renderLaunch } from './launch-flow.mjs';
import { renderToken } from './token-page.mjs';
import { renderRewards } from './rewards-view.mjs';
import { circleFundingPanel } from './circle-funding.mjs';
import { initShell, renderLastSale, syncSearch } from './shell.mjs';

let config, evmWallet, solWallet, wallet;
let mode = 'local', account = '0', state = null, busy = false, refreshRevision = 0, progressHook = null;
let allTokens = [], discoveryErrors = [], chainControls = [], connecting=false;
const ui = { filter: 'all', query: '', sort: 'marketcap',stage:'all' };

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
    const result = action === 'deploy' ? await wallet.deploy() : mode === 'local' ? await api(action, body) : await wallet.transact(action, body);
    if (!quiet) toast(result.message ?? 'Done.', { kind: 'success', link: txLink(result.hash) });
    try { await refresh(); } catch {}
    return result;
  } catch(error){api('client-error',{stage:action,code:error.code??error.name??'UNKNOWN'}).catch(()=>{});throw error;
  } finally { busy = false; delete document.body.dataset.busy; progressHook = null; updateChrome(); }
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
  for(const t of next.tokens??[])if(t.pair==='native')t.usdReference=reference;
  state = next; updateChrome(); rerender(preserveInput ? 'background' : 'data');
  if(mode==='testnet'){
    const results=await Promise.allSettled(config.testnets.map(async net=>(await api(`public/tokens?network=${encodeURIComponent(net.key)}`)).map(t=>({...t,network:net.key,usdReference:t.pair==='native'?config.prices?.[net.key]:t.usdReference}))));
    if(revision!==refreshRevision)return state;
    discoveryErrors=results.flatMap((r,i)=>r.status==='rejected'?[config.testnets[i].name]:[]);
    if(next.discoveryError)discoveryErrors.push(wallet.net.name);
    const indexed=results.flatMap(r=>r.status==='fulfilled'?r.value:[]);
    const merged=new Map(indexed.map(t=>[`${t.network}:${t.address.toLowerCase()}`,t]));
    for(const t of next.tokens??[]){const key=`${currentChain()}:${t.address.toLowerCase()}`,publicToken=merged.get(key);merged.set(key,{...publicToken,...t,priceChange24h:publicToken?.priceChange24h??t.priceChange24h,network:currentChain()});}
    if(solWallet.deployment&&wallet!==solWallet){try{for(const t of await solWallet.publicTokens())merged.set(`${solWallet.net.key}:${t.address}`,{...t,network:solWallet.net.key});}catch{discoveryErrors.push(solWallet.net.name);}}
    allTokens=[...merged.values()];
    if(currentRoute.name==='explore')rerender('background');
    refreshLastSale();
  }else allTokens=next.tokens;
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
  mode = 'local'; state = null; refreshLastSale();
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
    try { await connect(net.key, w.id); toast(`Connected to ${net.name} with ${w.name}.`, { kind: 'success' }); onDone(); }
    catch (e) { onError(e); }
    finally { button.disabled = false; text.textContent = label; }
  } } }, w.icon && (/^data:image\//.test(w.icon)||/^\/assets\/wallets\//.test(w.icon)) ? h('img.wallet-icon', { src: w.icon, alt: '', width: 18, height: 18 }) : icon('wallet', 'icon-sm'), h('span', list.length > 1 ? w.name : `Connect ${w.name}`))));
}
const ctx = {
  get config() { return config; }, get state() { return state; }, get mode() { return mode; }, get wallet() { return wallet; }, get account() { return account; },
  get busy() { return busy; }, get solWallet() { return solWallet; }, api, run, act, refresh, connect, useLocal, currentChain, networks, networkByKey, txLink, walletButtons,
  /** The EVM provider for signatures outside a launch (ownership verification): the chosen wallet. */
  evmProvider: () => evmWallet.eth,
  navigate: hash => { if (location.hash === hash) route(); else location.hash = hash; },
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
function envBanner() {
  const local = mode === 'local';
  const text = local
    ? `${config?.hostedSimulation ? 'Shared simulation. Visitors share demo accounts and launches.' : 'Local simulation.'} Contracts run on a private test chain with simulated balances. Everything resets when the server restarts.`
    : wallet.net.mainnet
      ? `${wallet.net.name} mainnet beta. Real funds: your wallet signs every transaction and pays network fees in SOL. The contracts are new; launch and trade only what you can afford to lose.${wallet.beta?.enabled ? ' Launching is invite-only during the beta.' : ''}`
      : wallet.net.kind === 'solana'
      ? `${wallet.net.name} public testnet. Your wallet signs every transaction and pays network fees in devnet SOL. Launches pay their creation fee in SOL.`
      : `${wallet.net.name} public testnet. Your wallet signs every transaction and pays gas in test ${wallet.net.nativeCurrency.symbol}.`;
  return h('div.env-banner', { 'data-env': mode }, icon(local ? 'flask-conical' : 'globe'), h('span', text),
    h('button.btn.btn-sm.btn-secondary', { type: 'button', 'data-busy-disable': '', on: { click: openTools } }, local ? 'Test funds' : 'Network and funds'));
}

/* ---------- Routing ---------- */
let currentRoute = { name: 'explore' };
function parseRoute() {
  const [hash,query] = (location.hash.replace(/^#/, '') || '/').split('?');
  const token = hash.match(/^\/token\/([A-Za-z0-9]{32,64})$/);
  if (token) return { name: 'token', address: token[1],network:new URLSearchParams(query).get('network') };
  return { name: { '/': 'explore', '': 'explore', '/portfolio': 'portfolio', '/rewards': 'rewards', '/launch': 'launch', '/analytics': 'analytics' }[hash] ?? 'notfound' };
}
function route() {
  const next = parseRoute(); const changed = next.name !== currentRoute.name || next.address !== currentRoute.address;
  currentRoute = next;

  if(next.network&&networkByKey(next.network)&&next.network!==currentChain()){chooseChain(next.network).catch(e=>toast(errorText(e),{kind:'error'}));return;}
  $$('[data-nav]').forEach(link => { if (link.dataset.nav === next.name) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
  document.title = { explore: 'Explore tokens across chains | Elpida', portfolio: 'Portfolio | Elpida', rewards: 'Creator rewards | Elpida', launch: 'Create a token | Elpida', token: 'Token | Elpida', analytics: 'Analytics — Launches, volume & fees | Elpida', notfound: 'Page not found | Elpida' }[next.name];
  rerender('route');
  if(changed&&wallet?.address&&!['explore','analytics'].includes(next.name))refresh({preserveInput:true,walletRead:true}).catch(e=>toast(errorText(e),{kind:'error'}));
  if (changed) { window.scrollTo({ top: 0 }); if (next.name !== 'launch') $('#main').focus({ preventScroll: true }); }
}
let launchView = null, analyticsView = null;
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
  if(r.name==='notfound'){view.setAttribute('aria-busy','false');view.replaceChildren(notFoundView());return;}
  if (r.name === 'launch') {
    // The launch flow owns its own state; a data refresh only updates balances and connection status.
    if (!launchView || reason === 'route' && !view.contains(launchView.root)) { launchView = renderLaunch(ctx); view.replaceChildren(launchView.root); }
    else launchView.update?.();
    return;
  }
  launchView = null;
  if(['portfolio','rewards'].includes(r.name)&&(mode!=='testnet'||!wallet.address)){view.replaceChildren(h('div.empty',h('h1',r.name==='rewards'?'Rewards':'Portfolio'),h('p','Connect your wallet to see your '+r.name+'.'),h('p.small.muted','Connecting lets you interact—it does not give us access to your funds.'),h('button.btn.btn-primary',{type:'button',on:{click:connectCurrent}},'Connect wallet')));return;}
  if (!state) { view.replaceChildren(loadingView()); return; }
  if (r.name === 'token') {
    // Keep the editor and wallet-signing state intact while a holder is writing.
    if(reason==='background'&&(document.activeElement?.id==='holder-thesis'||view.querySelector('.thesis-editor[data-pending="true"]')))return;
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
  else if (r.name === 'portfolio') view.replaceChildren(portfolioView());
  else if (r.name === 'rewards') view.replaceChildren(renderRewards(ctx));
  else view.replaceChildren(exploreView());
}
function notFoundView() { return h('section.not-found', h('h1', 'Page not found.'), h('p', 'That page doesn’t exist. Every token, launch and chart starts from Explore.'), h('a.btn-accent', { href: '#/' }, icon('compass', 'icon-sm'), 'Explore tokens')); }
function loadingView() { return h('div', h('div.page-head', h('div', h('h1', 'Explore tokens'), h('p', 'Loading the launchpad…'))), h('div.token-grid', [1, 2, 3].map(() => h('div.skeleton', { 'aria-hidden': 'true' })))); }

/* ---------- Explore ---------- */
function stats() {
  const totals = {};
  const listings=mode==='local'?state.tokens:allTokens;
  for (const t of listings) { const q = t.quoteSymbol ?? state.nativeSymbol ?? 'ETH'; totals[q] = (totals[q] ?? 0) + Number(t.reserve); }
  const solana = mode === 'testnet' && wallet === solWallet;
  const dex = mode === 'local' ? config.dex : wallet.dex;
  // Balances are in the network's native coin (pricing is native only).
  const balance = `${number(state.nativeBalance ?? state.balance, 4)} ${state.nativeSymbol ?? state.balanceSymbol ?? 'ETH'}`;
  return h('section.stats', { 'aria-label': 'Launchpad overview' },
    h('div', h('span', 'Tokens launched'), h('strong', String(listings.length))),
    h('div', h('span', 'Trading reserves'), h('strong', Object.entries(totals).map(([q, v]) => `${number(v, v < 1 ? 4 : 2)} ${q}`).join(' + ') || '0'), h('small', mode === 'local' ? 'Simulated assets held by curves and pools' : 'Test assets held by curves and pools')),
    h('div', h('span', mode === 'local' ? 'Your simulated balance' : 'Your balance'), h('strong', state.disconnected ? '—' : balance)),
    h('div', h('span', 'Trading fee'), h('strong', solana ? '1.25% → 0.30%' : dex ? '1.25% → 1%' : '1.25%'), h('small', solana ? 'Curve, then PumpSwap pool' : dex ? 'Curve, then Uniswap v3 pool' : 'Bonding curve')));
}
function age(created){const seconds=Math.max(0,(nowSeconds()*1000-created)/1000);return seconds<60?`${Math.floor(seconds)}s`:seconds<3600?`${Math.floor(seconds/60)}m`:seconds<86400?`${Math.floor(seconds/3600)}h`:`${Math.floor(seconds/86400)}d`;}
function tokenCard(token) {
  const life = lifecycle(token), pct = progressOf(token), p = pricing(token);
  const chain=networkByKey(token.network);
  return h('a.token-card', { href: `#/token/${token.address}${token.network?'?network='+encodeURIComponent(token.network):''}`, 'aria-label': `${token.name}, ${token.symbol}. ${chain?.name??'Simulation'}. ${life.label}.` },
    h('div.token-card-head', avatar(token), h('div', h('h3', token.name), h('span.sym', `$${token.symbol}`))),
    h('div.chips', h('span.chip',chainIcon(token.network),chain?.name??'Simulation'),h(`span.chip${life.chip ? '.' + life.chip : ''}`, life.label), h('span.chip',assetIcon(token.quoteSymbol??'ETH'),`${token.quoteSymbol ?? state.nativeSymbol ?? 'ETH'} pair`),
      token.devBoughtPct != null ? h('span.chip.dev-chip', { title: devLabel(token.devBoughtPct, token.devHoldingPct) }, `Dev ${number(token.devBoughtPct, 1)}% → ${token.devHoldingPct != null ? number(token.devHoldingPct, 1) + '%' : '—'}`) : null),
    h('p.desc', token.metadata?.description || 'No description yet.'),
    // Market cap = price × the full 1B supply (all minted at launch), the same figure as FDV.
    h('div.figures', h('div.figure', h('span', 'Market cap'), h('strong', fmtValue(p.marketCap, token))), h('div.figure', h('span', 'Price'), h('strong.nowrap', fmtPrice(token)))),
    h('div.figures',h('div.figure',h('span',{title:token.graduated?'Indexed quote assets in the DEX pool; not total two-sided TVL.':'Real quote funds collected by the curve. Virtual reserves are excluded.'},'Liquidity'),h('strong',fmtValue(token.reserve,token))),h('div.figure',h('span','Age'),h('strong',token.created?age(token.created):'Unavailable'))),
    h('p.card-change',{'data-direction':!token.priceChange24h?'unknown':token.priceChange24h.percent>=0?'up':'down',title:token.priceChange24h?.basis??'Requires confirmed prices near both comparison times'},token.priceChange24h?icon(token.priceChange24h.percent>=0?'trending-up':'trending-down','icon-sm'):null,token.priceChange24h?`${token.priceChange24h.percent>=0?'+':''}${number(token.priceChange24h.percent,2)}% — 24h`:'24h change unavailable'),
    token.complete&&!token.graduated?h('p.small.muted','Migration pending. Open token for status and next action.'):null,
    h('div.progress', h('div.progress-label', h('span', token.graduated ? 'Graduated' : 'Bonding curve'), h('strong', `${number(pct, 1)}%`)), bar(pct, token.complete || token.graduated)));
}
function filtered(list) {return discoveryTokens(list,{query:ui.query,category:ui.stage});}
function exploreView() {
  const grid = h('div.token-grid');
  const empty = h('div');
  const draw = () => {
    const items = filtered([...(mode==='local'?state.tokens:allTokens)]);
    grid.replaceChildren(...items.map(tokenCard));
    empty.replaceChildren(items.length ? '' : emptyState());
    count.textContent = `${items.length} ${items.length === 1 ? 'token' : 'tokens'}`;
  };
  const count = h('span.muted.small');
  const search = h('input.input', { type: 'search', placeholder: 'Search by name or symbol', 'aria-label': 'Search tokens', value: ui.query, on: { input: e => { ui.query = e.target.value; syncSearch(ui.query); draw(); } } });
  const stages=h('div.stage-filters',{role:'group','aria-label':'Launch stage'},[['all','All'],['migrating','Migrating'],['graduated','Graduated'],['new','New']].map(([key,label])=>h('button.btn.btn-ghost.btn-sm',{type:'button','aria-pressed':String(ui.stage===key),on:{click:e=>{ui.stage=key;stages.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b===e.currentTarget)));draw();}}},label)));
  const view = h('div',
    h('section.intro', h('div', h('h1', 'Create a token. Build your community.'), h('p', 'Launch a token, choose its trading pair and decide where creator fees go.')),
      h('div.intro-actions', h('a.btn.btn-primary.btn-lg', { href: '#/launch' }, icon('plus'), 'Create token'), h('button.btn.btn-secondary.btn-lg', { type: 'button', on: { click: () => $('#how-dialog').showModal() } }, 'How it works'))),
    discoveryErrors.length?h('p.small.error-text',`Some networks could not load: ${discoveryErrors.join(', ')}. Refresh to retry.`):null,
    h('div.price-ticker',{'aria-label':'Native asset USD reference prices'}, ['ETH','BNB','SOL'].map(symbol=>{const p=Object.values(config.prices??{}).find(p=>p.symbol===symbol&&!p.simulation&&p.status==='fresh'&&nowSeconds()-p.updatedAt<=(p.maxAge??180));return h('span',{title:p?.updatedAt?`${p.source} — Updated ${new Date(p.updatedAt*1000).toLocaleString()}`:'Price unavailable'},assetIcon(symbol),h('strong',symbol),p?.status==='fresh'?'$'+number(p.usd):'Price unavailable');})),
    h('details.price-sources',h('summary','Price sources & freshness'),['ETH','BNB','SOL'].map(symbol=>{const p=Object.values(config.prices??{}).find(p=>p.symbol===symbol&&!p.simulation&&p.status==='fresh'&&nowSeconds()-p.updatedAt<=(p.maxAge??180));return h('p.small.muted',`${symbol}: ${p?.source??'Unavailable'}${p?.updatedAt?' · '+new Date(p.updatedAt*1000).toLocaleString():''}. Display reference; launch fees are verified separately by the contract.`);})),
    h('section', { 'aria-labelledby': 'tokens-title' },
      h('div.page-head', h('div', h('h2#tokens-title', 'Tokens'), count), h('button.btn.btn-ghost.btn-sm', { type: 'button', on: { click: () => refresh().then(() => toast('Updated.')).catch(e => toast(errorText(e), { kind: 'error' })) } }, icon('refresh-cw', 'icon-sm'), 'Refresh')),
      h('div.toolbar', h('label.search', icon('search'), search)),stages, grid, empty),
    );
  draw();
  return view;
}
function emptyState() {
  const text = ui.query ? 'No tokens match your search. Try another name or symbol.' : ui.filter !=='all'&&state.disconnected?'Connect your wallet to see your tokens.':ui.filter === 'held' ? 'You do not hold any tokens yet.' : ui.filter === 'created' ? 'You have not created a token yet.' : 'No indexed launches yet. Tokens across Elpida networks appear here.';
  const needsWallet=state.disconnected&&ui.filter!=='all';
  return h('div.empty', h('img', { src: '/assets/brand/elpida-mark.svg', alt: '' }), h('h3', needsWallet ? 'Wallet not connected' : 'Nothing here yet'), h('p', text),
    needsWallet ? h('button.btn.btn-primary', { type: 'button', on: { click: () => connectCurrent() } }, icon('wallet'), 'Connect wallet') : null);
}
function activitySection() {
  const items = mode === 'local' ? state.activity ?? [] : state.tokens.map(t => ({ type: 'Launch', symbol: t.symbol, account: t.creator, hash: t.hash, url: t.hash ? wallet.txUrl(t.hash) : t.url, time: t.created }));
  const rows = items.slice(0, 6).map(a => {
    const when = a.time ? new Date(a.time).toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' }) : '';
    const link = a.url ?? (mode === 'testnet' && a.hash ? wallet.txUrl(a.hash) : null);
    return h('div.activity-row', h('span.glyph', { 'data-kind': a.type }, icon(a.type === 'Sell' ? 'trending-up' : a.type === 'Launch' ? 'plus' : a.type === 'Buy' ? 'arrow-down-up' : 'coins', 'icon-sm')),
      h('div', h('strong', `${a.type === 'Fees paid' ? 'Creator fees distributed' : a.type} · ${a.symbol}`), h('span.meta', a.amount ? `${number(a.amount, 4)} ${a.type === 'Sell' ? a.symbol : a.quoteSymbol ?? state.nativeSymbol ?? 'ETH'}` : 'On-chain transaction')),
      h('span.meta.who', short(a.account)),
      link ? h('a.small', { href: link, target: '_blank', rel: 'noopener noreferrer' }, 'View', icon('external-link', 'icon-sm')) : h('span.meta', when));
  });
  return h('section.section', { 'aria-labelledby': 'activity-title' }, h('div.page-head', h('h2#activity-title', 'Recent activity'), h('span.muted.small', mode === 'local' ? 'This local session' : `Launches on ${wallet.net.name}`)),
    rows.length ? h('div.activity', rows) : h('p.muted', 'Launches and trades will appear here.'));
}

/* ---------- Portfolio ---------- */
function portfolioView() {
  const held = state.tokens.filter(t => Number(t.balance) > 0);
  const created = state.tokens.filter(t => t.creator?.toLowerCase() === state.wallet?.toLowerCase());
  const holdingRows = held.map(t => {
    const p = pricing(t), value = Number(t.balance) * p.price;
    return h('a.fee-row', { href: `#/token/${t.address}`, class: 'token-row' },
      h('div.token-card-head', avatar(t),chainIcon(t.network??currentChain()), h('div', h('h3', t.name), h('span.sym.muted.small', `$${t.symbol}`))),
      h('div.figure', h('span', 'Balance'), h('strong', `${compact(t.balance)} ${t.symbol}`)),
      h('div.figure', h('span', 'Value'), h('strong', fmtValue(value, t))),
      h('div.figure', h('span', 'Share of supply'), h('strong', `${number(Number(t.balance) / Number(t.supply) * 100, 3)}%`)));
  });
  return h('div',
    h('div.page-head', h('div', h('h1', 'Portfolio'), h('p', mode === 'local' ? 'Holdings of the selected demo account in the local simulation.' : state.disconnected ? 'Connect your wallet to see your holdings.' : `Holdings of ${short(state.wallet)} on ${wallet.net.name}.`)),
      h('div.stats', { class: 'compact' }, h('div', h('span', 'Tokens held'), h('strong', String(held.length))), h('div', h('span', 'Tokens created'), h('strong', String(created.length))))),
    h('section.section', h('h2', 'Holdings'), held.length ? h('div.activity', holdingRows) : h('div.empty', h('h3', 'No holdings yet'), h('p', 'Tokens you buy appear here with their current value in the trading pair.'), h('a.btn.btn-primary', { href: '#/' }, 'Explore tokens'))),
    h('section.section', h('h2', 'Created by you'), created.length ? h('div.token-grid', created.map(tokenCard)) : h('div.empty', h('h3', 'You have not created a token yet'), h('p', 'Your launches appear here with their curve progress and creator fees.'), h('a.btn.btn-primary', { href: '#/launch' }, icon('plus'), 'Create token'))));
}

/* ---------- Network and test funds ---------- */
/** Wallet picker for the current network: one row per wallet this browser announces. */
function openWalletDialog(net = wallet.net) {
  const dialog = $('#wallet-dialog'), body = $('#wallet-body'), error = h('p.error-text', { role: 'alert' });
  $('#wallet-intro').textContent = `Choose your wallet to connect on ${net.name}.`;
  const draw = () => {
    const solana = net.kind === 'solana';
    const list = solana ? solanaWallets(net.mainnet ? 'solana:mainnet' : 'solana:devnet') : evmWallets();
    const chosen = solana ? chosenSolanaWallet() : chosenEvmWallet();
    const sorted = [...list].sort((a, b) => Number(b.id === chosen) - Number(a.id === chosen));
    const again = h('button.round-button', { type: 'button', 'aria-label': 'Look for wallets again', on: { click: () => { window.dispatchEvent(new Event('eip6963:requestProvider')); setTimeout(draw, 250); } } }, icon('refresh-cw', 'icon-sm'));
    const row = w => h('button.wallet-row', { type: 'button', 'data-busy-disable': '', on: { click: async event => {
      const button = event.currentTarget, note = button.querySelector('small');
      button.disabled = true; note.textContent = `Waiting for ${w.name}…`; error.textContent = '';
      try { await connect(net.key, w.id); dialog.close(); toast(`Connected to ${net.name} with ${w.name}.`, { kind: 'success' }); }
      catch (e) { error.textContent = errorText(e); note.textContent = w.id === chosen ? 'Last used' : 'Detected'; }
      finally { button.disabled = false; }
    } } },
      h('span.wallet-logo', w.icon && (/^data:image\//.test(w.icon) || /^\/assets\/wallets\//.test(w.icon)) ? h('img', { src: w.icon, alt: '', width: 28, height: 28 }) : icon('wallet')),
      h('span', h('strong', w.name), h('small', w.id === chosen ? 'Last used' : 'Detected')), icon('chevron-right'));
    body.replaceChildren(h('div.wallet-list-head', h('span', 'Available in this browser'), again),
      sorted.length ? sorted.map(row) : h('p.wallet-empty', solana ? 'No Solana wallet found in this browser. Install Phantom, Solflare or Backpack, then look again.' : 'No Ethereum wallet found in this browser. Install MetaMask, Rabby or another browser wallet, then look again.'),
      error);
  };
  draw();
  if (!dialog.open) dialog.showModal();
}
async function connectCurrent() { openWalletDialog(wallet.net); }

/* ---------- Last sale strip ---------- */
async function refreshLastSale() {
  if (mode !== 'testnet') { renderLastSale([], { href: () => '#/' }); return; }
  try { renderLastSale(await api('public/recent-trades?limit=16'), { href: t => `#/token/${t.address}?network=${encodeURIComponent(t.network)}` }); } catch {}
}
function openTools() {
  const body = $('#tools-body'); const error = h('p.error-text', { role: 'alert' });
  const fail = e => { error.textContent = errorText(e); };
  const local = mode === 'local';
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
      funds.append(h('div.tools-section', h('h4', 'Launchpad on this network'),
        deployed&&wallet.dex&&wallet.feeUsdc&&state?.pricing?.owner&&pairs?.usdc?.unavailable?h('div.stack',h('p.small.muted','Approve the configured USDC asset for trading. This creates its graduation adapter and fixes the starting valuation in USDC at the launchpad\u2019s starting FDV. Existing tokens are unchanged.'),h('button.btn.btn-secondary',{type:'button',on:{click:()=>act('setup-usdc-pair',{}).then(()=>openTools())}},'Enable USDC trading pair')):null,
        h('p.small.muted', deployed ? `${wallet.deployment.shared ? 'Shared team' : 'Your'} launchpad: ${short(wallet.deployment.factory)}.${wallet.modelUpgradeAvailable ? ' This is the older model 9 launchpad. Model 10 adds launch protection, the 10x curve and the graduation escape hatch; existing tokens keep trading on model 9.' : wallet.needsMetadataUpgrade ? ' A newer version with shared token metadata is available.' : ''}` : 'Each public testnet needs a one-time launchpad setup from your wallet before the first token.'),
        (!deployed || wallet.needsMetadataUpgrade || wallet.modelUpgradeAvailable) && wallet.address ? h('button.btn.btn-secondary', { type: 'button', 'data-busy-disable': '', on: { click: async () => { error.textContent = ''; try { await run('deploy', {}); openTools(); } catch (e) { fail(e); } } } }, deployed ? 'Set up the newer launchpad' : 'Set up launchpad') : null,
        deployed ? h('div.stack', h('p.small.muted', state?.pricing?.verified ? `$10 launch fee, converted by the on-chain price feed at execution. Starting FDV: $${Number(wallet.startFdvUsd ?? 5000).toLocaleString()} before the first purchase.` : 'USD pricing must be activated before launching.'), !state?.pricing?.verified ? h('button.btn.btn-secondary',{type:'button',on:{click:()=>act('apply-pricing',{}).then(()=>openTools())}},'Activate price feed') : null) : null,
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
  setInterval(()=>{if(!busy&&document.visibilityState==='visible'&&!(currentRoute.name==='rewards'&&document.activeElement?.closest('form')))refresh({preserveInput:true}).catch(()=>{});},60000);
  setInterval(()=>{if(document.visibilityState==='visible')refreshLastSale();},30000);
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
  initShell({ onHow: () => $('#how-dialog').showModal(), onSearch: query => { ui.query = query; if (currentRoute.name !== 'explore') { if (query) location.hash = '#/'; } else rerender('background'); } });
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
