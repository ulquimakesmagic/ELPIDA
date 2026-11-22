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

/**
 * The network entry for `template` from its deployment `record` and `plan`, or `{ net: null, reason }` while it is not
 * usable: no record yet, not "ready", another chain, or a contract or plan address missing.
 */
export function mainnetNetwork(template, record, plan) {
  if (!record) return { net: null, reason: `${template.name}: no mainnet deployment record yet.` };
  if (record.status !== 'ready') return { net: null, reason: `${template.name}: the deployment record is "${record.status ?? 'unknown'}", not "ready" (run the Safe batch, then verify).` };
  if (Number(record.chainId) !== template.chainId) return { net: null, reason: `${template.name}: the deployment record is for chain ${record.chainId}, not ${template.chainId}.` };
  if (!plan || Number(plan.chainId) !== template.chainId) return { net: null, reason: `${template.name}: the deployment plan is missing or for another chain.` };
  const c = record.contracts ?? {};
  const missing = CONTRACTS.filter(k => !ADDRESS.test(String(c[k] ?? '')));
  if (missing.length) return { net: null, reason: `${template.name}: the deployment record has no ${missing.join(', ')}.` };
  for (const k of ['poolManager', 'usdFeed', 'usdc', 'keeper', 'treasury']) if (!ADDRESS.test(String(plan[k] ?? ''))) return { net: null, reason: `${template.name}: the plan has no ${k}.` };
  if (!Number.isInteger(record.block) || record.block <= 0) return { net: null, reason: `${template.name}: the deployment record has no deploy block.` };
  const { planKey, usdMaxAge, payoutDex, ...facts } = template;
  return {
    net: {
      ...facts, enabled: true,
      v4: { poolManager: plan.poolManager },
      v2: { shared: { factory: c.factory, hook: c.hook, router: c.router, airdrop: c.airdrop, holder: c.holder, flywheel: c.flywheel,
        keeper: plan.keeper, treasury: plan.treasury, block: record.block, minFeeBps: Number(plan.minFeeBps ?? 100), distributions: false,
        // The USDC trader-airdrop distributor, once `usdc-airdrop` has deployed and recorded it (22 November 2026).
        ...(ADDRESS.test(String(c.usdcAirdrop ?? '')) ? { usdcAirdrop: c.usdcAirdrop } : {}) } },
      usd: { feed: plan.usdFeed, usdc: plan.usdc, maxAge: usdMaxAge ?? 3600 },
      // The plan's dollar: USDC (18 decimals on BNB Chain), or USDG on Robinhood Chain. Pinned so payouts and amounts use
      // the plan's own symbol and decimals instead of assuming a 6-decimal USDC.
      payoutStable: { address: plan.usdc, symbol: plan.usdcSymbol ?? 'USDC', decimals: Number(plan.usdcDecimals ?? 6), test: false },
      ...(payoutDex ? { payoutDex } : {}),
      deployment: { planSha256: record.planSha256 ?? null, approval: record.approval ?? null, gitCommit: record.gitCommit ?? null },
    },
    reason: null,
  };
}

/** The server-side RPC for a network: ELPIDA_RPC_<chainId> (a private endpoint) or the public one. Never sent to browsers. */
export const serverRpcUrl = (net, env = {}) => env[`ELPIDA_RPC_${net.chainId}`] || net.rpcUrl;
