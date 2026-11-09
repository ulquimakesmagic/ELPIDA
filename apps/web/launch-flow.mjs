import {taxPolicy} from './tax-policy.mjs';
import { nowSeconds } from './clock.mjs';
import { assetIcon, chainIcon } from './chain-ui.mjs';
// Guided token creation: details → network and trading pair → creator rewards → first purchase →
// review. The draft survives step changes, failed requests and page reloads (session storage).
import { h, icon, short, number, compact, avatar, metadataLinks, callout, field, setError, errorText, storage, safeImage, toast } from './ui.mjs';
import { normalizeMetadata, MAX_IMAGE_BYTES, IMAGE_TYPES, IMAGE_FORMATS } from './metadata.mjs';
import { normalizeRewardPolicy } from './reward-policy.mjs';
import { launchProfile } from './launch-capabilities.mjs';
import { STRATEGIES } from './rewards-view.mjs';
import { usdcFunding } from './usdc-funding.mjs';
import { PAIR_KINDS, PAIR_INFO, EQUITY_PROVIDERS, issuerNotice } from '/pairs.mjs';
import { stockPicker, loadStockCatalog, stockCatalog } from './stock-picker.mjs';
import { curveShape, DEX_MODEL, BETA_MODEL, BASE_FEE_BPS, LOCAL_START_FDV_USD } from '/curve-model.mjs';
import { launchTierNotice } from './partner-labels.mjs';
import { v4Deployment, v2Deployment } from './v4-launchpad.mjs';
import { splitPreview } from './v2-launchpad.mjs';
import { V2, V2_MODEL } from '/v2-economics.mjs';
import { V4_MODEL } from '/v4-model.mjs';

const DRAFT_KEY = 'elpida:launch-draft';
const STEPS = [
  { key: 'details', title: 'Token details', lead: 'How your token appears everywhere on Elpida. Name and symbol cannot be changed after launch.' },
  { key: 'network', title: 'Trading pair', lead: 'Pick the network, then the asset buyers pay with.' },
  { key: 'rewards', title: 'Creator rewards', lead: 'Decide where the creator share of trading fees goes. Your choice is fixed at launch.' },
  { key: 'purchase', title: 'Creator purchase (optional)', lead: 'Launch without buying, or make a creator purchase in the launch transaction.' },
  { key: 'review', title: 'Review and create', lead: 'Check everything before you create your token. Items marked as fixed cannot be changed later.' },
];
const STEP_ICONS = { details: 'file-pen', network: 'layers', rewards: 'coins', purchase: 'zap', review: 'shield-check' };
const STRATEGY_TEXT = {
  creator: 'Creator fees accumulate for one or more wallets you choose. Each wallet can claim its share.',
  holders: 'When the distribution threshold is reached, fees are paid to eligible holders in the trading asset, weighted by their holdings at a snapshot.',
  paired: 'At the threshold, creator fees buy a reward asset you choose and distribute it to eligible holders of your token.',
  buyback: 'At the threshold, creator fees buy back your token and vest it to eligible holders over a period you set.',
  exclusive: 'Fees are allocated by percentage to wallets, X accounts or websites. X and website shares stay in the treasury until ownership is verified.',
};
const blankDraft = () => ({ name: '', symbol: '', description: '', image: '', imageUrl: '', website: '', twitter: '', telegram: '', discord: '', chain: '', pair: 'native', quoteAsset: '', rewardMode: 'creator', recipients: [{ kind: 'wallet', target: '', percent: '100' }], threshold: '0.01', minimumHolding: '1000', minimumHoldingUsd: '', vestingDays: '30', rewardToken: '', feeCurrency:'native', firstBuy: '0', buyWith: 'pair', nativeBuy: '0', taxBuy:'0', taxSell:'0' });

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
  const root = h('div.lk',
    h('header.lk-head', h('h1', 'Launch your token, ', h('em', 'built on hope'), ' across any chain.'),
      h('button.tk-pill', { type: 'button', on: { click: () => location.hash = '#/docs' } }, icon('circle-help', 'icon-sm'), 'How it works')),
    h('nav.lk-stepper', { 'aria-label': 'Create token progress' }, stepper),
    h('div.launch', panel, preview));

  const profile = () => launchProfile(draft.chain === 'local' ? 'local' : draft.chain || 'local');
  const net = () => draft.chain && draft.chain !== 'local' ? ctx.networkByKey(draft.chain) : null;
  const isPublic = () => draft.chain && draft.chain !== 'local';
  const solana = () => draft.chain?.startsWith('solana');
  const connected = () => !!draft.chain && ctx.currentChain() === draft.chain && (draft.chain === 'local' || !!ctx.wallet.address);
  const freshPrice = p => p?.status === 'fresh' && Number(p.usd) > 0 && nowSeconds()-p.updatedAt <= (p.maxAge ?? 180);
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
    // One curve shape for every chain (packages/core/curve-model.mjs); the basic local launchpad keeps model 8.
    const shape = curveShape(ctx.config.dex ? DEX_MODEL : BETA_MODEL);
    const curveFor = startValue => ({ vq: startValue * shape.virtualFactor, vt: shape.virtualTokens, cap: shape.saleCap, feeBps: BASE_FEE_BPS });
    const nativeCurve = curveFor(startFdv);
    const assets = rewardData?.assets ?? [];
    const loading = rewardData ? null : 'Loading the approved assets…';
    const paired = (list, empty) => !ctx.config.dex ? { assets: [], unavailable: 'Needs the local DEX environment, which graduates into Uniswap v3.' } : list.length ? { assets: list } : { assets: [], unavailable: loading ?? empty };
    return {
      native: { assets: [{ id: 'native', symbol: 'ETH', name: 'Local test ETH', decimals: 18, curve: nativeCurve, ...fee }] },
      usdc: ctx.config.dex ? { assets: [{ id:ctx.config.local.feeUsdc,symbol:'USDC',name:'Simulated USDC (test only)',decimals:6,curve:curveFor(LOCAL_START_FDV_USD),...fee }] } : { assets:[],unavailable:'USDC trading pairs need the local DEX environment.' },
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
  // Creator purchase paid in the native coin on a non-native pair: swapped into the pair asset before the launch
  // (apps/web/launch-conversion.mjs). Public EVM testnets with a DEX only; the quote shows what the swap delivers.
  // Solana: stock pairs only, converted in the program's devnet SOL/stock pool (Jupiter on mainnet later).
  // Model 11 pays its first buy in the pair asset itself (no conversion step in its launch).
  const canPayNative = () => !(draft.launchModel === 'v11' && v4Offered()) && !(draft.launchModel === 'v20' && v2Offered()) && (!solana() || !!selectedAsset()?.lockedPool) && isPublic() && draft.pair !== 'native' && connected() && !net()?.mainnet && typeof ctx.wallet.firstBuyConversionQuote === 'function' && !!selectedAsset();
  const payNative = () => draft.buyWith === 'native' && canPayNative();
  let conversion = { key: '', state: 'idle' };
  const conversionFor = () => `${draft.chain}:${selectedAsset()?.id}:${draft.nativeBuy}`;
  let conversionTimer = null, conversionDrawn = () => {};
  function quoteConversion() {
    const key = conversionFor();
    if (!payNative() || conversion.key === key && conversion.state !== 'error') return;
    clearTimeout(conversionTimer);
    if (!(Number(draft.nativeBuy) > 0)) { conversion = { key, state: 'idle' }; conversionDrawn(); return; }
    conversion = { key, state: 'loading' }; conversionDrawn();
    conversionTimer = setTimeout(async () => {
      try { const q = await ctx.wallet.firstBuyConversionQuote({ quoteAsset: selectedAsset().id, nativeAmount: draft.nativeBuy }); if (conversionFor() === key) conversion = { key, state: 'ok', ...q }; }
      catch (error) { if (conversionFor() === key) conversion = { key, state: 'error', error: errorText(error) }; }
      if (conversionFor() === key) conversionDrawn();
    }, 400);
  }
  const converted = () => payNative() && conversion.key === conversionFor() && conversion.state === 'ok' ? conversion : null;
  /** The pair-asset amount the first purchase spends (for estimates): converted output when paying natively. */
  const buyAmount = () => payNative() ? Number(converted()?.pending ?? converted()?.output ?? 0) : Number(draft.firstBuy || 0);
  const buyText = () => {
    if (!payNative()) return `${number(draft.firstBuy, 6)} ${pairSymbol()}`;
    const c = converted();
    return c?.pending ? `${number(c.pending, 6)} ${pairSymbol()} (converted earlier)` : `${number(draft.nativeBuy, 6)} ${nativeSymbol()} → ${c ? `about ${number(c.output, 6)}` : '…'} ${pairSymbol()}`;
  };
  // Model 11 (Uniswap v4 hook) is offered where its test launchpad exists; it pairs with the native coin or USDC.
  const v4Offered = () => !!draft.chain && draft.chain !== 'local' && !solana() && !!v4Deployment(net());
  const v4Chosen = () => draft.launchModel === 'v11' && v4Offered();
  // ELPIDA V2 is offered where its test launchpad exists: the creator's own fee, the five-way split, native or USDC pairs.
  const v2Offered = () => !!draft.chain && draft.chain !== 'local' && !solana() && !!v2Deployment(net());
  const v2Chosen = () => draft.launchModel === 'v20' && v2Offered();
  const modelsOffered = () => v4Offered() || v2Offered();
  const feePercent = () => (Number(draft.feeBps ?? V2.defaultFeeBps) / 100).toFixed(2);
  const modelName = () => v2Chosen() ? `ELPIDA V2 test · ${feePercent()}% fee` : v4Chosen() ? 'Model 11 test · Uniswap v4' : 'Model 10 · bonding curve';
  const dexName = () => v4Chosen() || v2Chosen() ? 'Uniswap v4' : !draft.chain ? 'DEX' : solana() ? 'Raydium' : draft.chain === 'local' ? (ctx.config.dex ? 'Uniswap v3' : 'test') : draft.chain === 'base-sepolia' ? 'Uniswap v3' : ctx.config.publicDexes?.[draft.chain]?.name ?? 'test';

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
      h('div.preview-card', h('span.lk-label', h('i'), 'Token preview'),
        h('div.lk-well', draft.image ? avatar({ symbol: draft.symbol || 'NEW', metadata: { image: draft.image } }, 'avatar-xl') : h('span.lk-spark', icon('sparkles'))),
        h('div.lk-name', h('h3', draft.name || 'Your token name'), h('span.sym.muted.small', `$${(draft.symbol || 'SYMBOL').toUpperCase()}`), h('span.lk-paired', 'Paired with ', h('strong', pairSymbol()))),
        h('dl.lk-facts', h('dt', 'Network'), h('dd', draft.chain ? (draft.chain === 'local' ? 'Local simulation' : net()?.name ?? draft.chain) : 'Not chosen'), h('dt', 'Status'), h('dd', 'Pre-launch'), ...(startCap() ? [h('dt', 'Starts at'), h('dd', startCap())] : [])),
        h('p.desc', draft.description || 'Your description appears here.'), links,
        h('div.chips', { class: 'links' }, h('span.chip',chainIcon(draft.chain), draft.chain ? (draft.chain === 'local' ? 'Local simulation' : net()?.name ?? draft.chain) : 'Network not chosen'), h('span.chip',assetIcon(pairSymbol()), `Pair: ${pairSymbol()}`))),
      h('div.summary-card', h('h4', 'Launch summary'), h('dl.kv',
        ...(modelsOffered() ? [h('dt', 'Launch model'), h('dd', modelName())] : []),
        h('dt', 'Launch fee · $10'), h('dd', feeAmount()===null?'Quote unavailable':`${number(feeAmount(), 6)} ${feeSymbol()}${connected()?'':' (estimate)'}`),
        h('dt', 'First purchase'), h('dd', buyText()),
        h('dt', 'Estimated tokens'), h('dd', est ? `${compact(est.tokens)}` : '—'),
        h('dt', 'Creator rewards'), h('dd', strategy),
        h('dt.total', connected()?'You pay':'Estimated total'), h('dd.total', youPay())),
        h('p.hint', { text: `Launch fee conversion is verified before signing. Plus the network fee. Fixed supply of 1,000,000,000 ${draft.symbol ? draft.symbol.toUpperCase() : 'tokens'}.` })));
  }
  /** Market cap the token starts at, from the selected pair's curve. USD only when the conversion is known. */
  function startCap() {
    const asset = selectedAsset(), curve = asset?.curve;
    if (!curve || !(curve.vt > 0)) return '';
    const quote = curve.vq * 1e9 / curve.vt, usd = asset.symbol === 'USDC' ? 1 : asset.id === 'native' && freshPrice(launchPrice()) ? launchPrice().usd : null;
    const testNote = draft.chain === 'local' ? ' · simulation' : draft.chain && !net()?.mainnet ? ' · test size' : '';
    return usd !== null ? `$${number(quote * usd, 0)} market cap${testNote}` : `USD market cap unavailable${testNote}`;
  }
  function youPay() {
    if(feeAmount()===null)return 'Quote unavailable';
    if (payNative()) { const buy = converted()?.pending ? 0 : Number(draft.nativeBuy || 0), fee = feeAmount(); return feeSymbol() === nativeSymbol() ? `${number(buy + fee, 6)} ${nativeSymbol()}` : `${number(fee, 6)} ${feeSymbol()} + ${number(buy, 6)} ${nativeSymbol()}`; }
    const buy = Number(draft.firstBuy || 0);
    return feeSymbol() === pairSymbol() ? `${number(buy + feeAmount(), 6)} ${pairSymbol()}` : `${number(feeAmount(), 6)} ${feeSymbol()} + ${number(buy, 6)} ${pairSymbol()}`;
  }
  function estimate() {
    const buy = buyAmount(), curve = selectedAsset()?.curve;
    if (!(buy > 0) || !curve) return null;
    // Same virtual-reserve curve the contracts use: tokens = Vt × net / (Vq + net), net of the base fee.
    // The creator's first buy always pays the 1.25% base fee; the anti-snipe fee applies to other traders only.
    const tax=solana()?0:Number(draft.taxBuy??0);
    if(!Number.isFinite(tax)||tax<0||tax>10)return null;
    if (v2Chosen()) {
      // V2: virtual token 1.25 B and virtual quote = start × 5/4 (Model 10's is start × 10/9 at the same test start), the
      // creator's own fee, no token tax; the hook refuses a first buy above 3% of supply.
      const net = buy * (1 - Number(draft.feeBps ?? V2.defaultFeeBps) / 10000), vq = curve.vq * 1.125, tokens = 1.25e9 * net / (vq + net), cap = 3e7;
      return { tokens: Math.min(tokens, cap), exceeds: tokens > cap, completes: false, share: Math.min(tokens, cap) / 1e9 * 100 };
    }
    const net = buy * (1 - ((curve.feeBps ?? 125)+tax*100) / 10000), tokens = curve.vt * net / (curve.vq + net);
    return { tokens: Math.min(tokens, curve.cap),exceeds:tokens>curve.cap, completes: tokens >= curve.cap, share: Math.min(tokens, curve.cap) / 1e9 * 100 };
  }
  /** A first purchase of about 0.5% of the starting FDV, rounded to two significant figures. */
  function defaultBuy() { return '0'; }

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

  /** Model 11 pairs with the native coin, USDC or a test stock: a saved token pair falls back to the native coin. */
  const V4_PAIRS = ['native', 'usdc', 'xstock'], V2_PAIRS = ['native', 'usdc', 'xstock'];
  const modelPairs = () => v2Chosen() ? V2_PAIRS : v4Chosen() ? V4_PAIRS : null;
  function fitPairToModel() {
    if (!modelPairs() || modelPairs().includes(draft.pair)) return;
    draft.pair = 'native';
    const native = pairOptions()?.native?.assets?.[0];
    if (native) { draft.quoteAsset = native.id; draft.firstBuy = defaultBuy('native', native); }
  }
  /** V2: the creator's trading fee, from the launchpad's minimum to 4%, and what it means on a $1,000 trade. */
  const minFeeBps = () => Number(v2Deployment(net())?.minFeeBps ?? 100);
  function feeSelector() {
    const bps = draft.feeBps ?? V2.defaultFeeBps, set = value => { draft.feeBps = value; save(); draw(); };
    const presets = [...new Set([minFeeBps(), 125, 200, 300, 400])].filter(b => b >= minFeeBps() && b <= V2.maxFeeBps).sort((a, b) => a - b);
    const input = h('input.input', { type: 'number', min: (minFeeBps() / 100).toFixed(2), max: '4.00', step: '0.01', value: (bps / 100).toFixed(2), inputmode: 'decimal', 'aria-label': 'Trading fee, percent',
      on: { change: e => { const v = Math.round(Number(e.target.value) * 100); set(Number.isFinite(v) ? Math.min(V2.maxFeeBps, Math.max(minFeeBps(), v)) : V2.defaultFeeBps); } } });
    const preview = splitPreview('1000', bps, 6), labels = { creator: 'You (creator)', traderAirdrop: 'Traders · monthly airdrop', flywheel: 'Flywheel · buy and burn', holderRewards: 'Holders', treasury: 'Elpida treasury' };
    return h('div.stack.fee-picker', h('h3', 'Trading fee'), h('p.small.muted', `Charged on every buy and sell, before and after graduation. You choose it once: it can never be changed. ${(minFeeBps() / 100).toFixed(2)}% to 4.00%; 1.25% is the default. A higher fee earns more per trade but may slow trading.`),
      h('div.fee-row', h('div.fee-presets', { role: 'group', 'aria-label': 'Common fees' }, ...presets.map(b => h('button.btn.btn-secondary.btn-sm', { type: 'button', 'aria-pressed': String(b === bps), on: { click: () => set(b) } }, `${(b / 100).toFixed(2)}%${b === 125 ? ' · default' : ''}`))),
        h('label.fee-input', input, h('span', '%'))),
      h('div.fee-split', h('p.small', h('strong', `On a $1,000 trade: $${Number(preview.fee).toFixed(2)} fee`)),
        h('ul', ...preview.parts.map(p => h('li', h('span', labels[p.key]), h('span.small.muted', `${p.bps / 100}%`), h('strong', `$${Number(p.amount).toFixed(2)}`))))),
      h('p.small.muted', 'For the first 60 seconds after launch the fee starts at 90% and falls to your fee, to deter sniping; that surplus is added to the locked liquidity.'));
  }
  function networkStep() {
    fitPairToModel();
    const error = h('p.error-text', { role: 'alert' }, networkError);
    const connection = h('div.connection');
    if (!draft.chain) connection.append(h('p.muted', 'Choose a network to continue. You are asked to connect a wallet only after choosing a public testnet.'));
    else if (draft.chain === 'local') connection.append(h('div.connection-row', icon('flask-conical'), h('div.grow', h('strong', 'Local simulation ready'), h('p.small.muted', `Using the demo ${ctx.config.accounts[Number(ctx.account)].name.toLowerCase()} account with simulated ETH.`))));
    else {
      const n = net();
      if (!connected()) connection.append(h('div.connection-row', icon('wallet'), h('div.grow', h('strong', `Connect your wallet to ${n.name}`), h('p.small.muted', `Choose the wallet to use. It asks you to approve the connection${n.kind === 'solana' ? '' : ' and to switch to ' + n.name + ' if needed'}.`)),
        ctx.walletButtons(n, { onDone: () => { networkError = ''; draw(); }, onError: e => { networkError = errorText(e); draw(); } })));
      else {
        connection.append(h('div.connection-row', icon('circle-check'), h('div.grow', h('strong', `Connected to ${n.name}${/^your/i.test(ctx.wallet.walletName ?? 'your') ? '' : ' with ' + ctx.wallet.walletName}`), h('p.small.muted', ctx.wallet.address)), h('button.btn.btn-ghost.btn-sm', { type: 'button', on: { click: async () => { networkError = ''; try { await ctx.connect(draft.chain); } catch (e) { networkError = errorText(e); } draw(); } } }, 'Reconnect')));
        if (ctx.wallet.beta?.enabled && !ctx.wallet.beta.allowed) connection.append(callout('warn', 'lock', 'Launching is invite-only during the mainnet beta, and this wallet is not on the list yet. You can still browse and trade; ask the Elpida team to add this wallet to launch.'));
        else if (n.mainnet) connection.append(callout('warn', 'triangle-alert', 'Mainnet beta: this launch uses real funds and new, unaudited contracts.'));
        // Launchpad setup is operator work (operator panel, Launchpads); a visitor only learns the network is not ready.
        if (!ctx.wallet.deployment) connection.append(callout('warn', 'triangle-alert', `${n.name} is not set up for launches yet. Choose another network, or try again later.`));
      }
    }
    // Network cards with each chain's icon. Choosing one switches the app's chain, exactly like the header menu.
    function networkPicker() {
      const choices = [...(ctx.networks?.() ?? []), { key: 'local', name: 'Simulation' }];
      const label = n => n.key === 'local' ? 'Test funds' : n.mainnet ? 'Mainnet' : n.kind === 'solana' ? 'Devnet' : 'Testnet';
      const pick = async key => { if (key === draft.chain) return; networkError = ''; try { await ctx.chooseChain(key); draft.chain = ctx.currentChain(); save(); } catch (e) { networkError = errorText(e); } draw(); };
      const cards = choices.map(n => h('button.network-card', { type: 'button', role: 'radio', 'aria-checked': String(n.key === draft.chain), tabIndex: n.key === draft.chain ? 0 : -1, 'data-busy-disable': '', disabled: ctx.busy, on: { click: () => pick(n.key) } }, chainIcon(n.key), h('span.network-name', n.name), h('small', label(n))));
      const group = h('div.network-grid', { role: 'radiogroup', 'aria-label': 'Network' }, cards);
      // Arrow keys move between cards, as in any radio group.
      group.addEventListener('keydown', e => { if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return; e.preventDefault(); const at = cards.indexOf(document.activeElement), next = cards[(at + (['ArrowRight', 'ArrowDown'].includes(e.key) ? 1 : -1) + cards.length) % cards.length]; next?.focus(); });
      return h('div.stack', h('h3', 'Network'), group);
    }
    // The pair's own icon: the network's coin for native pairs, USDC for USDC, the asset's icon when it has one.
    function pairIcon(kind, group) {
      if (kind === 'usdc') return assetIcon('USDC');
      if (kind === 'native') return assetIcon(group?.assets?.[0]?.symbol ?? nativeSymbol());
      return group?.assets?.length === 1 ? assetIcon(group.assets[0].symbol) : icon(PAIR_INFO[kind].glyph);
    }
    const pairs = pairOptions();
    if (!stockCatalog() && pairs?.xstock?.assets?.length) loadStockCatalog().then(c => { if (c) draw(); });
    const pairGrid = h('div.choice-grid', { class: 'pair-grid', role: 'radiogroup', 'aria-label': 'Trading pair' }, PAIR_KINDS.map(kind => {
      const info = PAIR_INFO[kind], group = pairs?.[kind];
      const reason = !draft.chain ? 'Choose a network first.' : v2Chosen() && !V2_PAIRS.includes(kind) ? 'V2 test launches pair with the native coin, USDC or a test stock approved for V2. Choose Model 10 above for this pair.' : v4Chosen() && !V4_PAIRS.includes(kind) ? 'Model 11 test launches pair with the native coin, USDC or a test stock. Choose Model 10 above for this pair.' : !pairs ? 'Connect your wallet to see the assets on this network.' : group?.unavailable ?? (group?.assets.length ? null : 'Not available on this network.');
      const symbols = group?.assets.map(a => a.symbol).join(', ');
      const ownerSetup=kind==='usdc'&&!!reason&&draft.chain!=='local'&&!solana()&&connected()&&ctx.state?.pricing?.owner&&ctx.wallet.dex&&ctx.wallet.feeUsdc;
      const finish=ownerSetup?h('a.btn.btn-secondary.btn-sm',{href:'#/monkey?tab=pairs'},'Approve in the operator panel'):null;
      return h('div.choice', { 'data-unavailable': reason ? 'true' : undefined }, h('label',h('input', { type: 'radio', name: 'pair', value: kind, checked: draft.pair === kind, disabled: !!reason, on: { change: () => { draft.pair = kind; draft.quoteAsset = group.assets[0].id; draft.firstBuy = defaultBuy(kind, group.assets[0]); save(); draw(); } } }),
        h('span.choice-title', pairIcon(kind, group), info.title, symbols ? h('span.chip', symbols) : null), h('p', ownerSetup?'This launchpad has not approved USDC yet. Pair approvals are made by the treasury in the operator panel (Pairs).':reason ?? info.note(kind === 'native' ? group.assets[0].symbol : ''))),finish);
    }));
    const asset = selectedAsset(), group = pairs?.[draft.pair];
    const balanceOf = a => ctx.state?.pairBalances?.[a.id] ?? (draft.pair === 'native' ? ctx.state?.nativeBalance : null);
    const fund = a => !a?.faucet ? null : a.faucet.href ? h('a.btn.btn-secondary.btn-sm', { href: a.faucet.href, target: '_blank', rel: 'noopener noreferrer' }, icon('droplet', 'icon-sm'), a.faucet.label, icon('external-link', 'icon-sm'))
      : h('button.btn.btn-secondary.btn-sm', { type: 'button', 'data-busy-disable': '', on: { click: async () => { error.textContent = ''; try { await ctx.run(a.faucet.action, a.faucet.body); draw(); } catch (e) { error.textContent = errorText(e); } } } }, icon('droplet', 'icon-sm'), a.faucet.label);
    const assetBox = asset && group?.assets.length ? h('div.reveal.stack',
      draft.pair === 'xstock' ? stockPicker({ assets: group.assets, selectedId: asset.id, onSelect: a => { draft.quoteAsset = a.id; draft.firstBuy = defaultBuy('xstock', a); save(); draw(); } }) :
      group.assets.length > 1 ? field({ label: `${PAIR_INFO[draft.pair].title} asset`, control: h('select.select', { on: { change: e => { draft.quoteAsset = e.target.value; draft.firstBuy = defaultBuy(draft.pair, selectedAsset()); save(); draw(); } } }, group.assets.map(a => h('option', { value: a.id, selected: a.id === asset.id }, `${a.symbol} · ${a.name}`))) }) : null,
      // A stock's identity is in the dropdown above; here only its balance, the creation fee and the test faucet.
      draft.pair === 'xstock' ? h('div.connection-row.stock-balance-row', h('p.small.muted.grow', [balanceOf(asset) != null ? `Balance: ${number(balanceOf(asset), 4)} ${asset.symbol}` : `${asset.symbol} balance appears once your wallet is connected`, `Creation fee: ${number(Number(asset.feeAmount ?? 0), 6)} ${asset.feeSymbol ?? nativeSymbol()}`].join(' · ')), fund(asset)) :
      h('div.connection-row', assetIcon(asset.symbol,false,{size:'md'}), h('div.grow', h('strong', asset.symbol), h('p.small.muted', [asset.name, balanceOf(asset) != null ? `Balance: ${number(balanceOf(asset), 4)} ${asset.symbol}` : null, `Creation fee: ${number(Number(asset.feeAmount ?? 0), 6)} ${asset.feeSymbol ?? nativeSymbol()}`].filter(Boolean).join(' · '))), fund(asset)),
      asset.lockedPool && draft.pair === 'xstock' ? callout('', 'lock', `When this curve completes, trading continues in Elpida's own locked pool on Solana, opened by the buy that completes it. Its liquidity can never be withdrawn. No Solana DEX accepts this stock's mint yet, so aggregators do not route to the pool.`) : null,
      asset.test && draft.pair === 'xstock' && asset.stock?.provider === 'ondo-test' && asset.lockedPool ? callout('warn', 'flask-conical', `${asset.symbol} is a test stand-in for an Ondo stock on Solana, with no value and no real-world backing. Its mint has the same controls as Ondo's: the issuer can pause it or freeze a wallet, which halts trading in it until lifted. Live Ondo stocks stay off until the provider and our checks are verified.`) : null,
      asset.test && draft.pair === 'xstock' && asset.stock?.provider === 'ondo-test' && !asset.lockedPool ? callout('warn', 'flask-conical', v4Chosen() ? `${asset.symbol} is a test stock with no value or real-world backing. Its issuer can pause it or block the shared PoolManager, stopping trading and payouts until transfers resume. Liquidity stays locked. Model 11 has no on-chain stock-market or corporate-action gate yet; real stocks remain unavailable.` : `${asset.symbol} is a test stand-in for an Ondo stock, with no value and no real-world backing. Like the real token, its (test) issuer can pause it or block wallets, which halts trading in it; and the buy that completes the curve waits for a fresh stock price, so graduation pauses during a corporate action or a stale price. Live Ondo stocks stay off until the provider and our checks are verified.`) : null,
      asset.test && draft.pair === 'xstock' && asset.stock?.provider !== 'ondo-test' ? callout('warn', 'flask-conical', `${asset.symbol} is a simulated stock for testing. It is not an issued token from ${EQUITY_PROVIDERS[draft.chain] ?? 'any provider'} and has no real-world backing. Live tokenized stocks stay off until the provider and our checks are verified.`) : null,
      !asset.test && draft.pair === 'xstock' ? callout('warn', 'triangle-alert', issuerNotice(EQUITY_PROVIDERS[draft.chain])) : null,
      asset.wsol ? callout('', 'info', 'You pay and receive plain SOL. Elpida wraps it for each trade and unwraps what is left in the same transaction.') : null) : null;
    return { body: [
      networkPicker(), connection,
      modelsOffered() ? h('div.stack', h('h3', 'Launch model'), h('div.choice-grid', { role: 'radiogroup', 'aria-label': 'Launch model' },
        [['v10', 'Model 10 · bonding curve', `The curve sells the supply, then the buy that completes it moves the liquidity into a locked ${ctx.config.publicDexes?.[draft.chain]?.name ?? 'Uniswap v3'} pool.`],
          ...(v4Offered() ? [['v11', 'Model 11 test · Uniswap v4', 'The same curve inside one Uniswap v4 pool, with the liquidity locked from the first trade: no graduation step. Native, USDC or test-stock pairs (stocks once the operator approves them for Model 11), no token tax. Not audited; test networks only.']] : []),
          ...(v2Offered() ? [['v20', 'ELPIDA V2 test · your fee', 'Liquidity locked from the first trade in one Uniswap v4 pool. You choose the trading fee (up to 4%), fixed for good. Every fee is shared: 30% to you, 30% to traders as a monthly airdrop, 10% buys and burns top tokens, 10% to holders, 20% to Elpida. First buy capped at 3% of supply. Native, USDC or test-stock pairs (stocks once the operator approves them for V2). Not audited; test networks only.']] : [])].map(([key, title, text]) =>
          h('label.choice', h('input', { type: 'radio', name: 'launch-model', value: key, checked: (draft.launchModel ?? 'v10') === key, on: { change: () => { draft.launchModel = key; fitPairToModel(); save(); draw(); } } }),
            h('span.choice-title', icon(key === 'v20' ? 'sparkles' : key === 'v11' ? 'flask-conical' : 'chart-line'), title), h('p', text), key !== 'v10' ? h('span.chip', 'Test') : null)))) : null,
      v2Chosen() ? feeSelector() : null,
      h('div.stack', h('h3', 'Trading pair'), h('p.small.muted', 'Choose native currency, USDC, an xStock or another approved token. Buyers pay in this asset, and the graduated pool keeps the same pair. Pay the $10 launch fee separately in native currency or USDC. Network gas is always paid in the native coin.'), pairGrid, assetBox),
      draft.chain!=='local'&&(solana()?!solanaPriced():!ctx.config.oracles?.[draft.chain]?.available)?callout('warn','info',solana()?'USD pricing is not active on this Solana cluster yet. It turns on when the team upgrades the program and runs the deploy (solana-upgrade.cmd). Existing tokens can still be browsed and traded.':'Verified launch pricing is pending configuration on this network. Use simulation to test creation.') : null,
      error,
    ], validate: () => {
      if (!draft.chain) { error.textContent = 'Choose a network.'; return false; }
      if (!connected()) { error.textContent = draft.chain === 'local' ? 'The local simulation is not running.' : 'Connect your wallet to continue.'; return false; }
      if (!ready()) { error.textContent = solana()?(!solanaPriced()?'USD pricing is not active on this Solana cluster yet. Use simulation, or ask the team to run the Solana upgrade.':'The on-chain SOL/USD price is stale right now. Wait a moment, then refresh.'):!ctx.config.oracles?.[draft.chain]?.available?'A verified USD feed has not been configured for this network.':!ctx.wallet.deployment?'This network is not set up for launches yet. Choose another network.':'Launch pricing is not active on this network yet. Choose another network, or try again later.'; return false; }
      if (ctx.wallet.beta?.enabled && !ctx.wallet.beta.allowed) { error.textContent = 'This wallet is not on the beta launch list yet.'; return false; }
      const group = pairOptions()?.[draft.pair];
      if (!group?.assets.length) { error.textContent = group?.unavailable ?? 'Choose a trading pair.'; return false; }
      if (v4Chosen() && !V4_PAIRS.includes(draft.pair)) { error.textContent = 'Model 11 test launches pair with the native coin, USDC or a test stock.'; return false; }
      if (v2Chosen() && !V2_PAIRS.includes(draft.pair)) { error.textContent = 'V2 test launches pair with the native coin, USDC or a test stock approved for V2.'; return false; }
      if (v2Chosen() && !(Number.isInteger(draft.feeBps ?? V2.defaultFeeBps) && (draft.feeBps ?? V2.defaultFeeBps) >= minFeeBps() && (draft.feeBps ?? V2.defaultFeeBps) <= V2.maxFeeBps)) { error.textContent = `Choose a trading fee from ${(minFeeBps() / 100).toFixed(2)}% to 4.00%.`; return false; }
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
        field({ label: 'Minimum token holding', control: h('div.input-affix', input('minimumHolding', { type: 'number', min: '0', step: 'any' }), h('span.affix', (draft.symbol || 'tokens').toUpperCase())), hint: 'Wallets holding less are skipped. Pools, the curve and treasuries never qualify.' })),
        field({ label: 'Minimum holding value (optional)', control: h('div.input-affix', input('minimumHoldingUsd', { type: 'number', min: '0', max: '100000', step: 'any', placeholder: 'e.g. 30' }), h('span.affix', 'USD')), hint: 'Holders must also hold at least this much in USD, converted to tokens at each distribution using a fresh price. The larger of the two minimums applies. If no fresh USD price exists for the pair, distributions wait instead of guessing.' }));
      if (draft.rewardMode === 'paired') settings.append(field({ label: 'Reward asset', control: h('select.select', { on: { change: e => { draft.rewardToken = e.target.value; save(); drawPreview(); } } }, (rewardData?.assets ?? []).map(a => h('option', { value: a.address, selected: a.address === draft.rewardToken }, a.symbol))), hint: 'The asset holders receive. It can differ from the trading pair; if it is the same, fees are paid directly without a swap.' }));
      if (draft.rewardMode === 'buyback') settings.append(field({ label: 'Vesting duration', control: h('div.input-affix', input('vestingDays', { type: 'number', min: '1', max: '3650', step: '1' }), h('span.affix', 'days')), hint: 'Bought-back tokens unlock linearly over this period for the eligible holders at each snapshot.' }));
      settings.append(callout('', 'info', 'Holder payouts are weighted by each wallet’s eligible token balance at the recorded snapshot, not by total supply.'));
    } else settings.append(allocationEditor());
    const canTax = local ? !!ctx.config.taxLaunch?.available : !!ctx.wallet?.net?.taxDeployment;
    const taxControls = !solana() ? h('section.stack',h('h3','Optional token tax'),
      field({label:'Buy tax (%)',control:input('taxBuy',{type:'number',min:'0',max:'10',step:'0.01',disabled:!canTax})}),
      field({label:'Sell tax (%)',control:input('taxSell',{type:'number',min:'0',max:'10',step:'0.01',disabled:!canTax})}),
      h('p.hint',canTax?'0–10% per side, fixed at launch. Additional tax splits 30% to Elpida and 70% to your wallet allocations. The 1.25% curve fee remains 50/50. After migration, the token tax and V2 pool fee apply. Creator tax rewards after migration are paid in your launched token.':'Tax launches require the verified V2 tax factory deployment. Available in the local DEX rehearsal; existing public V3 factories cannot create transfer-tax tokens.')) : null;
    settings.append(h('div.summary-card', h('h4', 'Fixed at launch'), h('ul.fixed-list', h('li', 'The reward strategy and its settings'), h('li', 'Recipients and their percentages'), h('li', 'Your creator share of trading fees'))));
    return { body: [
      local ? null : callout('', 'info', 'On public testnets, creator fees go to one creator wallet. Holder distributions, buybacks and X or website allocations are available in the local simulation until their contracts are deployed publicly.'),
      taxControls, grid, settings, error,
    ], validate: () => {
      error.textContent = '';
      try { buildPolicy(); const tax=taxPolicy({buy:draft.taxBuy,sell:draft.taxSell,recipients:draft.recipients,owner:ctx.state?.wallet});
        if(tax&&(!canTax||draft.rewardMode!=='creator'))throw new Error('Tax launches require a verified V2 deployment and creator wallet allocations.');return true; } catch (e) { error.textContent = errorText(e); return false; }
    } };
  }
  function allocationEditor() {
    const exclusive = draft.rewardMode === 'exclusive';
    const local = draft.chain === 'local' || !!ctx.wallet?.net?.taxDeployment;
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
    const policy = normalizeRewardPolicy({ mode: draft.rewardMode, threshold: draft.threshold, minimumHolding: draft.minimumHolding, minimumHoldingUsd: draft.minimumHoldingUsd || '0', vestingDays: draft.vestingDays, rewardToken: draft.rewardToken, recipients: draft.recipients }, draft.chain || 'local');
    const taxed=!solana()&&(Number(draft.taxBuy)>0||Number(draft.taxSell)>0)&&!!ctx.wallet?.net?.taxDeployment;
    if (draft.chain !== 'local' && (policy.mode !== 'creator' || (!taxed&&policy.recipients.length!==1) || policy.recipients.some(r=>r.kind!=='wallet'))) throw new Error('Public standard launches support one creator wallet. Verified tax deployments support fixed wallet allocations.');
    return policy;
  }

  function purchaseStep() {
    const est = estimate();
    const amount = input('firstBuy', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', onInput: e => { draft.firstBuy = e.target.value; drawEstimate(); } });
    const nativeAmount = input('nativeBuy', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', onInput: e => { draft.nativeBuy = e.target.value; quoteConversion(); drawEstimate(); } });
    const amountField = h('div');
    const drawAmount = () => amountField.replaceChildren(payNative()
      ? field({ label: 'Purchase amount', control: h('div.input-affix', nativeAmount, h('span.affix', nativeSymbol())), hint: `Optional. Swapped into ${pairSymbol()} on ${dexName()} at the live pool price, at most 1% below the quote, in a separate confirmation before the launch. If the launch then stops, the ${pairSymbol()} stays in your wallet and your next attempt uses it.` })
      : field({ label: 'Purchase amount', control: h('div.input-affix', amount, h('span.affix', pairSymbol())), hint: v2Chosen() ? 'Optional. Your first buy can receive at most 3% of the supply (30,000,000 tokens); a larger amount is refused before anything is sent. Enter 0 to launch without buying.' : 'Optional. Enter 0 to launch without buying. Launch fees and network gas still apply.' }));
    const buyWith = canPayNative() ? h('select.select', { on: { change: e => { draft.buyWith = e.target.value; save(); drawAmount(); quoteConversion(); drawEstimate(); } } },
      h('option', { value: 'pair', selected: !payNative() }, `${pairSymbol()} from your wallet`),
      h('option', { value: 'native', selected: payNative() }, `${nativeSymbol()}, converted to ${pairSymbol()} first`)) : null;
    const conversionRows = () => {
      if (!payNative()) return [];
      const c = conversion.key === conversionFor() ? conversion : { state: 'idle' };
      if (c.state === 'ok' && c.pending) return [callout('', 'info', `You already converted ${number(c.pending, 6)} ${pairSymbol()} for an earlier launch attempt. This launch uses it as the first purchase; no new conversion is sent.`)];
      if (c.state === 'ok') return [h('dl.kv', h('dt', 'You convert'), h('dd', `${number(draft.nativeBuy, 6)} ${nativeSymbol()}`), h('dt', 'You receive about'), h('dd', `${number(c.output, 6)} ${pairSymbol()} (at least ${number(c.minimum, 6)})`))];
      if (c.state === 'loading') return [h('p.hint', `Quoting ${nativeSymbol()} → ${pairSymbol()} on ${dexName()}…`)];
      if (c.state === 'error') return [callout('warn', 'triangle-alert', /No funded/.test(c.error) ? `There is no funded ${nativeSymbol()}/${pairSymbol()} market on ${net()?.name} yet, so the purchase cannot be paid in ${nativeSymbol()}. Pay with ${pairSymbol()} instead.` : c.error)];
      return [];
    };
    const estBox = h('div'),priceStatus=h('p.price-status',priceNote());
    const balance = () => { if (!connected()) return null; const a = selectedAsset(); const v = a ? ctx.state?.pairBalances?.[a.id] ?? (draft.pair === 'native' ? ctx.state?.nativeBalance : null) : null; return v == null ? null : `${number(v, 6)} ${pairSymbol()}`; };
    const drawEstimate = () => {
      const e = estimate();
      estBox.replaceChildren(...[...conversionRows(), h('dl.kv', h('dt', 'Launch fee · $10'), h('dd', feeAmount()===null?'Quote unavailable':`${number(feeAmount(), 6)} ${feeSymbol()}${connected()?'':' (estimate)'}`), h('dt', 'First purchase'), h('dd', buyText()), h('dt', 'Trading fee included'), h('dd', `${number(buyAmount() * (v2Chosen() ? Number(draft.feeBps ?? V2.defaultFeeBps) / 10000 : 0.0125), 6)} ${pairSymbol()}`),
        h('dt', 'Estimated tokens'), h('dd', e ? `${compact(e.tokens)} (${number(e.share, 2)}% of supply)` : 'Shown after launch'), balance() ? [h('dt', 'Available balance'), h('dd', balance())] : null,
        connected()&&draft.chain!=='local'?[h('dt','Available for native payment and gas'),h('dd',`${number(ctx.state?.nativeBalance??0,8)} ${nativeSymbol()}`)]:null),
        connected()&&draft.chain!=='local'&&Number(ctx.state?.nativeBalance)===0?callout('warn','info',`This wallet has no ${nativeSymbol()} on ${net()?.name}. Add native currency for approval and launch gas, even when both payments use USDC.`):null,
        e?.completes ? callout('warn', 'triangle-alert', 'This amount reaches the curve limit. An amount above the remaining curve is rejected. Reduce your first purchase to leave supply for the community.') : null,
        !e ? h('p.hint', 'This network does not publish the curve for this pair before launch, so the exact amount appears on the token page.') : null].filter(Boolean));
      drawPreview();
    };
    conversionDrawn = drawEstimate;
    drawAmount(); quoteConversion(); drawEstimate();
    pricingRefresh=()=>{drawEstimate();priceStatus.textContent=priceNote();};
    const payment=h('select.select',{on:{change:e=>{draft.feeCurrency=e.target.value;save();drawEstimate();}}},h('option',{value:'native',selected:draft.feeCurrency!=='usdc'},nativeSymbol()+' · $10 equivalent'),h('option',{value:'usdc',disabled:!usdcAvailable(),selected:draft.feeCurrency==='usdc'},'USDC · 10 USDC'+(usdcAvailable()?'':' (unavailable on this network)')));
    if(draft.feeCurrency==='usdc'&&!usdcAvailable()){draft.feeCurrency='native';payment.value='native';drawEstimate();}
    return { body: [
      field({label:'Pay launch fee with',control:payment,hint:'Independent of the trading pair. USDC payment does not change your token’s pool.'}),
      priceStatus,
      buyWith ? field({ label: 'Pay first purchase with', control: buyWith, hint: `Buyers always trade in ${pairSymbol()}. Paying in ${nativeSymbol()} adds one conversion confirmation before the launch.` }) : null,
      amountField,
      estBox,
      draft.pair==='native'?usdcFunding(ctx,{amount:()=>String(draft.firstBuy),symbol:nativeSymbol()}):null,
      callout('', 'info', 'Native payment uses the on-chain price at execution, rounded up by at most one smallest unit. A 1% fee cap protects your total; unused native funds are refunded. The oracle price can differ from the live market. USDC payment is exactly 10 USDC, whose dollar value can move.'),
      callout('', 'info', `This is the first trade on the virtual bonding curve. The curve is not a funded pool: your purchase starts the trading reserve, which moves into a locked ${dexName()} pool when the curve sells out.${solana() ? ' Your first purchase pays the normal 1.25% fee; other buyers pay a higher launch-protection fee during the first minute.' : ''}`),
    ], validate: () => {
      if (payNative()) {
        if (!(Number(draft.nativeBuy) >= 0) || !/^\d+(\.\d{0,18})?$/.test(draft.nativeBuy)) { setError(nativeAmount, 'Enter zero or a positive amount, at most 18 decimal places.'); nativeAmount.focus(); return false; }
        if (Number(draft.nativeBuy) > 0 && !converted()) { setError(nativeAmount, conversion.state === 'loading' ? 'Wait for the conversion quote.' : `This amount cannot be converted to ${pairSymbol()} right now.`); return false; }
        if (estimate()?.exceeds) { setError(nativeAmount, 'This amount exceeds the curve. Reduce your first purchase.'); return false; }
        return true;
      }
      const control = amount;
      if(estimate()?.exceeds){setError(control,v2Chosen()?'A first buy can receive at most 3% of the supply. Reduce your first purchase.':'This amount exceeds the curve. Reduce your first purchase.');control.focus();return false;}
      if (!(Number(draft.firstBuy) >= 0)) { setError(control, 'Enter zero or a positive amount.'); control.focus(); return false; }
      const places = assetDecimals();
      if (!new RegExp(`^\\d+(\\.\\d{0,${places}})?$`).test(draft.firstBuy)) { setError(control, `Use at most ${places} decimal places.`); return false; }
      return true;
    } };
  }

  // Early-partner tier of the connected wallet on the chosen network, read once per (network, wallet).
  const tier = { key: null, record: undefined };
  function loadTier() {
    if (!connected() || draft.chain === 'local' || typeof ctx.wallet.partnerTier !== 'function') return null;
    const key = `${draft.chain}:${ctx.wallet.address}`;
    if (tier.key !== key) {
      Object.assign(tier, { key, record: undefined });
      ctx.wallet.partnerTier().then(record => { if (tier.key !== key) return; tier.record = record; if (phase === 'edit' && STEPS[step].key === 'review') draw(); }).catch(() => { if (tier.key === key) tier.record = null; });
    }
    return tier.record ? launchTierNotice(tier.record) : null;
  }

  function reviewStep() {
    const notice = loadTier();
    const policy = (() => { try { return buildPolicy(); } catch { return null; } })();
    const edit = i => h('button.link-button', { type: 'button', on: { click: () => go(i) } }, icon('pencil', 'icon-sm'), 'Edit');
    const block = (title, i, ...rows) => h('section.review-block', h('header', h('h4', title), edit(i)), h('dl.kv', ...rows));
    const row = (k, v) => [h('dt', k), h('dd', v)];
    const recipients = policy?.recipients?.length ? policy.recipients.map(r => `${r.bps / 100}% · ${r.kind === 'x' ? '@' + r.target : r.kind === 'domain' ? r.target : r.target ? short(r.target) : 'your connected wallet'}`).join(', ') : '—';
    return { body: [
      h('div.review',
        block('Token', 0, row('Name', draft.name), row('Symbol', `$${draft.symbol.toUpperCase()}`), row('Description', draft.description), row('Logo', draft.image ? (draft.image.startsWith('data:') ? 'Uploaded image' : draft.image) : '—'), row('Links', ['website', 'twitter', 'telegram', 'discord'].filter(k => draft[k]).map(k => ({ website: 'Website', twitter: 'X', telegram: 'Telegram', discord: 'Discord' })[k]).join(', ') || 'None')),
        block('Network and trading pair', 1, ...(modelsOffered() ? [row('Launch model', modelName())] : []), ...(v2Chosen() ? [row('Trading fee', `${feePercent()}% on every trade, fixed for good`), row('Fee split', '30% you · 30% traders · 10% flywheel · 10% holders · 20% Elpida')] : []), row('Network', draft.chain === 'local' ? 'Local simulation' : net()?.name ?? '—'), row('Wallet', draft.chain === 'local' ? `Demo ${ctx.config.accounts[Number(ctx.account)].name.toLowerCase()}` : short(ctx.wallet.address)), row('Trading pair', `${PAIR_INFO[draft.pair]?.title ?? ''} · ${pairSymbol()}`), v4Chosen() || v2Chosen() ? row('Liquidity', 'Locked from launch in the same Uniswap v4 pool') : row('Graduates into', `A locked ${dexName()} pool`), notice?.live ? row('Partner tier', `${notice.tier} · ${notice.percent}% of fees buy back and burn`) : null),
        block('Creator rewards', 2, row('Strategy', STRATEGIES[draft.rewardMode].name), ...(['holders', 'paired', 'buyback'].includes(draft.rewardMode) ? [row('Distribution threshold', `${draft.threshold} ${pairSymbol()}`), row('Minimum token holding', `${number(draft.minimumHolding, 0)} ${draft.symbol.toUpperCase()}`)] : [row('Recipients', recipients)]), draft.rewardMode === 'paired' ? row('Reward asset', rewardData?.assets.find(a => a.address === draft.rewardToken)?.symbol ?? '—') : null, draft.rewardMode === 'buyback' ? row('Vesting', `${draft.vestingDays} days`) : null),
        block('Creator purchase and costs', 3, row('Launch fee · $10', feeAmount()===null?'Quote unavailable':`${number(feeAmount(), 6)} ${feeSymbol()}${connected()?'':' (estimate)'}`), row('First purchase', buyText()), payNative() ? row('Paid with', `${nativeSymbol()}, converted to ${pairSymbol()} in a separate confirmation first`) : null, row('Buy / sell token tax', `${draft.taxBuy||0}% / ${draft.taxSell||0}% · additional to trading fees`), row('Estimated tokens', estimate() ? compact(estimate().tokens) : 'Shown after launch'), row('Conversion',priceNote()),row('Network gas', 'Estimated before signing; paid separately'))),
      notice ? callout(notice.live ? '' : 'warn', notice.live ? 'flame' : 'info', notice.text) : null,
      h('section.summary-card', h('h4', 'Fixed after launch'), h('ul.fixed-list', h('li', 'Name, symbol and the 1,000,000,000 fixed supply'), h('li', `Trading pair (${pairSymbol()})`), h('li', 'Creator reward strategy, recipients and percentages'), ...(v2Chosen() ? [h('li', `Trading fee ${feePercent()}% and its five-way split`)] : []), h('li', v4Chosen() || v2Chosen() ? 'Uniswap v4 liquidity locked from launch; the milestone keeps the same pool' : `Graduation into a ${dexName()} pool with permanently locked liquidity`), notice?.live ? h('li', `${notice.tier} tier: ${notice.percent}% of trading fees buy back and burn the token, for life`) : null)),
      ctx.mode!=='local'&&!solana() ? h('p.hint',draft.pair==='native'&&draft.feeCurrency!=='usdc' ? 'One launch confirmation pays the native fee, records supported metadata, creates your token and makes the first purchase. No token spending approval is needed.' : ctx.wallet.atomicLaunch ? 'Your wallet supports one atomic confirmation for payment approval, creation, supported metadata and the first purchase.' : 'Metadata uses the launch confirmation. This wallet may require a separate token payment approval; one-confirmation approval and launch requires an atomic-capable wallet.') : null,
      draft.chain==='base-sepolia'&&!ctx.wallet.needsMetadataUpgrade ? h('p.hint',ctx.config.metadataPublishing?.publicEnabled ? 'Token details are pinned to public IPFS and their reference is included in your launch transaction.' : 'Token details are stored on Elpida’s persistent server and their content reference is included in your launch transaction. Public IPFS pinning is not configured.') : null,
      policy ? null : callout('error', 'circle-alert', 'The reward settings need attention before you can create this token.'),
    ], validate: () => !!policy };
  }

  /* ---------- Submission ---------- */
  const STATUS_STEPS = () => ctx.mode === 'local'
    ? [['submit', 'Create on the local simulation', 'Simulated funds, no wallet needed'], ['confirm', 'Confirmed', 'Your token is live']]
    : [...(payNative() && Number(draft.nativeBuy) > 0 ? [['convert', `Convert ${nativeSymbol()} to ${pairSymbol()}`, 'A separate swap at the live pool price. If the launch stops, you keep it and the next attempt uses it']] : []), ...(!solana() && !ctx.wallet.atomicLaunch && (draft.pair !== 'native'||draft.feeCurrency==='usdc') ? [['approve', 'Approve the payment if needed', 'Allows only the requested launch payment; no unlimited approval']] : []), ['wallet', 'Confirm in your wallet', `Pays the ${feeSymbol()} creation fee, records supported metadata, creates the token and makes your first purchase`], ['submit', 'Submitted', 'Waiting for the network to confirm'], ['confirm', 'Confirmed', 'Your token is live']];
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
    const body = { ...normalizeMetadata(draft), name: draft.name.trim(), symbol: draft.symbol.trim().toUpperCase(), pair: draft.pair, quoteAsset: selectedAsset()?.id ?? draft.quoteAsset, firstBuy: payNative() ? '0' : String(draft.firstBuy), feeCurrency:draft.feeCurrency, reward: ctx.state?.wallet ?? '' };
    if (payNative() && Number(draft.nativeBuy) > 0) { body.firstBuyPayment = 'native'; body.nativeBuy = String(draft.nativeBuy); }
    if(!solana())body.tax=taxPolicy({buy:draft.taxBuy,sell:draft.taxSell,recipients:draft.recipients,owner:ctx.state?.wallet});
    if (v4Chosen()) { body.model = V4_MODEL; delete body.tax; delete body.firstBuyPayment; delete body.nativeBuy; }
    if (v2Chosen()) { body.model = V2_MODEL; body.feeBps = draft.feeBps ?? V2.defaultFeeBps; delete body.tax; delete body.firstBuyPayment; delete body.nativeBuy; }
    if (draft.chain === 'local' && (draft.pair === 'token' || draft.pair === 'xstock')) body.quoteToken = body.quoteAsset;
    if (draft.chain === 'local') body.rewardPolicy = policy;
    else body.reward = policy.recipients[0].target || ctx.wallet.address;
    phase = 'submitting'; statusState = { step: ctx.mode === 'local' ? 'submit' : STATUS_STEPS()[0][0], error: null, done: false }; draw();
    const onProgress = message => {
      statusState.message=message;
      if (/conver/i.test(message)) statusState.step = 'convert';
      else if (/approv/i.test(message)) statusState.step = 'approve';
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
        h('p', v2Chosen() ? `${draft.name} is trading in its Uniswap v4 pool on ${net()?.name}, liquidity locked from the first trade, at a ${feePercent()}% fee shared five ways (ELPIDA V2 test, not audited). Share it with your community.` : v4Chosen() ? `${draft.name} is trading in its Uniswap v4 pool on ${net()?.name}, with its liquidity locked from the first trade (Model 11 test, not audited). Share it with your community; creator fees follow the reward settings you chose.` : `${draft.name} is trading on its bonding curve${draft.chain === 'local' ? ' in the local simulation' : ` on ${net()?.name}`}. Share it with your community; creator fees follow the reward settings you chose.`),
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
      h('span.lk-saved', icon('check', 'icon-xs'), 'Draft saved in this browser'),
      step > 0 ? h('button.btn.btn-secondary', { type: 'button', disabled: phase === 'submitting', on: { click: () => go(step - 1) } }, icon('chevron-left', 'icon-sm'), 'Back') : h('a.btn.btn-ghost', { href: '#/' }, 'Cancel'),
      step < STEPS.length - 1 ? h('button.btn.btn-primary', { type: 'button', on: { click: () => go(step + 1) } }, 'Continue', icon('chevron-right', 'icon-sm'))
        : h('button.btn.btn-primary.btn-lg', { type: 'button', 'data-busy-disable': '', disabled: phase === 'submitting', on: { click: () => { if (current.validate()) create(); } } }, phase === 'failed' ? 'Try again' : 'Create token'));
    const status = statusState ? h('div.panel', { class: 'stack' }, h('h3', phase === 'failed' ? 'Your token was not created' : 'Creating your token'), statusView(),statusState.message?h('p.small',statusState.message):null,
      statusState.error ? callout('error', 'circle-alert', statusState.error, ' Your draft is saved, so you can adjust it and try again.') : null) : null;
    panel.replaceChildren(...[h('header.lk-sec-head', h('span.lk-ico', icon(STEP_ICONS[s.key] ?? 'sparkles')), h('div', h('span.step-kicker', `Step ${step + 1} of ${STEPS.length}`), h('h2', { tabindex: '-1' }, s.title), h('p', s.lead))), h('div.step-body', current.body), status, nav].filter(Boolean));
  }
  draw();
  loadRewards();
  return { root, update: () => { if(phase==='edit'&&draft.chain!==ctx.currentChain()){draft.chain=ctx.currentChain();draft.pair='native';draft.quoteAsset='';draft.feeCurrency='native';draft.buyWith='pair';maxStep=Math.min(maxStep,1);step=Math.min(step,1);networkError='Chain changed. Review the trading pair and reward availability before continuing. Your token details and reward draft are preserved.';save();draw();return;}  if (phase === 'edit' && STEPS[step].key === 'network') draw(); else if(phase==='edit'&&STEPS[step].key==='review')draw();else { drawStepper(); drawPreview();pricingRefresh(); } loadRewards(); } };
}
