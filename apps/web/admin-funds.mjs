import { h, icon, errorText } from './ui.mjs';
import { chainIcon } from './chain-ui.mjs';
import { circleFundingPanel } from './circle-funding.mjs';

// Operator panel, Test funds tab (#/monkey?tab=funds, 6 November 2026). Test funds are for testing, so they live here
// and only here (Malik, 6 November 2026: "that should only be available to admin for testing"): the network's gas
// faucet, free mints of the labelled test pair assets, and Circle's test USDC. The public Network and wallet dialog
// keeps only the network choice and the wallet connection.

export function renderTestFunds(ctx, { connect }) {
  const root = h('div.op-dash.pr');
  const error = h('p.error-text', { role: 'alert' });
  const card = (title, ...content) => h('section.tk-card.op-card', h('h2.tk-h', title), ...content.filter(Boolean));

  function draw() {
    const w = ctx.wallet, net = w?.net;
    if (ctx.mode !== 'testnet' || !net) { root.replaceChildren(card('Test funds', h('p.small.muted', 'The local simulation has its own demo accounts with simulated funds. Switch to a public test network to get test funds there.'))); return; }
    if (net.mainnet) { root.replaceChildren(card('Test funds', h('p.small.muted', `${net.name} is a mainnet: there are no test funds.`))); return; }
    const gas = net.gasFaucet ? h('a.btn.btn-secondary', { href: net.gasFaucet, target: '_blank', rel: 'noopener noreferrer' }, icon('droplet'), `${net.nativeCurrency.symbol} faucet`, icon('external-link', 'icon-sm')) : null;
    let pairs = null; try { pairs = w.address ? w.pairOptions?.() : null; } catch {}
    const faucets = Object.values(pairs ?? {}).flatMap(group => group.assets).filter(a => a.faucet && !a.faucet.href);
    const mint = a => h('button.btn.btn-secondary', { type: 'button', 'data-busy-disable': '', on: { click: async () => { error.textContent = ''; try { await ctx.run(a.faucet.action, a.faucet.body); draw(); } catch (e) { error.textContent = errorText(e); } } } }, icon('droplet'), a.faucet.label);
    root.replaceChildren(
      h('header.op-head', h('div', h('h1', h('span.op-net', chainIcon(net.key), `Test funds · ${net.name}`)), h('p.small.muted', 'For testing only. Test assets are free and have no value.'))),
      error,
      h('div.op-grid',
        card('Network coin', h('p.small.muted', `${net.nativeCurrency.symbol} pays network fees, creation fees and ${net.nativeCurrency.symbol}-paired purchases.`), gas ?? h('p.small.muted', 'No public faucet is listed for this network.')),
        card('Test pair assets',
          !w.address ? h('div.stack', h('p.small.muted', `Connect a wallet on ${net.name} to mint its test assets.`), h('button.btn.btn-secondary', { type: 'button', on: { click: connect } }, 'Connect wallet'))
            : faucets.length ? h('div.wallet-choices', faucets.map(mint)) : h('p.small.muted', 'No test pair asset with a faucet on this network.'),
          faucets.length ? h('p.small.muted', 'TEST-STOCK and the Ondo-style stand-ins are simulated stocks, not issued Ondo oStocks.') : null)),
      circleFundingPanel({ config: ctx.config.circle, csrf: ctx.config.csrf, connected: { address: w.address, network: net.key } }));
  }
  queueMicrotask(draw);
  return { root, update: draw };
}
