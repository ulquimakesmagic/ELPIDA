import { h, icon, short, errorText, toast } from './ui.mjs';
import { chainIcon, assetIcon } from './chain-ui.mjs';
import { testLiquidityTools } from './test-stock-liquidity-ui.mjs';
import { stockApprovalGate } from './stock-approval.mjs';

// Operator panel, Pairs tab (#/monkey?tab=pairs, 3 November 2026). Every trading-pair approval for the launchpad
// lives here and only here: the labelled test pairs on testnets, the USDC pair, and real tokenized stocks on mainnet
// (one at a time, only once the verified registry allows it). The test stock issuer controls and the test conversion
// tools moved here too. Approvals are on-chain treasury calls: sent from the connected wallet when it is the
// treasury, otherwise downloaded as a Safe Transaction Builder file. The public account panel no longer shows any of it.

function downloadSafeBatch(result) {
  if (!result?.safeBatch) return result;
  const url = URL.createObjectURL(new Blob([JSON.stringify(result.safeBatch, null, 2)], { type: 'application/json' }));
  const link = h('a', { href: url, download: `elpida-treasury-${result.safeBatch.chainId}-${Date.now()}.json` });
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  return result;
}

/** The test issuer's controls for Ondo-style test stocks: price, market status, pause and blocklist. */
export function testStockControls(wallet, run, fail) {
  const stocks = (wallet.approvedQuotes ?? []).filter(a => a.stock?.provider === 'ondo-test');
  if (!stocks.length) return null;
  const act = async body => { try { await run('test-stock', body); } catch (e) { fail(e); } };
  return h('section.tk-card.op-card', h('h2.tk-h', 'Test stock issuer controls'),
    h('p.small.muted', 'Only the launchpad treasury that deployed them can use these. They rehearse what a real stock issuer can do: post the total-return price, freeze it for a corporate action, pause the stock or block a wallet. Token pages update within about a minute.'),
    ...stocks.map(a => {
      const price = h('input.input', { inputmode: 'decimal', placeholder: 'USD price, e.g. 180', 'aria-label': `${a.symbol} test price in USD` });
      const status = h('select.input', { 'aria-label': `${a.symbol} market status` }, ['open', 'closed', 'corporate-action'].map(v => h('option', { value: v }, v === 'corporate-action' ? 'Corporate action' : v[0].toUpperCase() + v.slice(1))));
      const account = h('input.input', { placeholder: '0x… wallet to block or unblock', spellcheck: false, autocomplete: 'off', 'aria-label': `Wallet to block on ${a.symbol}` });
      const btn = (label, body) => h('button.btn.btn-secondary.btn-sm', { type: 'button', 'data-busy-disable': '', on: { click: () => act({ asset: a.address, ...body() }) } }, label);
      return h('details.stack', h('summary', h('strong', a.symbol), ` · ${short(a.address)}`),
        h('div.wallet-choices', price, btn('Post price', () => ({ op: 'price', value: price.value }))),
        h('div.wallet-choices', status, btn('Set market status', () => ({ op: 'status', value: status.value }))),
        h('div.wallet-choices', btn('Pause stock', () => ({ op: 'pause', value: true })), btn('Unpause', () => ({ op: 'pause', value: false }))),
        h('div.wallet-choices', account, btn('Block', () => ({ op: 'block', account: account.value.trim(), value: true })), btn('Unblock', () => ({ op: 'block', account: account.value.trim(), value: false }))));
    }));
}

export function renderPairs(ctx, { connect }) {
  const root = h('div.op-dash.pr');
  const error = h('p.error-text', { role: 'alert' });
  const fail = e => { error.textContent = errorText(e); };
  const run = async (action, body = {}) => { error.textContent = ''; const r = downloadSafeBatch(await ctx.run(action, body)); draw(); return r; };
  const card = (title, ...content) => h('section.tk-card.op-card', h('h2.tk-h', title), ...content.filter(Boolean));
  let registry = { key: null, view: undefined };

  function loadRegistry(key) {
    if (registry.key === key) return registry.view;
    registry = { key, view: undefined };
    fetch(`/api/public/tokenized-equity?network=${encodeURIComponent(key)}&provider=ondo`).then(r => r.ok ? r.json() : null)
      .then(view => { if (registry.key === key) { registry.view = view; draw(); } }).catch(() => { if (registry.key === key) { registry.view = null; draw(); } });
    return undefined;
  }

  function draw() {
    const w = ctx.wallet, net = w?.net;
    if (ctx.mode !== 'testnet' || !net || net.kind === 'solana') { root.replaceChildren(card('Trading pairs', h('p.small.muted', 'Pair approvals are per EVM launchpad. Switch to Base, Ethereum, BNB Chain or Robinhood Chain in Network and funds, then come back here.'))); return; }
    if (!w.address) { root.replaceChildren(card('Trading pairs', h('p.small.muted', `Connect the treasury wallet on ${net.name} to manage its trading pairs.`), h('button.btn.btn-secondary', { type: 'button', on: { click: connect } }, 'Connect wallet'))); return; }
    if (!w.deployment) { root.replaceChildren(card('Trading pairs', h('p.small.muted', `There is no launchpad on ${net.name} yet.`))); return; }
    let pairs = null; try { pairs = w.pairOptions?.(); } catch {}
    const owner = !!ctx.state?.pricing?.owner, approved = w.approvedQuotes ?? [];
    const head = h('header.op-head', h('div', h('h1', h('span.op-net', chainIcon(net.key), `Trading pairs · ${net.name}`)),
      h('p.small.muted', `Launchpad ${short(w.deployment.factory)} · `, owner ? h('span.op-pill.op-ok', 'connected wallet is the treasury') : h('span.op-pill.op-warn', 'connected wallet is not the treasury: approvals download as a Safe file'))));

    const list = card('Approved pairs', approved.length ? h('div.table-scroll', h('table.market-table.tk-table.op-table',
      h('thead', h('tr', ...['Asset', 'Kind', 'Address', 'Issuer'].map(l => h('th', { scope: 'col' }, l)))),
      h('tbody', approved.map(a => h('tr', h('td', h('span.op-net', assetIcon(a.symbol, a.kind === 'xstock', { provider: a.stock?.provider, name: a.name }), a.symbol, a.test ? h('span.chip.chip-xs.chip-test', 'Test') : null)),
        h('td', a.kind), h('td', h('a.mono', { href: `${net.explorer}/address/${a.address}`, target: '_blank', rel: 'noopener noreferrer' }, short(a.address))), h('td', a.stock?.provider ?? '—')))))) : h('p.small.muted', pairs ? 'No approved pairs yet besides the native coin.' : 'Loading the approved pairs…'));

    const recovery = h('input.input', { type: 'text', placeholder: '0x…', spellcheck: false, autocomplete: 'off', 'aria-label': 'Previous TEST-STOCK deployment hash' });
    const missing = w.missingTestPairs?.() ?? [];
    const testPairs = !net.mainnet && w.dex ? card('Test pairs',
      h('p.small.muted', 'Labelled test assets with no value: TEST-STOCK, TEST-MEME and the Ondo-style stand-ins. One pair per press, three or four confirmations, test gas only. An interrupted step resumes and reuses what is already deployed.'),
      missing.length ? h('label.field', h('span.small', 'Previous TEST-STOCK deployment hash (optional, to recover an interrupted setup)'), recovery) : null,
      missing.length ? h('button.btn.btn-secondary', { type: 'button', 'data-busy-disable': '', on: { click: () => run('setup-pairs', { recoveryHash: recovery.value.trim() || undefined }).catch(fail) } },
        `Add test pair: ${missing[0].symbol} (${missing[0].ondo ? 4 : 3} confirmations)${missing.length > 1 ? ` · ${missing.length - 1} more after it` : ''}`) : h('p.small', h('span.op-pill.op-ok', 'all test pairs approved'))) : null;

    const usdc = w.dex && w.feeUsdc && !/^0x0{40}$/i.test(w.feeUsdc) && pairs?.usdc?.unavailable ? card('USDC pair',
      h('p.small.muted', 'Approve the configured USDC asset for trading. This deploys its graduation adapter and fixes the starting valuation in USDC at the launchpad’s starting FDV. Existing tokens are unchanged.'),
      h('button.btn.btn-secondary', { type: 'button', 'data-busy-disable': '', on: { click: () => run('setup-usdc-pair').catch(fail) } }, 'Enable USDC trading pair')) : null;

    const view = loadRegistry(net.key), approvedSet = new Set(approved.map(a => a.address.toLowerCase()));
    const stockRows = (view?.assets ?? []).map(record => {
      const done = approvedSet.has(record.address), gate = done ? null : stockApprovalGate(record, { mainnet: true }) ?? (net.mainnet ? null : 'Mainnet only.');
      return h('tr', h('td', h('span.op-net', assetIcon(record.symbol, true, { provider: 'ondo', name: record.underlying }), record.symbol)), h('td.small', record.underlying),
        h('td', done ? h('span.op-pill.op-ok', 'approved') : gate ? h('span.op-pill.op-warn', { title: gate }, 'blocked') : h('span.op-pill.op-ok', 'ready')),
        h('td.small.muted', done ? '' : gate ?? ''),
        h('td', !done && !gate ? h('button.btn.btn-secondary.btn-sm', { type: 'button', 'data-busy-disable': '', on: { click: () => run('approve-stock', { asset: record.address }).then(r => toast(r.message, { kind: 'success' })).catch(fail) } }, 'Approve') : null));
    });
    const stocks = card('Tokenized stocks (Ondo)',
      h('p.small.muted', 'Real stocks are approved one at a time, on mainnet only, and only when the verified registry marks the stock as a launch quote reserve and a graduated pool asset with a production price feed. The starting valuation is fixed from that feed at approval.'),
      net.mainnet ? null : h('p.small', h('span.op-pill.op-warn', 'testnet'), ' Ondo’s stocks exist only on mainnet; testnets use the stand-ins above. The registry status below is the mainnet view.'),
      view === undefined ? h('p.small.muted', 'Loading the registry…') : !view ? h('p.small.muted', 'No tokenized-stock provider is designated for this network.')
        : h('div.table-scroll', h('table.market-table.tk-table.op-table', h('thead', h('tr', ...['Stock', 'Underlying', 'State', 'Why', ''].map(l => h('th', { scope: 'col' }, l)))), h('tbody', stockRows))));

    const sepoliaRouter = w.net.chainId === 11155111 && w.dex?.routerVersion === 2 ? card('Ordinary-wallet native router',
      h('p.small.muted', w.nativeRouterRecord()?.address ? `Deployed: ${short(w.nativeRouterRecord().address)}` : 'Native trades on ordinary wallets need a fixed router deployment. One test-gas transaction, no deposit.'),
      !w.nativeRouterRecord()?.address ? h('button.btn.btn-secondary', { type: 'button', 'data-busy-disable': '', on: { click: () => run('deploy-native-router').catch(fail) } }, 'Deploy ordinary-wallet native router') : null) : null;
    const liquidity = w.dex ? testLiquidityTools(w, (action, body) => run(action, body)) : null;

    const extra = [testPairs, usdc, sepoliaRouter].filter(Boolean);
    root.replaceChildren(...[head, error, h('div.op-grid', list, stocks), extra.length ? h('div.op-grid', ...extra) : null,
      w.dex ? testStockControls(w, (action, body) => run(action, body), fail) : null, liquidity ? card('Test conversion liquidity', liquidity) : null].filter(Boolean));
  }
  queueMicrotask(draw);
  return { root, update: draw };
}
