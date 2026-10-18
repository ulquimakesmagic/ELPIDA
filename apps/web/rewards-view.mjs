import { nowSeconds } from './clock.mjs';
// Rewards: creator-fee distribution for the tokens you created, plus the local reward treasuries
// (threshold progress, completed holder distributions, claims, identity verification, vesting).
import { $, h, icon, short, number, avatar, callout, errorText, toast, copyButton } from './ui.mjs';

export const STRATEGIES = {
  creator: { name: 'Creator wallets', glyph: 'wallet' },
  holders: { name: 'Share fees with holders', glyph: 'users' },
  paired: { name: 'Buy a reward token for holders', glyph: 'coins' },
  buyback: { name: 'Buy back and vest to holders', glyph: 'hourglass' },
  exclusive: { name: 'Wallet, X and website allocations', glyph: 'badge-check' },
};
const amount = (value, symbol) => `${number(value, 6)} ${symbol}`;
const fromUnits = (raw, decimals) => { try { const v = BigInt(raw), s = 10n ** BigInt(decimals); return Number(v / s) + Number(v % s) / Number(s); } catch { return Number(raw) || 0; } };

export function renderRewards(ctx) {
  const root = h('div');
  const mine = ctx.state.tokens.filter(t => ctx.isCreatorOf(t)||t.creatorRecipients?.some(r=>r.address.toLowerCase()===String(ctx.state.wallet).toLowerCase()));
  root.append(h('div.page-head', h('div', h('h1', 'Rewards'), h('p', 'Claim creator fees, follow holder distributions and claim rewards allocated to you.'))));
  root.append(feesSection(ctx, mine));
  const treasuries = h('section.section', { 'aria-labelledby': 'treasury-title' });
  root.append(treasuries);
  if (ctx.mode !== 'local') {
    treasuries.append(h('h2#treasury-title', 'Reward treasuries'), callout('', 'info', 'Holder distributions, reward-token purchases, buybacks with vesting and X or website allocations run in the local simulation. Standard public launches use one creator wallet. Tax launches support fixed wallet allocations when a verified tax deployment is configured.'));
    return root;
  }
  treasuries.append(h('div.page-head', h('div', h('h2#treasury-title', 'Reward treasuries'), h('p', 'Each treasury holds the creator share of fees and follows the strategy fixed at launch.')),
    h('button.btn.btn-secondary.btn-sm', { type: 'button', 'data-busy-disable': '', on: { click: async e => { const button = e.currentTarget; button.disabled = true; try { toast((await ctx.api('reward-process', {})).message, { kind: 'success' }); await ctx.refresh(); } catch (err) { toast(errorText(err), { kind: 'error' }); } finally { button.disabled = false; } } } }, icon('refresh-cw', 'icon-sm'), 'Process rewards now')),
    h('p.small.muted', 'Holder payouts are weighted by each wallet’s eligible token balance at the recorded snapshot block. The unsold curve inventory, liquidity pools, burn addresses and treasuries are excluded. The local simulation processes treasuries after trades and every 30 seconds.'));
  const list = h('div.stack', h('div.skeleton', { 'aria-hidden': 'true' }));
  treasuries.append(list);
  ctx.api('rewards').then(data => {
    list.replaceChildren(...(data.rows.length ? data.rows.map(row => treasury(ctx, row, data)) : [h('div.empty', h('h3', 'No reward treasuries yet'), h('p', 'Create a token with a holder, buyback or allocation strategy to start one. Treasuries appear here with their progress and claims.'), h('a.btn.btn-primary', { href: '#/launch' }, icon('plus'), 'Create token'))]));
  }).catch(error => list.replaceChildren(callout('error', 'circle-alert', `Reward treasuries could not load. ${errorText(error)}`)));
  return root;
}

function feesSection(ctx, mine) {
  const section = h('section.section', { 'aria-labelledby': 'fees-title' }, h('h2#fees-title', 'Creator fees'));
  if (ctx.state.disconnected) { section.append(callout('', 'wallet', 'Connect your wallet to see the tokens you created.')); return section; }
  if (!mine.length) { section.append(h('div.empty', h('h3', 'No creator fees yet'), h('p', 'When you create a token, its creator fees appear here. Every curve trade pays 1.25%, split equally between Elpida and the creator.'), h('a.btn.btn-primary', { href: '#/launch' }, icon('plus'), 'Create token'))); return section; }
  section.append(h('p.small.muted', 'Claiming pays each share to its fixed recipient: the creator wallet or reward treasury, and Elpida. Recipients are fixed at launch; this action does not redirect fees to the connected wallet.'));
  const table = h('div.activity');
  for (const token of mine) {
    const q = token.quoteSymbol ?? ctx.state?.nativeSymbol ?? 'ETH';
    const harvest = Number(token.harvestableQuote) > 0;
    const nothing = token.tax ? Number(token.protocolFees)+Number(token.creatorAllocationFees)+Number(token.creatorTokenFees)===0 : !token.rewardVault && !token.feeSplitter && Number(token.protocolFees) + Number(token.creatorFees) === 0 && !harvest;
    const error = h('p.error-text', { role: 'alert' });
    table.append(h('div.fee-row',
      h('a.token-card-head', { href: `#/token/${token.address}` }, avatar(token), h('div', h('h3', token.name), h('span.sym.muted.small', token.tax?'Fixed creator allocations':token.rewardVault ? 'Reward treasury' : `Creator wallet ${short(token.reward)}`))),
      h('div.figure', h('span', token.tax?'Your creator allocation':'Creator share'), h('strong', token.tax?`${amount(token.creatorAllocationFees,q)} + ${amount(token.creatorTokenFees,token.symbol)}`:amount(token.creatorFees, q))),
      h('div.figure', h('span', harvest ? 'PumpSwap LP fees ready' : 'Elpida share'), h('strong', harvest ? `${number(token.harvestableQuote, 4)} ${q} + ${number(token.harvestableTokens, 0)} ${token.symbol}` : amount(token.protocolFees, q))),
      h('div', h('button.btn.btn-secondary.btn-sm', { type: 'button', 'data-busy-disable': '', disabled: nothing, on: { click: async () => { error.textContent = ''; try { await ctx.run('withdraw', { token: token.address }); } catch (e) { error.textContent = errorText(e); } } } }, 'Claim fees'), error)));
  }
  section.append(table);
  return section;
}

function treasury(ctx, row, data) {
  const strategy = STRATEGIES[row.policy.mode] ?? { name: row.policy.mode, glyph: 'gift' };
  const automated = ['holders', 'paired', 'buyback'].includes(row.policy.mode);
  const busyButton = (label, action, cls = 'btn-secondary') => h(`button.btn.btn-sm.${cls}`, { type: 'button', on: { click: async e => { const b = e.currentTarget; b.disabled = true; try { const r = await action(); if (r?.message) toast(r.message, { kind: 'success' }); await ctx.refresh(); } catch (err) { toast(errorText(err), { kind: 'error' }); b.disabled = false; } } } }, label);
  const group = (title, glyph, items, emptyText) => h('div.treasury-group', h('h4', icon(glyph, 'icon-sm'), title, h('span.count', items.length ? `(${items.length})` : '')), items.length ? items : h('p.empty-note', emptyText));
  const decimalsOf = asset => row.balances.find(b => b.asset === asset)?.decimals ?? 18;
  const symbolOf = asset => row.balances.find(b => b.asset === asset)?.symbol ?? 'tokens';

  const accumulating = automated
    ? row.balances.filter(b => Number(b.strategy) > 0 || b.asset === row.balances[0]?.asset).map(b => {
      const pct = Math.min(100, Number(b.strategy) / Number(row.policy.threshold) * 100);
      const track = h('div.bar', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)), 'aria-label': `${b.symbol} toward threshold` }, h('span'));
      requestAnimationFrame(() => { track.firstChild.style.width = `${pct}%`; });
      return h('div.alloc-card', h('div.row', h('strong', `${number(b.strategy, 6)} of ${number(row.policy.threshold, 6)} ${b.symbol}`), h('span.muted', `${number(pct, 0)}%`)), track);
    })
    : row.balances.filter(b => Number(b.held) > 0).map(b => h('div.alloc-card', h('div.row', h('strong', amount(b.held, b.symbol)), h('span.muted', 'total in treasury'))));
  const completed = row.events.map(e => h('div.alloc-card', h('strong', e.mode === 'buyback' ? `Bought back ${number(fromUnits(e.budget, decimalsOf(e.asset)), 4)} ${symbolOf(e.asset)}` : `Paid ${number(fromUnits(e.budget, decimalsOf(e.asset)), 6)} ${symbolOf(e.asset)}`),
    h('span.muted', `${e.holders} eligible ${e.holders === 1 ? 'holder' : 'holders'} · snapshot block ${e.snapshot}${e.mode === 'buyback' ? ' · added to vesting' : ''}`)));

  const ready = [], unverified = [], verified = [];
  for (const recipient of row.recipients) {
    const label = recipient.kind === 'x' ? `@${recipient.target}` : recipient.kind === 'domain' ? recipient.target : short(recipient.target);
    const kindLabel = recipient.kind === 'x' ? 'X account' : recipient.kind === 'domain' ? 'Website' : 'Wallet';
    const balances = recipient.balances.filter(b => Number(b.claimable) > 0);
    if (!recipient.verified) {
      unverified.push(h('div.alloc-card', h('div.row', h('strong', `${recipient.bps / 100}% · ${kindLabel} ${label}`)),
        h('span.muted', balances.length ? `Held in treasury: ${balances.map(b => amount(b.claimable, b.symbol)).join(', ')}` : 'Nothing allocated yet. Fees stay in the treasury until ownership is verified.'),
        h('div', h('button.btn.btn-secondary.btn-sm', { type: 'button', on: { click: () => openVerify(ctx, row, recipient, data) } }, icon(recipient.kind === 'x' ? 'at-sign' : 'globe', 'icon-sm'), 'Verify ownership'))));
      continue;
    }
    verified.push(h('div.alloc-card', h('div.row', h('strong', `${recipient.bps / 100}% · ${kindLabel} ${label}`), h('span.chip.chip-positive', icon('badge-check', 'icon-sm'), recipient.kind === 'wallet' ? 'Wallet' : 'Verified')), h('span.muted', `Payout wallet ${short(recipient.verified)}`)));
    for (const b of balances) ready.push(h('div.alloc-card', h('div.row', h('strong', amount(b.claimable, b.symbol)), h('span.muted', `${kindLabel} ${label}`)),
      h('span.muted', `Paid to ${short(recipient.verified)}`), h('div', busyButton(`Claim ${b.symbol}`, () => ctx.api('reward-claim', { token: row.token, index: recipient.index, asset: b.asset }), 'btn-primary'))));
  }
  const now = nowSeconds();
  const vesting = row.grants.map(g => {
    const unlocked = Number(g.total) * Math.min(1, Math.max(0, (now - g.start) / g.duration));
    const claimable = Math.max(0, unlocked - Number(g.claimed));
    return h('div.alloc-card', h('div.row', h('strong', `${number(g.total, 2)} ${row.symbol}`), h('span.muted', `${Math.round(g.duration / 86400)}-day vesting`)),
      h('span.muted', `Unlocked ${number(unlocked, 2)} · claimed ${number(g.claimed, 2)} · for ${short(g.recipient)}`),
      h('div', busyButton('Claim unlocked tokens', () => ctx.api('reward-claim', { token: row.token, grant: g.index }))));
  });
  if (vesting.length) vesting.forEach(v => { const b = v.querySelector('button'); const text = v.querySelector('.muted:last-of-type'); if (text && /Unlocked 0 ·/.test(text.textContent)) b.disabled = true; });

  const groups = [];
  if (automated) groups.push(group('Accumulating toward threshold', 'hourglass', accumulating, 'No fees collected since the last distribution.'));
  else groups.push(group('Held in treasury', 'lock', accumulating, 'No fees collected yet.'));
  if (automated) groups.push(group('Completed holder distributions', 'users', completed, `No distribution yet. One runs when ${row.policy.threshold} in the trading asset has accumulated and eligible holders exist.`));
  if (!automated) groups.push(group('Ready to claim', 'gift', ready, 'Nothing to claim yet.'));
  if (row.policy.mode === 'exclusive') groups.push(group('Awaiting ownership verification', 'shield-check', unverified, 'No unverified X or website allocations.'));
  if (!automated) groups.push(group('Verified allocations', 'badge-check', verified, 'No verified allocations yet.'));
  if (row.policy.mode === 'buyback') groups.push(group('Vesting', 'clock', vesting, 'Bought-back tokens appear here as they vest.'));
  const settings = automated ? `Distribution threshold ${row.policy.threshold} · minimum token holding ${number(row.policy.minimumHolding, 0)} ${row.symbol}${row.policy.mode === 'buyback' ? ` · ${row.policy.vestingDays}-day vesting` : ''}` : `${row.recipients.length} ${row.recipients.length === 1 ? 'recipient' : 'recipients'}, fixed at launch`;
  return h('article.treasury', h('header', h('div', h('h3', `${row.symbol} · ${strategy.name}`), h('p.small.muted', settings)), h('span.chip', row.status)),
    h('div.treasury-groups', groups),
    h('details.tech', { class: 'treasury-tech' }, h('summary', 'Technical details', icon('chevron-down', 'icon-sm')), h('dl.kv', h('dt', 'Treasury contract'), h('dd', row.vault), h('dt', 'Token'), h('dd', row.token))));
}

function openVerify(ctx, row, recipient, data) {
  const dialog = $('#verify-dialog'), body = $('#verify-body');
  const x = recipient.kind === 'x';
  const target = x ? `@${recipient.target}` : recipient.target;
  $('#verify-title').textContent = `Verify ${target}`;
  $('#verify-intro').textContent = x ? 'Prove you control this X account and choose the wallet that receives its rewards. Funds stay in the treasury until verification succeeds.' : 'Prove you control this website with a DNS record and choose the wallet that receives its rewards. Funds stay in the treasury until verification succeeds.';
  if (x && !data.xVerificationConfigured) {
    body.replaceChildren(callout('warn', 'triangle-alert', 'X verification is not available on this server yet. Your allocation remains in the treasury until the service is enabled and you verify ownership.'), h('button.btn.btn-secondary', { type: 'button', on: { click: () => dialog.close() } }, 'Close'));
    dialog.showModal(); return;
  }
  let challenge = null;
  const walletInput = h('input.input#verify-wallet', { 'aria-label': 'Payout wallet', placeholder: '0x…', autocomplete: 'off', spellcheck: false });
  const signature = h('input.input#verify-signature', { placeholder: '0x…', autocomplete: 'off', spellcheck: false });
  const error = h('p.error-text', { role: 'alert' });
  const recordBox = h('div.stack');
  const steps = h('ol.verify-steps');
  const fail = e => {
    const text = errorText(e);
    error.textContent = /DNS TXT record is not visible/i.test(text) ? 'The DNS record is not visible yet. Check that the name and value match exactly, wait a few minutes for DNS to update, then try again.' : /expired/i.test(text) ? 'This challenge expired after 10 minutes. Get a new record and sign again.' : text;
  };
  const step1 = h('li', h('div', h('h4', 'Choose the payout wallet'), h('p.small.muted', 'Rewards for this allocation are paid to this wallet after verification. It cannot be changed later.'),
    walletInput, h('div', h('button.btn.btn-secondary.btn-sm', { type: 'button', on: { click: async () => { try { const eth = ctx.evmProvider() ?? window.ethereum; if (!eth) throw new Error('No browser wallet found. Paste the payout address instead.'); const [a] = await eth.request({ method: 'eth_requestAccounts' }); walletInput.value = a; } catch (e) { fail(e); } } } }, icon('wallet', 'icon-sm'), 'Use connected wallet'))));
  const step2 = h('li', h('div', h('h4', x ? 'Create a sign-in challenge' : 'Add the DNS record'),
    h('p.small.muted', x ? 'The challenge links this X account to your payout wallet for 10 minutes.' : `Add this TXT record at your DNS provider for ${recipient.target}. The record is valid for 10 minutes.`),
    h('div', h('button.btn.btn-secondary.btn-sm', { type: 'button', on: { click: async () => {
      error.textContent = '';
      try {
        challenge = await ctx.api('reward-challenge', { token: row.token, index: recipient.index, wallet: walletInput.value.trim() });
        step1.dataset.done = 'true';
        recordBox.replaceChildren(...(!x ? [h('div.record', h('span.muted', 'Type'), h('code', 'TXT'), h('span')), h('div.record', h('span.muted', 'Name'), h('code', challenge.name), copyButton(challenge.name, 'Copy')), h('div.record', h('span.muted', 'Value'), h('code', challenge.txt), copyButton(challenge.txt, 'Copy'))] : []),
          h('p.small.muted', 'Message to sign with the payout wallet:'), h('pre.message-box', challenge.message));
      } catch (e) { fail(e); }
    } } }, x ? 'Create challenge' : 'Get DNS record')), recordBox));
  const step3 = h('li', h('div', h('h4', 'Sign with the payout wallet'), h('p.small.muted', 'Signing proves you control the payout wallet. It is free and sends no transaction.'),
    h('div', h('button.btn.btn-secondary.btn-sm', { type: 'button', on: { click: async () => {
      error.textContent = '';
      try {
        if (!challenge) throw new Error(x ? 'Create the challenge first.' : 'Get the DNS record first.');
        const eth = ctx.evmProvider() ?? window.ethereum;
        if (!eth) throw new Error('No browser wallet found. Sign the message elsewhere and paste the signature below.');
        const [a] = await eth.request({ method: 'eth_requestAccounts' });
        if (a.toLowerCase() !== walletInput.value.trim().toLowerCase()) throw new Error('Switch your wallet to the payout address entered in step 1.');
        const hex = '0x' + [...new TextEncoder().encode(challenge.message)].map(n => n.toString(16).padStart(2, '0')).join('');
        signature.value = await eth.request({ method: 'personal_sign', params: [hex, a] });
        step2.dataset.done = 'true';
      } catch (e) { fail(e); }
    } } }, icon('pencil', 'icon-sm'), 'Sign message')),
    h('div.field', h('label', { for: 'verify-signature' }, 'Signature'), signature)));
  const step4 = h('li', h('div', h('h4', x ? 'Sign in with X' : 'Check the record'), h('p.small.muted', x ? 'You will be sent to X to sign in. Elpida only reads your account name and never posts.' : 'Elpida looks up the TXT record and binds this website to your payout wallet.'),
    h('div', h('button.btn.btn-primary', { type: 'button', on: { click: async () => {
      error.textContent = '';
      try {
        if (!challenge) throw new Error(x ? 'Create the challenge first.' : 'Get the DNS record first.');
        if (!signature.value.trim()) throw new Error('Sign the message or paste the signature first.');
        if (x) { const result = await ctx.api('reward-x-start', { nonce: challenge.nonce, signature: signature.value.trim() }); const url = new URL(result.url); if (url.origin !== 'https://x.com') throw new Error('Unexpected sign-in address. Verification stopped.'); location.assign(url.href); return; }
        const result = await ctx.api('reward-verify', { nonce: challenge.nonce, signature: signature.value.trim() });
        dialog.close(); toast(result.message, { kind: 'success' }); await ctx.refresh();
      } catch (e) { fail(e); }
    } } }, x ? 'Continue to X' : 'Verify ownership'))));
  steps.append(step1, step2, step3, step4);
  body.replaceChildren(steps, error);
  dialog.showModal();
}
