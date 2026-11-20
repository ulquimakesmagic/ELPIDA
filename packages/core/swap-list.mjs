// Swap-only token lists (Malik, 20 November 2026: every Ondo stock and ETF on BNB Chain in Swap). Swap prices each trade
// from DEX pools through KyberSwap, so a token here needs no price feed, unlike the launch list (stock-list.mjs). Candidates
// come from the issuer's published list (Ondo's GM token CSV linked from docs.ondo.finance/addresses), and each one is
// checked on chain: a contract whose symbol matches and whose decimals are sane. Nothing here makes a token launchable.
export const SWAP_LIST_SCHEMA = 'elpida-swap-list-v1';
const TOKEN_ABI = ['function symbol() view returns(string)', 'function decimals() view returns(uint8)'];
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export async function verifySwapToken({ Contract, provider }, c) {
  const symbol = String(c?.symbol ?? '').trim(), fail = reason => ({ ok: false, symbol: symbol || '(no symbol)', address: c?.address ?? null, reason });
  if (!/^[A-Za-z0-9.]{1,16}$/.test(symbol)) return fail('symbol missing or malformed');
  if (!ADDRESS.test(c.address ?? '')) return fail('token address malformed');
  try {
    if ((await provider.getCode(c.address)) === '0x') return fail('no contract at the token address');
    const token = new Contract(c.address, TOKEN_ABI, provider);
    const [onSymbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
    if (onSymbol !== symbol) return fail(`the token's symbol is ${onSymbol}, not ${symbol}`);
    if (Number(decimals) < 6 || Number(decimals) > 18) return fail(`unsupported decimals ${decimals}`);
    return { ok: true, token: { symbol, name: c.name ?? symbol, address: c.address, decimals: Number(decimals), type: c.type ?? 'Stock' } };
  } catch (e) { return fail(`read failed: ${String(e.shortMessage ?? e.message).slice(0, 160)}`); }
}

/** Checks every candidate, a few at a time; duplicates by address or symbol are refused. */
export async function buildSwapList({ Contract, provider, network, chainId, source, candidates, concurrency = 6, now = new Date() }) {
  const seen = new Set(), rejected = [], tokens = [], queue = [];
  for (const c of candidates) {
    const keys = [String(c?.address ?? '').toLowerCase(), String(c?.symbol ?? '')];
    if (keys.some(k => seen.has(k))) { rejected.push({ symbol: c?.symbol ?? '(no symbol)', address: c?.address ?? null, reason: 'duplicate address or symbol' }); continue; }
    keys.forEach(k => seen.add(k)); queue.push(c);
  }
  const results = new Array(queue.length); let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => { while (next < queue.length) { const i = next++; results[i] = await verifySwapToken({ Contract, provider }, queue[i]); } }));
  for (const r of results) (r.ok ? tokens.push(r.token) : rejected.push(r));
  return { list: { schema: SWAP_LIST_SCHEMA, network, chainId, source, checkedAt: now.toISOString(), tokens }, rejected };
}
