// Guided token creation: details → network and trading pair → creator rewards → first purchase →
// review. The draft survives step changes, failed requests and page reloads (session storage).
import { h, icon, short, number, compact, avatar, metadataLinks, callout, field, setError, errorText, storage, safeImage, toast } from './ui.mjs';
import { normalizeMetadata, MAX_IMAGE_BYTES, IMAGE_TYPES, IMAGE_FORMATS } from './metadata.mjs';
import { normalizeRewardPolicy } from './reward-policy.mjs';
import { launchProfile } from './launch-capabilities.mjs';
import { STRATEGIES } from './rewards-view.mjs';

const DRAFT_KEY = 'elpida:launch-draft';
const STEPS = [
  { key: 'details', title: 'Token details', lead: 'How your token appears everywhere on Elpida. Name and symbol cannot be changed after launch.' },
  { key: 'network', title: 'Network and trading pair', lead: 'Choose where your token launches and which asset buyers pay with.' },
  { key: 'rewards', title: 'Creator rewards', lead: 'Decide where the creator share of trading fees goes. Your choice is fixed at launch.' },
  { key: 'purchase', title: 'First purchase', lead: 'Your token launches with your first purchase on its bonding curve, in the same transaction.' },
  { key: 'review', title: 'Review and create', lead: 'Check everything before you create your token. Items marked as fixed cannot be changed later.' },
];
const STRATEGY_TEXT = {
  creator: 'Creator fees accumulate for one or more wallets you choose. Each wallet can claim its share.',
  holders: 'When the distribution threshold is reached, fees are paid to eligible holders in the trading asset, weighted by their holdings at a snapshot.',
  paired: 'At the threshold, creator fees buy a reward asset you choose and distribute it to eligible holders of your token.',
  buyback: 'At the threshold, creator fees buy back your token and vest it to eligible holders over a period you set.',
  exclusive: 'Fees are allocated by percentage to wallets, X accounts or websites. X and website shares stay in the treasury until ownership is verified.',
};
const blankDraft = () => ({ name: '', symbol: '', description: '', image: '', imageUrl: '', website: '', twitter: '', telegram: '', discord: '', chain: '', pair: 'usdc', quoteToken: '', rewardMode: 'creator', recipients: [{ kind: 'wallet', target: '', percent: '100' }], threshold: '1', minimumHolding: '1000', vestingDays: '30', rewardToken: '', firstBuy: '25' });

export function renderLaunch(ctx) {
  const draft = { ...blankDraft(), ...(storage.get(DRAFT_KEY) ?? {}) };
  if (!draft.chain) draft.chain = ctx.currentChain();
  let step = 0, maxStep = 0, rewardData = null, phase = 'edit', result = null, statusState = null, networkError = '';
  // Large base64 logos exceed browser session-storage quotas. Keep the other draft fields;
  // the image remains in memory throughout the flow and must be reselected after a reload.
  const save = () => storage.set(DRAFT_KEY, {...draft,image:draft.image.startsWith('data:') && draft.image.length > 349528 ? '' : draft.image});
  const stepper = h('ol.stepper', { 'aria-label': 'Create token steps' });
  const panel = h('section.step-panel', { 'aria-live': 'polite' });
  const preview = h('aside.preview', { 'aria-label': 'Live preview' });
  const root = h('div', h('a.back-link', { href: '#/' }, icon('arrow-left', 'icon-sm'), 'Back to tokens'), h('div.launch', stepper, panel, preview));

  const profile = () => launchProfile(draft.chain === 'local' ? 'local' : draft.chain || 'local');
  const net = () => draft.chain && draft.chain !== 'local' ? ctx.networkByKey(draft.chain) : null;
  const isPublic = () => draft.chain && draft.chain !== 'local';
  const solana = () => draft.chain?.startsWith('solana');
  const connected = () => !!draft.chain && ctx.currentChain() === draft.chain && (draft.chain === 'local' || !!ctx.wallet.address);
  const ready = () => connected() && (draft.chain === 'local' || !!ctx.wallet.deployment);
  const nativeSymbol = () => draft.chain === 'local' ? 'ETH' : net()?.nativeCurrency.symbol ?? 'ETH';
  const usdcLabel = () => solana() ? (connected() && ctx.wallet.usesTestToken ? 'Elpida tUSDC' : 'USDC') : (net() && !net().quote?.address ? 'Elpida test USDC' : 'USDC');
  const quoteAsset = () => rewardData?.assets.find(a => a.address.toLowerCase() === draft.quoteToken.toLowerCase());
  const pairSymbol = () => draft.pair === 'native' ? nativeSymbol() : draft.pair === 'token' ? (quoteAsset()?.symbol ?? 'paired token') : usdcLabel();
  const feeSymbol = () => solana() && connected() && ctx.wallet.usesTestToken ? 'tUSDC' : 'test USDC';
  const dexName = () => !draft.chain ? 'DEX' : solana() ? 'PumpSwap' : draft.chain === 'local' ? (ctx.config.dex ? 'Uniswap v3' : 'test') : draft.chain === 'base-sepolia' ? 'Uniswap v3' : 'test';

  async function loadRewards() {
    if (rewardData || ctx.mode !== 'local') return;
    try { rewardData = await ctx.api('rewards'); if (!draft.rewardToken && rewardData.assets[0]) draft.rewardToken = rewardData.assets[0].address; if (!draft.quoteToken) draft.quoteToken = rewardData.assets.find(a => a.pairEligible)?.address ?? ''; draw(); } catch {}
  }

  /* ---------- Stepper and preview ---------- */
  function drawStepper() {
    stepper.replaceChildren(...STEPS.map((s, i) => h('li', h('button', { type: 'button', 'aria-label': `Step ${i + 1}: ${s.title}`, disabled: i > maxStep || phase !== 'edit', 'aria-current': i === step ? 'step' : undefined, 'data-done': String(i < step || i < maxStep && i !== step), on: { click: () => go(i) } },
      h('span.n', i < maxStep && i !== step ? icon('check', 'icon-sm') : String(i + 1)), h('span', s.title)))));
  }
  function drawPreview() {
    let links = h('div'); try { links = metadataLinks(draft); } catch {}
    const strategy = STRATEGIES[draft.rewardMode]?.name ?? 'Creator wallets';
    const est = estimate();
    preview.replaceChildren(
      h('div.preview-card', h('span.small.muted', 'Preview'),
        h('div.token-card-head', avatar({ symbol: draft.symbol || 'NEW', metadata: { image: draft.image } }), h('div', h('h3', draft.name || 'Your token name'), h('span.sym.muted.small', `$${(draft.symbol || 'SYMBOL').toUpperCase()}`))),
        h('p.desc', draft.description || 'Your description appears here.'), links,
        h('div.chips', { class: 'links' }, h('span.chip', draft.chain ? (draft.chain === 'local' ? 'Local simulation' : net()?.name ?? draft.chain) : 'Network not chosen'), h('span.chip', `Pair: ${pairSymbol()}`))),
      h('div.summary-card', h('h4', 'Launch summary'), h('dl.kv',
        h('dt', 'Creation fee'), h('dd', `10 ${feeSymbol()}`),
        h('dt', 'First purchase'), h('dd', `${number(draft.firstBuy, 6)} ${pairSymbol()}`),
        h('dt', 'Estimated tokens'), h('dd', est ? `${compact(est.tokens)}` : '—'),
        h('dt', 'Creator rewards'), h('dd', strategy),
        h('dt.total', 'You pay'), h('dd.total', draft.pair === 'usdc' && pairSymbol() !== 'paired token' ? `${number(Number(draft.firstBuy || 0) + 10, 6)} ${feeSymbol()}` : `10 ${feeSymbol()} + ${number(draft.firstBuy, 6)} ${pairSymbol()}`)),
        h('p.hint', { text: `Plus the network fee. Fixed supply of 1,000,000,000 ${draft.symbol ? draft.symbol.toUpperCase() : 'tokens'}.` })));
  }
  function estimate() {
    const buy = Number(draft.firstBuy);
    if (!(buy > 0) || draft.pair !== 'usdc') return null;
    // Same virtual-reserve curve the contracts use: tokens = Vt × net / (Vq + net), net of the 1.25% fee.
    let vq = 5333.333333, vt = 1066666666.6667, cap = 800000000;
    if (solana()) { vq = 5555.555556; vt = 1111111111.1111; cap = 759746926.65; }
    else { const t = ctx.state?.tokens.find(x => x.pair === 'usdc' && x.virtualQuote); if (t) { vq = Number(t.virtualQuote) / 1e6; vt = Number(t.virtualToken) / 1e18; cap = Number(t.saleCap ?? cap); } }
    const net = buy * (1 - 0.0125), tokens = vt * net / (vq + net);
    return { tokens: Math.min(tokens, cap), completes: tokens >= cap, share: Math.min(tokens, cap) / 1e9 * 100 };
  }

  /* ---------- Steps ---------- */
  function input(key, { multiline, onInput, ...attrs } = {}) {
    return h(multiline ? 'textarea.textarea' : 'input.input', { ...attrs, value: draft[key] ?? '', on: { input: e => { onInput?.(e); draft[key] = e.target.value; setError(e.target, ''); save(); drawPreview(); } } });
  }
  function detailsStep() {
    const name = input('name', { maxLength: profile().maxNameBytes, placeholder: 'e.g. Morning Garden', autocomplete: 'off', required: true });
    const symbol = input('symbol', { maxLength: 10, placeholder: 'e.g. GARDEN', autocomplete: 'off', required: true, autocapitalize: 'characters', onInput: e => { e.target.value = e.target.value.toUpperCase(); } });
    const counter = h('span.hint');
    const description = input('description', { multiline: true, maxLength: 1000, rows: 4, placeholder: 'What is your token about, and who is it for?', onInput: e => { counter.textContent = `${e.target.value.length} / 1,000`; } });
    counter.textContent = `${draft.description.length} / 1,000`;
    const file = h('input#logo-file', { type: 'file', accept: IMAGE_TYPES.join(','), 'aria-describedby': 'logo-hint logo-error' });
    const url = input('imageUrl', { type: 'url', placeholder: 'https://example.com/logo.png', onInput: e => { draft.image = e.target.value.trim(); save(); logoPreview(); drawPreview(); } });
    const logoBox = h('div');
    const logoError = h('p.error-text#logo-error', { role: 'alert' });
    const logoPreview = () => logoBox.replaceChildren(avatar({ symbol: draft.symbol || 'NEW', metadata: { image: draft.image } }));
    logoPreview();
    file.addEventListener('change', async () => {
      logoError.textContent = ''; const f = file.files[0]; if (!f) return;
      try {
        if (!IMAGE_TYPES.includes(f.type)) throw new Error(`Use a ${IMAGE_FORMATS} image.`);
        if (f.size > MAX_IMAGE_BYTES) throw new Error(`This image is ${(f.size / 1024 / 1024).toFixed(2)} MB. Use one up to 5 MB.`);
        const data = await new Promise((done, fail) => { const r = new FileReader(); r.onload = () => done(r.result); r.onerror = () => fail(new Error('The image could not be read.')); r.readAsDataURL(f); });
        normalizeMetadata({ image: data });
        draft.image = data; draft.imageUrl = ''; url.value = ''; save(); logoPreview(); drawPreview();
      } catch (e) { file.value = ''; logoError.textContent = errorText(e); }
    });
    const remove = h('button.link-button', { type: 'button', on: { click: () => { draft.image = ''; draft.imageUrl = ''; url.value = ''; file.value = ''; save(); logoPreview(); drawPreview(); } } }, 'Remove logo');
    return { body: [
      h('div.row-2', field({ label: 'Token name', control: name, hint: `Up to ${profile().maxNameBytes} characters.` }), field({ label: 'Symbol', control: symbol, hint: '1–10 letters or numbers, shown in capitals.' })),
      h('div.field', h('label', { for: description.id = 'f-description' }, 'Description', counter), description, h('p.error-text#f-description-error', { role: 'alert' })),
      h('div.field', h('span.field-label', 'Logo'), h('div.logo-drop', logoBox, h('div.stack', h('label.field-label', { for: 'logo-file' }, 'Upload an image'), file, h('p.hint#logo-hint', `Square ${IMAGE_FORMATS}, up to 5 MB on every network. Keep logos simple. Reselect large uploads if you reload the page.`), draft.image ? remove : null)), logoError),
      field({ label: 'Or use a hosted logo URL', optional: true, control: url, hint: 'A public HTTPS image address. Uploading is more reliable.' }),
      h('fieldset', { class: 'stack' }, h('legend.field-label', 'Community links ', h('span.opt', 'Optional')),
        h('div.row-2', field({ label: 'Website', control: input('website', { type: 'url', placeholder: 'https://yourproject.com' }) }), field({ label: 'X', control: input('twitter', { type: 'url', placeholder: 'https://x.com/yourproject' }) })),
        h('div.row-2', field({ label: 'Telegram', control: input('telegram', { type: 'url', placeholder: 'https://t.me/yourproject' }) }), field({ label: 'Discord', control: input('discord', { type: 'url', placeholder: 'https://discord.gg/invite' }) }))),
    ], validate: () => {
      let ok = true;
      const fail = (control, message) => { setError(control, message); if (ok) control.focus(); ok = false; };
      if (!draft.name.trim()) fail(name, 'Enter a token name.');
      else if (new TextEncoder().encode(draft.name.trim()).length > profile().maxNameBytes) fail(name, `Use at most ${profile().maxNameBytes} characters.`);
      if (!/^[A-Za-z0-9]{1,10}$/.test(draft.symbol.trim())) fail(symbol, 'Use 1–10 letters or numbers, with no spaces.');
      if (!draft.description.trim()) fail(description, 'Add a short description so people know what this token is for.');
      if (!draft.image) { logoError.textContent = 'Add a logo: upload an image or paste a hosted image URL.'; if (ok) file.focus(); ok = false; }
      try { normalizeMetadata(draft); } catch (e) { logoError.textContent = errorText(e); ok = false; }
      return ok;
    } };
  }

  function networkStep() {
    const error = h('p.error-text', { role: 'alert' }, networkError);
    const options = [{ key: 'local', name: 'Local simulation', note: 'Private test chain with simulated funds. Supports every reward strategy and trading pair.', env: 'sim', wallet: 'Demo accounts' },
      ...ctx.networks().map(n => ({ key: n.key, name: n.name, note: n.kind === 'solana' ? 'Public testnet. USDC pair; graduates into a locked PumpSwap pool.' : n.key === 'base-sepolia' ? 'Public testnet. Graduates into a locked Uniswap v3 pool.' : 'Public testnet. Graduates into a locked test pool.', env: 'testnet', wallet: n.kind === 'solana' ? 'Phantom, Solflare or Backpack' : 'Browser wallet such as MetaMask' }))];
    const choose = async key => {
      draft.chain = key; networkError = ''; error.textContent = '';
      const p = launchProfile(key);
      if (!p.pairs.includes(draft.pair) && !(key === 'local' && draft.pair === 'token')) draft.pair = 'usdc';
      if (key !== 'local' && draft.pair === 'token') draft.pair = 'usdc';
      if (key !== 'local') { draft.rewardMode = 'creator'; draft.recipients = [{ kind: 'wallet', target: '', percent: '100' }]; }
      save();
      if (key === 'local' && ctx.mode !== 'local') { try { await ctx.useLocal(); } catch (e) { networkError = errorText(e); } }
      draw();
    };
    const netGrid = h('div.choice-grid', { role: 'radiogroup', 'aria-label': 'Network' }, options.map(o => h('label.choice', h('input', { type: 'radio', name: 'network', value: o.key, checked: draft.chain === o.key, on: { change: () => choose(o.key) } }),
      h('span.choice-title', o.name), h('p', o.note), h(`span.chip.chip-${o.env}`, o.env === 'sim' ? 'Simulated funds' : 'Public testnet'))));
    const connection = h('div.connection');
    if (!draft.chain) connection.append(h('p.muted', 'Choose a network to continue. You are asked to connect a wallet only after choosing a public testnet.'));
    else if (draft.chain === 'local') connection.append(h('div.connection-row', icon('flask-conical'), h('div.grow', h('strong', 'Local simulation ready'), h('p.small.muted', `Using the demo ${ctx.config.accounts[Number(ctx.account)].name.toLowerCase()} account with simulated test USDC.`))));
    else {
      const n = net();
      if (!connected()) connection.append(h('div.connection-row', icon('wallet'), h('div.grow', h('strong', `Connect your wallet to ${n.name}`), h('p.small.muted', `${n.kind === 'solana' ? 'Phantom, Solflare or Backpack' : 'Your browser wallet'} will ask you to approve the connection${n.kind === 'solana' ? '' : ' and switch networks if needed'}.`)),
        h('button.btn.btn-primary', { type: 'button', 'data-busy-disable': '', on: { click: async () => { networkError = ''; error.textContent = ''; try { await ctx.connect(draft.chain); toast(`Connected to ${n.name}.`, { kind: 'success' }); } catch (e) { networkError = `${errorText(e)} Check that your wallet is unlocked and set to ${n.name}, then try again.`; } draw(); } } }, 'Connect wallet')));
      else {
        connection.append(h('div.connection-row', icon('circle-check'), h('div.grow', h('strong', `Connected to ${n.name}`), h('p.small.muted', ctx.wallet.address)), h('button.btn.btn-ghost.btn-sm', { type: 'button', on: { click: async () => { networkError = ''; try { await ctx.connect(draft.chain); } catch (e) { networkError = errorText(e); } draw(); } } }, 'Reconnect')));
        if (!ctx.wallet.deployment) connection.append(n.kind === 'solana'
          ? callout('warn', 'triangle-alert', 'The Elpida program is not deployed on this network. Run npm.cmd run solana:deploy in the elpida-v1 folder, then restart npm run dev.')
          : h('div.connection-row', callout('warn', 'triangle-alert', `${n.name} needs a one-time launchpad setup from your wallet before the first token. It takes ${ctx.wallet.usesTestToken ? 'two confirmations and deploys Elpida test USDC' : 'one confirmation'} and costs only gas.`),
            h('button.btn.btn-secondary', { type: 'button', 'data-busy-disable': '', on: { click: async () => { networkError = ''; error.textContent = ''; try { await ctx.run('deploy', {}); } catch (e) { networkError = errorText(e); } draw(); } } }, 'Set up launchpad')));
      }
    }
    const p = profile(), local = draft.chain === 'local';
    const pairs = [
      { key: 'native', title: `${nativeSymbol()}`, glyph: 'coins', note: `Buyers pay in ${nativeSymbol()}, the network’s native asset.`, disabled: !draft.chain || !p.pairs.includes('native') ? (solana() ? 'Solana launches use a USDC pair.' : 'Choose a network first.') : null },
      { key: 'usdc', title: usdcLabel(), glyph: 'coins', note: solana() && ctx.wallet.usesTestToken && connected() ? 'Buyers pay in Elpida tUSDC, a free test token, so curves can complete on devnet.' : 'Buyers pay in USDC. Prices are shown in dollars.', disabled: !draft.chain ? 'Choose a network first.' : null },
      { key: 'token', title: 'Approved token', glyph: 'layers', note: 'Pair with an approved same-network asset, such as a graduated Elpida token or the simulated stock.', disabled: !local ? 'Available in the local simulation only.' : null },
    ];
    const pairGrid = h('div.choice-grid', { role: 'radiogroup', 'aria-label': 'Trading pair' }, pairs.map(o => h('label.choice', h('input', { type: 'radio', name: 'pair', value: o.key, checked: draft.pair === o.key, disabled: !!o.disabled, on: { change: () => { draft.pair = o.key; draft.firstBuy = o.key === 'native' || o.key === 'token' && quoteAsset()?.kind === 'simulation' ? '0.01' : '25'; save(); draw(); } } }),
      h('span.choice-title', icon(o.glyph), o.title), h('p', o.disabled ?? o.note))));
    const quoteSelect = draft.pair === 'token' && local ? h('div.reveal.stack', field({ label: 'Paired token', control: h('select.select', { on: { change: e => { draft.quoteToken = e.target.value; save(); draw(); } } }, (rewardData?.assets ?? []).filter(a => a.pairEligible).map(a => h('option', { value: a.address, selected: a.address === draft.quoteToken }, a.symbol))), hint: 'Approved same-network assets only. The creation fee stays 10 test USDC; the first purchase, trades and graduation use this token.' }),
      quoteAsset()?.kind === 'simulation' ? callout('warn', 'flask-conical', 'TEST-STOCK is a simulated asset for local testing. It is not an issued xStock and has no real-world backing. ', h('button.link-button', { type: 'button', on: { click: async () => { try { await ctx.run('reward-stock-faucet', {}); } catch (e) { error.textContent = errorText(e); } } } }, 'Get 1 TEST-STOCK for 120 test USDC')) : null) : null;
    return { body: [
      h('div.stack', h('h3', 'Network'), netGrid), connection,
      h('div.stack', h('h3', 'Trading pair'), h('p.small.muted', 'The trading pair is the asset buyers pay with. It builds the trading reserve and stays the same after graduation. The reward asset is chosen separately in the next step.'), pairGrid, quoteSelect),
      error,
    ], validate: () => {
      if (!draft.chain) { error.textContent = 'Choose a network.'; return false; }
      if (!connected()) { error.textContent = draft.chain === 'local' ? 'The local simulation is not running.' : 'Connect your wallet to continue.'; return false; }
      if (!ready()) { error.textContent = 'Complete the one-time setup for this network first.'; return false; }
      if (draft.pair === 'token' && !quoteAsset()) { error.textContent = 'Choose a paired token.'; return false; }
      return true;
    } };
  }

  function rewardsStep() {
    const error = h('p.error-text', { role: 'alert' });
    const local = draft.chain === 'local';
    const grid = h('div.choice-grid', { role: 'radiogroup', 'aria-label': 'Reward strategy' }, Object.entries(STRATEGIES).map(([key, s]) => h('label.choice', h('input', { type: 'radio', name: 'strategy', value: key, checked: draft.rewardMode === key, disabled: !local && key !== 'creator', on: { change: () => { draft.rewardMode = key; if (key === 'creator') draft.recipients = draft.recipients.map(r => ({ ...r, kind: 'wallet' })); save(); draw(); } } }),
      h('span.choice-title', icon(s.glyph), s.name), h('p', STRATEGY_TEXT[key]), !local && key !== 'creator' ? h('span.chip', 'Local simulation only') : null)));
    const settings = h('div.stack.reveal');
    const automated = ['holders', 'paired', 'buyback'].includes(draft.rewardMode);
    if (automated) {
      settings.append(h('div.row-2',
        field({ label: 'Distribution threshold', control: h('div.input-affix', input('threshold', { type: 'number', min: '0.000001', step: 'any' }), h('span.affix', pairSymbol())), hint: 'Creator fees collected before each distribution runs, in the trading asset.' }),
        field({ label: 'Minimum token holding', control: h('div.input-affix', input('minimumHolding', { type: 'number', min: '0', step: 'any' }), h('span.affix', (draft.symbol || 'tokens').toUpperCase())), hint: 'Wallets holding less are skipped. Pools, the curve and treasuries never qualify.' })));
      if (draft.rewardMode === 'paired') settings.append(field({ label: 'Reward asset', control: h('select.select', { on: { change: e => { draft.rewardToken = e.target.value; save(); drawPreview(); } } }, (rewardData?.assets ?? []).map(a => h('option', { value: a.address, selected: a.address === draft.rewardToken }, a.symbol))), hint: 'The asset holders receive. It can differ from the trading pair; if it is the same, fees are paid directly without a swap.' }));
      if (draft.rewardMode === 'buyback') settings.append(field({ label: 'Vesting duration', control: h('div.input-affix', input('vestingDays', { type: 'number', min: '1', max: '3650', step: '1' }), h('span.affix', 'days')), hint: 'Bought-back tokens unlock linearly over this period for the eligible holders at each snapshot.' }));
      settings.append(callout('', 'info', 'Holder payouts are weighted by each wallet’s eligible token balance at the recorded snapshot, not by total supply.'));
    } else settings.append(allocationEditor());
    settings.append(h('div.summary-card', h('h4', 'Fixed at launch'), h('ul.fixed-list', h('li', 'The reward strategy and its settings'), h('li', 'Recipients and their percentages'), h('li', 'The 50/50 split of trading fees between Elpida and the creator share'))));
    return { body: [
      local ? null : callout('', 'info', 'On public testnets, creator fees go to one creator wallet. Holder distributions, buybacks and X or website allocations are available in the local simulation until their contracts are deployed publicly.'),
      grid, settings, error,
    ], validate: () => {
      error.textContent = '';
      try { buildPolicy(); return true; } catch (e) { error.textContent = errorText(e); return false; }
    } };
  }
  function allocationEditor() {
    const exclusive = draft.rewardMode === 'exclusive';
    const local = draft.chain === 'local';
    const list = h('div.alloc');
    const total = h('div.alloc-total', { role: 'status' });
    const updateTotal = () => { const sum = draft.recipients.reduce((n, r) => n + Number(r.percent || 0), 0); total.dataset.ok = String(Math.abs(sum - 100) < 1e-9); total.replaceChildren(h('span', 'Total'), h('span', `${number(sum, 2)}% of 100%`)); };
    const drawRows = () => {
      list.replaceChildren(...draft.recipients.map((r, i) => {
        const kind = h('select.select', { 'aria-label': `Recipient ${i + 1} type`, disabled: !exclusive, on: { change: e => { r.kind = e.target.value; save(); drawRows(); } } }, [['wallet', 'Wallet'], ['x', 'X account'], ['domain', 'Website']].map(([v, l]) => h('option', { value: v, selected: r.kind === v }, l)));
        const target = h('input.input', { 'aria-label': `Recipient ${i + 1}`, value: r.target, placeholder: r.kind === 'x' ? '@account' : r.kind === 'domain' ? 'community.org' : i === 0 ? 'Empty = your connected wallet' : solana() ? 'Solana address' : '0x…', on: { input: e => { r.target = e.target.value; save(); } } });
        const pct = h('div.input-affix', h('input.input', { type: 'number', min: '0.01', max: '100', step: '0.01', value: r.percent, 'aria-label': `Recipient ${i + 1} percentage`, on: { input: e => { r.percent = e.target.value; save(); updateTotal(); } } }), h('span.affix', '%'));
        const remove = h('button.icon-button', { type: 'button', 'aria-label': `Remove recipient ${i + 1}`, disabled: draft.recipients.length === 1, on: { click: () => { draft.recipients.splice(i, 1); save(); drawRows(); } } }, icon('x'));
        return h('div.alloc-row', kind, target, pct, remove);
      }));
      updateTotal();
    };
    drawRows();
    return h('div.stack', h('h3', exclusive ? 'Allocations' : 'Creator wallets'),
      h('p.small.muted', exclusive ? 'Split the creator share between wallets, X accounts and websites. Percentages must total exactly 100%.' : 'Split the creator share between up to 12 wallets. Percentages must total exactly 100%.'),
      list, h('div', h('button.btn.btn-secondary.btn-sm', { type: 'button', disabled: !local && !exclusive, on: { click: () => { if (draft.recipients.length >= 12) return; draft.recipients.push({ kind: 'wallet', target: '', percent: '0' }); save(); drawRows(); } } }, icon('plus', 'icon-sm'), 'Add recipient'), !local ? h('span.hint', '  Public testnets support one creator wallet.') : null), total,
      exclusive ? callout('warn', 'shield-check', 'X and website shares stay in the treasury until the owner verifies the account or domain and chooses a payout wallet. Nobody else, including you, can claim them.') : null);
  }
  function buildPolicy() {
    const policy = normalizeRewardPolicy({ mode: draft.rewardMode, threshold: draft.threshold, minimumHolding: draft.minimumHolding, vestingDays: draft.vestingDays, rewardToken: draft.rewardToken, recipients: draft.recipients }, draft.chain || 'local');
    if (draft.chain !== 'local' && (policy.mode !== 'creator' || policy.recipients.length !== 1 || policy.recipients[0].kind !== 'wallet')) throw new Error('Public testnets support one creator wallet. Remove extra recipients or use the local simulation.');
    return policy;
  }

  function purchaseStep() {
    const est = estimate();
    const amount = input('firstBuy', { type: 'number', min: '0.000001', step: 'any', inputmode: 'decimal', onInput: e => { draft.firstBuy = e.target.value; drawEstimate(); } });
    const estBox = h('div');
    const balance = () => !connected() ? null : draft.pair === 'native' ? `${number(ctx.state?.nativeBalance ?? 0, 6)} ${nativeSymbol()}` : draft.pair === 'usdc' ? `${number(ctx.state?.balance ?? 0, 4)} ${ctx.state?.balanceSymbol ?? 'USDC'}` : null;
    const drawEstimate = () => {
      const e = estimate();
      estBox.replaceChildren(...[h('dl.kv', h('dt', 'Creation fee'), h('dd', `10 ${feeSymbol()}`), h('dt', 'First purchase'), h('dd', `${number(draft.firstBuy, 6)} ${pairSymbol()}`), h('dt', 'Trading fee included'), h('dd', `${number(Number(draft.firstBuy || 0) * 0.0125, 6)} ${pairSymbol()}`),
        h('dt', 'Estimated tokens'), h('dd', e ? `${compact(e.tokens)} (${number(e.share, 2)}% of supply)` : 'Shown after launch'), balance() ? [h('dt', 'Available balance'), h('dd', balance())] : null),
        e?.completes ? callout('warn', 'triangle-alert', 'This amount would buy the whole curve. Only the amount needed is charged, and the token is ready to graduate immediately.') : null,
        !e ? h('p.hint', draft.pair === 'native' ? `Native-pair estimates depend on the network’s ${nativeSymbol()} price template, so the exact amount appears on the token page after launch.` : 'The estimate appears once a paired-token price is available.') : null].filter(Boolean));
      drawPreview();
    };
    drawEstimate();
    return { body: [
      field({ label: 'Purchase amount', control: h('div.input-affix', amount, h('span.affix', pairSymbol())), hint: 'Required by the launch contract: any amount above zero. Smaller purchases leave more of the curve for your community.' }),
      estBox,
      callout('', 'info', `This is the first trade on the virtual bonding curve. The curve is not a funded pool: your purchase starts the trading reserve, which moves into a locked ${dexName()} pool when the curve sells out.${solana() ? ' Your first purchase pays the normal 1.25% fee; other buyers pay a higher launch-protection fee during the first minute.' : ''}`),
    ], validate: () => {
      const control = amount;
      if (!(Number(draft.firstBuy) > 0)) { setError(control, 'Enter an amount greater than zero.'); control.focus(); return false; }
      const decimals = draft.pair === 'usdc' ? 6 : 18;
      if (!(new RegExp(`^\\d+(\\.\\d{0,${decimals}})?$`)).test(draft.firstBuy)) { setError(control, `Use at most ${decimals} decimal places.`); return false; }
      return true;
    } };
  }

  function reviewStep() {
    const policy = (() => { try { return buildPolicy(); } catch { return null; } })();
    const edit = i => h('button.link-button', { type: 'button', on: { click: () => go(i) } }, icon('pencil', 'icon-sm'), 'Edit');
    const block = (title, i, ...rows) => h('section.review-block', h('header', h('h4', title), edit(i)), h('dl.kv', ...rows));
    const row = (k, v) => [h('dt', k), h('dd', v)];
    const recipients = policy?.recipients?.length ? policy.recipients.map(r => `${r.bps / 100}% · ${r.kind === 'x' ? '@' + r.target : r.kind === 'domain' ? r.target : r.target ? short(r.target) : 'your connected wallet'}`).join(', ') : '—';
    return { body: [
      h('div.review',
        block('Token', 0, row('Name', draft.name), row('Symbol', `$${draft.symbol.toUpperCase()}`), row('Description', draft.description), row('Logo', draft.image ? (draft.image.startsWith('data:') ? 'Uploaded image' : draft.image) : '—'), row('Links', ['website', 'twitter', 'telegram', 'discord'].filter(k => draft[k]).map(k => ({ website: 'Website', twitter: 'X', telegram: 'Telegram', discord: 'Discord' })[k]).join(', ') || 'None')),
        block('Network and trading pair', 1, row('Network', draft.chain === 'local' ? 'Local simulation' : net()?.name ?? '—'), row('Wallet', draft.chain === 'local' ? `Demo ${ctx.config.accounts[Number(ctx.account)].name.toLowerCase()}` : short(ctx.wallet.address)), row('Trading pair', pairSymbol()), row('Graduates into', `A locked ${dexName()} pool`)),
        block('Creator rewards', 2, row('Strategy', STRATEGIES[draft.rewardMode].name), ...(['holders', 'paired', 'buyback'].includes(draft.rewardMode) ? [row('Distribution threshold', `${draft.threshold} ${pairSymbol()}`), row('Minimum token holding', `${number(draft.minimumHolding, 0)} ${draft.symbol.toUpperCase()}`)] : [row('Recipients', recipients)]), draft.rewardMode === 'paired' ? row('Reward asset', rewardData?.assets.find(a => a.address === draft.rewardToken)?.symbol ?? '—') : null, draft.rewardMode === 'buyback' ? row('Vesting', `${draft.vestingDays} days`) : null),
        block('First purchase and costs', 3, row('Creation fee', `10 ${feeSymbol()}`), row('First purchase', `${number(draft.firstBuy, 6)} ${pairSymbol()}`), row('Estimated tokens', estimate() ? compact(estimate().tokens) : 'Shown after launch'), row('Network fee', 'Paid separately'))),
      h('section.summary-card', h('h4', 'Fixed after launch'), h('ul.fixed-list', h('li', 'Name, symbol and the 1,000,000,000 fixed supply'), h('li', `Trading pair (${pairSymbol()})`), h('li', 'Creator reward strategy, recipients and percentages'), h('li', `Graduation into a ${dexName()} pool with permanently locked liquidity`))),
      policy ? null : callout('error', 'circle-alert', 'The reward settings need attention before you can create this token.'),
    ], validate: () => !!policy };
  }

  /* ---------- Submission ---------- */
  const STATUS_STEPS = () => ctx.mode === 'local'
    ? [['submit', 'Create on the local simulation', 'Simulated funds, no wallet needed'], ['confirm', 'Confirmed', 'Your token is live']]
    : [...(!solana() ? [['approve', 'Approve the USDC payment if needed', draft.pair === 'native' ? 'Allows payment of the USDC creation fee; the first purchase uses the native asset' : 'Allows payment of the creation fee and first purchase']] : []), ['wallet', 'Confirm in your wallet', 'Creates the token and makes your first purchase'], ['submit', 'Submitted', 'Waiting for the network to confirm'], ['confirm', 'Confirmed', 'Your token is live']];
  function statusView() {
    const steps = STATUS_STEPS();
    const at = steps.findIndex(s => s[0] === statusState.step);
    return h('ol.status-list', { 'aria-label': 'Creation progress' }, steps.map(([key, title, note], i) => {
      const state = statusState.error && i === at ? 'error' : i < at || statusState.done ? 'done' : i === at ? 'active' : 'pending';
      return h('li', { 'data-state': state }, h('span.mark', state === 'done' ? icon('check', 'icon-sm') : state === 'error' ? icon('x', 'icon-sm') : state === 'active' ? icon('loader-circle', 'icon-sm spin') : ''), h('div', h('strong', title), h('small', note)));
    }));
  }
  async function create() {
    const policy = buildPolicy();
    const body = { ...normalizeMetadata(draft), name: draft.name.trim(), symbol: draft.symbol.trim().toUpperCase(), pair: draft.pair, firstBuy: String(draft.firstBuy), reward: ctx.state?.wallet ?? '' };
    if (draft.pair === 'token') body.quoteToken = draft.quoteToken;
    if (draft.chain === 'local') body.rewardPolicy = policy;
    else body.reward = policy.recipients[0].target || ctx.wallet.address;
    phase = 'submitting'; statusState = { step: ctx.mode === 'local' ? 'submit' : STATUS_STEPS()[0][0], error: null, done: false }; draw();
    const onProgress = message => {
      if (/approv/i.test(message)) statusState.step = 'approve';
      else if (/submitted|waiting/i.test(message)) statusState.step = 'submit';
      else if (/confirm|sign|publishing/i.test(message)) statusState.step = 'wallet';
      draw();
    };
    try {
      result = await ctx.run('launch', body, { quiet: true, onProgress });
      statusState = { step: 'confirm', done: true }; phase = 'done'; storage.remove(DRAFT_KEY); draw();
    } catch (error) {
      statusState.error = errorText(error); phase = 'failed'; draw();
    }
  }

  /* ---------- Rendering ---------- */
  const builders = [detailsStep, networkStep, rewardsStep, purchaseStep, reviewStep];
  let current = null;
  function go(i) {
    if (phase !== 'edit' && phase !== 'failed') return;
    if (i > step && !current?.validate()) return;
    phase = 'edit'; statusState = null;
    step = i; maxStep = Math.max(maxStep, i); draw();
    panel.querySelector('h2')?.focus();
  }
  function draw() {
    drawStepper(); drawPreview();
    if (phase === 'done') {
      const token = { symbol: draft.symbol, metadata: { image: draft.image } };
      panel.replaceChildren(h('div.success.panel', avatar(token, 'avatar-lg'), h('h2', { tabindex: '-1' }, `${draft.symbol.toUpperCase()} is live`),
        h('p', `${draft.name} is trading on its bonding curve${draft.chain === 'local' ? ' in the local simulation' : ` on ${net()?.name}`}. Share it with your community; creator fees follow the reward settings you chose.`),
        h('div.actions', result?.token ? h('a.btn.btn-primary', { href: `#/token/${result.token}` }, 'View token') : null, ctx.txLink(result?.hash) ? h('a.btn.btn-secondary', { href: ctx.txLink(result.hash).href, target: '_blank', rel: 'noopener noreferrer' }, 'View transaction', icon('external-link', 'icon-sm')) : null,
          h('button.btn.btn-ghost', { type: 'button', on: { click: () => { Object.assign(draft, blankDraft(), { chain: ctx.currentChain() }); step = 0; maxStep = 0; phase = 'edit'; result = null; draw(); } } }, 'Create another'))));
      panel.querySelector('h2').focus();
      return;
    }
    const s = STEPS[step];
    current = builders[step]();
    const nav = h('div.step-nav',
      step > 0 ? h('button.btn.btn-secondary', { type: 'button', disabled: phase === 'submitting', on: { click: () => go(step - 1) } }, icon('chevron-left', 'icon-sm'), 'Back') : h('a.btn.btn-ghost', { href: '#/' }, 'Cancel'),
      step < STEPS.length - 1 ? h('button.btn.btn-primary', { type: 'button', on: { click: () => go(step + 1) } }, 'Continue', icon('chevron-right', 'icon-sm'))
        : h('button.btn.btn-primary.btn-lg', { type: 'button', 'data-busy-disable': '', disabled: phase === 'submitting', on: { click: () => { if (current.validate()) create(); } } }, phase === 'failed' ? 'Try again' : 'Create token'));
    const status = statusState ? h('div.panel', { class: 'stack' }, h('h3', phase === 'failed' ? 'Your token was not created' : 'Creating your token'), statusView(),
      statusState.error ? callout('error', 'circle-alert', statusState.error, ' Your draft is saved, so you can adjust it and try again.') : null) : null;
    panel.replaceChildren(...[h('header', h('span.step-kicker', `Step ${step + 1} of ${STEPS.length}`), h('h2', { tabindex: '-1' }, s.title), h('p', s.lead)), h('div.step-body', current.body), status, nav].filter(Boolean));
  }
  draw();
  loadRewards();
  return { root, update: () => { if (phase === 'edit' && STEPS[step].key === 'network') draw(); else { drawStepper(); drawPreview(); } loadRewards(); } };
}
