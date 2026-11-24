// Swap (Malik, 20 November 2026): the native coin, USDC and the network's tokenized stocks, both ways, on each mainnet
// (Coinbase stocks on Base, Ondo stocks elsewhere, from config/stocks/<network>.json). Routes come from the KyberSwap
// aggregator (no key; it reaches Aerodrome, Uniswap and PancakeSwap pools). The server only asks for routes and calldata;
// the visitor's own wallet approves and signs, and the page refuses any router but Kyber's.
// Fee (Malik, 20 November 2026): KyberSwap charges integrators nothing; Elpida adds its own swap fee (ELPIDA_SWAP_FEE_BPS,
// default 50 = 0.5%, capped at 1%) through Kyber's extraFee, paid to the network's treasury Safe. It is taken in the native
// coin or USDC side of the swap where there is one, so the treasury collects ETH/BNB/USDC rather than stock tokens.
export const KYBER_API = 'https://aggregator-api.kyberswap.com';
export const KYBER_CHAINS = Object.freeze({ 'base-mainnet': 'base', 'bnb-mainnet': 'bsc', 'ethereum-mainnet': 'ethereum', 'robinhood-mainnet': 'robinhood' });
/** KyberSwap's MetaAggregationRouterV2 (the same address on these chains). */
export const KYBER_ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';
export const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/, AMOUNT = /^[1-9][0-9]{0,77}$/, CLIENT = 'elpida';

/** Tokens a network's Swap offers: native, its USDC and its verified stocks. */
export function swapTokens(net, stockList, swapList = null) {
  if (!net || !KYBER_CHAINS[net.key]) return [];
  const out = [{ address: NATIVE, symbol: net.nativeCurrency?.symbol ?? 'ETH', name: net.nativeCurrency?.name ?? 'Native coin', decimals: 18, kind: 'native' }];
  const usdc = net.payoutStable?.address ?? net.usd?.usdc;
  if (ADDRESS.test(String(usdc ?? ''))) out.push({ address: usdc, symbol: net.payoutStable?.symbol ?? 'USDC', name: net.payoutStable?.name ?? 'USD Coin', decimals: Number(net.payoutStable?.decimals ?? 6), kind: 'usdc' });
  for (const s of stockList?.stocks ?? []) if (ADDRESS.test(String(s.address ?? ''))) out.push({ address: s.address, symbol: s.symbol, name: s.name, decimals: Number(s.decimals), kind: 'xstock' });
  // Swap-only tokens (config/swap/<network>.json, e.g. every Ondo stock and ETF on BNB Chain): no price feed needed here.
  const have = new Set(out.map(t => t.address.toLowerCase()));
  if (swapList?.chainId == null || Number(swapList.chainId) === Number(net.chainId ?? swapList.chainId))
    for (const t of swapList?.tokens ?? []) if (ADDRESS.test(String(t.address ?? '')) && !have.has(t.address.toLowerCase()) && Number(t.decimals) >= 6 && Number(t.decimals) <= 18) { have.add(t.address.toLowerCase()); out.push({ address: t.address, symbol: t.symbol, name: t.name, decimals: Number(t.decimals), kind: 'xstock' }); }
  return out;
}

export const DEFAULT_SWAP_FEE_BPS = 50, MAX_SWAP_FEE_BPS = 100;

/** The swap fee for a mainnet network: { bps, receiver } or null (no treasury, or the fee is set to 0). */
export function swapFeeFor(net, env = {}) {
  const raw = env.ELPIDA_SWAP_FEE_BPS, n = raw == null || raw === '' ? DEFAULT_SWAP_FEE_BPS : Number(raw);
  const bps = Number.isInteger(n) && n >= 0 ? Math.min(n, MAX_SWAP_FEE_BPS) : DEFAULT_SWAP_FEE_BPS;
  const receiver = net?.v2?.shared?.treasury;
  return bps > 0 && ADDRESS.test(String(receiver ?? '')) ? { bps, receiver } : null;
}

/** Which side pays the fee: the input when it is the native coin or USDC, otherwise the output. */
export function feeSide(tokens, tokenIn) {
  const t = tokens.find(x => x.address.toLowerCase() === String(tokenIn).toLowerCase());
  return t && (t.kind === 'native' || t.kind === 'usdc') ? 'currency_in' : 'currency_out';
}

export function createSwap({ fetchImpl = fetch, tokensFor, feeFor = () => null, launchPairsFor = () => [] }) {
  // A creator's first buy paid in the native coin (Malik, 21 Nov: "pay first buy with native or the stock"): native →
  // a launch pair asset (USDC or an approved stock), swapped just before the launch. Creators already pay the $10 launch
  // fee, so these carry no Elpida swap fee. Only native → launch pair qualifies; every other swap pays the fee.
  const isPair = (network, a) => launchPairsFor(network).some(x => x.toLowerCase() === String(a).toLowerCase()), isNative = a => String(a).toLowerCase() === NATIVE.toLowerCase();
  // 'first-buy': native → pair only. 'pair' (a token page trade paid or received in the native coin, 21 Nov): either way
  // between the native coin and a launch pair asset; the token's own 1.25% trading fee applies to the trade itself.
  const launchConversion = (network, tokenIn, tokenOut, purpose = 'first-buy') => isNative(tokenIn) && isPair(network, tokenOut) || purpose === 'pair' && isPair(network, tokenIn) && isNative(tokenOut);
  const PURPOSES = new Set(['first-buy', 'pair']);
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
    async quote({ network, tokenIn, tokenOut, amountIn, purpose = null }) {
      const chain = check(network, String(tokenIn ?? ''), String(tokenOut ?? ''));
      if (!AMOUNT.test(String(amountIn ?? ''))) { const e = new Error('Enter an amount.'); e.status = 400; throw e; }
      if (PURPOSES.has(purpose) && !launchConversion(network, tokenIn, tokenOut, purpose)) { const e = new Error('A launch conversion goes between the native coin and the launch pair.'); e.status = 400; throw e; }
      const fee = PURPOSES.has(purpose) ? null : feeFor(network), side = fee ? feeSide(tokensFor(network), tokenIn) : null;
      const feeQuery = fee ? `&feeAmount=${fee.bps}&isInBps=true&chargeFeeBy=${side}&feeReceiver=${fee.receiver}` : '';
      const d = await call(`${KYBER_API}/${chain}/api/v1/routes?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}&gasInclude=true${feeQuery}`);
      if (String(d.routerAddress ?? '').toLowerCase() !== KYBER_ROUTER.toLowerCase()) { const e = new Error('Unexpected swap router; nothing was sent.'); e.status = 502; throw e; }
      const s = d.routeSummary ?? {};
      return { routeSummary: s, amountOut: String(s.amountOut ?? '0'), gasUsd: s.gasUsd ?? null, amountInUsd: s.amountInUsd ?? null, amountOutUsd: s.amountOutUsd ?? null, router: KYBER_ROUTER,
        fee: fee ? { bps: fee.bps, side: side === 'currency_in' ? 'in' : 'out' } : null };
    },
    async build({ network, routeSummary, sender, slippageBps, purpose = null }) {
      const chain = check(network, String(routeSummary?.tokenIn ?? ''), String(routeSummary?.tokenOut ?? ''));
      if (!ADDRESS.test(String(sender ?? ''))) { const e = new Error('Connect a wallet.'); e.status = 400; throw e; }
      if (PURPOSES.has(purpose) && !launchConversion(network, routeSummary.tokenIn, routeSummary.tokenOut, purpose)) { const e = new Error('A launch conversion goes between the native coin and the launch pair.'); e.status = 400; throw e; }
      const fee = PURPOSES.has(purpose) ? null : feeFor(network);
      if (fee) {
        // The fee the quote asked for must still be in the route the page sends back (Kyber builds from routeSummary).
        const x = routeSummary.extraFee ?? {};
        if (String(x.feeAmount) !== String(fee.bps) || x.isInBps !== true || String(x.feeReceiver ?? '').toLowerCase() !== fee.receiver.toLowerCase() || x.chargeFeeBy !== feeSide(tokensFor(network), routeSummary.tokenIn)) {
          const e = new Error('This quote is out of date. Get a new quote and try again.'); e.status = 400; throw e;
        }
      }
      const bps = Math.round(Number(slippageBps ?? 100)); if (!(bps >= 10 && bps <= 500)) { const e = new Error('Slippage must be between 0.1% and 5%.'); e.status = 400; throw e; }
      const d = await call(`${KYBER_API}/${chain}/api/v1/route/build`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ routeSummary, sender, recipient: sender, slippageTolerance: bps, deadline: Math.floor(Date.now() / 1000) + 600, source: CLIENT }) });
      if (String(d.routerAddress ?? '').toLowerCase() !== KYBER_ROUTER.toLowerCase() || !/^0x[0-9a-fA-F]*$/.test(String(d.data ?? ''))) { const e = new Error('Unexpected swap router; nothing was sent.'); e.status = 502; throw e; }
      return { to: KYBER_ROUTER, data: d.data, value: String(d.transactionValue ?? '0'), amountOut: String(d.amountOut ?? '0'), amountIn: String(d.amountIn ?? routeSummary.amountIn ?? '0') };
    },
  };
}
