// A public feed of Elpida launches for scanners and aggregators (GMGN, DexScreener and others; Malik, 22 November 2026:
// token images were not reaching them). A token on BNB Chain or Base has no standard place for a logo, so scanners
// show images only for launchpads they integrate. This is what an integration reads: every Elpida V2 launch on a
// mainnet with its chain facts (token, creator, launch transaction, Uniswap v4 pool) and the creator's metadata
// (image, description, links) exactly as published at launch (the factory records the metadata URI on chain).
// Read-only and public: nothing here is not already public on chain or on the token page.
import { getAddress } from 'ethers';

const ABS = /^https:\/\//, SOCIAL = { website: 'website', twitter: 'twitter', telegram: 'telegram', discord: 'discord' };
export const SCANNER_FEED_VERSION = 1;

const absolute = (value, origin) => {
  const v = String(value ?? '').trim();
  if (!v) return null;
  if (v.startsWith('/api/')) return origin + v;
  return ABS.test(v) ? v : null;
};

/** One token for scanners. `t`: a public-indexer listing row; `net`: its network; `origin`: the site's https origin. */
export function scannerToken(t, net, origin) {
  const m = t.metadata ?? {}, links = {};
  for (const [k, field] of Object.entries(SOCIAL)) { const v = absolute(m[field], origin); if (v) links[k] = v; }
  const image = absolute(m.image, origin);
  return {
    chainId: net.chainId, network: net.key, address: getAddress(t.address), name: t.name, symbol: t.symbol, decimals: 18, totalSupply: '1000000000000000000000000000',
    image, description: String(m.description ?? '').slice(0, 1000) || null, links,
    creator: t.creator ? getAddress(t.creator) : null, createdAt: Math.floor(Number(t.created ?? 0) / 1000) || null, launchBlock: t.creationBlock ?? null, launchTx: t.hash ?? null,
    metadataURI: t.metadataURI || null,
    pool: { venue: 'Uniswap v4', poolManager: t.poolManager ?? null, poolId: t.poolId ?? null, hook: t.hook ?? null, quote: t.quoteAddress ? getAddress(t.quoteAddress) : null, quoteSymbol: t.quoteSymbol ?? null, pairKind: t.pair ?? null },
    feeBps: t.feeBps ?? null, graduated: !!t.graduated,
    launchpad: { name: 'Elpida', url: `${origin}/token/${net.key}/${String(t.address).toLowerCase()}`, factory: t.factory ?? null },
    explorer: net.explorer ? `${net.explorer}/token/${t.address}` : null,
  };
}

/**
 * The feed: launches on one mainnet (or all), newest first. `since` (unix seconds) and `limit` (max 500) page it.
 * Only Elpida V2 launches on mainnets: test networks never appear.
 */
export function scannerFeed({ networks, listings, origin, network = null, since = 0, limit = 100 }) {
  const nets = networks.filter(n => n.mainnet && n.kind === 'evm' && (!network || n.key === network));
  const tokens = nets.flatMap(net => listings(net.key).filter(t => t.deploymentModel === 'v2-hook').map(t => scannerToken(t, net, origin)))
    .filter(t => (t.createdAt ?? 0) >= since).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  const n = Math.max(1, Math.min(500, Number(limit) || 100));
  return { version: SCANNER_FEED_VERSION, launchpad: 'Elpida', site: origin, chains: nets.map(n => ({ chainId: n.chainId, network: n.key, name: n.name })), count: Math.min(n, tokens.length), tokens: tokens.slice(0, n) };
}
