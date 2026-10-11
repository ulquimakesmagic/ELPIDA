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

let config, evmWallet, solWallet, wallet;
let mode = 'local', account = '0', state = null, busy = false, refreshRevision = 0, progressHook = null;
const ui = { filter: 'all', query: '', sort: 'newest',stage:'all' };

async function api(path, body) {
  const response = await fetch(`/api/${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Elpida-Token': config.csrf }, body: JSON.stringify({ ...body, account }) } : {});
  let result = {}; try { result = await response.json(); } catch {}
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
  busy = true; document.body.dataset.busy = 'true'; progressHook = onProgress ?? null;
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

async function refresh({ preserveInput = false } = {}) {
  const revision = ++refreshRevision;
  try{const latest=await api('prices');config.prices=latest;}catch{}
  if(mode==='local'){try{const c=await api('config');config.local=c.local;config.pricing=c.pricing;}catch{}}
  let next;
  if (mode === 'testnet' && !wallet.address) next = { balance: '0', nativeBalance:'0', tokens: wallet.net.kind==='evm'?await api('public/tokens?network='+encodeURIComponent(currentChain())):[], activity: [], disconnected: true };
  else if(mode==='local')next=await api(`state?account=${account}`);
  else{try{next=await wallet.state();}catch(error){
    if(wallet.net.kind!=='evm'||!wallet.net.shared?.factory)throw error;
    api('client-error',{stage:'wallet-state',code:error.code??error.name??'UNKNOWN'}).catch(()=>{});
    next={balance:'0',nativeBalance:'0',tokens:await api('public/tokens?network='+encodeURIComponent(currentChain())),activity:[],disconnected:true,walletReadError:true};
  }}
  if (revision !== refreshRevision) return state;
  const reference=mode==='testnet'&&wallet.price?wallet.price:config.prices?.[currentChain()];
  for(const t of next.tokens??[])if(t.pair==='native')t.usdReference=reference;
  state = next; updateChrome(); rerender(preserveInput ? 'background' : 'data');
  return state;
}
async function connect(key, walletId) {
  const previousWallet = wallet, previousKey = wallet.net.key;
  let connected = false;
  try {
    wallet = key === config.solana.key ? solWallet : evmWallet;
    wallet.select(key);
    await wallet.connect(walletId); connected = true; mode = 'testnet';
    try { localStorage.setItem('elpida:network', key); } catch {}
    state = { wallet: wallet.address, balance: '0', tokens: [], activity: [] };
    await refresh();
    return true;
  } catch (error) {
    if (!connected) { wallet = previousWallet; try { if (wallet.net.key !== previousKey) wallet.select(previousKey); } catch {} }
    throw error;
  } finally { updateChrome(); }
}
async function useLocal() {
  mode = 'local'; state = null;
  try { localStorage.setItem('elpida:network', 'local'); } catch {}
  await refresh(); return true;
}
/**
 * One button per installed wallet of the network's kind, so the person picks which extension opens
 * (several extensions compete for window.ethereum; the wrong one never shows a prompt for some chains).
 */
function walletButtons(net, { onDone = () => {}, onError = () => {} } = {}) {
  const solana = net.kind === 'solana';
  const list = solana ? solanaWallets() : evmWallets();
  const chosen = solana ? chosenSolanaWallet() : chosenEvmWallet();
  if (!list.length) return h('p.small.muted', solana ? 'No Solana wallet found. Install Phantom, Solflare or Backpack, then reload this page.' : 'No Ethereum wallet found. Install MetaMask or another browser wallet, then reload this page.');
  const sorted = [...list].sort((a, b) => Number(b.id === chosen) - Number(a.id === chosen));
  return h('div.wallet-choices', sorted.map((w, i) => h(`button.btn.${i === 0 ? 'btn-primary' : 'btn-secondary'}`, { type: 'button', 'data-busy-disable': '', on: { click: async event => {
    const button = event.currentTarget, text = button.lastChild, label = text.textContent; button.disabled = true; text.textContent = `Waiting for ${w.name}…`;
    try { await connect(net.key, w.id); toast(`Connected to ${net.name} with ${w.name}.`, { kind: 'success' }); onDone(); }
    catch (e) { onError(e); }
    finally { button.disabled = false; text.textContent = label; }
  } } }, w.icon && /^data:image\//.test(w.icon) ? h('img.wallet-icon', { src: w.icon, alt: '', width: 18, height: 18 }) : icon('wallet', 'icon-sm'), h('span', list.length > 1 ? w.name : `Connect ${w.name}`))));
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
  const envButton = $('#env-button');
  envButton.dataset.env = mode; $('#env-label').textContent = envLabel();
  envButton.setAttribute('aria-label', `${envLabel()}. Open network and test funds.`);
  $('#account-label').textContent = mode === 'local' ? (config?.accounts?.[Number(account)]?.name ? `Demo ${config.accounts[Number(account)].name.toLowerCase()}` : 'Demo account') : wallet.address ? short(wallet.address) : 'Connect wallet';
  $('#account-button').setAttribute('aria-label', `${$('#account-label').textContent}. Open account and network settings.`);
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
  const hash = location.hash.replace(/^#/, '') || '/';
  const token = hash.match(/^\/token\/([A-Za-z0-9]{32,64})$/);
  if (token) return { name: 'token', address: token[1] };
  return { name: { '/': 'explore', '/portfolio': 'portfolio', '/rewards': 'rewards', '/launch': 'launch' }[hash] ?? 'explore' };
}
function route() {
  const next = parseRoute(); const changed = next.name !== currentRoute.name || next.address !== currentRoute.address;
  currentRoute = next;
  $$('[data-nav]').forEach(link => { if (link.dataset.nav === next.name) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
  document.title = `Elpida · ${{ explore: 'Explore tokens', portfolio: 'Portfolio', rewards: 'Rewards', launch: 'Create a token', token: 'Token' }[next.name]}`;
  rerender('route');
  if (changed) { window.scrollTo({ top: 0 }); if (next.name !== 'launch') $('#main').focus({ preventScroll: true }); }
}
let launchView = null;
function rerender(reason) {
  const view = $('#view'); view.setAttribute('aria-busy', state ? 'false' : 'true');
  if (!config) return;
  const r = currentRoute;
  if (r.name === 'launch') {
    // The launch flow owns its own state; a data refresh only updates balances and connection status.
    if (!launchView || reason === 'route' && !view.contains(launchView.root)) { launchView = renderLaunch(ctx); view.replaceChildren(launchView.root); }
    else launchView.update?.();
    return;
  }
  launchView = null;
  if (!state) { view.replaceChildren(loadingView()); return; }
  if (r.name === 'token') {
    const previous = reason === 'background' ? {
      side: view.querySelector('[role=tab][aria-selected=true]')?.dataset.side,
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
function loadingView() { return h('div', h('div.page-head', h('div', h('h1', 'Explore tokens'), h('p', 'Loading the launchpad…'))), h('div.token-grid', [1, 2, 3].map(() => h('div.skeleton', { 'aria-hidden': 'true' })))); }

/* ---------- Explore ---------- */
function stats() {
  const totals = {};
  for (const t of state.tokens) { const q = t.quoteSymbol ?? state.nativeSymbol ?? 'ETH'; totals[q] = (totals[q] ?? 0) + Number(t.reserve); }
  const solana = mode === 'testnet' && wallet === solWallet;
  const dex = mode === 'local' ? config.dex : wallet.dex;
  // Balances are in the network's native coin (pricing is native only).
  const balance = `${number(state.nativeBalance ?? state.balance, 4)} ${state.nativeSymbol ?? state.balanceSymbol ?? 'ETH'}`;
  return h('section.stats', { 'aria-label': 'Launchpad overview' },
    h('div', h('span', 'Tokens launched'), h('strong', String(state.tokens.length))),
    h('div', h('span', 'Trading reserves'), h('strong', Object.entries(totals).map(([q, v]) => `${number(v, 2)} ${q}`).join(' + ') || '0'), h('small', mode === 'local' ? 'Simulated assets held by curves and pools' : 'Test assets held by curves and pools')),
    h('div', h('span', mode === 'local' ? 'Your simulated balance' : 'Your balance'), h('strong', state.disconnected ? '—' : balance)),
    h('div', h('span', 'Trading fee'), h('strong', solana ? '1.25% → 0.30%' : dex ? '1.25% → 1%' : '1.25%'), h('small', solana ? 'Curve, then PumpSwap pool' : dex ? 'Curve, then Uniswap v3 pool' : 'Bonding curve')));
}
function tokenCard(token) {
  const life = lifecycle(token), pct = progressOf(token), p = pricing(token);
  return h('a.token-card', { href: `#/token/${token.address}`, 'aria-label': `${token.name}, ${token.symbol}. ${life.label}.` },
    h('div.token-card-head', avatar(token), h('div', h('h3', token.name), h('span.sym', `$${token.symbol}`))),
    h('div.chips', h(`span.chip${life.chip ? '.' + life.chip : ''}`, life.label), h('span.chip', `${token.quoteSymbol ?? state.nativeSymbol ?? 'ETH'} pair`)),
    h('p.desc', token.metadata?.description || 'No description yet.'),
    h('div.figures', h('div.figure', h('span', 'Price'), h('strong', fmtPrice(token))), h('div.figure', h('span', 'Circulating cap'), h('strong', fmtValue(p.marketCap, token))),h('div.figure',h('span','FDV'),h('strong',fmtValue(p.fdv,token)))),
    h('div.progress', h('div.progress-label', h('span', token.graduated ? 'Graduated' : 'Bonding curve'), h('strong', `${number(pct, 1)}%`)), bar(pct, token.complete || token.graduated)));
}
function filtered(list) {
  const q = ui.query.trim().toLowerCase();
  let items = list.filter(t => `${t.name} ${t.symbol}`.toLowerCase().includes(q));
  if(ui.stage==='curve')items=items.filter(t=>!t.graduated);
  if(ui.stage==='dex')items=items.filter(t=>t.graduated);
  if (ui.filter === 'held') items = items.filter(t => Number(t.balance) > 0);
  if (ui.filter === 'created') items = items.filter(t => t.creator?.toLowerCase() === state.wallet?.toLowerCase());
  const sorters = { newest: (a, b) => b.created - a.created, marketcap: (a, b) => pricing(b).marketCap*(usdRate(b)??0) - pricing(a).marketCap*(usdRate(a)??0), progress: (a, b) => progressOf(b) - progressOf(a), reserve: (a, b) => Number(b.reserve)*(usdRate(b)??0) - Number(a.reserve)*(usdRate(a)??0) };
  return items.sort(sorters[ui.sort] ?? sorters.newest);
}
function exploreView() {
  const grid = h('div.token-grid');
  const empty = h('div');
  const draw = () => {
    const items = filtered([...state.tokens]);
    grid.replaceChildren(...items.map(tokenCard));
    empty.replaceChildren(items.length ? '' : emptyState());
    count.textContent = `${items.length} ${items.length === 1 ? 'token' : 'tokens'}`;
  };
  const count = h('span.muted.small');
  const search = h('input.input', { type: 'search', placeholder: 'Search by name or symbol', 'aria-label': 'Search tokens', value: ui.query, on: { input: e => { ui.query = e.target.value; draw(); } } });
  const segmented = h('div.segmented', { role: 'group', 'aria-label': 'Show' }, [['all', 'All tokens'], ['created', 'Created by me'], ['held', 'Holding']].map(([key, label]) =>
    h('button', { type: 'button', 'aria-pressed': String(ui.filter === key), on: { click: e => { ui.filter = key; segmented.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === e.currentTarget))); draw(); } } }, label)));
  const sort = h('select.select', { 'aria-label': 'Sort tokens', on: { change: e => { ui.sort = e.target.value; draw(); } } },
    [['newest', 'Newest first'], ['marketcap', 'Highest market cap'], ['progress', 'Closest to graduation'], ['reserve', 'Largest trading reserve']].map(([v, l]) => h('option', { value: v, selected: ui.sort === v }, l)));
  const stages=h('div.stage-filters',{role:'group','aria-label':'Launch stage'},[['all','All stages'],['curve','Bonding curve'],['dex','Graduated']].map(([key,label])=>h('button.btn.btn-ghost.btn-sm',{type:'button','aria-pressed':String(ui.stage===key),on:{click:e=>{ui.stage=key;stages.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b===e.currentTarget)));draw();}}},label)));
  const view = h('div',
    h('section.intro', h('div', h('h1', 'Create a token. Build your community.'), h('p', 'Launch with a fixed supply and a virtual bonding curve. Choose how creator fees are allocated, and follow your token from its first trade to graduation.')),
      h('div.intro-actions', h('a.btn.btn-primary.btn-lg', { href: '#/launch' }, icon('plus'), 'Create token'), h('button.btn.btn-secondary.btn-lg', { type: 'button', on: { click: () => $('#how-dialog').showModal() } }, 'How it works'))),
    h('div', { class: 'section' }, envBanner()),
    h('div.price-ticker',{'aria-label':'Native asset USD reference prices'}, ['ETH','BNB','SOL'].map(symbol=>{const p=Object.values(config.prices??{}).find(p=>p.symbol===symbol&&!p.simulation&&p.status==='fresh');return h('span',{title:p?.updatedAt?'Updated '+new Date(p.updatedAt*1000).toLocaleString():''},h('strong',symbol),p?.status==='fresh'?'$'+number(p.usd):'Price unavailable');})),
    stats(),
    h('section', { 'aria-labelledby': 'tokens-title' },
      h('div.page-head', h('div', h('h2#tokens-title', 'Tokens'), count), h('button.btn.btn-ghost.btn-sm', { type: 'button', on: { click: () => refresh().then(() => toast('Updated.')).catch(e => toast(errorText(e), { kind: 'error' })) } }, icon('refresh-cw', 'icon-sm'), 'Refresh')),
      h('div.toolbar', h('label.search', icon('search'), search), segmented, sort),stages, grid, empty),
    activitySection());
  draw();
  return view;
}
function emptyState() {
  const text = state.disconnected ? `Connect your wallet to see tokens on ${wallet.net.name}.` : state.undeployed ? 'Elpida is not set up on this network yet. Create a token to start the one-time setup.' : ui.query ? 'No tokens match your search. Try another name or symbol.' : ui.filter === 'held' ? 'You do not hold any tokens yet.' : ui.filter === 'created' ? 'You have not created a token on this network yet.' : 'No tokens yet. Be the first to create one.';
  return h('div.empty', h('img', { src: '/assets/brand/elpida-mark.svg', alt: '' }), h('h3', state.disconnected ? 'Wallet not connected' : 'Nothing here yet'), h('p', text),
    state.disconnected ? h('button.btn.btn-primary', { type: 'button', on: { click: () => connectCurrent() } }, icon('wallet'), 'Connect wallet') : h('a.btn.btn-primary', { href: '#/launch' }, icon('plus'), 'Create token'));
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
      h('div.token-card-head', avatar(t), h('div', h('h3', t.name), h('span.sym.muted.small', `$${t.symbol}`))),
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
async function connectCurrent() {
  const list = wallet.net.kind === 'solana' ? solanaWallets() : evmWallets();
  if (list.length > 1 && !(wallet.net.kind === 'solana' ? chosenSolanaWallet() : chosenEvmWallet())) return openTools();
  try { await connect(wallet.net.key); toast(`Connected to ${wallet.net.name}.`, { kind: 'success' }); } catch (error) { toast(errorText(error), { kind: 'error' }); }
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
        h('p.small.muted', deployed ? `${wallet.deployment.shared ? 'Shared team' : 'Your'} launchpad: ${short(wallet.deployment.factory)}.${wallet.needsMetadataUpgrade ? ' A newer version with shared token metadata is available.' : ''}` : 'Each public testnet needs a one-time launchpad setup from your wallet before the first token.'),
        (!deployed || wallet.needsMetadataUpgrade) && wallet.address ? h('button.btn.btn-secondary', { type: 'button', 'data-busy-disable': '', on: { click: async () => { error.textContent = ''; try { await run('deploy', {}); openTools(); } catch (e) { fail(e); } } } }, deployed ? 'Set up the newer launchpad' : 'Set up launchpad') : null,
        deployed ? h('div.stack', h('p.small.muted', state?.pricing?.verified ? '$10 launch fee, converted by the on-chain price feed at execution. Starting FDV: $5,000 before the first purchase.' : 'USD pricing must be activated before launching.'), !state?.pricing?.verified ? h('button.btn.btn-secondary',{type:'button',on:{click:()=>act('apply-pricing',{}).then(()=>openTools())}},'Activate price feed') : null) : null,
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
  config = await api('config');
  setInterval(()=>{if(!busy&&document.visibilityState==='visible'&&!(currentRoute.name==='rewards'&&document.activeElement?.closest('form')))refresh({preserveInput:true}).catch(()=>{});},60000);
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
  if (location.pathname === '/launch') history.replaceState({}, '', '/#/launch');
  $$('dialog').forEach(d => { closeOnBackdrop(d); d.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => d.close())); });
  $('#env-button').addEventListener('click', openTools);
  $('#account-button').addEventListener('click', () => (mode === 'testnet' && !wallet.address ? connectCurrent() : openTools()));
  $('#how-button').addEventListener('click', () => $('#how-dialog').showModal());
  window.addEventListener('hashchange', route);
  updateChrome(); route();
  // Return to the testnet used last time, but only silently: wallets that already trust Elpida reconnect
  // without a prompt. Anything else shows the local simulation first, so the page never waits on a popup.
  const previous = saved && saved !== 'local' ? networkByKey(saved) : null;
  if (previous) {
    let trusted = false;
    try {
      // Give EIP-6963 wallets a moment to announce themselves before asking the chosen one.
      await new Promise(resolve => setTimeout(resolve, 150));
      if (previous.kind === 'solana') { const provider = solWallet.provider; trusted = !!provider && (provider.isConnected && !!provider.publicKey || !!(await Promise.race([provider.connect({ onlyIfTrusted: true }), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 2500))]))); }
      else trusted = ((await Promise.race([evmWallet.eth?.request({ method: 'eth_accounts' }), new Promise(resolve => setTimeout(() => resolve([]), 2500))])) ?? []).length > 0;
    } catch {}
    if (trusted) { try { await connect(previous.key); } catch { trusted = false; } }
    if (!trusted) { wallet = previous.kind === 'solana' ? solWallet : evmWallet; mode='testnet';state=null;toast(`Browsing ${previous.name}. Connect your wallet to trade.`, { kind: 'info' }); }
  }
  try { if (!state) await refresh(); }
  catch (error) { $('#view').replaceChildren(h('div.page-head', h('div', h('h1', 'Elpida'))), callout('error', 'circle-alert', h('strong', 'The launchpad could not load. '), errorText(error), ' ', h('button.link-button', { type: 'button', on: { click: () => location.reload() } }, 'Try again'))); }
}
init().catch(error => { $('#view').replaceChildren(callout('error', 'circle-alert', h('strong', 'Elpida could not start. '), errorText(error))); });

export { ctx };
