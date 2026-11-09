// Public cluster identities, verified through each Solana public RPC's getGenesisHash.
export const SOLANA_GENESIS = Object.freeze({
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
});

export function validateSolanaRpc(value) {
  const fail = () => { const e = new Error('SOLANA_RPC_URL must be one HTTPS endpoint, not a list.'); e.code = 'RPC_CONFIG_INVALID'; throw e; };
  if (typeof value !== 'string' || /\s|,/.test(value) || (value.match(/https?:\/\//g) ?? []).length !== 1) return fail();
  let url; try { url = new URL(value); } catch { return fail(); }
  const local = ['127.0.0.1', 'localhost'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.hash) return fail();
  return url.href;
}

/**
 * The server's Solana RPCs in order of preference: SOLANA_RPC_URL first, then SOLANA_RPC_URLS (several endpoints,
 * separated by commas, spaces or new lines), so the server can move to the next one when an endpoint fails or runs
 * out of credits. Duplicates are dropped. Invalid entries are counted, never echoed: they may hold API keys.
 */
export function solanaRpcList(env = process.env) {
  const raw = [env.SOLANA_RPC_URL, env.SOLANA_RPC_URLS].flatMap(v => String(v ?? '').split(/[\s,]+/)).filter(Boolean);
  const urls = [];
  let invalid = 0;
  for (const value of raw) {
    try { const url = validateSolanaRpc(value); if (!urls.includes(url)) urls.push(url); } catch { invalid++; }
  }
  return { urls, invalid };
}

/** The host of an RPC URL, the only part of it that is ever logged or shown (the path or query may hold a key). */
export function rpcHost(url) { try { return new URL(url).host; } catch { return null; } }
