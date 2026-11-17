// EVM mainnets (17 November 2026). A mainnet appears on the mainnet site (ELPIDA_MODE=mainnet) only once its V2
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
  const { planKey, usdMaxAge, ...facts } = template;
  return {
    net: {
      ...facts, enabled: true,
      v4: { poolManager: plan.poolManager },
      v2: { shared: { factory: c.factory, hook: c.hook, router: c.router, airdrop: c.airdrop, holder: c.holder, flywheel: c.flywheel,
        keeper: plan.keeper, treasury: plan.treasury, block: record.block, minFeeBps: Number(plan.minFeeBps ?? 100), distributions: false } },
      usd: { feed: plan.usdFeed, usdc: plan.usdc, maxAge: usdMaxAge ?? 3600 },
      deployment: { planSha256: record.planSha256 ?? null, approval: record.approval ?? null, gitCommit: record.gitCommit ?? null },
    },
    reason: null,
  };
}

/** The server-side RPC for a network: ELPIDA_RPC_<chainId> (a private endpoint) or the public one. Never sent to browsers. */
export const serverRpcUrl = (net, env = {}) => env[`ELPIDA_RPC_${net.chainId}`] || net.rpcUrl;
