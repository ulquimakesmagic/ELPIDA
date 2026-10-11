import { PriceKeeper } from './price-keeper.mjs';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createRuntime } from './curve-runtime.mjs';
import {MetadataStore} from './metadata-store.mjs';
import { publicOrigin, acceptsRequest } from './network-policy.mjs';
import { MAX_METADATA_REQUEST_BYTES } from '../web/metadata.mjs';
import { evmTestnets, solanaDevnet, solanaLocalnet, solanaMainnet } from '../../packages/core/networks.mjs';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const ethersFile = fileURLToPath(new URL('../../node_modules/ethers/dist/ethers.min.js', import.meta.url));
const resources = new Map([['/', ['index.html', 'text/html']], ['/launch', ['index.html', 'text/html']], ['/reward-policy.mjs', ['reward-policy.mjs', 'text/javascript']], ['/reward-ui.mjs', ['reward-ui.mjs', 'text/javascript']], ['/metadata.mjs', ['metadata.mjs', 'text/javascript']], ['/launch-capabilities.mjs', ['launch-capabilities.mjs', 'text/javascript']], ['/styles.css', ['styles.css', 'text/css']], ['/app.mjs', ['app.mjs', 'text/javascript']], ['/wallet.mjs', ['wallet.mjs', 'text/javascript']], ['/solana-wallet.mjs', ['solana-wallet.mjs', 'text/javascript']], ['/ui.mjs', ['ui.mjs', 'text/javascript']], ['/launch-flow.mjs', ['launch-flow.mjs', 'text/javascript']], ['/token-page.mjs', ['token-page.mjs', 'text/javascript']], ['/rewards-view.mjs', ['rewards-view.mjs', 'text/javascript']]]);
// Static design assets (brand, fonts, icon sprite): only these extensions, only inside apps/web/assets.
const assetRoot = fileURLToPath(new URL('../web/assets/', import.meta.url));
resources.set('/metadata-cache.mjs', ['metadata-cache.mjs', 'text/javascript']);
const assetTypes = { '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };
const vendorFiles = new Map([
  ['/vendor/ethers.js', ethersFile],
  ['/vendor/solana-web3.js', fileURLToPath(new URL('../../node_modules/@solana/web3.js/lib/index.iife.min.js', import.meta.url))],
  ['/elpida-solana.mjs', fileURLToPath(new URL('../../packages/solana/client.mjs', import.meta.url))],
  ['/pairs.mjs', fileURLToPath(new URL('../../packages/core/pairs.mjs', import.meta.url))],
]);
const base58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Solana Devnet by default; ELPIDA_SOLANA_CLUSTER=localnet targets a local solana-test-validator.
// The deployment comes from networks.mjs `shared`, else from `npm run solana:deploy` output.
export function solanaConfig() {
  const cluster = process.env.ELPIDA_SOLANA_CLUSTER;
  const net = cluster === 'localnet' ? solanaLocalnet : cluster === 'mainnet' ? solanaMainnet : solanaDevnet;
  let deployment = null;
  if (net.shared?.programId && base58.test(net.shared.programId)) deployment = { programId: net.shared.programId, shared: true };
  else {
    // This machine's own deploy record first, then the committed public copy (what Railway serves).
    const file = [`../../local-data/solana-${net.cluster}.json`, `../../deployments/solana-${net.cluster}.json`].map(path => fileURLToPath(new URL(path, import.meta.url))).find(path => existsSync(path));
    if (file) {
      try {
        const record = JSON.parse(readFileSync(file, 'utf8'));
        if (base58.test(record.programId) && record.cluster === net.cluster) deployment = { programId: record.programId, shared: false, build: record.build ?? 'testnet', pairs: Array.isArray(record.pairs) ? record.pairs.filter(p => p && base58.test(p.config ?? '') && base58.test(p.mint ?? '') && ['native', 'xstock', 'token'].includes(p.kind)).map(({ kind, key, symbol, name, mint, config, decimals, tokenProgram, test, wsol, faucet }) => ({ kind, key, symbol, name, mint, config, decimals, tokenProgram, test: !!test, wsol: !!wsol, faucet: faucet ?? null })) : null };
      } catch {}
    }
  }
  return { ...net, deployment };
}

/**
 * Mainnet: forwards the browser's Solana JSON-RPC calls to SOLANA_RPC_URL (for example a Helius URL with
 * its API key), so the key stays on the server. Only the read, simulate and send methods the app uses are
 * allowed, one call per request, with a per-address rate limit.
 */
export const RPC_METHODS = new Set(['getAccountInfo', 'getMultipleAccounts', 'getProgramAccounts', 'getBalance', 'getLatestBlockhash', 'getBlockHeight', 'getSlot', 'getBlockTime', 'getSignatureStatuses', 'simulateTransaction', 'sendTransaction', 'getMinimumBalanceForRentExemption', 'getTransaction', 'getEpochInfo', 'getVersion', 'getGenesisHash', 'getFeeForMessage', 'isBlockhashValid', 'getTokenAccountBalance']);
export function createRpcProxy(target, { perSecond = 15, burst = 60 } = {}) {
  // https only, except a local validator used to rehearse a mainnet deployment.
  if (!target || !/^https:\/\/|^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(target)) { console.warn('Solana mainnet needs SOLANA_RPC_URL (https) for the RPC proxy.'); return null; }
  const buckets = new Map();
  return async (req, res, send) => {
    const ip = req.socket.remoteAddress ?? 'unknown', now = Date.now();
    const bucket = buckets.get(ip) ?? { tokens: burst, at: now };
    bucket.tokens = Math.min(burst, bucket.tokens + (now - bucket.at) / 1000 * perSecond); bucket.at = now; buckets.set(ip, bucket);
    if (buckets.size > 10_000) buckets.clear();
    if (bucket.tokens < 1) return send(429, { jsonrpc: '2.0', error: { code: 429, message: 'Too many requests. Slow down.' }, id: null });
    bucket.tokens -= 1;
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 65_536) return send(413, { jsonrpc: '2.0', error: { code: 413, message: 'Request too large.' }, id: null }); chunks.push(chunk); }
    let body; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { return send(400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }); }
    if (!body || Array.isArray(body) || !RPC_METHODS.has(body.method)) return send(400, { jsonrpc: '2.0', error: { code: -32601, message: 'Method not allowed' }, id: body?.id ?? null });
    try {
      const upstream = await fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, method: body.method, params: body.params ?? [] }), signal: AbortSignal.timeout(20_000) });
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' }); return res.end(await upstream.text());
    } catch { return send(502, { jsonrpc: '2.0', error: { code: 502, message: 'Solana RPC unavailable' }, id: body.id ?? null }); }
  };
}

export async function startServer({ port = Number(process.env.PORT ?? 3000), seed = true, publicUrl = publicOrigin(), host = process.env.HOST ?? '127.0.0.1' } = {}) {
  const dataPrefix=port===3000||process.env.RAILWAY_ENVIRONMENT_NAME?'':`preview-${port}-`;
  const metadataStore=new MetadataStore({path:port===0?null:fileURLToPath(new URL('../../local-data/'+dataPrefix+'ipfs-content',import.meta.url))});
  const runtime = await createRuntime({ seed, metadataStore, metadataPath:port===0?null:fileURLToPath(new URL('../../local-data/'+dataPrefix+'token-metadata.json',import.meta.url)), dex:port!==0, indexerPath:port===0?":memory:":fileURLToPath(new URL('../../local-data/'+dataPrefix+'curve-dex-usd-v9-index.sqlite',import.meta.url)) });
  const priceKeeper=new PriceKeeper();
  const updatePrices=async()=>{await priceKeeper.refresh();const prices=priceKeeper.snapshot();const p=[prices.local,prices['base-sepolia'],prices['ethereum-sepolia']].find(p=>p.status==='fresh');if(p)await runtime.updatePrice(p.usd);};
  const priceTimer=port===0?null:setInterval(()=>updatePrices().catch(()=>{}),60000);priceTimer?.unref();
  if(port!==0)updatePrices().catch(()=>{});
  const priceSnapshot=()=>({...priceKeeper.snapshot(),local:runtime.config.local.price});
  const cookieSecurity = publicUrl ? '; Secure' : '';
  const csrf = randomBytes(24).toString('hex');
  const solana = solanaConfig();
  const connectSources = [...evmTestnets.map(net => net.rpcUrl), solana.rpcUrl, solana.wsUrl].filter(url => /^(https?|wss?):/.test(url ?? '')).join(' ');
  const rpcProxy = solana.mainnet ? createRpcProxy(process.env.SOLANA_RPC_URL) : null;
  const server = createServer(async (req, res) => {
    const actualPort = server.address().port;
    const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self' ${connectSources}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    if (!acceptsRequest({host:req.headers.host,origin:req.headers.origin,method:req.method,path:req.url,port:actualPort,publicUrl})) return send(403, { error: 'Host or origin not allowed.' });
    if (req.method === 'GET' && req.url === '/health') return send(200, {status:'ok',mode:'simulation'});
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET') {
        if(url.pathname==='/api/rewards/x/callback'){
          try{const cookie=String(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith('elpida_x='))?.slice(9);await runtime.transact('reward-x-finish',{state:url.searchParams.get('state'),code:url.searchParams.get('code'),cookie});res.writeHead(200,{'Content-Type':'text/html','Set-Cookie':`elpida_x=; HttpOnly; SameSite=Lax; Path=/api/rewards/x/callback; Max-Age=0${cookieSecurity}`});return res.end('<!doctype html><title>X verified</title><h1>X profile verified</h1><p>Your rewards are bound to the signed payout wallet. Return to Creator rewards and refresh to claim.</p><a href="/">Return to Elpida</a>');}catch{ return send(400,{error:'X verification failed or expired. Return to the dashboard and try again.'});}
        }
        if (url.pathname === '/api/rewards') return send(200,await runtime.rewards.dashboard());
        if(url.pathname==='/api/prices')return send(200,priceSnapshot());
        if (url.pathname === '/api/config') return send(200, { ...runtime.config, prices:priceSnapshot(), hostedSimulation:Boolean(publicUrl), metadataPublishing:metadataStore.status(), solana: solanaConfig(), csrf });
        if(url.pathname==='/api/metadata/resolve')return send(200,await metadataStore.resolve(url.searchParams.get('uri')));
        if(url.pathname.startsWith('/api/content/')){const record=metadataStore.get(url.pathname.slice('/api/content/'.length));if(!record)return send(404,{error:'Content not found.'});res.writeHead(200,{'Content-Type':record.type,'Cache-Control':'public, max-age=31536000, immutable'});return res.end(Buffer.from(record.data,'base64'));}
        if (url.pathname === '/api/indexer/status') { await runtime.indexer.sync(); return send(200,runtime.indexer.status()); }
        if (url.pathname === '/api/tokens') { await runtime.indexer.sync(); return send(200,runtime.listings()); }
        const indexed = url.pathname.match(/^\/api\/tokens\/(0x[a-fA-F0-9]{40})(?:\/(trades|candles))?$/);
        if (indexed) { await runtime.indexer.sync(); const token=runtime.listings().find(t=>t.address===indexed[1].toLowerCase()); if(!token)return send(404,{error:'Token not found.'}); return send(200,indexed[2]==='trades'?runtime.indexer.trades(token.address):indexed[2]==='candles'?runtime.indexer.candles(token.address,Number(url.searchParams.get('interval')??60)):token); }
        if (url.pathname === '/api/state') return send(200, await runtime.state(url.searchParams.get('account') ?? '0'));
        if (vendorFiles.has(url.pathname)) { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); return res.end(await readFile(vendorFiles.get(url.pathname))); }
        const resource = resources.get(url.pathname);
        if (resource) { const content = await readFile(resolve(webRoot, resource[0])); res.writeHead(200, { 'Content-Type': `${resource[1]}; charset=utf-8` }); return res.end(content); }
        if (url.pathname.startsWith('/assets/')) {
          const file = resolve(assetRoot, '.' + decodeURIComponent(url.pathname.slice('/assets'.length)));
          const type = assetTypes[file.slice(file.lastIndexOf('.'))];
          if (!type || !file.startsWith(assetRoot) || !existsSync(file)) return send(404, { error: 'Not found.' });
          res.setHeader('Cache-Control', 'public, max-age=3600');
          res.writeHead(200, { 'Content-Type': type }); return res.end(await readFile(file));
        }
        if (url.pathname === '/favicon.ico') { res.writeHead(302, { Location: '/assets/brand/favicon-32.png' }); return res.end(); }
        return send(404, { error: 'Not found.' });
      }
      if (req.method === 'POST' && url.pathname === '/api/solana-rpc') return rpcProxy ? rpcProxy(req, res, send) : send(404, { error: 'Not found.' });
      if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) return send(405, { error: 'Method not allowed.' });
      if (req.headers['x-elpida-token'] !== csrf || req.headers['content-type'] !== 'application/json') return send(403, { error: 'Refresh this page before submitting.' });
      const chunks = [];
      let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > (['/api/launch','/api/metadata/publish'].includes(url.pathname) ? MAX_METADATA_REQUEST_BYTES : 8192)) { send(413, { error: 'Request too large.' }); return; } chunks.push(chunk); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { return send(400, { error: 'Invalid request.' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return send(400, { error: 'Invalid request.' });
      const action = url.pathname.slice('/api/'.length);
      if(action==='metadata/publish')return send(200,await metadataStore.publish(body,true));
      if(action==='reward-x-start'){const result=await runtime.transact(action,body);res.setHeader('Set-Cookie',`elpida_x=${result.cookie}; HttpOnly; SameSite=Lax; Path=/api/rewards/x/callback; Max-Age=600${cookieSecurity}`);return send(200,{url:result.url});}
      if (action === 'quote') return send(200, await runtime.getQuote(body));
      if (!['launch', 'buy', 'sell', 'withdraw', 'graduate', 'reward-claim', 'reward-challenge', 'reward-verify', 'reward-process', 'reward-stock-faucet'].includes(action)) return send(404, { error: 'Action not found.' });
      return send(200, await runtime.transact(action, body));
    } catch (error) {
      const message = error.reason ?? error.shortMessage ?? error.message ?? 'Request failed.';
      return send(400, { error: String(message).slice(0, 250) });
    }
  });
  const rewardTimer=port===0?null:setInterval(()=>runtime.transact('reward-process',{}).catch(()=>{}),30000);rewardTimer?.unref();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, host, done); });
  return { url: `http://localhost:${server.address().port}`, runtime, async close() {clearInterval(priceTimer);clearInterval(rewardTimer); await new Promise(done => server.close(done)); await runtime.close(); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log('Starting Elpida local chain and deploying demo contracts…');
  let app;
  try { app = await startServer(); }
  catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    const port = process.env.PORT ?? 3000;
    console.error(`\nPort ${port} is already in use, probably by another Elpida server.`);
    console.error(`Open http://localhost:${port}, stop the other server, or pick another port:`);
    console.error(`  PowerShell:  $env:PORT=${Number(port) + 1}; npm.cmd run dev`);
    console.error(`  bash:        PORT=${Number(port) + 1} npm run dev\n`);
    process.exit(1);
  }
  console.log(`Elpida is ready: ${app.url}`);
  console.log('Local demo balances and launches reset when this process restarts.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
