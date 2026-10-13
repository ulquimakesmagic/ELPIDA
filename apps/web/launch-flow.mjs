import { assetIcon, chainIcon } from './chain-ui.mjs';
// Guided token creation: details → network and trading pair → creator rewards → first purchase →
// review. The draft survives step changes, failed requests and page reloads (session storage).
import { h, icon, short, number, compact, avatar, metadataLinks, callout, field, setError, errorText, storage, safeImage, toast } from './ui.mjs';
import { normalizeMetadata, MAX_IMAGE_BYTES, IMAGE_TYPES, IMAGE_FORMATS } from './metadata.mjs';
import { normalizeRewardPolicy } from './reward-policy.mjs';
import { launchProfile } from './launch-capabilities.mjs';
import { STRATEGIES } from './rewards-view.mjs';
import { usdcFunding } from './usdc-funding.mjs';
import { PAIR_KINDS, PAIR_INFO } from '/pairs.mjs';

const DRAFT_KEY = 'elpida:launch-draft';
const STEPS = [
  { key: 'details', title: 'Token details', lead: 'How your token appears everywhere on Elpida. Name and symbol cannot be changed after launch.' },
  { key: 'network', title: 'Trading pair', lead: 'Choose the asset buyers pay with. Change the chain using the selector at the top.' },
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
const blankDraft = () => ({ name: '', symbol: '', description: '', image: '', imageUrl: '', website: '', twitter: '', telegram: '', discord: '', chain: '', pair: 'native', quoteAsset: '', rewardMode: 'creator', recipients: [{ kind: 'wallet', target: '', percent: '100' }], threshold: '0.01', minimumHolding: '1000', vestingDays: '30', rewardToken: '', feeCurrency:'native', firstBuy: '0.01' });

export function renderLaunch(ctx) {
  const draft = { ...blankDraft(), ...(storage.get(DRAFT_KEY) ?? {}) };
  if (draft.quoteToken && !draft.quoteAsset) draft.quoteAsset = draft.quoteToken; // drafts saved before pair kinds
  if (!PAIR_KINDS.includes(draft.pair)) { draft.pair = 'native'; draft.quoteAsset = ''; draft.firstBuy = '0.01'; } // drafts from the USDC era
  delete draft.quoteToken;
  draft.chain = ctx.currentChain();
  let step = 0, maxStep = 0, rewardData = null, phase = 'edit', result = null, statusState = null, networkError = '', pricingRefresh=()=>{};
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
  const freshPrice = p => p?.status === 'fresh' && Number(p.usd) > 0 && Date.now()/1000-p.updatedAt <= (p.maxAge ?? 180);
  // Solana: the program verifies the bound Pyth SOL/USD account itself; launches need it active and fresh.
  const solanaPriced = () => !!ctx.wallet?.deployment?.usdPricing;
  const ready = () => solana() ? connected() && !!ctx.wallet.deployment && solanaPriced() && freshPrice(ctx.wallet.price) : (draft.chain==='local'||!!ctx.config.oracles?.[draft.chain]?.available) && connected() && (draft.chain === 'local' || (!!ctx.wallet.deployment&&freshPrice(ctx.wallet.price)));
  const nativeSymbol = () => draft.chain === 'local' ? 'ETH' : net()?.nativeCurrency.symbol ?? 'ETH';
  /** Same structure on every chain: { native, xstock, token } → { assets, unavailable }. Null until known. */
  const pairOptions = () => {
    if (!draft.chain) return null;
    if (draft.chain === 'local') return localPairs();
    if (!connected()) return null;
    try { return ctx.wallet.pairOptions?.() ?? null; } catch { return null; }
  };
  function localPairs() {
    // Simulation uses the same fee enforcement with an explicitly labelled mock oracle.
    const fee = { feeAmount: ctx.config.local?.launchFee ?? '0.004', feeSymbol: 'ETH' };
    const startFdv = Number(ctx.config.pricing?.local?.startFdv ?? 2);
    const nativeCurve = { vq: startFdv * 16 / 15, vt: 1066666666.6667, cap: 8e8, feeBps: 125 };
    const assets = rewardData?.assets ?? [];
    const loading = rewardData ? null : 'Loading the approved assets…';
    const paired = (list, empty) => !ctx.config.dex ? { assets: [], unavailable: 'Needs the local DEX environment, which graduates into Uniswap v3.' } : list.length ? { assets: list } : { assets: [], unavailable: loading ?? empty };
    return {
      native: { assets: [{ id: 'native', symbol: 'ETH', name: 'Local test ETH', decimals: 18, curve: nativeCurve, ...fee }] },
      usdc: ctx.config.dex ? { assets: [{ id:ctx.config.local.feeUsdc,symbol:'USDC',name:'Simulated USDC (test only)',decimals:6,curve:{vq:5000*16/15,vt:1066666666.6667,cap:8e8,feeBps:125},...fee }] } : { assets:[],unavailable:'USDC trading pairs need the local DEX environment.' },
      xstock: paired(assets.filter(a => a.kind === 'simulation').map(a => ({ id: a.address, symbol: 'TEST-STOCK', name: 'Simulated stock (test only, not an issued xStock)', decimals: 18, test: true, ...fee, faucet: { label: 'Get 1 TEST-STOCK for 0.04 local ETH', action: 'reward-stock-faucet', body: {} } })), 'The simulated stock is not available.'),
      token: paired(assets.filter(a => a.kind === 'elpida' && a.pairEligible).map(a => ({ id: a.address, symbol: a.symbol, name: `${a.symbol}, a graduated Elpida token`, decimals: 18, ...fee })), 'No graduated ETH-paired Elpida token yet. Graduate one first, and it can become a pair.'),
    };
  }
  const selectedAsset = () => { const group = pairOptions()?.[draft.pair]; return group?.assets.find(a => a.id === draft.quoteAsset) ?? group?.assets[0] ?? null; };
  const pairSymbol = () => selectedAsset()?.symbol ?? (draft.pair === 'native' ? nativeSymbol() : PAIR_INFO[draft.pair]?.title ?? nativeSymbol());
  // Native payment uses the execution-time oracle; USDC payment is independent of the pool asset.
  const feeAmount = () => draft.feeCurrency==='usdc'?10:selectedAsset()?.feeAmount!=null?Number(selectedAsset().feeAmount):freshPrice(launchPrice())?10/launchPrice().usd:null;
  const feeSymbol = () => draft.feeCurrency==='usdc'?'USDC':selectedAsset()?.feeSymbol ?? nativeSymbol();
  const launchPrice = () => draft.chain==='local'?ctx.config.local.price:connected()?ctx.wallet.price:ctx.config.prices?.[draft.chain];
  const priceNote = () => {const p=launchPrice();return freshPrice(p)?`1 ${nativeSymbol()} ≈ USD ${number(p.usd,2)} · ${p.source} · Updated ${new Date(p.updatedAt*1000).toLocaleTimeString()}`:'Price feed unavailable or stale. Refresh before launching.';};
  const usdcAvailable = () => draft.chain==='local'||(connected()&&!!ctx.wallet.feeUsdc&&!/^0x0{40}$/.test(ctx.wallet.feeUsdc));
  const assetDecimals = () => selectedAsset()?.decimals ?? 18;
  const dexName = () => !draft.chain ? 'DEX' : solana() ? 'PumpSwap' : draft.chain === 'local' ? (ctx.config.dex ? 'Uniswap v3' : 'test') : draft.chain === 'base-sepolia' ? 'Uniswap v3' : 'test';

  async function loadRewards() {
    if (rewardData || ctx.mode !== 'local') return;
    try { rewardData = await ctx.api('rewards'); if (!draft.rewardToken && rewardData.assets[0]) draft.rewardToken = rewardData.assets[0].address; draw(); } catch {}
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
        h('div.chips', { class: 'links' }, h('span.chip',chainIcon(draft.chain), draft.chain ? (draft.chain === 'local' ? 'Local simulation' : net()?.name ?? draft.chain) : 'Network not chosen'), h('span.chip',assetIcon(pairSymbol()), `Pair: ${pairSymbol()}`))),
      h('div.summary-card', h('h4', 'Launch summary'), h('dl.kv',
        h('dt', 'Launch fee · $10'), h('dd', feeAmount()===null?'Quote unavailable':`${number(feeAmount(), 6)} ${feeSymbol()}${connected()?'':' (estimate)'}`),
        h('dt', 'First purchase'), h('dd', `${number(draft.firstBuy, 6)} ${pairSymbol()}`),
        h('dt', 'Estimated tokens'), h('dd', est ? `${compact(est.tokens)}` : '—'),
        h('dt', 'Creator rewards'), h('dd', strategy),
        h('dt.total', connected()?'You pay':'Estimated total'), h('dd.total', youPay())),
        h('p.hint', { text: `Launch fee conversion is verified before signing. Plus the network fee. Fixed supply of 1,000,000,000 ${draft.symbol ? draft.symbol.toUpperCase() : 'tokens'}.` })));
  }
  function youPay() {
    if(feeAmount()===null)return 'Quote unavailable';
    const buy = Number(draft.firstBuy || 0);
    return feeSymbol() === pairSymbol() ? `${number(buy + feeAmount(), 6)} ${pairSymbol()}` : `${number(feeAmount(), 6)} ${feeSymbol()} + ${number(buy, 6)} ${pairSymbol()}`;
  }
  function estimate() {
    const buy = Number(draft.firstBuy), curve = selectedAsset()?.curve;
    if (!(buy > 0) || !curve) return null;
    // Same virtual-reserve curve the contracts use: tokens = Vt × net / (Vq + net), net of the base fee.
    const net = buy * (1 - (curve.feeBps ?? 125) / 10000), tokens = curve.vt * net / (curve.vq + net);
    return { tokens: Math.min(tokens, curve.cap),exceeds:tokens>curve.cap, completes: tokens >= curve.cap, share: Math.min(tokens, curve.cap) / 1e9 * 100 };
  }
  /** A first purchase of about 0.5% of the starting FDV, rounded to two significant figures. */
  function defaultBuy(kind, asset) {
    if (asset?.curve) { const v = asset.curve.vq * 1e9 / asset.curve.vt * 0.005; const p = 10 ** (Math.floor(Math.log10(v)) - 1); return String(Number((Math.round(v / p) * p).toPrecision(2))); }
    return { native: '0.01', usdc:'10', xstock: '1', token: '100' }[kind];
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
    const connection = h('div.connection');
    if (!draft.chain) connection.append(h('p.muted', 'Choose a network to continue. You are asked to connect a wallet only after choosing a public testnet.'));
    else if (draft.chain === 'local') connection.append(h('div.connection-row', icon('flask-conical'), h('div.grow', h('strong', 'Local simulation ready'), h('p.small.muted', `Using the demo ${ctx.config.accounts[Number(ctx.account)].name.toLowerCase()} account with simulated ETH.`))));
    else {
      const n = net();
      if(!solana()&&ctx.wallet.deployment&&connected()&&!ctx.wallet.price)connection.append(h('button.btn.btn-secondary',{type:'button',on:{click:async()=>{try{await ctx.run('apply-pricing',{});}catch(e){networkError=errorText(e);}draw();}}},'Activate price feed'));
      if (!connected()) connection.append(h('div.connection-row', icon('wallet'), h('div.grow', h('strong', `Connect your wallet to ${n.name}`), h('p.small.muted', `Choose the wallet to use. It asks you to approve the connection${n.kind === 'solana' ? '' : ' and to switch to ' + n.name + ' if needed'}.`)),
        ctx.walletButtons(n, { onDone: () => { networkError = ''; draw(); }, onError: e => { networkError = errorText(e); draw(); } })));
      else {
        connection.append(h('div.connection-row', icon('circle-check'), h('div.grow', h('strong', `Connected to ${n.name}${/^your/i.test(ctx.wallet.walletName ?? 'your') ? '' : ' with ' + ctx.wallet.walletName}`), h('p.small.muted', ctx.wallet.address)), h('button.btn.btn-ghost.btn-sm', { type: 'button', on: { click: async () => { networkError = ''; try { await ctx.connect(draft.chain); } catch (e) { networkError = errorText(e); } draw(); } } }, 'Reconnect')));
        if (ctx.wallet.beta?.enabled && !ctx.wallet.beta.allowed) connection.append(callout('warn', 'lock', 'Launching is invite-only during the mainnet beta, and this wallet is not on the list yet. You can still browse and trade; ask the Elpida team to add this wallet to launch.'));
        else if (n.mainnet) connection.append(callout('warn', 'triangle-alert', 'Mainnet beta: this launch uses real funds and new, unaudited contracts.'));
        if (!ctx.wallet.deployment) connection.append(n.kind === 'solana'
          ? callout('warn', 'triangle-alert', 'The Elpida program is not deployed on this network. Run npm.cmd run solana:deploy in the elpida-v1 folder, then restart npm run dev.')
          : h('div.connection-row', callout('warn', 'triangle-alert', `${n.name} needs a one-time launchpad setup from your wallet before the first token. ${ctx.wallet.dex ? 'This includes the native and USDC trading pairs, with wallet confirmations for deployment and registration.' : 'It takes two wallet confirmations.'} Setup costs only gas. Launches are then charged ${ctx.wallet.feeText?.() ?? ''} ${n.nativeCurrency.symbol} each, the on-chain equivalent of $10 (or 10 USDC).`),
            h('button.btn.btn-secondary', { type: 'button', 'data-busy-disable': '', on: { click: async () => { networkError = ''; error.textContent = ''; try { await ctx.run('deploy', {}); } catch (e) { networkError = errorText(e); } draw(); } } }, 'Set up launchpad')));
      }
    }
    const pairs = pairOptions();
    const pairGrid = h('div.choice-grid', { class: 'pair-grid', role: 'radiogroup', 'aria-label': 'Trading pair' }, PAIR_KINDS.map(kind => {
      const info = PAIR_INFO[kind], group = pairs?.[kind];
      const reason = !draft.chain ? 'Choose a network first.' : !pairs ? 'Connect your wallet to see the assets on this network.' : group?.unavailable ?? (group?.assets.length ? null : 'Not available on this network.');
      const symbols = group?.assets.map(a => a.symbol).join(', ');
      const ownerSetup=kind==='usdc'&&!!reason&&draft.chain!=='local'&&!solana()&&connected()&&ctx.state?.pricing?.owner&&ctx.wallet.dex&&ctx.wallet.feeUsdc;
      const finish=ownerSetup?h('button.btn.btn-secondary.btn-sm',{type:'button','data-busy-disable':'',on:{click:async e=>{e.preventDefault();networkError='';try{await ctx.run('setup-usdc-pair',{});const asset=ctx.wallet.pairOptions().usdc.assets[0];if(asset){draft.pair='usdc';draft.quoteAsset=asset.id;draft.firstBuy=defaultBuy('usdc',asset);save();}}catch(err){networkError=errorText(err);}draw();}}},'Finish USDC setup'):null;
      return h('div.choice', { 'data-unavailable': reason ? 'true' : undefined }, h('label',h('input', { type: 'radio', name: 'pair', value: kind, checked: draft.pair === kind, disabled: !!reason, on: { change: () => { draft.pair = kind; draft.quoteAsset = group.assets[0].id; draft.firstBuy = defaultBuy(kind, group.assets[0]); save(); draw(); } } }),
        h('span.choice-title', icon(info.glyph), info.title, symbols ? h('span.chip', symbols) : null), h('p', ownerSetup?'Finish this existing deployment’s one-time USDC setup. Your wallet confirms the adapter and registration; creators do not repeat this.':reason ?? info.note(kind === 'native' ? group.assets[0].symbol : ''))),finish);
    }));
    const asset = selectedAsset(), group = pairs?.[draft.pair];
    const balanceOf = a => ctx.state?.pairBalances?.[a.id] ?? (draft.pair === 'native' ? ctx.state?.nativeBalance : null);
    const fund = a => !a?.faucet ? null : a.faucet.href ? h('a.btn.btn-secondary.btn-sm', { href: a.faucet.href, target: '_blank', rel: 'noopener noreferrer' }, icon('droplet', 'icon-sm'), a.faucet.label, icon('external-link', 'icon-sm'))
      : h('button.btn.btn-secondary.btn-sm', { type: 'button', 'data-busy-disable': '', on: { click: async () => { error.textContent = ''; try { await ctx.run(a.faucet.action, a.faucet.body); draw(); } catch (e) { error.textContent = errorText(e); } } } }, icon('droplet', 'icon-sm'), a.faucet.label);
    const assetBox = asset && group?.assets.length ? h('div.reveal.stack',
      group.assets.length > 1 ? field({ label: `${PAIR_INFO[draft.pair].title} asset`, control: h('select.select', { on: { change: e => { draft.quoteAsset = e.target.value; draft.firstBuy = defaultBuy(draft.pair, selectedAsset()); save(); draw(); } } }, group.assets.map(a => h('option', { value: a.id, selected: a.id === asset.id }, `${a.symbol} · ${a.name}`))) }) : null,
      h('div.connection-row', assetIcon(asset.symbol), h('div.grow', h('strong', asset.symbol), h('p.small.muted', [asset.name, balanceOf(asset) != null ? `Balance: ${number(balanceOf(asset), 4)} ${asset.symbol}` : null, `Creation fee: ${number(Number(asset.feeAmount ?? 0), 6)} ${asset.feeSymbol ?? nativeSymbol()}`].filter(Boolean).join(' · '))), fund(asset)),
      asset.test && draft.pair === 'xstock' ? callout('warn', 'flask-conical', `${asset.symbol} is a simulated stock for testing. It is not an issued xStock and has no real-world backing.`) : null,
      asset.wsol ? callout('', 'info', 'You pay and receive plain SOL. Elpida wraps it for each trade and unwraps what is left in the same transaction.') : null) : null;
    return { body: [
      h('p.chain-context',chainIcon(draft.chain),`Launching on ${net()?.name??'Simulation'}. Change the chain in the header.`), connection,
      h('div.stack', h('h3', 'Trading pair'), h('p.small.muted', 'Choose native currency, USDC, an xStock or another approved token. Buyers pay in this asset, and the graduated pool keeps the same pair. Pay the $10 launch fee separately in native currency or USDC. Network gas is always paid in the native coin.'), pairGrid, assetBox),
      draft.chain!=='local'&&(solana()?!solanaPriced():!ctx.config.oracles?.[draft.chain]?.available)?callout('warn','info',solana()?'USD pricing is not active on this Solana cluster yet. It turns on when the team upgrades the program and runs the deploy (solana-upgrade.cmd). Existing tokens can still be browsed and traded.':'Verified launch pricing is pending configuration on this network. Use simulation to test creation.') : null,
      error,
    ], validate: () => {
      if (!draft.chain) { error.textContent = 'Choose a network.'; return false; }
      if (!connected()) { error.textContent = draft.chain === 'local' ? 'The local simulation is not running.' : 'Connect your wallet to continue.'; return false; }
      if (!ready()) { error.textContent = solana()?(!solanaPriced()?'USD pricing is not active on this Solana cluster yet. Use simulation, or ask the team to run the Solana upgrade.':'The on-chain SOL/USD price is stale right now. Wait a moment, then refresh.'):!ctx.config.oracles?.[draft.chain]?.available?'A verified USD feed has not been configured for this network.':!ctx.wallet.deployment?'Fund your connected wallet with test ETH, then click Set up launchpad above. Approve the wallet confirmations before continuing.':'Click Activate price feed above, or in Network and test funds. You need test ETH for its network fee.'; return false; }
      if (ctx.wallet.beta?.enabled && !ctx.wallet.beta.allowed) { error.textContent = 'This wallet is not on the beta launch list yet.'; return false; }
      const group = pairOptions()?.[draft.pair];
      if (!group?.assets.length) { error.textContent = group?.unavailable ?? 'Choose a trading pair.'; return false; }
      if (!group.assets.some(a => a.id === draft.quoteAsset)) { draft.quoteAsset = group.assets[0].id; save(); }
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
    const estBox = h('div'),priceStatus=h('p.price-status',priceNote());
    const balance = () => { if (!connected()) return null; const a = selectedAsset(); const v = a ? ctx.state?.pairBalances?.[a.id] ?? (draft.pair === 'native' ? ctx.state?.nativeBalance : null) : null; return v == null ? null : `${number(v, 6)} ${pairSymbol()}`; };
    const drawEstimate = () => {
      const e = estimate();
      estBox.replaceChildren(...[h('dl.kv', h('dt', 'Launch fee · $10'), h('dd', feeAmount()===null?'Quote unavailable':`${number(feeAmount(), 6)} ${feeSymbol()}${connected()?'':' (estimate)'}`), h('dt', 'First purchase'), h('dd', `${number(draft.firstBuy, 6)} ${pairSymbol()}`), h('dt', 'Trading fee included'), h('dd', `${number(Number(draft.firstBuy || 0) * 0.0125, 6)} ${pairSymbol()}`),
        h('dt', 'Estimated tokens'), h('dd', e ? `${compact(e.tokens)} (${number(e.share, 2)}% of supply)` : 'Shown after launch'), balance() ? [h('dt', 'Available balance'), h('dd', balance())] : null,
        connected()&&draft.chain!=='local'?[h('dt','Available for native payment and gas'),h('dd',`${number(ctx.state?.nativeBalance??0,8)} ${nativeSymbol()}`)]:null),
        connected()&&draft.chain!=='local'&&Number(ctx.state?.nativeBalance)===0?callout('warn','info',`This wallet has no ${nativeSymbol()} on ${net()?.name}. Add native currency for approval and launch gas, even when both payments use USDC.`):null,
        e?.completes ? callout('warn', 'triangle-alert', 'This amount reaches the curve limit. An amount above the remaining curve is rejected. Reduce your first purchase to leave supply for the community.') : null,
        !e ? h('p.hint', 'This network does not publish the curve for this pair before launch, so the exact amount appears on the token page.') : null].filter(Boolean));
      drawPreview();
    };
    drawEstimate();
    pricingRefresh=()=>{drawEstimate();priceStatus.textContent=priceNote();};
    const payment=h('select.select',{on:{change:e=>{draft.feeCurrency=e.target.value;save();drawEstimate();}}},h('option',{value:'native',selected:draft.feeCurrency!=='usdc'},nativeSymbol()+' · $10 equivalent'),h('option',{value:'usdc',disabled:!usdcAvailable(),selected:draft.feeCurrency==='usdc'},'USDC · 10 USDC'+(usdcAvailable()?'':' (unavailable on this network)')));
    if(draft.feeCurrency==='usdc'&&!usdcAvailable()){draft.feeCurrency='native';payment.value='native';drawEstimate();}
    return { body: [
      field({label:'Pay launch fee with',control:payment,hint:'Independent of the trading pair. USDC payment does not change your token’s pool.'}),
      priceStatus,
      field({ label: 'Purchase amount', control: h('div.input-affix', amount, h('span.affix', pairSymbol())), hint: 'Required by the launch contract: any amount above zero. Smaller purchases leave more of the curve for your community.' }),
      estBox,
      draft.pair==='native'?usdcFunding(ctx,{amount:()=>String(draft.firstBuy),symbol:nativeSymbol()}):null,
      callout('', 'info', 'Native payment uses the on-chain price at execution, rounded up by at most one smallest unit. A 1% fee cap protects your total; unused native funds are refunded. The oracle price can differ from the live market. USDC payment is exactly 10 USDC, whose dollar value can move.'),
      callout('', 'info', `This is the first trade on the virtual bonding curve. The curve is not a funded pool: your purchase starts the trading reserve, which moves into a locked ${dexName()} pool when the curve sells out.${solana() ? ' Your first purchase pays the normal 1.25% fee; other buyers pay a higher launch-protection fee during the first minute.' : ''}`),
    ], validate: () => {
      const control = amount;
      if(estimate()?.exceeds){setError(control,'This amount exceeds the curve. Reduce your first purchase.');control.focus();return false;}
      if (!(Number(draft.firstBuy) > 0)) { setError(control, 'Enter an amount greater than zero.'); control.focus(); return false; }
      const places = assetDecimals();
      if (!new RegExp(`^\\d+(\\.\\d{0,${places}})?$`).test(draft.firstBuy)) { setError(control, `Use at most ${places} decimal places.`); return false; }
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
        block('Network and trading pair', 1, row('Network', draft.chain === 'local' ? 'Local simulation' : net()?.name ?? '—'), row('Wallet', draft.chain === 'local' ? `Demo ${ctx.config.accounts[Number(ctx.account)].name.toLowerCase()}` : short(ctx.wallet.address)), row('Trading pair', `${PAIR_INFO[draft.pair]?.title ?? ''} · ${pairSymbol()}`), row('Graduates into', `A locked ${dexName()} pool`)),
        block('Creator rewards', 2, row('Strategy', STRATEGIES[draft.rewardMode].name), ...(['holders', 'paired', 'buyback'].includes(draft.rewardMode) ? [row('Distribution threshold', `${draft.threshold} ${pairSymbol()}`), row('Minimum token holding', `${number(draft.minimumHolding, 0)} ${draft.symbol.toUpperCase()}`)] : [row('Recipients', recipients)]), draft.rewardMode === 'paired' ? row('Reward asset', rewardData?.assets.find(a => a.address === draft.rewardToken)?.symbol ?? '—') : null, draft.rewardMode === 'buyback' ? row('Vesting', `${draft.vestingDays} days`) : null),
        block('First purchase and costs', 3, row('Launch fee · $10', feeAmount()===null?'Quote unavailable':`${number(feeAmount(), 6)} ${feeSymbol()}${connected()?'':' (estimate)'}`), row('First purchase', `${number(draft.firstBuy, 6)} ${pairSymbol()}`), row('Estimated tokens', estimate() ? compact(estimate().tokens) : 'Shown after launch'), row('Conversion',priceNote()),row('Network gas', 'Estimated before signing; paid separately'))),
      h('section.summary-card', h('h4', 'Fixed after launch'), h('ul.fixed-list', h('li', 'Name, symbol and the 1,000,000,000 fixed supply'), h('li', `Trading pair (${pairSymbol()})`), h('li', 'Creator reward strategy, recipients and percentages'), h('li', `Graduation into a ${dexName()} pool with permanently locked liquidity`))),
      ctx.mode!=='local'&&!solana() ? h('p.hint',draft.pair==='native'&&draft.feeCurrency!=='usdc' ? 'One launch confirmation pays the native fee, records supported metadata, creates your token and makes the first purchase. No token spending approval is needed.' : ctx.wallet.atomicLaunch ? 'Your wallet supports one atomic confirmation for payment approval, creation, supported metadata and the first purchase.' : 'Metadata uses the launch confirmation. This wallet may require a separate token payment approval; one-confirmation approval and launch requires an atomic-capable wallet.') : null,
      draft.chain==='base-sepolia'&&!ctx.wallet.needsMetadataUpgrade ? h('p.hint',ctx.config.metadataPublishing?.publicEnabled ? 'Token details are pinned to public IPFS and their reference is included in your launch transaction.' : 'Token details are stored on Elpida’s persistent server and their content reference is included in your launch transaction. Public IPFS pinning is not configured.') : null,
      policy ? null : callout('error', 'circle-alert', 'The reward settings need attention before you can create this token.'),
    ], validate: () => !!policy };
  }

  /* ---------- Submission ---------- */
  const STATUS_STEPS = () => ctx.mode === 'local'
    ? [['submit', 'Create on the local simulation', 'Simulated funds, no wallet needed'], ['confirm', 'Confirmed', 'Your token is live']]
    : [...(!solana() && !ctx.wallet.atomicLaunch && (draft.pair !== 'native'||draft.feeCurrency==='usdc') ? [['approve', 'Approve the payment if needed', 'Allows only the requested launch payment; no unlimited approval']] : []), ['wallet', 'Confirm in your wallet', `Pays the ${feeSymbol()} creation fee, records supported metadata, creates the token and makes your first purchase`], ['submit', 'Submitted', 'Waiting for the network to confirm'], ['confirm', 'Confirmed', 'Your token is live']];
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
    const body = { ...normalizeMetadata(draft), name: draft.name.trim(), symbol: draft.symbol.trim().toUpperCase(), pair: draft.pair, quoteAsset: selectedAsset()?.id ?? draft.quoteAsset, firstBuy: String(draft.firstBuy), feeCurrency:draft.feeCurrency, reward: ctx.state?.wallet ?? '' };
    if (draft.chain === 'local' && (draft.pair === 'token' || draft.pair === 'xstock')) body.quoteToken = body.quoteAsset;
    if (draft.chain === 'local') body.rewardPolicy = policy;
    else body.reward = policy.recipients[0].target || ctx.wallet.address;
    phase = 'submitting'; statusState = { step: ctx.mode === 'local' ? 'submit' : STATUS_STEPS()[0][0], error: null, done: false }; draw();
    const onProgress = message => {
      statusState.message=message;
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
        result?.metadataPublished ? h('p.small',result.metadataStorage==='elpida-hosted' ? 'Token details are hosted by Elpida, with their content reference recorded on-chain. Public IPFS pinning is not configured.' : 'Token details published and linked on-chain.') : null,
        h('div.actions', result?.token ? h('a.btn.btn-primary', { href: `#/token/${result.token}` }, 'View token') : null, ctx.txLink(result?.hash) ? h('a.btn.btn-secondary', { href: ctx.txLink(result.hash).href, target: '_blank', rel: 'noopener noreferrer' }, 'View transaction', icon('external-link', 'icon-sm')) : null,
          h('button.btn.btn-ghost', { type: 'button', on: { click: () => { Object.assign(draft, blankDraft(), { chain: ctx.currentChain() }); step = 0; maxStep = 0; phase = 'edit'; result = null; draw(); } } }, 'Create another'))));
      panel.querySelector('h2').focus();
      return;
    }
    const s = STEPS[step];
    pricingRefresh=()=>drawPreview();
    current = builders[step]();
    const nav = h('div.step-nav',
      step > 0 ? h('button.btn.btn-secondary', { type: 'button', disabled: phase === 'submitting', on: { click: () => go(step - 1) } }, icon('chevron-left', 'icon-sm'), 'Back') : h('a.btn.btn-ghost', { href: '#/' }, 'Cancel'),
      step < STEPS.length - 1 ? h('button.btn.btn-primary', { type: 'button', on: { click: () => go(step + 1) } }, 'Continue', icon('chevron-right', 'icon-sm'))
        : h('button.btn.btn-primary.btn-lg', { type: 'button', 'data-busy-disable': '', disabled: phase === 'submitting', on: { click: () => { if (current.validate()) create(); } } }, phase === 'failed' ? 'Try again' : 'Create token'));
    const status = statusState ? h('div.panel', { class: 'stack' }, h('h3', phase === 'failed' ? 'Your token was not created' : 'Creating your token'), statusView(),statusState.message?h('p.small',statusState.message):null,
      statusState.error ? callout('error', 'circle-alert', statusState.error, ' Your draft is saved, so you can adjust it and try again.') : null) : null;
    panel.replaceChildren(...[h('header', h('span.step-kicker', `Step ${step + 1} of ${STEPS.length}`), h('h2', { tabindex: '-1' }, s.title), h('p', s.lead)), h('div.step-body', current.body), status, nav].filter(Boolean));
  }
  draw();
  loadRewards();
  return { root, update: () => { if(phase==='edit'&&draft.chain!==ctx.currentChain()){draft.chain=ctx.currentChain();draft.pair='native';draft.quoteAsset='';draft.feeCurrency='native';maxStep=Math.min(maxStep,1);step=Math.min(step,1);networkError='Chain changed. Review the trading pair and reward availability before continuing. Your token details and reward draft are preserved.';save();draw();return;}  if (phase === 'edit' && STEPS[step].key === 'network') draw(); else if(phase==='edit'&&STEPS[step].key==='review')draw();else { drawStepper(); drawPreview();pricingRefresh(); } loadRewards(); } };
}
