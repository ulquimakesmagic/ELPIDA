// Swap (Malik, 20 November 2026): the native coin, USDC and the network's tokenized stocks, both ways, on each mainnet
// (Coinbase stocks on Base, Ondo stocks elsewhere, from config/stocks/<network>.json). Routes come from the KyberSwap
// aggregator (no key; it reaches Aerodrome, Uniswap and PancakeSwap pools). The server only asks for routes and calldata;
// the visitor's own wallet approves and signs, and the page refuses any router but Kyber's.
export const KYBER_API = 'https://aggregator-api.kyberswap.com';
export const KYBER_CHAINS = Object.freeze({ 'base-mainnet': 'base', 'bnb-mainnet': 'bsc', 'ethereum-mainnet': 'ethereum' });
/** KyberSwap's MetaAggregationRouterV2 (the same address on these chains). */
export const KYBER_ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';
export const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/, AMOUNT = /^[1-9][0-9]{0,77}$/, CLIENT = 'elpida';

/** Tokens a network's Swap offers: native, its USDC and its verified stocks. */
export function swapTokens(net, stockList) {
  if (!net || !KYBER_CHAINS[net.key]) return [];
  const out = [{ address: NATIVE, symbol: net.nativeCurrency?.symbol ?? 'ETH', name: net.nativeCurrency?.name ?? 'Native coin', decimals: 18, kind: 'native' }];
  const usdc = net.payoutStable?.address ?? net.usd?.usdc;
  if (ADDRESS.test(String(usdc ?? ''))) out.push({ address: usdc, symbol: net.payoutStable?.symbol ?? 'USDC', name: 'USD Coin', decimals: Number(net.payoutStable?.decimals ?? 6), kind: 'usdc' });
  for (const s of stockList?.stocks ?? []) if (ADDRESS.test(String(s.address ?? ''))) out.push({ address: s.address, symbol: s.symbol, name: s.name, decimals: Number(s.decimals), kind: 'xstock' });
  return out;
}

export function createSwap({ fetchImpl = fetch, tokensFor }) {
  const allowed = (network, a) => tokensFor(network).some(t => t.address.toLowerCase() === String(a).toLowerCase());
  const call = async (url, init) => {
    const r = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json', 'x-client-id': CLIENT, ...(init?.headers ?? {}) } });
    let json = null; try { json = await r.json(); } catch { json = null; }
    if (!r.ok || !json?.data) { const e = new Error(json?.message && /route not found|no route/i.test(json.message) ? 'No route for this swap right now. Try a smaller amount or another pair.' : 'Swap routing is unavailable right now. Try again shortly.'); e.status = r.status === 400 ? 400 : 502; throw e; }
    return json.data;
  };
  function check(network, tokenIn, tokenOut) {
    const chain = KYBER_CHAINS[network];
    if (!chain) { const e = new Error('Swap is not available on this network yet.'); e.status = 400; throw e; }
    if (!allowed(network, tokenIn) || !allowed(network, tokenOut) || tokenIn.toLowerCase() === tokenOut.toLowerCase()) { const e = new Error('Choose two different assets offered on this network.'); e.status = 400; throw e; }
    return chain;
  }
  return {
    async quote({ network, tokenIn, tokenOut, amountIn }) {
      const chain = check(network, String(tokenIn ?? ''), String(tokenOut ?? ''));
      if (!AMOUNT.test(String(amountIn ?? ''))) { const e = new Error('Enter an amount.'); e.status = 400; throw e; }
      const d = await call(`${KYBER_API}/${chain}/api/v1/routes?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}&gasInclude=true`);
      if (String(d.routerAddress ?? '').toLowerCase() !== KYBER_ROUTER.toLowerCase()) { const e = new Error('Unexpected swap router; nothing was sent.'); e.status = 502; throw e; }
      const s = d.routeSummary ?? {};
      return { routeSummary: s, amountOut: String(s.amountOut ?? '0'), gasUsd: s.gasUsd ?? null, amountInUsd: s.amountInUsd ?? null, amountOutUsd: s.amountOutUsd ?? null, router: KYBER_ROUTER };
    },
    async build({ network, routeSummary, sender, slippageBps }) {
      const chain = check(network, String(routeSummary?.tokenIn ?? ''), String(routeSummary?.tokenOut ?? ''));
      if (!ADDRESS.test(String(sender ?? ''))) { const e = new Error('Connect a wallet.'); e.status = 400; throw e; }
      const bps = Math.round(Number(slippageBps ?? 100)); if (!(bps >= 10 && bps <= 500)) { const e = new Error('Slippage must be between 0.1% and 5%.'); e.status = 400; throw e; }
      const d = await call(`${KYBER_API}/${chain}/api/v1/route/build`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ routeSummary, sender, recipient: sender, slippageTolerance: bps, deadline: Math.floor(Date.now() / 1000) + 600, source: CLIENT }) });
      if (String(d.routerAddress ?? '').toLowerCase() !== KYBER_ROUTER.toLowerCase() || !/^0x[0-9a-fA-F]*$/.test(String(d.data ?? ''))) { const e = new Error('Unexpected swap router; nothing was sent.'); e.status = 502; throw e; }
      return { to: KYBER_ROUTER, data: d.data, value: String(d.transactionValue ?? '0'), amountOut: String(d.amountOut ?? '0'), amountIn: String(d.amountIn ?? routeSummary.amountIn ?? '0') };
    },
  };
}
