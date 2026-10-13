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
