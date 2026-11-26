// GMGN charts on mainnet token pages (Malik, 22 November 2026: "change embedded chart source from dexscreener to gmgn").
// GMGN's chart widget (www.gmgn.cc/kline/<chain>/<token>) is keyed by the token, so no pair lookup is needed, and it
// prices our V4 pools the right way round (DexScreener showed SPIDERMAN/AAPLon inverted, as AAPLon priced in SPIDERMAN).
// Checked 22 Nov on SPIDERMAN (BNB Chain): the widget loads, shows the market cap, and sends no X-Frame-Options or CSP.
// Robinhood Chain added 26 Nov (Malik: "the embedded gmgn charts should be for all chains"); checked on PEPE that
// www.gmgn.cc/kline/robinhood/<token> loads. Solana uses GMGN's 'sol' and keeps the mint's case (base58).
export const GMGN_CHAINS = Object.freeze({ 'base-mainnet': 'base', 'bnb-mainnet': 'bsc', 'ethereum-mainnet': 'eth', 'robinhood-mainnet': 'robinhood', 'solana-mainnet': 'sol' });
const ADDRESS = /^0x[0-9a-fA-F]{40}$/, MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** { embed, page, source } for a mainnet token, or { embed: null } where GMGN has no such chain. */
export function gmgnChart(network, token) {
  const chain = GMGN_CHAINS[network];
  const solana = chain === 'sol';
  if (!chain || !(solana ? MINT : ADDRESS).test(String(token ?? ''))) return { embed: null, page: null, source: null };
  const t = solana ? token : token.toLowerCase();
  return { embed: `https://www.gmgn.cc/kline/${chain}/${t}?theme=dark&interval=15`, page: `https://gmgn.ai/${chain}/token/${t}`, source: 'GMGN' };
}
