// DexScreener charts on mainnet token pages (Malik, 20 November 2026): once DexScreener lists a token's pair, the token
// page embeds DexScreener's chart instead of Elpida's own. The server looks the pair up (DexScreener's public API) and
// caches it, so browsers make no third-party API calls; the page only frames dexscreener.com.
export const DEXSCREENER_CHAINS = Object.freeze({ 'base-mainnet': 'base', 'bnb-mainnet': 'bsc', 'ethereum-mainnet': 'ethereum' });
const API = 'https://api.dexscreener.com/token-pairs/v1';
const FOUND_MS = 6 * 3600_000, MISSING_MS = 5 * 60_000, ADDRESS = /^0x[0-9a-fA-F]{40}$/, PAIR = /^0x[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$/;

/** The embed URL for a DexScreener pair (dark theme, chart only). */
export function dexscreenerEmbed(chain, pair) {
  return `https://dexscreener.com/${chain}/${pair.toLowerCase()}?embed=1&loadChartSettings=0&trades=0&tabs=0&info=0&chartLeftToolbar=0&chartTheme=dark&theme=dark&chartStyle=1&chartType=usd&interval=15`;
}

/** Picks the token's most liquid pair from DexScreener's answer, or null. */
export function pickPair(json, chain, token) {
  if (!Array.isArray(json)) return null;
  const t = token.toLowerCase();
  const pairs = json.filter(p => p?.chainId === chain && typeof p.pairAddress === 'string' && PAIR.test(p.pairAddress)
    && [p.baseToken?.address, p.quoteToken?.address].some(a => String(a ?? '').toLowerCase() === t));
  pairs.sort((a, b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0));
  return pairs[0]?.pairAddress ?? null;
}

export function createDexscreener({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  const cache = new Map(), pending = new Map();
  async function lookup(network, token) {
    const chain = DEXSCREENER_CHAINS[network];
    if (!chain || !ADDRESS.test(String(token ?? ''))) return { pair: null, embed: null };
    const key = `${chain}:${token.toLowerCase()}`, hit = cache.get(key);
    if (hit && hit.until > now()) return hit.value;
    if (pending.has(key)) return pending.get(key);
    const task = (async () => {
      let pair = null;
      try {
        const r = await fetchImpl(`${API}/${chain}/${token.toLowerCase()}`, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
        if (r.ok) pair = pickPair(await r.json(), chain, token);
      } catch { pair = null; }
      const value = { pair, embed: pair ? dexscreenerEmbed(chain, pair) : null, page: pair ? `https://dexscreener.com/${chain}/${pair.toLowerCase()}` : null };
      cache.set(key, { value, until: now() + (pair ? FOUND_MS : MISSING_MS) });
      if (cache.size > 5000) cache.delete(cache.keys().next().value);
      return value;
    })().finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  }
  return { lookup };
}
