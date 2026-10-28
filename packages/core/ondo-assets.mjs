import { normalizeAddress } from './tokenized-equity.mjs';

const CHAINS = { ETHEREUM: { network: 'ethereum', chainId: 1 }, BSC: { network: 'bnb', chainId: 56 }, SOLANA: { network: 'solana', chainId: 101 } };

/** Extract structured issuer asset data, never arbitrary addresses from page text or partner links. */
export function parseOndoAssetPage({ html, source, symbol, accessed }) {
  const url = new URL(source);
  if (url.origin !== 'https://app.ondo.finance' || url.pathname !== `/assets/${symbol.toLowerCase()}` || url.search || url.hash || url.username || url.password) throw new Error('An exact official Ondo asset URL is required.');
  if (!/^[A-Za-z0-9]+on$/.test(symbol) || !/^\d{4}-\d{2}-\d{2}$/.test(accessed)) throw new Error('Invalid symbol or access date.');
  const matches = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (!Array.isArray(value) && value.symbol === symbol && Array.isArray(value.supportedNetworks)) matches.push(value);
    for (const child of Object.values(value)) visit(child);
  };
  for (const match of html.matchAll(/self\.__next_f\.push\((\[.*?\])\)<\/script>/gs)) {
    let chunk;
    try { chunk = JSON.parse(match[1])[1]; } catch { continue; }
    if (typeof chunk !== 'string') continue;
    for (const line of chunk.split('\n')) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      try { visit(JSON.parse(line.slice(colon + 1))); } catch { /* Non-JSON React stream records are not asset data. */ }
    }
  }
  if (!matches.length) throw new Error('No structured issuer asset record found; page format may have changed.');
  const records = matches.map(asset => {
    if (typeof asset.underlyingName !== 'string' || !asset.underlyingName.trim() || !asset.supportedNetworks.length) throw new Error('Incomplete issuer asset identity.');
    return asset.supportedNetworks.map(entry => {
    const chain = CHAINS[entry.network];
    if (!chain || entry.chainId !== chain.chainId) throw new Error('Unsupported or mismatched Ondo chain identity.');
    const address = normalizeAddress(chain.network, entry.address);
    if (!address || !Number.isInteger(entry.decimals) || entry.decimals < 0 || entry.decimals > 18) throw new Error('Invalid canonical address or decimals.');
    return { network: chain.network, provider: 'ondo', symbol, underlying: asset.underlyingName, address, decimals: entry.decimals, source, accessed, model: null, feedIncludesMultiplier: null, balanceOfKind: null, verified: false };
    });
  });
  if (records.some(r => JSON.stringify(r) !== JSON.stringify(records[0]))) throw new Error('Conflicting issuer asset records.');
  if (new Set(records[0].map(a => a.network)).size !== records[0].length) throw new Error('Duplicate issuer network records.');
  return records[0];
}
