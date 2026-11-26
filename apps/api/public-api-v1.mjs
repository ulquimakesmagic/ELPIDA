// The public read API for builders, version 1 (Malik, 26 November 2026: "a way to publish our integration docs for
// people wanting to build on Elpida"). A small, stable set of GET endpoints under /api/v1, documented on the Developers
// section of the docs (#/docs/developers) and in docs/PUBLIC_API.md. The site's own /api/public/* endpoints stay
// internal: they can change without notice; /api/v1 only grows (new fields, new endpoints), never breaks.
//
// Everything here is public already (on chain or on the token pages). Mainnet EVM launches of the V2 launchpad only.
// Open to any origin (CORS *), cached briefly, and rate limited per client so outside traffic cannot slow the site.
import { Interface, getAddress } from 'ethers';
import { scannerFeed, scannerToken } from './scanner-feed.mjs';
import { PUBLIC_ABIS } from '../../packages/core/public-abi.mjs';
import { V23_FEE_SPLIT } from '../../packages/core/v2-economics.mjs';

export const API_V1_VERSION = 1;
/** Requests a client may make per minute; beyond it the API answers 429 with Retry-After. */
export const API_V1_PER_MINUTE = 120;
const NETWORK = /^[a-z0-9-]{2,40}$/, ADDRESS = /^0x[0-9a-fA-F]{40}$/, INTERVALS = [60, 300, 900, 3600, 14400, 86400];
const ENDPOINTS = [
  ['GET /api/v1', 'This index.'],
  ['GET /api/v1/chains', 'Every mainnet Elpida runs on, with its contract addresses and fee split.'],
  ['GET /api/v1/tokens?chain=&since=&limit=', 'Launches, newest first: identity, creator, metadata (image, links), pool. limit ≤ 500.'],
  ['GET /api/v1/tokens/{chain}/{address}', 'One launch.'],
  ['GET /api/v1/tokens/{chain}/{address}/trades?limit=', 'Its latest trades, newest first. limit ≤ 500.'],
  ['GET /api/v1/tokens/{chain}/{address}/candles?interval=&limit=', 'Price candles; interval in seconds: 60, 300, 900, 3600, 14400 or 86400.'],
  ['GET /api/v1/tokens/{chain}/{address}/holders', 'Its largest holders.'],
  ['GET /api/v1/rewards?wallet=', 'The monthly trader airdrop (EWPR): rules, the month so far, and one wallet’s standing.'],
  ['GET /api/v1/abi', 'The contract interfaces (factory, router, hook, token) as JSON ABIs.'],
  ['GET /api/v1/abi/{name}', 'One of them.'],
];

/**
 * `ctx`: { networks() → the EVM networks, index → the public indexer (listings, listing, detail, freshness),
 * origin() → the site's https origin, ewpr(wallet|null) → the trader airdrop status, clientIp(req), now() }.
 * Returns a handler `(req, res, url, send) → boolean` that answers /api/v1 and /api/v1/* and returns false otherwise.
 */
export function publicApiV1(ctx) {
  const now = ctx.now ?? (() => Date.now()), buckets = new Map();
  const abis = Object.fromEntries(Object.entries(PUBLIC_ABIS).map(([k, v]) => [k, JSON.parse(new Interface(v).formatJson())]));
  const mainnets = () => ctx.networks().filter(n => n.mainnet && n.kind === 'evm');
  const limited = req => {
    const ip = String(ctx.clientIp(req) ?? 'unknown'), t = now(), b = buckets.get(ip) ?? { start: t, count: 0 };
    if (t - b.start >= 60_000) { b.start = t; b.count = 0; }
    b.count++; buckets.set(ip, b);
    if (buckets.size > 20_000) for (const [k, v] of buckets) if (t - v.start >= 60_000) buckets.delete(k);
    return b.count > API_V1_PER_MINUTE ? Math.ceil((b.start + 60_000 - t) / 1000) : 0;
  };
  const chain = key => mainnets().find(n => n.key === key) ?? null;
  const contractsOf = net => {
    const v2 = net.v2?.shared ?? {};
    const pick = { factory: v2.factory, hook: v2.hook, router: v2.router, traderAirdrop: v2.usdcAirdrop, treasury: v2.treasury, poolManager: net.v4?.poolManager ?? v2.poolManager };
    return Object.fromEntries(Object.entries(pick).filter(([, a]) => typeof a === 'string' && ADDRESS.test(a)).map(([k, a]) => [k, getAddress(a)]));
  };
  const v23 = net => (net.v2?.shared?.model ?? '') === 'v2.3-hook';

  return async function handle(req, res, url, send) {
    if (url.pathname !== '/api/v1' && !url.pathname.startsWith('/api/v1/')) return false;
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Methods', 'GET'); res.setHeader('Access-Control-Max-Age', '86400'); res.writeHead(204); res.end(); return true; }
    if (req.method !== 'GET') { send(405, { error: 'The public API is read-only: use GET.' }); return true; }
    const wait = limited(req);
    if (wait) { res.setHeader('Retry-After', String(wait)); send(429, { error: `Rate limit: ${API_V1_PER_MINUTE} requests a minute. Retry in ${wait} s.` }); return true; }
    res.setHeader('Cache-Control', 'public, max-age=15, stale-while-revalidate=30');
    const path = url.pathname.replace(/\/+$/, '') || '/api/v1', origin = ctx.origin();

    if (path === '/api/v1') { send(200, { version: API_V1_VERSION, launchpad: 'Elpida', site: origin, docs: `${origin}/#/docs/developers`, rateLimitPerMinute: API_V1_PER_MINUTE, endpoints: ENDPOINTS.map(([route, description]) => ({ route, description })) }); return true; }
    if (path === '/api/v1/chains') {
      res.setHeader('Cache-Control', 'public, max-age=300');
      send(200, { version: API_V1_VERSION, chains: mainnets().map(net => ({ chainId: net.chainId, chain: net.key, name: net.name, explorer: net.explorer ?? null, nativeSymbol: net.nativeCurrency?.symbol ?? null, payoutToken: net.payoutStable?.symbol ?? 'USDC', contracts: contractsOf(net), feeSplitBps: v23(net) ? { traders: V23_FEE_SPLIT.traderAirdrop, creator: V23_FEE_SPLIT.creator, elpida: V23_FEE_SPLIT.treasury } : null })) });
      return true;
    }
    if (path === '/api/v1/abi') { res.setHeader('Cache-Control', 'public, max-age=3600'); send(200, { version: API_V1_VERSION, abis }); return true; }
    { const m = path.match(/^\/api\/v1\/abi\/([a-z]+)$/); if (m) { if (!abis[m[1]]) { send(404, { error: `Unknown ABI. Choose one of: ${Object.keys(abis).join(', ')}.` }); return true; } res.setHeader('Cache-Control', 'public, max-age=3600'); send(200, abis[m[1]]); return true; } }
    if (path === '/api/v1/tokens') {
      const key = url.searchParams.get('chain');
      if (key && (!NETWORK.test(key) || !chain(key))) { send(400, { error: 'Unknown chain. See /api/v1/chains.' }); return true; }
      const since = Number(url.searchParams.get('since') ?? 0), limit = Number(url.searchParams.get('limit') ?? 100);
      const feed = scannerFeed({ networks: mainnets(), listings: k => ctx.index.listings(k), origin, network: key || null, since: Number.isFinite(since) ? since : 0, limit });
      send(200, { version: API_V1_VERSION, count: feed.count, tokens: feed.tokens.map(t => ({ ...t, chain: t.network })) });
      return true;
    }
    const m = path.match(/^\/api\/v1\/tokens\/([a-z0-9-]{2,40})\/(0x[0-9a-fA-F]{40})(?:\/(trades|candles|holders))?$/);
    if (m) {
      const net = chain(m[1]), address = m[2].toLowerCase();
      if (!net) { send(400, { error: 'Unknown chain. See /api/v1/chains.' }); return true; }
      const t = ctx.index.listing(net.key, address);
      if (!t || t.deploymentModel !== 'v2-hook') { send(404, { error: 'No Elpida launch at that address on that chain.' }); return true; }
      const fresh = ctx.index.freshness?.(net.key, address) ?? null;
      if (!m[3]) { const token = scannerToken(t, net, origin); send(200, { version: API_V1_VERSION, ...token, chain: token.network, indexedAt: fresh?.indexedAt ?? null, stale: !!fresh?.stale }); return true; }
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 100));
      let interval = 60;
      if (m[3] === 'candles') { interval = Number(url.searchParams.get('interval') ?? 60); if (!INTERVALS.includes(interval)) { send(400, { error: `interval must be one of ${INTERVALS.join(', ')} (seconds).` }); return true; } }
      let data;
      try { data = ctx.index.detail(net.key, address, m[3], interval, limit); } catch { send(503, { error: 'The index for this chain is catching up. Retry shortly.' }); return true; }
      send(200, { version: API_V1_VERSION, chain: net.key, token: getAddress(address), indexedAt: fresh?.indexedAt ?? null, stale: !!fresh?.stale, [m[3]]: data ?? [] });
      return true;
    }
    if (path === '/api/v1/rewards') {
      const w = url.searchParams.get('wallet');
      if (w && !ADDRESS.test(w)) { send(400, { error: 'wallet must be a 0x address.' }); return true; }
      const status = ctx.ewpr?.(w || null) ?? null;
      if (!status) { send(503, { error: 'Trader rewards are not available on this server right now.' }); return true; }
      send(200, { version: API_V1_VERSION, ...status });
      return true;
    }
    send(404, { error: 'Unknown endpoint. See /api/v1 for the list.' });
    return true;
  };
}
