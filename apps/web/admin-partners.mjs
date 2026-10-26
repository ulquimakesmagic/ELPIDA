import { h, icon, short, errorText, toast, copyButton } from './ui.mjs';
import { chainIcon } from './chain-ui.mjs';
import { withWalletTimeout } from './wallet.mjs';

// Admin panel, Partners area (docs/DESIGN_PARTNER_TIERS.md section 3). Operators review applications, approve with a
// tier, a window and the chains to register, or reject. Approval only records the decision: registering the wallet is
// the factory's setPartner, which the treasury wallet signs. This page shows that call per chain (to paste into a Safe)
// and can send it from the connected wallet when that wallet is the chain's treasury. The on-chain record is read back,
// so "registered" always means the factory says so.

const TIER = { partner: { name: 'Partner', split: '50 · 10 · 40' }, elite: { name: 'Elite', split: '50 · 20 · 30' } };
const date = s => new Date(s * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const when = ms => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const STATE = { registered: ['ok', 'registered'], none: ['warn', 'not registered'], different: ['bad', 'different terms'], unsupported: ['warn', 'factory has no registry'], error: ['bad', 'RPC error'] };

export function renderPartners(ctx, { getJson }) {
  const root = h('div.op-dash.pa');
  const post = (path, body) => getJson(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Elpida-Token': ctx.config.csrf }, body: JSON.stringify(body) });

  async function load(fresh = false) {
    root.replaceChildren(h('p.muted', 'Loading applications…'));
    try { const d = await getJson(`admin/partners${fresh ? '?fresh=1' : ''}`); root.replaceChildren(...view(d).filter(Boolean)); }
    catch (e) { root.replaceChildren(h('div.pf-empty', h('h2', 'Partners unavailable'), h('p', errorText(e)), h('button.btn.btn-secondary', { type: 'button', on: { click: () => load() } }, 'Retry'))); }
  }

  async function decide(id, body, done) {
    try { await post('admin/partners/review', { id, ...body }); toast(done, { kind: 'success' }); load(true); }
    catch (e) { toast(errorText(e), { kind: 'error' }); }
  }

  function contact(a) {
    return h('div.pa-contact',
      a.x ? h('a', { href: `https://x.com/${encodeURIComponent(a.x)}`, target: '_blank', rel: 'noopener noreferrer' }, icon('at-sign', 'icon-xs'), a.x) : null,
      a.telegram ? h('a', { href: `https://t.me/${encodeURIComponent(a.telegram)}`, target: '_blank', rel: 'noopener noreferrer' }, icon('send', 'icon-xs'), a.telegram) : null,
      a.email ? h('span.mono.small', a.email) : null);
  }
  const wallets = a => h('dl.op-kv', [a.evm && [h('dt', 'EVM wallet'), h('dd', copyButton(a.evm, short(a.evm)))], a.solana && [h('dt', 'Solana wallet'), h('dd', copyButton(a.solana, short(a.solana)))]].filter(Boolean).flat());
  const notes = a => a.notes.length ? h('ul.pa-notes', a.notes.map(n => h('li', h('span.muted.small', `${when(n.at)} · ${short(n.by)} · ${n.action}`), n.note ? h('span', ` ${n.note}`) : null))) : null;

  function noteForm(a) {
    const text = h('input.input', { placeholder: 'Add a note for other operators', maxlength: 500 });
    return h('form.pa-note', { on: { submit: e => { e.preventDefault(); if (text.value.trim()) decide(a.id, { decision: 'note', note: text.value }, 'Note added.'); } } }, text, h('button.btn.btn-secondary.btn-sm', { type: 'submit' }, 'Add note'));
  }

  function pending(a, networks) {
    const tier = h('select.select', ['partner', 'elite'].map(t => h('option', { value: t, selected: t === a.tier }, `${TIER[t].name} (${TIER[t].split})`)));
    const days = h('select.select', [30, 45, 60, 90].map(d => h('option', { value: d, selected: d === 60 }, `${d} days`)));
    const boxes = networks.map(n => {
      const usable = n.kind === 'evm' ? !!(a.evm && n.factory) : !!(a.solana && n.supported);
      const reason = n.kind === 'solana' ? (!a.solana ? 'No Solana wallet given.' : n.supported ? '' : n.reason) : !a.evm ? 'No EVM wallet given.' : !n.factory ? 'No factory on this network.' : '';
      const box = h('input', { type: 'checkbox', value: n.key, checked: usable, disabled: !usable });
      return h('label.pa-chain', { title: reason }, box, chainIcon(n.key), h('span', n.name), reason ? h('small.muted', ` ${reason}`) : null);
    });
    const note = h('input.input', { placeholder: 'Reason or note (optional)', maxlength: 500 });
    const approve = h('button.btn-accent.btn-sm', { type: 'button', on: { click: () => {
      const chains = boxes.map(l => l.querySelector('input')).filter(b => b.checked && !b.disabled).map(b => b.value);
      if (!chains.length) { toast('Choose at least one chain to register.', { kind: 'error' }); return; }
      decide(a.id, { decision: 'approve', tier: tier.value, days: Number(days.value), chains, note: note.value }, 'Approved. Register the wallet on each chain below.');
    } } }, icon('check', 'icon-sm'), 'Approve');
    const reject = h('button.btn.btn-secondary.btn-sm', { type: 'button', on: { click: () => decide(a.id, { decision: 'reject', note: note.value }, 'Application rejected.') } }, 'Reject');
    return h('article.tk-card.op-card.pa-app',
      h('header.pa-app-head', h('div', h('strong', `${TIER[a.tier].name} requested`), h('span.muted.small', ` · ${when(a.created)}`)), contact(a)),
      wallets(a),
      h('p.pa-pitch', a.pitch),
      a.links.length ? h('ul.pa-links', a.links.map(l => h('li', h('a', { href: l, target: '_blank', rel: 'noopener noreferrer nofollow' }, l)))) : null,
      notes(a),
      h('div.pa-decide',
        h('div.pa-row', h('label.field-label', 'Tier', tier), h('label.field-label', 'Window', days)),
        h('fieldset.pa-chains', h('legend.field-label', 'Register on'), boxes),
        note, h('div.op-actions', approve, reject)),
      noteForm(a));
  }

  function chainRow(a, n, record, call) {
    const [lvl, label] = STATE[record?.state] ?? ['warn', 'unknown'];
    const ended = a.status === 'ended';
    const needs = ended ? record?.state !== 'none' && record?.state !== 'unsupported' : record?.state !== 'registered' && record?.state !== 'unsupported';
    const treasury = n.treasury?.toLowerCase();
    // Read the wallet at click time: the operator may connect the treasury after this page was drawn.
    const canSend = () => ctx.mode === 'testnet' && ctx.wallet !== ctx.solWallet && ctx.wallet?.net?.key === n.key && !!treasury && ctx.wallet.address?.toLowerCase() === treasury;
    const send = h('button.btn.btn-secondary.btn-sm', { type: 'button', on: { click: async () => {
      if (!canSend()) { toast(treasury ? `Connect the treasury ${short(treasury)} on ${n.name} to send this, or paste the call into the treasury Safe.` : `The treasury on ${n.name} is unknown right now (RPC unavailable).`, { kind: 'error' }); return; }
      send.disabled = true;
      try {
        await ctx.wallet.checkNetwork?.();
        const tx = await withWalletTimeout(ctx.wallet.signer.sendTransaction({ to: call.to, data: call.data }), ctx.wallet.walletName);
        toast('Sent. Waiting for confirmation…', { link: n.explorer ? { href: `${n.explorer}/tx/${tx.hash}` } : undefined });
        await tx.wait();
        toast(ended ? 'Tier cleared on chain.' : 'Wallet registered on chain.', { kind: 'success' });
        load(true);
      } catch (e) { toast(errorText(e), { kind: 'error' }); send.disabled = false; }
    } } }, icon('wallet', 'icon-sm'), ended ? 'Clear with treasury' : 'Register with treasury');
    return h('div.pa-reg',
      h('div.pa-reg-head', h('span.op-net', chainIcon(n.key), n.name), h(`span.op-pill.op-${ended && record?.state === 'none' ? 'ok' : lvl}`, ended && record?.state === 'none' ? 'cleared' : label),
        record?.state === 'different' ? h('small.muted', ` on chain: ${record.buybackBps / 100}% until ${date(record.expiresAt)}`) : null,
        record?.state === 'error' ? h('small.muted', ` ${record.error}`) : null),
      needs && call ? h('div.pa-call',
        h('dl.op-kv', h('dt', 'To (factory)'), h('dd', copyButton(call.to, short(call.to))), h('dt', 'Data'), h('dd', copyButton(call.data, `${call.data.slice(0, 18)}…`)), h('dt', 'Value'), h('dd', '0')),
        h('div.op-actions', send, h('span.small.muted', treasury ? `Treasury ${short(treasury)}. Or paste the call into the treasury Safe on ${n.name}.` : 'Treasury unknown: RPC unavailable.'))) : null);
  }

  /** Solana: the SOL pair's treasury signs `set_partner`; the page builds it from the approved terms. */
  function solanaRow(a, n, record) {
    const ended = a.status === 'ended';
    const [lvl, label] = ended && record?.state === 'none' ? ['ok', 'cleared'] : STATE[record?.state] ?? ['warn', 'unknown'];
    const needs = ended ? record?.state !== 'none' : record?.state !== 'registered';
    const terms = ended ? { buybackBps: 0, expiresAt: 0 } : { buybackBps: a.approved.buybackBps, expiresAt: a.approved.expiresAt };
    const treasury = n.treasury;
    const canSend = () => ctx.mode === 'testnet' && ctx.wallet === ctx.solWallet && ctx.wallet?.net?.key === n.key && !!treasury && ctx.wallet.address === treasury;
    const send = h('button.btn.btn-secondary.btn-sm', { type: 'button', on: { click: async () => {
      if (!canSend()) { toast(treasury ? `Connect the Solana treasury ${short(treasury)} on ${n.name} to send this, or run the command shown.` : 'The Solana treasury is unknown.', { kind: 'error' }); return; }
      send.disabled = true;
      try {
        const w = ctx.wallet, ix = w.client.setPartner({ authority: w.publicKey, creator: a.solana, ...terms });
        await w.sendInstructions([ix], [], ended ? 'Confirm clearing the partner tier…' : 'Confirm the partner registration…');
        toast(ended ? 'Tier cleared on Solana.' : 'Wallet registered on Solana.', { kind: 'success' });
        load(true);
      } catch (e) { toast(errorText(e), { kind: 'error' }); send.disabled = false; }
    } } }, icon('wallet', 'icon-sm'), ended ? 'Clear with treasury' : 'Register with treasury');
    const command = `npm run solana:partner -- --cluster ${n.cluster ?? 'devnet'} --creator ${a.solana} --bps ${terms.buybackBps} --expires ${terms.expiresAt}`;
    return h('div.pa-reg',
      h('div.pa-reg-head', h('span.op-net', chainIcon(n.key), n.name), h(`span.op-pill.op-${lvl}`, label),
        record?.state === 'different' ? h('small.muted', ` on chain: ${record.buybackBps / 100}% until ${date(record.expiresAt)}`) : null,
        record?.state === 'error' ? h('small.muted', ` ${record.error}`) : null),
      needs ? h('div.pa-call',
        h('dl.op-kv', h('dt', 'Wallet'), h('dd', copyButton(a.solana, short(a.solana))), h('dt', 'Terms'), h('dd', terms.buybackBps ? `${terms.buybackBps / 100}% until ${date(terms.expiresAt)}` : 'end (0, 0)'),
          h('dt', 'Or run'), h('dd', copyButton(command, 'copy command'))),
        h('div.op-actions', send, h('span.small.muted', treasury ? `Treasury ${short(treasury)} (the SOL pair's treasury, which is the deploy key on devnet).` : ''))) : null);
  }

  function partner(a, networks, registry, calls) {
    const t = TIER[a.approved.tier], expired = a.approved.expiresAt * 1000 < Date.now();
    const end = h('button.btn.btn-secondary.btn-sm', { type: 'button', on: { click: () => { if (end.dataset.armed) decide(a.id, { decision: 'end' }, 'Partnership ended. Clear the tier on each chain below.'); else { end.dataset.armed = '1'; end.textContent = 'Click again to end'; } } } }, 'End partnership');
    // A chain approved earlier but no longer configured on this server still shows, so nothing silently disappears.
    const chains = a.approved.chains.map(key => networks.find(n => n.key === key) ?? { key, name: key, kind: 'missing' });
    return h('article.tk-card.op-card.pa-app',
      h('header.pa-app-head', h('div', h('strong', `${t.name} · ${t.split}`), h('span.muted.small', a.status === 'ended' ? ' · ended' : expired ? ` · window closed ${date(a.approved.expiresAt)}` : ` · launches until ${date(a.approved.expiresAt)}`)), contact(a)),
      wallets(a),
      chains.map(n => n.kind === 'missing' ? h('div.pa-reg', h('div.pa-reg-head', h('span.op-net', chainIcon(n.key), n.name), h('span.op-pill.op-warn', 'not configured'), h('small.muted', ' This server does not index this network.'))) : n.kind === 'solana' ? (n.supported ? solanaRow(a, n, registry?.[a.id]?.[n.key]) : h('div.pa-reg', h('div.pa-reg-head', h('span.op-net', chainIcon(n.key), n.name), h('span.op-pill.op-warn', 'not available'), h('small.muted', ` ${n.reason}`)))) : chainRow(a, n, registry?.[a.id]?.[n.key], calls?.[a.id]?.[n.key])),
      notes(a),
      a.status === 'approved' && !expired ? h('div.op-actions', end) : null,
      noteForm(a));
  }

  function view(d) {
    const by = s => d.applications.filter(a => a.status === s);
    const open = by('pending'), active = by('approved'), ended = by('ended'), rejected = by('rejected');
    const section = (title, items, empty) => h('section.pa-section', h('h2.tk-h', title, h('span.muted', ` ${items.length}`)), items.length ? items : h('p.small.muted', empty));
    return [
      h('header.op-head', h('div', h('h1', 'Partners'), h('p.small.muted', `${open.length} waiting · ${active.length} active · signed in as `, h('span.mono', short(d.operator)))),
        h('div.op-actions', h('a.btn.btn-secondary.btn-sm', { href: '#/partners', target: '_blank' }, 'Open the form'), h('button.btn.btn-secondary.btn-sm', { type: 'button', on: { click: () => load(true) } }, icon('refresh-cw', 'icon-sm'), 'Refresh'))),
      d.registryError ? h('div.callout.callout-warn', icon('triangle-alert'), h('div', `On-chain status unavailable: ${d.registryError}`)) : null,
      section('Applications', open.map(a => pending(a, d.networks)), 'No applications waiting.'),
      section('Active partners', active.map(a => partner(a, d.networks, d.registry, d.calls)), 'No active partners yet.'),
      ended.length ? section('Ended', ended.map(a => partner(a, d.networks, d.registry, d.calls)), '') : null,
      rejected.length ? h('details.pa-closed', h('summary', `Rejected (${rejected.length})`), rejected.map(a => h('article.tk-card.op-card.pa-app', h('header.pa-app-head', h('div', h('strong', `${TIER[a.tier].name} requested`), h('span.muted.small', ` · ${when(a.created)}`)), contact(a)), wallets(a), a.pitch ? h('p.pa-pitch', a.pitch) : h('p.small.muted', 'Details erased after six months.'), notes(a)))) : null,
    ];
  }

  load();
  return root;
}
