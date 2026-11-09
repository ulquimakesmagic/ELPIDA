import { h, short, errorText } from './ui.mjs';
import { chainIcon } from './chain-ui.mjs';
import { downloadSafeBatch } from './admin-pairs.mjs';
import { v4Available, v4Deployment, v4PoolManager, savedTestPoolManager, v4StockPairs, v2Deployment } from './v4-launchpad.mjs';
import { v2Available } from './v2-launchpad.mjs';

// Operator panel, Launchpads tab (#/monkey?tab=launchpads, 6 November 2026). Setting up a network is an operator job,
// so every deployment lives here and only here (Malik, 6 November 2026: "limited to admin panel only and not everyone"):
// the Model 10 launchpad and its upgrades, the USD price feed activation, the test DEX and relayed price feed on a
// test chain without them, and the Model 11 test launchpad. The public account panel and the launch form only say
// whether a network is set up. The contracts themselves are permissionless, so this hides the controls; what visitors
// use is decided by the deployments pinned in networks.mjs.

export function renderLaunchpads(ctx, { connect }) {
  const root = h('div.op-dash.pr');
  const error = h('p.error-text', { role: 'alert' });
  const fail = e => { error.textContent = errorText(e); };
  // One live status line for a multi-step deployment, instead of a notification per step.
  const status = h('p.small.op-status', { role: 'status', 'aria-live': 'polite' });
  const run = async (action, body = {}) => {
    error.textContent = ''; status.textContent = '';
    try { const r = downloadSafeBatch(await ctx.run(action, body, { onProgress: message => { status.textContent = message; } })); status.textContent = ''; draw(); return r; }
    catch (e) { status.textContent = ''; throw e; }
  };
  const card = (title, ...content) => h('section.tk-card.op-card', h('h2.tk-h', title), ...content.filter(Boolean));
  const button = (label, action, body) => h('button.btn.btn-secondary', { type: 'button', 'data-busy-disable': '', on: { click: () => run(action, typeof body === 'function' ? body() : body).catch(fail) } }, label);

  function curveCard(w, net) {
    const deployed = !!w.deployment, state = ctx.state;
    const upgrade = w.launchUpgradeAvailable ? 'Deploy automatic-graduation launchpad' : w.partnerUpgradeAvailable ? 'Deploy partner-tier launchpad' : w.reviewUpgradeAvailable ? 'Deploy reviewed launchpad'
      : w.feeFixUpgradeAvailable ? 'Deploy corrected Base Sepolia launchpad' : w.modelUpgradeAvailable || w.needsMetadataUpgrade ? 'Set up the newer launchpad' : deployed ? null : 'Set up launchpad';
    // The treasury is immutable: on mainnet it must be a Safe; on testnet it defaults to this wallet.
    const treasury = !deployed && w.dex ? h('input.input', { placeholder: net.mainnet ? '0x… Safe address (required)' : '0x… Safe address (optional; empty = this wallet)', spellcheck: false, autocomplete: 'off', 'aria-label': 'Treasury Safe address' }) : null;
    const why = w.reviewUpgradeAvailable ? 'This launchpad predates the 1 November security fixes: partner buybacks that cannot be sandwiched, and graduation leftovers paid to the fee splitter.'
      : w.partnerUpgradeAvailable ? 'This launchpad predates partner tiers (10% or 20% of fees buy back and burn).'
      : w.feeFixUpgradeAvailable ? 'The current Model 10 factory predates the shared-recipient fee fix.'
      : w.modelUpgradeAvailable ? 'This is the older model 9 launchpad. Model 10 adds launch protection, the 10x curve and the graduation escape hatch.'
      : w.needsMetadataUpgrade ? 'A newer version with shared token metadata is available.' : null;
    const external = w.deployment?.treasury && w.deployment.treasury.toLowerCase() !== String(w.address).toLowerCase();
    return card('Model 10 launchpad',
      h('p.small.muted', deployed ? [`${w.deployment.shared ? 'Shared team' : 'This browser’s'} launchpad: `, h('span.mono', short(w.deployment.factory)), '.'] : `${net.name} has no launchpad yet.`),
      why ? h('p.small.muted', why, ' Test gas only. Existing tokens keep their contracts and stay listed. After deployment, send the factory address so it can be pinned for all visitors.') : null,
      treasury ? h('label.field', h('span.small.muted', 'Treasury: receives launch fees and alone can finish the setup. It can never be changed. Use a Safe multisig for anything beyond testing.'), treasury) : null,
      upgrade ? button(upgrade, 'deploy', () => ({ treasury: treasury?.value ?? '' })) : null,
      deployed ? h('p.small.muted', state?.pricing?.verified ? `$10 launch fee, converted by the on-chain price feed at execution. Starting FDV: $${Number(w.startFdvUsd ?? 5000).toLocaleString()} before the first purchase.` : state ? 'USD pricing must be activated before launching.' : 'Checking this launchpad’s USD pricing…') : null,
      deployed && state && !state.pricing?.verified ? button(external ? 'Download the Safe setup file' : 'Activate price feed', 'apply-pricing', {}) : null);
  }

  function testDexCard(w, net) {
    if (!net.testDex || w.dex) return null;
    const saved = w.savedTestDex?.(), done = !!saved?.feed, relay = ctx.config.relay;
    return card('Test DEX and price feed',
      h('p.small.muted', `${net.name} has no Uniswap v3 and no Chainlink price feed yet. Tokens here graduate into an Elpida test deployment of Uniswap v3 (Uniswap's own published contracts, with a test WETH), and launches are priced by Chainlink ETH / USD relayed from ${relay?.networks?.[net.key]?.source?.network ?? 'another test network'} by the Elpida server, with Chainlink's own timestamps. Testnet only.`),
      done ? h('div.stack', h('p.small', 'Deployed from this browser. Send these addresses to be registered, then set up the launchpad:'), h('pre.small.selectable', JSON.stringify(saved, null, 2))) : null,
      !done ? (relay?.address ? button(saved ? 'Finish the test DEX setup' : 'Set up test DEX and price feed (6 confirmations)', 'deploy-test-dex', {}) : h('p.small.muted', 'The server price relay is not configured yet, so the price feed cannot be deployed.')) : null);
  }

  // BNB Chain testnet has no Uniswap v4: a labelled test copy of Uniswap's own PoolManager comes first.
  function poolManagerCard(net) {
    if (!v4Available(net) || net.v4.poolManager) return null;
    const saved = savedTestPoolManager(net);
    return card('Test Uniswap v4 PoolManager',
      h('p.small.muted', `${net.name} has no Uniswap v4 (Uniswap deployed it on BNB Chain mainnet only). Model 11 here runs on a test copy of Uniswap's own PoolManager: the published v4-core 1.0.2 contract, unchanged, owned by this wallet (which can only set protocol fees; they stay 0). Testnet only.`),
      saved?.address ? h('div.stack', h('p.small', 'Deployed from this browser. Send it to be pinned with the launchpad below:'), h('pre.small.selectable', JSON.stringify({ poolManager: saved.address, block: saved.block }, null, 2)))
        : button('Deploy test PoolManager (1 confirmation)', 'deploy-v4-pool-manager', {}));
  }

  // Test stocks as Model 11 pairs (6 November 2026): each is approved once, at its Model 10 starting price. While the
  // issuer pauses a stock its pools stop trading, the fees stay held and the liquidity stays locked; both resume after.
  function stockPairs(net) {
    const box = h('div.stack', h('h3.small', 'Test stock pairs'), h('p.small.muted', 'Loading the test stocks on this network…'));
    v4StockPairs(ctx.wallet).then(list => {
      if (!list.length) { box.replaceChildren(h('h3.small', 'Test stock pairs'), h('p.small.muted', 'No test stock is approved on this network\u2019s Model 10 launchpad yet (Pairs tab).')); return; }
      box.replaceChildren(h('h3.small', 'Test stock pairs'),
        h('p.small.muted', 'A stock pair starts at the same price as on Model 10. If the issuer pauses the stock, its pools stop trading, fees stay held for their recipients and the liquidity stays locked; everything resumes when the stock moves again.'),
        h('ul.plain', list.map(s => h('li', h('strong', s.symbol), ' ', h('span.mono.small.muted', short(s.address)), ' · ', s.approved ? h('span.small', 'Model 11 pair') : button(`Approve ${s.symbol} for Model 11`, 'approve-v4-stock', { asset: s.address })))));
    }).catch(e => { box.replaceChildren(h('h3.small', 'Test stock pairs'), h('p.small.muted', errorText(e))); });
    return box;
  }

  function v4Card(net) {
    if (!v4Available(net)) return null;
    if (!v4PoolManager(net)) return card('Model 11 test launchpad (Uniswap v4)', h('p.small.muted', 'Deploy the test PoolManager first; the launchpad is deployed on top of it.'));
    const v4 = v4Deployment(net);
    return card('Model 11 test launchpad (Uniswap v4)',
      h('p.small.muted', 'Model 11 keeps the launch curve inside one Uniswap v4 pool, with its liquidity locked from the first trade. Trades go through the Elpida v4 router. Not audited: test networks only, and every Model 11 token says so.'),
      v4?.pinned ? h('p.small.muted', 'Shared team launchpad: factory ', h('span.mono', short(v4.factory)), ', router ', h('span.mono', short(v4.router)), '.') : null,
      v4 && !v4.pinned ? h('div.stack', h('p.small', 'Deployed from this browser. Send these addresses to be pinned in networks.mjs so the site lists its tokens for every visitor:'), h('pre.small.selectable', JSON.stringify({ factory: v4.factory, hook: v4.hook, router: v4.router, block: v4.block, ...(net.v4.poolManager ? {} : { poolManager: v4.poolManager }) }, null, 2))) : null,
      !v4 ? button('Deploy Model 11 test launchpad (about 7 confirmations)', 'deploy-v4', {}) : null,
      v4 ? stockPairs(net) : null,
      !v4 ? h('p.small.muted', 'This wallet becomes its treasury. The hook address is found in this browser first (a few seconds): its last bits are its Uniswap v4 permissions. A step that fails or is rejected resumes where it stopped.') : null);
  }

  /** ELPIDA V2 test launchpad: the factory, the hook, the router and the three reward contracts the hook pays. */
  function v2Card(net) {
    if (!v2Available(net) || net.mainnet) return null;
    if (!v4PoolManager(net)) return card('ELPIDA V2 test launchpad', h('p.small.muted', 'Deploy the test PoolManager first; V2 is deployed on top of it.'));
    const v2 = v2Deployment(net);
    const minFee = !v2 ? h('input.input', { type: 'number', min: '0.01', max: '1.25', step: '0.01', value: '1.00', inputmode: 'decimal', 'aria-label': 'Minimum trading fee, percent' }) : null;
    return card('ELPIDA V2 test launchpad',
      h('p.small.muted', 'V2: $50 test starting market cap, graduation at ×5, each creator picks a fee from the minimum to 4% (1.25% default) for good, and every fee splits 30% creator / 30% trader airdrop / 10% flywheel / 10% holder rewards / 20% treasury, paid straight to their contracts. First buys are capped at 3% of supply. Not audited: test networks only.'),
      v2?.pinned ? h('p.small.muted', 'Shared team launchpad: factory ', h('span.mono', short(v2.factory)), ', router ', h('span.mono', short(v2.router)), '.') : null,
      v2 && !v2.pinned ? h('div.stack', h('p.small', 'Deployed from this browser. Send these addresses to be pinned in networks.mjs (v2.shared) so the site lists its tokens and shows its Rewards analytics:'),
        h('pre.small.selectable', JSON.stringify({ factory: v2.factory, hook: v2.hook, router: v2.router, airdrop: v2.airdrop, holder: v2.holder, flywheel: v2.flywheel, keeper: v2.keeper, block: v2.block, minFeeBps: v2.minFeeBps }, null, 2))) : null,
      minFee ? h('label.field', h('span.small.muted', 'Minimum trading fee a creator may choose (percent). Fixed for this launchpad; 1.00% is the recommendation until a mainnet value is approved.'), minFee) : null,
      !v2 ? button('Deploy V2 test launchpad (about 12 confirmations)', 'deploy-v2', () => ({ minFeeBps: Math.round(Number(minFee.value) * 100), keeper: ctx.config.v2Keeper?.address ?? '' })) : null,
      !v2 ? h('p.small.muted', ctx.config.v2Keeper?.address ? ['This wallet becomes the treasury. The Elpida server keeper ', h('span.mono', short(ctx.config.v2Keeper.address)), ' runs the reward contracts: it pays fees in daily, posts airdrop and holder payouts and runs the flywheel. It can never take their funds. A step that fails or is rejected resumes where it stopped.'] : 'This wallet becomes the treasury and, because the server keeper is not configured, also the keeper of the reward contracts (posting payouts and running the flywheel by hand). It can never take their funds. A step that fails or is rejected resumes where it stopped.') : null);
  }

  function draw() {
    const w = ctx.wallet, net = w?.net;
    if (ctx.mode === 'testnet' && net?.kind === 'solana') {
      root.replaceChildren(card('Launchpads', h('p.small.muted', w.deployment ? ['Solana program ', h('span.mono', short(w.deployment.programId)), '. It is deployed and upgraded from the command line with the deploy key: ', h('code', 'node scripts/solana-deploy.mjs --upgrade --keypair <deploy key>'), '.'] : 'The Solana program is not deployed. Deploy it from the command line: npm run solana:deploy.')));
      return;
    }
    if (ctx.mode !== 'testnet' || !net) { root.replaceChildren(card('Launchpads', h('p.small.muted', 'Launchpads are per network. Switch to Base, Ethereum, BNB Chain or Robinhood Chain in Network and funds, then come back here.'))); return; }
    if (!w.address) { root.replaceChildren(card('Launchpads', h('p.small.muted', `Connect the operator wallet on ${net.name} to set up its launchpads.`), h('button.btn.btn-secondary', { type: 'button', on: { click: connect } }, 'Connect wallet'))); return; }
    const head = h('header.op-head', h('div', h('h1', h('span.op-net', chainIcon(net.key), `Launchpads · ${net.name}`)), h('p.small.muted', 'Deployments send from the connected wallet. Each one is pinned in networks.mjs before visitors use it.')));
    root.replaceChildren(head, status, error, h('div.op-grid', ...[testDexCard(w, net), curveCard(w, net), poolManagerCard(net), v4Card(net), v2Card(net)].filter(Boolean)));
  }
  queueMicrotask(draw);
  return { root, update: draw };
}
