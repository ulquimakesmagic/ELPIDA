import { Contract, ZeroAddress, formatUnits } from 'ethers';

// Read-only figures for the operator panel: each network's treasury (read from its factory), the treasury's native and
// USDC balances, plus the health and activity summaries the server already computes. Nothing here can move funds.

const FACTORY_ABI = ['function treasury() view returns (address)', 'function feeUsdc() view returns (address)'];
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)'];

const withTimeout = (promise, ms, label) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms))]);

/**
 * Treasury and balances for each network. `networks` is [{ key, name, explorer, nativeSymbol, factory, provider }].
 * Each network fails on its own: a slow or broken RPC gives that row an error, never a guessed figure.
 * `contract` is injectable for tests.
 */
export async function readTreasuries(networks, { timeoutMs = 8000, contract = (address, abi, provider) => new Contract(address, abi, provider) } = {}) {
  return Promise.all(networks.map(async net => {
    const row = { network: net.key, name: net.name, explorer: net.explorer ?? null, factory: net.factory ?? null, treasury: null, native: null, nativeSymbol: net.nativeSymbol ?? 'ETH', usdc: null, error: null };
    if (!net.factory || !net.provider) return { ...row, error: 'No factory configured.' };
    try {
      const factory = contract(net.factory, FACTORY_ABI, net.provider);
      row.treasury = (await withTimeout(factory.treasury(), timeoutMs, 'treasury()')).toLowerCase();
      row.native = formatUnits(await withTimeout(net.provider.getBalance(row.treasury), timeoutMs, 'balance'), 18);
      let usdc = ZeroAddress;
      try { usdc = await withTimeout(factory.feeUsdc(), timeoutMs, 'feeUsdc()'); } catch { usdc = ZeroAddress; }
      if (usdc && usdc !== ZeroAddress) {
        const coin = contract(usdc, ERC20_ABI, net.provider);
        const [raw, decimals] = await Promise.all([withTimeout(coin.balanceOf(row.treasury), timeoutMs, 'USDC balance'), withTimeout(coin.decimals(), timeoutMs, 'USDC decimals')]);
        row.usdc = { address: usdc.toLowerCase(), balance: formatUnits(raw, Number(decimals)) };
      }
    } catch (error) { row.error = String(error?.shortMessage ?? error?.message ?? error).slice(0, 160); }
    return row;
  }));
}

/** Allowed operator addresses: configured admins plus every treasury that could be read. */
export function operatorAddresses(admins, treasuries) {
  return new Set([...(admins ?? []), ...(treasuries ?? []).map(t => t.treasury).filter(Boolean)].map(a => String(a).toLowerCase()));
}

/** A small cache so the panel and sign-in do not hit every RPC on each request. */
export function cachedLoader(load, ttlMs = 60000, now = () => Date.now()) {
  let at = 0, value = null, pending = null;
  return async ({ fresh = false } = {}) => {
    if (!fresh && value && now() - at < ttlMs) return value;
    pending ??= load().then(v => { value = v; at = now(); return v; }).finally(() => { pending = null; });
    return pending;
  };
}
