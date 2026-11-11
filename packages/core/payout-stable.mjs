// The USD stablecoin the V2 trader airdrop and holder rewards are paid in, per network (Malik, 10–11 November: "make all
// of them be converted to usdc", and on Robinhood Chain "usdg not usdc"). A network pins it as `payoutStable` in
// networks.mjs ({ address, symbol, decimals, test }) when it is not the network's configured USDC: Robinhood Chain pays
// USDG, and test chains without an official test stablecoin use Elpida's labelled, no-value test dollar
// (contracts/evm/testnet/ElpidaTestDollar.sol). Otherwise it is the network's USDC from usd-oracles.mjs.

/** { address, symbol, decimals, test } or null. `oracles`: usdOracles() (server) or { usdc } per key (browser). */
export function payoutStable(net, oracles = {}) {
  const pinned = net?.payoutStable;
  if (pinned?.address) return { address: pinned.address, symbol: pinned.symbol ?? 'USD', decimals: Number(pinned.decimals ?? 6), test: !!pinned.test };
  const usdc = oracles?.[net?.key]?.usdc;
  return usdc ? { address: usdc, symbol: 'USDC', decimals: 6, test: false } : null;
}

/** The stablecoin a network's payouts should use, by ecosystem: USDG on Robinhood Chain, USDC elsewhere. */
export const payoutTicker = net => (/robinhood/.test(String(net?.key ?? '')) ? 'USDG' : 'USDC');
