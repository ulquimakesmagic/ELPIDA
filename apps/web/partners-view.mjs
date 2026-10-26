import { h, icon, short, field, callout, errorText, storage } from './ui.mjs';
import { withWalletTimeout } from './wallet.mjs';

// "Partner with Elpida" (#/partners), linked from the footer. Devs apply for an early-partner tier
// (docs/DESIGN_PARTNER_TIERS.md): the creator keeps 50% of fees, and 10% (Partner) or 20% (Elite) buys back and burns
// the token, out of Elpida's share. The applicant signs one free message per launching wallet to prove control.
// The application goes to the server, is never public, and is reviewed by Elpida in the admin panel.

const DRAFT = 'elpida:partner-application';
const TERMS = [
  'The tier applies only to tokens your approved wallet launches before the expiry date Elpida sets at approval (usually one to two months).',
  'Those tokens keep the tier for life: you keep 50% of trading fees, and 10% (Partner) or 20% (Elite) buys back and burns your token, taken from Elpida’s share.',
  'Tokens launched before approval, after the expiry, or from another wallet are standard (50/50).',
  'Elpida may end a partnership early. That only affects future launches, never tokens already launched.',
  'Elite is for established projects and is assigned by Elpida at review. Applying does not guarantee a tier.',
];

async function post(ctx, path, body) {
  const response = await fetch(`/api/${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Elpida-Token': ctx.config.csrf }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error ?? `Request failed (${response.status}).`), { status: response.status });
  return data;
}

export function partnersView(ctx, { connect }) {
  const draft = { x: '', telegram: '', email: '', tier: 'partner', pitch: '', links: '', ...(storage.get(DRAFT) ?? {}) };
  const proofs = { evm: null, solana: null };
  const save = () => storage.set(DRAFT, draft);
  const root = h('div.pt');
  const walletBox = h('div.pt-wallets');
  const status = h('p.small.muted', { role: 'status', 'aria-live': 'polite' });
  const formError = h('p.error-text', { role: 'alert' });

  const input = (key, attrs = {}) => h(attrs.multiline ? 'textarea.textarea' : 'input.input', { ...attrs, multiline: undefined, value: draft[key], on: { input: e => { draft[key] = e.target.value; save(); } } });

  function currentKind() {
    if (ctx.mode !== 'testnet' || !ctx.wallet?.address) return null;
    return ctx.wallet === ctx.solWallet ? 'solana' : 'evm';
  }

  async function sign(kind) {
    formError.textContent = '';
    const wallet = ctx.wallet, address = wallet.address;
    status.textContent = 'Waiting for your wallet…';
    try {
      const challenge = await post(ctx, 'partners/challenge', { kind, address });
      let signature;
      if (kind === 'solana') {
        if (!wallet.provider?.signMessage) throw new Error('This Solana wallet cannot sign messages. Try Phantom, Solflare or Backpack.');
        const result = await withWalletTimeout(wallet.provider.signMessage(new TextEncoder().encode(challenge.message), 'utf8'), wallet.walletName);
        signature = btoa(String.fromCharCode(...(result.signature ?? result)));
      } else {
        await wallet.checkNetwork?.();
        signature = await withWalletTimeout(wallet.signer.signMessage(challenge.message), wallet.walletName);
      }
      proofs[kind] = { address: challenge.wallet, nonce: challenge.nonce, signature, expires: challenge.expires };
      status.textContent = '';
    } catch (e) { status.textContent = ''; formError.textContent = errorText(e); }
    drawWallets();
  }

  function walletRow(kind, label, other) {
    const proof = proofs[kind] && proofs[kind].expires > Date.now() ? proofs[kind] : null;
    const here = currentKind() === kind;
    return h('div.pt-wallet',
      h('div.pt-wallet-head', h('strong', label), proof ? h('span.op-pill.op-ok', 'signed') : h('span.op-pill', 'not added')),
      proof ? h('p.small', h('span.mono', short(proof.address)), ' · ', h('button.link-plain', { type: 'button', on: { click: () => { proofs[kind] = null; drawWallets(); } } }, 'Remove'))
        : here ? h('div.pt-wallet-act', h('p.small.muted', 'Connected: ', h('span.mono', short(ctx.wallet.address))),
            h('button.btn.btn-secondary.btn-sm', { type: 'button', on: { click: () => sign(kind) } }, icon('pencil', 'icon-sm'), 'Sign to prove this wallet'))
        : h('p.small.muted', `To add it, switch to ${other} in the network menu and connect the wallet you launch from.`));
  }

  function drawWallets() {
    const kind = currentKind();
    walletBox.replaceChildren(
      !kind ? h('div.pt-connect', h('p.small.muted', ctx.mode === 'testnet' ? 'Connect the wallet you will launch from.' : 'Choose a test network and connect the wallet you will launch from.'), ctx.mode === 'testnet' ? h('button.btn.btn-secondary.btn-sm', { type: 'button', on: { click: connect } }, icon('wallet', 'icon-sm'), 'Connect wallet') : null) : null,
      walletRow('evm', 'EVM launching wallet', 'Base, Ethereum, BNB or Robinhood'),
      walletRow('solana', 'Solana launching wallet', 'Solana'),
      h('p.hint', 'Add one or both. Signing is free and sends no transaction. Only these wallets can receive the tier.'));
  }

  const tierChoice = (value, title, share, text) => h('label.choice.pt-tier',
    h('input', { type: 'radio', name: 'pt-tier', value, checked: draft.tier === value, on: { change: () => { draft.tier = value; save(); } } }),
    h('span.pt-tier-body', h('strong', title), h('span.pt-split', share), h('span.small.muted', text)));

  const accept = h('input', { type: 'checkbox', id: 'pt-terms' });
  const submit = h('button.btn-accent', { type: 'submit' }, 'Send application');

  async function onSubmit(event) {
    event.preventDefault(); formError.textContent = '';
    const live = k => proofs[k] && proofs[k].expires > Date.now() ? proofs[k] : null;
    if (!live('evm') && !live('solana')) { formError.textContent = 'Add at least one launching wallet and sign with it.'; return; }
    submit.disabled = true; status.textContent = 'Sending…';
    try {
      const strip = p => p ? { address: p.address, nonce: p.nonce, signature: p.signature } : undefined;
      await post(ctx, 'partners/apply', { ...draft, links: draft.links.split(/\s+/).filter(Boolean), evm: strip(live('evm')), solana: strip(live('solana')), acceptTerms: accept.checked });
      storage.remove(DRAFT);
      root.replaceChildren(h('section.tk-card.pt-done', h('span.pf-mark', icon('circle-check')), h('h1', 'Application sent'),
        h('p.muted', 'Elpida reviews every application by hand. We will reach out on X or Telegram. If you are approved, your wallet is registered on chain, and the launch page shows your tier before you launch.'),
        h('a.btn.btn-secondary', { href: '#/' }, 'Back to Explore')));
    } catch (e) {
      status.textContent = ''; formError.textContent = errorText(e); submit.disabled = false;
      if (/signature expired|Sign again/i.test(e.message)) { proofs.evm = null; proofs.solana = null; drawWallets(); }
    }
  }

  const form = h('form.pt-form.tk-card', { on: { submit: onSubmit }, novalidate: true },
    h('h2.tk-h', 'Apply'),
    h('fieldset.stack', h('legend.field-label', 'Tier'),
      h('div.choice-grid.pt-tiers', { role: 'radiogroup' },
        tierChoice('partner', 'Partner', '50 · 10 · 40', 'You 50%, buyback and burn 10%, Elpida 40%.'),
        tierChoice('elite', 'Elite', '50 · 20 · 30', 'For established projects. You 50%, buyback and burn 20%, Elpida 30%.'))),
    h('fieldset.stack', h('legend.field-label', 'Launching wallets'), walletBox),
    h('div.row-2',
      field({ label: 'X handle', control: input('x', { placeholder: '@yourname', autocomplete: 'off', maxlength: 16 }) }),
      field({ label: 'Telegram', control: input('telegram', { placeholder: '@yourname', autocomplete: 'off', maxlength: 33 }) })),
    field({ label: 'Email', optional: true, control: input('email', { type: 'email', placeholder: 'you@example.com', maxlength: 120 }) }),
    field({ label: 'About you and what you will launch', control: input('pitch', { multiline: true, rows: 5, maxlength: 1200, placeholder: 'Your project, your community, and what you plan to launch on Elpida.' }), hint: 'At least a sentence, up to 1,200 characters.' }),
    field({ label: 'Links', optional: true, control: input('links', { multiline: true, rows: 3, placeholder: 'https://… one per line: past launches, your project, your community' }), hint: 'Up to five https links.' }),
    h('div.pt-terms', h('h3', 'Partner terms'), h('ul', TERMS.map(t => h('li', t))),
      h('label.pt-accept', accept, h('span', 'I accept these terms.'))),
    formError, status, submit,
    h('p.hint', 'Your application is private. Elpida keeps only what is on this form, and erases contact details from declined applications after six months.'));

  root.append(
    h('header.pt-head', h('span.pf-mark', icon('flame')), h('div',
      h('h1', 'Partner with Elpida'),
      h('p.muted', 'Early partners turn part of Elpida’s fee share into a buyback and burn of their own token, on every trade and after graduation. Your 50% never changes.'))),
    h('div.pt-grid',
      form,
      h('aside.tk-card.pt-how', h('h2.tk-h', 'How it works'),
        h('ol.pt-steps',
          h('li', h('strong', 'Apply'), h('span', 'Prove your launching wallets with a free signature.')),
          h('li', h('strong', 'Review'), h('span', 'Elpida reviews each application and sets your tier and window.')),
          h('li', h('strong', 'Registered on chain'), h('span', 'The treasury registers your wallet in the launch factory on each chain.')),
          h('li', h('strong', 'Launch'), h('span', 'Every token you launch in the window burns 10% or 20% of fees, for life.'))),
        callout('', 'info', 'Testnet: partner tiers are live on the EVM test networks, and on Solana devnet once its program upgrade is applied.'))));
  drawWallets();
  return { root, update: drawWallets };
}
