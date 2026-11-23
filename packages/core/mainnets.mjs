// EVM mainnets (17 November 2026; BNB Chain, Robinhood Chain and Ethereum added 18 November). A mainnet appears on the mainnet site (ELPIDA_MODE=mainnet) only once its V2
// deployment record says "ready": deployed by scripts/v2-mainnet-deploy.mjs, wired by the treasury Safe's batch and
// checked by `verify`. Until then it is not listed, so the mainnet site never shows a chain it cannot use.
// Chains move from the testnet site to the mainnet site one at a time, as each gets its record (Malik, 17 Nov).
//
// Pure: no I/O. The server reads deployments/<planKey>.json and deployments/plans/<planKey>.json and passes them in.
// The browser gets the built network from the server's runtime config.

/** Static facts per chain. `rpcUrl` is a public endpoint for browsers; the server uses ELPIDA_RPC_<chainId>. */
export const EVM_MAINNETS = Object.freeze([
  Object.freeze({
    key: 'base-mainnet', planKey: 'base-mainnet', name: 'Base', short: 'BASE', kind: 'evm', mainnet: true,
    chainId: 8453, rpcUrl: 'https://mainnet.base.org', explorer: 'https://basescan.org',
    nativeCurrency: Object.freeze({ name: 'Ether', symbol: 'ETH', decimals: 18 }), gasFaucet: null,
    // How old the Chainlink ETH/USD answer may be for the site's prices (Base heartbeat 20 minutes, as on Base Sepolia).
    usdMaxAge: 1500,
    // Uniswap v3 on Base (developers.uniswap.org, Base deployments): the market a "Buy a reward token" holder strategy
    // swaps the creator share through. SwapRouter02 (no deadline field), as ElpidaV2CreatorRewards expects.
    rewardDex: Object.freeze({ factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', router: '0x2626664c2603336E57B271c5C0b26F421741e481', weth: '0x4200000000000000000000000000000000000006', routerVersion: 2 }),
    // Where the trader airdrop converts its fees into USDC (Malik, 22 November 2026): Uniswap v3 on Base, SwapRouter02 and
    // QuoterV2 (developers.uniswap.org, Base deployments). `rehearse-usdc-airdrop` checks them on a fork before deploying.
    payoutDex: Object.freeze({ name: 'Uniswap v3', router: '0x2626664c2603336E57B271c5C0b26F421741e481', quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a', weth: '0x4200000000000000000000000000000000000006', routerVersion: 2 }),
  }),
  Object.freeze({
    key: 'bnb-mainnet', planKey: 'bnb-mainnet', name: 'BNB Chain', short: 'BNB', kind: 'evm', mainnet: true,
    chainId: 56, rpcUrl: 'https://bsc-dataseed.bnbchain.org', explorer: 'https://bscscan.com',
    nativeCurrency: Object.freeze({ name: 'BNB', symbol: 'BNB', decimals: 18 }), gasFaucet: null,
    usdMaxAge: 3600,
    // PancakeSwap v3 on BNB Chain (developer.pancakeswap.finance, v3 addresses): its SwapRouter takes a deadline
    // (routerVersion 1), QuoterV2, WBNB. Used to convert the trader airdrop into USDC.
    payoutDex: Object.freeze({ name: 'PancakeSwap v3', router: '0x1b81D678ffb9C0263b24A97847620C99d213eB14', quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997', weth: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', routerVersion: 1 }),
  }),
  Object.freeze({
    key: 'robinhood-mainnet', planKey: 'robinhood-mainnet', name: 'Robinhood Chain', short: 'ROBINHOOD', kind: 'evm', mainnet: true,
    chainId: 4663, rpcUrl: 'https://rpc.mainnet.chain.robinhood.com', explorer: 'https://robinhoodchain.blockscout.com',
    nativeCurrency: Object.freeze({ name: 'Ether', symbol: 'ETH', decimals: 18 }), gasFaucet: null,
    // Chainlink's Robinhood Chain ETH / USD heartbeat is not published with the address; allow a day, as the plan does.
    usdMaxAge: 86400,
    // Uniswap v3 on Robinhood Chain (developers.uniswap.org, v3 Robinhood Chain deployments): SwapRouter02 and QuoterV2;
    // WETH read from SwapRouter02.WETH9() on chain by Malik (24 November 2026). The airdrop converts ETH into USDG here.
    payoutDex: Object.freeze({ name: 'Uniswap v3', router: '0xCaf681a66D020601342297493863E78C959E5cb2', quoter: '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7', weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', routerVersion: 2 }),
  }),
  Object.freeze({
    key: 'ethereum-mainnet', planKey: 'ethereum-mainnet', name: 'Ethereum', short: 'ETH', kind: 'evm', mainnet: true,
    chainId: 1, rpcUrl: 'https://ethereum-rpc.publicnode.com', explorer: 'https://etherscan.io',
    nativeCurrency: Object.freeze({ name: 'Ether', symbol: 'ETH', decimals: 18 }), gasFaucet: null,
    // Chainlink ETH / USD on Ethereum updates at least hourly.
    usdMaxAge: 3900,
  }),
]);

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CONTRACTS = ['factory', 'hook', 'router', 'airdrop', 'holder', 'flywheel'];
/** V2.3 launchpads (23 November 2026) have no holder-reward distributor and no flywheel vault. */
const CONTRACTS_V23 = ['factory', 'hook', 'router', 'airdrop'];
const isV23Record = record => record?.model === 'v2.3-hook';

/** Why a deployment record cannot be used, or null. */
function unusable(template, record, plan) {
  if (!record) return `${template.name}: no mainnet deployment record yet.`;
  if (record.status !== 'ready') return `${template.name}: the deployment record is "${record.status ?? 'unknown'}", not "ready" (run the Safe batch, then verify).`;
  if (Number(record.chainId) !== template.chainId) return `${template.name}: the deployment record is for chain ${record.chainId}, not ${template.chainId}.`;
  if (!plan || Number(plan.chainId) !== template.chainId) return `${template.name}: the deployment plan is missing or for another chain.`;
  const c = record.contracts ?? {};
  const missing = (isV23Record(record) ? CONTRACTS_V23 : CONTRACTS).filter(k => !ADDRESS.test(String(c[k] ?? '')));
  if (missing.length) return `${template.name}: the deployment record has no ${missing.join(', ')}.`;
  for (const k of ['poolManager', 'usdFeed', 'usdc', 'keeper', 'treasury']) if (!ADDRESS.test(String(plan[k] ?? ''))) return `${template.name}: the plan has no ${k}.`;
  if (!Number.isInteger(record.block) || record.block <= 0) return `${template.name}: the deployment record has no deploy block.`;
  return null;
}

/** One launchpad's `v2.shared` entry from its record and plan. */
function sharedOf(record, plan) {
  const c = record.contracts, v23 = isV23Record(record);
  return { factory: c.factory, hook: c.hook, router: c.router, airdrop: c.airdrop, ...(v23 ? {} : { holder: c.holder, flywheel: c.flywheel }),
    model: v23 ? 'v2.3-hook' : 'v2-hook', split: v23 ? { creator: 30, traders: 50, treasury: 20 } : { creator: 30, traders: 30, flywheel: 10, holders: 10, treasury: 20 },
    keeper: plan.keeper, treasury: plan.treasury, block: record.block, minFeeBps: Number(plan.minFeeBps ?? 100), distributions: false,
    // The USDC trader-airdrop distributor, once `usdc-airdrop` has deployed and recorded it (22 November 2026).
    ...(ADDRESS.test(String(c.usdcAirdrop ?? '')) ? { usdcAirdrop: c.usdcAirdrop } : {}) };
}

/**
 * The network entry for `template` from its deployment `record` and `plan`, or `{ net: null, reason }` while it is not
 * usable: no record yet, not "ready", another chain, or a contract or plan address missing.
 * `next`: the chain's V2.3 launchpad ({ record, plan }, 23 November 2026). Once ready the chain runs on V2.3 alone
 * (Malik: "totally remove previous version and only implement the 50, 30, 20"): the V2.0 launchpad is no longer
 * indexed, traded, kept or shown on the site. Its contracts stay on chain, untouched.
 */
export function mainnetNetwork(template, record, plan, next = null) {
  const nextReady = next?.record && !unusable(template, next.record, next.plan) ? next : null;
  const why = unusable(template, record, plan);
  if (why && !nextReady) return { net: null, reason: why };
  const main = nextReady ?? { record, plan }, previous = [];
  const { planKey, usdMaxAge, payoutDex, ...facts } = template, p = main.plan, r = main.record;
  return {
    net: {
      ...facts, enabled: true,
      v4: { poolManager: p.poolManager },
      v2: { shared: sharedOf(r, p), ...(previous.length ? { previous } : {}) },
      usd: { feed: p.usdFeed, usdc: p.usdc, maxAge: usdMaxAge ?? 3600 },
      // The plan's dollar: USDC (18 decimals on BNB Chain), or USDG on Robinhood Chain. Pinned so payouts and amounts use
      // the plan's own symbol and decimals instead of assuming a 6-decimal USDC.
      payoutStable: { address: p.usdc, symbol: p.usdcSymbol ?? 'USDC', decimals: Number(p.usdcDecimals ?? 6), test: false },
      ...(payoutDex ? { payoutDex } : {}),
      deployment: { planSha256: r.planSha256 ?? null, approval: r.approval ?? null, gitCommit: r.gitCommit ?? null },
    },
    reason: null,
  };
}

/** The server-side RPC for a network: ELPIDA_RPC_<chainId> (a private endpoint) or the public one. Never sent to browsers. */
export const serverRpcUrl = (net, env = {}) => env[`ELPIDA_RPC_${net.chainId}`] || net.rpcUrl;
