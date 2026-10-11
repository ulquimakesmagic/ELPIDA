import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createRuntime } from './curve-runtime.mjs';
import {MetadataStore} from './metadata-store.mjs';
import { evmTestnets, solanaDevnet, solanaLocalnet } from '../../packages/core/networks.mjs';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const ethersFile = fileURLToPath(new URL('../../node_modules/ethers/dist/ethers.min.js', import.meta.url));
const resources = new Map([['/', ['index.html', 'text/html']], ['/launch', ['index.html', 'text/html']], ['/reward-policy.mjs', ['reward-policy.mjs', 'text/javascript']], ['/reward-ui.mjs', ['reward-ui.mjs', 'text/javascript']], ['/metadata.mjs', ['metadata.mjs', 'text/javascript']], ['/launch-capabilities.mjs', ['launch-capabilities.mjs', 'text/javascript']], ['/styles.css', ['styles.css', 'text/css']], ['/app.mjs', ['app.mjs', 'text/javascript']], ['/wallet.mjs', ['wallet.mjs', 'text/javascript']], ['/solana-wallet.mjs', ['solana-wallet.mjs', 'text/javascript']], ['/ui.mjs', ['ui.mjs', 'text/javascript']], ['/launch-flow.mjs', ['launch-flow.mjs', 'text/javascript']], ['/token-page.mjs', ['token-page.mjs', 'text/javascript']], ['/rewards-view.mjs', ['rewards-view.mjs', 'text/javascript']]]);
// Static design assets (brand, fonts, icon sprite): only these extensions, only inside apps/web/assets.
const assetRoot = fileURLToPath(new URL('../web/assets/', import.meta.url));
const assetTypes = { '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };
const vendorFiles = new Map([
  ['/vendor/ethers.js', ethersFile],
  ['/vendor/solana-web3.js', fileURLToPath(new URL('../../node_modules/@solana/web3.js/lib/index.iife.min.js', import.meta.url))],
  ['/elpida-solana.mjs', fileURLToPath(new URL('../../packages/solana/client.mjs', import.meta.url))],
]);
const base58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Solana Devnet by default; ELPIDA_SOLANA_CLUSTER=localnet targets a local solana-test-validator.
// The deployment comes from networks.mjs `shared`, else from `npm run solana:deploy` output.
export function solanaConfig() {
  const net = process.env.ELPIDA_SOLANA_CLUSTER === 'localnet' ? solanaLocalnet : solanaDevnet;
  let deployment = null;
  if (net.shared?.programId && base58.test(net.shared.programId)) deployment = { programId: net.shared.programId, shared: true };
  else {
    const file = fileURLToPath(new URL(`../../local-data/solana-${net.cluster}.json`, import.meta.url));
    if (existsSync(file)) {
      try {
        const record = JSON.parse(readFileSync(file, 'utf8'));
        if (base58.test(record.programId) && record.cluster === net.cluster) deployment = { programId: record.programId, shared: false };
      } catch {}
    }
  }
  return { ...net, deployment };
}

export async function startServer({ port = Number(process.env.PORT ?? 3000), seed = true } = {}) {
  const metadataStore=new MetadataStore({path:port===0?null:fileURLToPath(new URL('../../local-data/ipfs-content',import.meta.url))});
  const runtime = await createRuntime({ seed, metadataStore, metadataPath:port===0?null:fileURLToPath(new URL("../../local-data/token-metadata.json",import.meta.url)), dex:port!==0, indexerPath:port===0?":memory:":fileURLToPath(new URL("../../local-data/curve-dex-v5-index.sqlite",import.meta.url)) });
  const csrf = randomBytes(24).toString('hex');
  const solana = solanaConfig();
  const connectSources = [...evmTestnets.map(net => net.rpcUrl), solana.rpcUrl, solana.wsUrl].join(' ');
  const server = createServer(async (req, res) => {
    const actualPort = server.address().port;
    const hosts = [`localhost:${actualPort}`, `127.0.0.1:${actualPort}`];
    const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self' ${connectSources}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    if (!hosts.includes(req.headers.host)) return send(403, { error: 'Local access only.' });
    if (req.headers.origin && !hosts.map(host => `http://${host}`).includes(req.headers.origin)) return send(403, { error: 'Origin not allowed.' });
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET') {
        if(url.pathname==='/api/rewards/x/callback'){
          try{const cookie=String(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith('elpida_x='))?.slice(9);await runtime.transact('reward-x-finish',{state:url.searchParams.get('state'),code:url.searchParams.get('code'),cookie});res.writeHead(200,{'Content-Type':'text/html','Set-Cookie':'elpida_x=; HttpOnly; SameSite=Lax; Path=/api/rewards/x/callback; Max-Age=0'});return res.end('<!doctype html><title>X verified</title><h1>X profile verified</h1><p>Your rewards are bound to the signed payout wallet. Return to Creator rewards and refresh to claim.</p><a href="/">Return to Elpida</a>');}catch{ return send(400,{error:'X verification failed or expired. Return to the dashboard and try again.'});}
        }
        if (url.pathname === '/api/rewards') return send(200,await runtime.rewards.dashboard());
        if (url.pathname === '/api/config') return send(200, { ...runtime.config, metadataPublishing:metadataStore.status(), solana: solanaConfig(), csrf });
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
      if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) return send(405, { error: 'Method not allowed.' });
      if (req.headers['x-elpida-token'] !== csrf || req.headers['content-type'] !== 'application/json') return send(403, { error: 'Refresh this page before submitting.' });
      const chunks = [];
      let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > (['/api/launch','/api/metadata/publish'].includes(url.pathname) ? 400000 : 8192)) { send(413, { error: 'Request too large.' }); return; } chunks.push(chunk); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { return send(400, { error: 'Invalid request.' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return send(400, { error: 'Invalid request.' });
      const action = url.pathname.slice('/api/'.length);
      if(action==='metadata/publish')return send(200,await metadataStore.publish(body,true));
      if(action==='reward-x-start'){const result=await runtime.transact(action,body);res.setHeader('Set-Cookie',`elpida_x=${result.cookie}; HttpOnly; SameSite=Lax; Path=/api/rewards/x/callback; Max-Age=600`);return send(200,{url:result.url});}
      if (action === 'quote') return send(200, await runtime.getQuote(body));
      if (!['launch', 'buy', 'sell', 'withdraw', 'faucet', 'graduate', 'reward-claim', 'reward-challenge', 'reward-verify', 'reward-process', 'reward-stock-faucet'].includes(action)) return send(404, { error: 'Action not found.' });
      return send(200, await runtime.transact(action, body));
    } catch (error) {
      const message = error.reason ?? error.shortMessage ?? error.message ?? 'Request failed.';
      return send(400, { error: String(message).slice(0, 250) });
    }
  });
  const rewardTimer=port===0?null:setInterval(()=>runtime.transact('reward-process',{}).catch(()=>{}),30000);rewardTimer?.unref();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  return { url: `http://localhost:${server.address().port}`, runtime, async close() {clearInterval(rewardTimer); await new Promise(done => server.close(done)); await runtime.close(); } };
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
