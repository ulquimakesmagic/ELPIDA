import {CreatorFeeTotals} from './creator-fees.mjs';
import { indexedChange, indexedActivity, activityOf } from '../web/discovery.mjs';
import { protocolAnalytics } from './protocol-analytics.mjs';
import { PriceKeeper } from './price-keeper.mjs';
import {configuredGraduationKeeper} from './graduation-keeper.mjs';
import { PublicIndexer, recentTrade } from './public-indexer.mjs';
import { SolanaIndexer } from '../../packages/indexer/solana-indexer.mjs';
import { validateSolanaRpc } from '../../packages/solana/rpc-config.mjs';
import * as solanaWeb3 from '@solana/web3.js';
import { createCircleFunding } from './circle-test-wallets.mjs';
import { VanityMintPool, vanityKey, clientAddress } from './vanity-mints.mjs';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createRuntime } from './curve-runtime.mjs';
import {MetadataStore} from './metadata-store.mjs';
import {UploadAdmission} from './upload-admission.mjs';
import {configuredBackup} from './backup-runner.mjs';
import {OperationsMonitor,evaluateOperations} from './operations-health.mjs';
import {tmpdir} from 'node:os';
import {Contract,keccak256,formatUnits,parseUnits} from 'ethers';
import {HolderTheses,thesisIdentity} from './holder-theses.mjs';
import {HolderChat} from './holder-chat.mjs';
import {positionSummary} from '../../packages/core/position.mjs';
import { publicOrigin, acceptsRequest } from './network-policy.mjs';
import { createTokenizedEquity } from '../../packages/core/tokenized-equity.mjs';
import { MAX_METADATA_REQUEST_BYTES, normalizeMetadata } from '../web/metadata.mjs';
import { WalletTokenLists, walletTokenEntries } from './wallet-tokenlist.mjs';
const tokenizedEquity=createTokenizedEquity(JSON.parse(readFileSync(new URL('../../config/tokenized-equity-registry.json',import.meta.url),'utf8')),{env:process.env});
import { evmTestnets, solanaDevnet, solanaLocalnet, solanaMainnet } from '../../packages/core/networks.mjs';
import { isDexModel } from '../../packages/core/curve-model.mjs';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const ethersFile = fileURLToPath(new URL('../../node_modules/ethers/dist/ethers.min.js', import.meta.url));
const resources = new Map([['/', ['index.html', 'text/html']], ['/launch', ['index.html', 'text/html']], ['/reward-policy.mjs', ['reward-policy.mjs', 'text/javascript']], ['/reward-ui.mjs', ['reward-ui.mjs', 'text/javascript']], ['/metadata.mjs', ['metadata.mjs', 'text/javascript']], ['/launch-capabilities.mjs', ['launch-capabilities.mjs', 'text/javascript']], ['/styles.css', ['styles.css', 'text/css']], ['/app.mjs', ['app.mjs', 'text/javascript']], ['/wallet.mjs', ['wallet.mjs', 'text/javascript']], ['/solana-wallet.mjs', ['solana-wallet.mjs', 'text/javascript']], ['/ui.mjs', ['ui.mjs', 'text/javascript']], ['/launch-flow.mjs', ['launch-flow.mjs', 'text/javascript']], ['/token-page.mjs', ['token-page.mjs', 'text/javascript']], ['/amounts.mjs', ['amounts.mjs', 'text/javascript']], ['/rewards-view.mjs', ['rewards-view.mjs', 'text/javascript']]]);
// Static design assets (brand, fonts, icon sprite): only these extensions, only inside apps/web/assets.
const assetRoot = fileURLToPath(new URL('../web/assets/', import.meta.url));
resources.set('/terminal-chart.mjs',['terminal-chart.mjs','text/javascript']);
resources.set('/holder-terminal.mjs',['holder-terminal.mjs','text/javascript']);
resources.set('/chat-signature.mjs',['chat-signature.mjs','text/javascript']);
resources.set('/holder-chat.mjs',['holder-chat.mjs','text/javascript']);
resources.set('/trade-filter.mjs',['trade-filter.mjs','text/javascript']);
resources.set('/tax-policy.mjs',['tax-policy.mjs','text/javascript']);
resources.set('/tax-wallet.mjs',['tax-wallet.mjs','text/javascript']);
resources.set('/tax-allocation.mjs',['tax-allocation.mjs','text/javascript']);
resources.set('/wallet-discovery.mjs', ['wallet-discovery.mjs','text/javascript']);
resources.set('/wallet-token.mjs', ['wallet-token.mjs','text/javascript']);
resources.set('/discovery.mjs', ['discovery.mjs','text/javascript']);
resources.set('/chain-ui.mjs', ['chain-ui.mjs','text/javascript']);
resources.set('/usdc-conversion.mjs', ['usdc-conversion.mjs','text/javascript']);
resources.set('/usdc-funding.mjs', ['usdc-funding.mjs','text/javascript']);
resources.set('/payment-errors.mjs', ['payment-errors.mjs','text/javascript']);
resources.set('/analytics', ['index.html', 'text/html']);
resources.set('/analytics-view.mjs', ['analytics-view.mjs', 'text/javascript']);
resources.set('/metadata-cache.mjs', ['metadata-cache.mjs', 'text/javascript']);
resources.set('/wallet-batch.mjs', ['wallet-batch.mjs', 'text/javascript']);
resources.set('/upload-proof.mjs', ['upload-proof.mjs', 'text/javascript']);
resources.set('/upload-proof-worker.mjs', ['upload-proof-worker.mjs', 'text/javascript']);
resources.set('/circle-funding.mjs', ['circle-funding.mjs', 'text/javascript']);
resources.set('/clock.mjs', ['clock.mjs', 'text/javascript']);
resources.set('/theme.css', ['theme.css', 'text/css']);
resources.set('/search.mjs',['search.mjs','text/javascript']);
resources.set('/shell.mjs', ['shell.mjs', 'text/javascript']);
resources.set('/theme-boot.js', ['theme-boot.js', 'text/javascript']);
resources.set('/explore-view.mjs', ['explore-view.mjs', 'text/javascript']);
resources.set('/odometer.mjs', ['odometer.mjs', 'text/javascript']);
resources.set('/explore.css', ['explore.css', 'text/css']);
resources.set('/token.css', ['token.css', 'text/css']);
resources.set('/launch.css', ['launch.css', 'text/css']);
resources.set('/docs.css', ['docs.css', 'text/css']);
resources.set('/docs-view.mjs', ['docs-view.mjs', 'text/javascript']);
const assetTypes = { '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };
const vendorFiles = new Map([
  ['/vendor/lightweight-charts.js', fileURLToPath(new URL('../../node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js', import.meta.url))],
  ['/vendor/ethers.js', ethersFile],
  ['/vendor/solana-web3.js', fileURLToPath(new URL('../../node_modules/@solana/web3.js/lib/index.iife.min.js', import.meta.url))],
  ['/elpida-solana.mjs', fileURLToPath(new URL('../../packages/solana/client.mjs', import.meta.url))],
  ['/pairs.mjs', fileURLToPath(new URL('../../packages/core/pairs.mjs', import.meta.url))],
  ['/curve-model.mjs', fileURLToPath(new URL('../../packages/core/curve-model.mjs', import.meta.url))],
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
        if (base58.test(record.programId) && record.cluster === net.cluster) deployment = { programId: record.programId, shared: false, build: record.build ?? 'testnet', usdPricing: record.usdPricing && base58.test(record.usdPricing.priceAccount ?? '') ? { priceAccount: record.usdPricing.priceAccount, feeUsdE6: String(record.usdPricing.feeUsdE6), startFdvUsdE6: String(record.usdPricing.startFdvUsdE6), maxAgeSecs: Number(record.usdPricing.maxAgeSecs), usdcMint: base58.test(record.usdPricing.usdcMint ?? '') ? record.usdPricing.usdcMint : null } : null, pairs: Array.isArray(record.pairs) ? record.pairs.filter(p => p && base58.test(p.config ?? '') && base58.test(p.mint ?? '') && ['native', 'usdc', 'xstock', 'token'].includes(p.kind)).map(({ kind, key, symbol, name, mint, config, decimals, tokenProgram, test, wsol, faucet }) => ({ kind, key, symbol, name, mint, config, decimals, tokenProgram, test: !!test, wsol: !!wsol, faucet: faucet ?? null })) : null };
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
  try { target = validateSolanaRpc(target); }
  catch { console.warn('Solana needs one valid HTTPS SOLANA_RPC_URL for the RPC proxy.'); return null; }
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

export async function startServer({ port = Number(process.env.PORT ?? 3000), seed = true, publicUrl = publicOrigin(), host = process.env.HOST ?? '127.0.0.1', circleFunding = null } = {}) {
  const dataPrefix=port===3000||process.env.RAILWAY_ENVIRONMENT_NAME?'':`preview-${port}-`;
  const dataDir=resolve(process.env.ELPIDA_DATA_DIR??process.env.RAILWAY_VOLUME_MOUNT_PATH??fileURLToPath(new URL('../../local-data/',import.meta.url)));
  const dataFile=name=>resolve(dataDir,dataPrefix+name);
  const circle = circleFunding ?? createCircleFunding({ path: port === 0 ? null : dataFile('circle-test-wallets.json') });
  const metadataStore=new MetadataStore({path:port===0?null:dataFile('ipfs-content'),chainBound:Boolean(publicUrl),...(process.env.ELPIDA_METADATA_MAX_BYTES?{maxBytes:Number(process.env.ELPIDA_METADATA_MAX_BYTES)}:{}),...(process.env.ELPIDA_METADATA_MAX_PENDING_BYTES?{maxPendingBytes:Number(process.env.ELPIDA_METADATA_MAX_PENDING_BYTES)}:{})});
  const walletTokenLists=new WalletTokenLists({path:port===0?null:dataFile('wallet-tokenlists.json')});
  // The simulation is rebuilt from its action journal on the data volume, so its index can stay in memory.
  const runtime = await createRuntime({ seed, metadataStore, metadataPath:port===0?null:dataFile('token-metadata.json'), dex:port!==0, indexerPath:":memory:", journalPath:port===0?null:dataFile('simulation-journal-v2.jsonl'), log:console.log });
  const publicIndex=new PublicIndexer({networks:port===0?[]:evmTestnets,contracts:runtime.config.contracts,dataDir,metadataStore}).start();
  const graduationKeeper=configuredGraduationKeeper({env:port===0?{}:process.env,publicIndex,path:port===0?null:dataFile('graduation-keeper.sqlite')});
  // Solana public indexer: the deployed program's pools and trades, read-only, stored on the data volume.
  const solanaNet=solanaConfig(),solanaRpc=process.env.SOLANA_RPC_URL??(/^https?:\/\//.test(solanaNet.rpcUrl)?solanaNet.rpcUrl:null);
  // D9: pre-ground Solana mint addresses ending in "hope" (encrypted at rest; random mint fallback).
  const vanity=new VanityMintPool({path:port===0?null:dataFile('solana-vanity-mints.json'),key:vanityKey(process.env.ELPIDA_VANITY_KEY),programId:solanaNet.deployment?.programId,suffix:process.env.ELPIDA_VANITY_SUFFIX||'hope',target:Number(process.env.ELPIDA_VANITY_TARGET??3),workers:Number(process.env.ELPIDA_VANITY_WORKERS??1)});
  if(process.env.ELPIDA_VANITY_KEY&&!vanity.enabled)console.log(JSON.stringify({event:'vanity_mints_disabled',reason:'ELPIDA_VANITY_KEY must be 32 bytes (64 hex characters or base64), with a Solana deployment configured.'}));
  let solanaIndex=null,solanaTimer=null;
  if(port!==0&&solanaNet.deployment&&solanaRpc&&process.env.ELPIDA_SOLANA_INDEXER!=='off'){
    try{
      solanaIndex=new SolanaIndexer({web3:solanaWeb3,connection:new solanaWeb3.Connection(validateSolanaRpc(solanaRpc),'confirmed'),deployment:solanaNet.deployment,network:solanaNet,metadataStore,path:dataFile(`public-solana-${solanaNet.cluster}-${solanaNet.deployment.programId}.sqlite`)});
      const tick=()=>solanaIndex.sync().then(()=>console.log(JSON.stringify({event:'public_indexer_synced',...solanaIndex.status()}))).catch(()=>console.log(JSON.stringify({event:'public_indexer_error',network:solanaNet.key,code:solanaIndex.lastError,phase:solanaIndex.lastErrorPhase,message:'Indexing unavailable; retrying.'})));
      tick();solanaTimer=setInterval(tick,20000);solanaTimer.unref();
    }catch(error){console.log(JSON.stringify({event:'public_indexer_error',network:solanaNet.key,code:String(error.name??'INIT').slice(0,40),message:error.message.slice(0,120)}));}
  }
  console.log(JSON.stringify({event:'storage_ready',durable:Boolean(process.env.RAILWAY_VOLUME_MOUNT_PATH),dataDir,publicNetworks:[...publicIndex.entries.keys()],simulation:runtime.config.simulation?.durable?`journal replay: ${runtime.config.simulation.replayed} actions restored, ${runtime.config.simulation.skipped} skipped`:'resets on process restart'}));
  const priceKeeper=new PriceKeeper();
  const updatePrices=async()=>{await priceKeeper.refresh();const prices=priceKeeper.snapshot();const p=[prices.local,prices['base-sepolia'],prices['ethereum-sepolia']].find(p=>p.status==='fresh');if(p)await runtime.updatePrice(p.usd);};
  const priceTimer=port===0?null:setInterval(()=>updatePrices().catch(()=>{}),60000);priceTimer?.unref();
  if(port!==0)updatePrices().catch(()=>{});
  const priceSnapshot=()=>({...priceKeeper.snapshot(),local:runtime.config.local.price});
  const cookieSecurity = publicUrl ? '; Secure' : '';
  const creatorFeeTotals=new CreatorFeeTotals();
  const csrf = randomBytes(24).toString('hex');
  function indexedMarket(network,address){
    if(network==='local'){const token=runtime.indexer.listings().find(t=>t.address===address.toLowerCase());if(!token)throw new Error('Token not indexed.');return {token,index:runtime.indexer.indexFor?.(address)??runtime.indexer,sol:false};}
    if(network.startsWith('solana-')){if(!solanaIndex||solanaIndex.network.key!==network||solanaIndex.status().error||!solanaIndex.status().lastSuccess||Date.now()-Date.parse(solanaIndex.status().lastSuccess)>180000)throw new Error('Network not indexed.');const token=solanaIndex.token(address);if(!token)throw new Error('Token not indexed.');return {token,index:solanaIndex,sol:true};}
    const current=publicIndex.entries.get(network),e=publicIndex.entryFor(network,address)??current;if(!e?.validated||e.error||Date.now()-Date.parse(e.lastSuccess)>180000)throw new Error('Indexing is behind. Retry shortly.');const token=e.index.listings().find(t=>t.address===address.toLowerCase());if(!token)throw new Error('Token not indexed.');return {token,index:e.index,sol:false};
  }
  async function heldBalance(i,live=false){const {index,sol}=indexedMarket(i.network,i.token);if(!sol&&live)return formatUnits(await new Contract(i.token,['function balanceOf(address) view returns (uint256)'],index.provider).balanceOf(i.author),18);if(!sol)return index.holders(i.token,Number.MAX_SAFE_INTEGER).find(h=>h.address===i.author)?.balance??'0';
    const accounts=await index.connection.getTokenAccountsByOwner(new solanaWeb3.PublicKey(i.author),{mint:new solanaWeb3.PublicKey(i.token)},'confirmed');return formatUnits(accounts.value.reduce((n,a)=>n+(a.account.data.length>=72?a.account.data.readBigUInt64LE(64):0n),0n),6);
  }
  const theses=new HolderTheses({path:port===0?':memory:':dataFile('public-theses.sqlite'),origin:publicUrl??`http://${host}:${port}`,holding:async i=>Number(await heldBalance(i,true))>0});
  const chat=new HolderChat({path:port===0?':memory:':dataFile('public-holder-chat.sqlite'),origin:()=>publicUrl??`http://${host}:${server.address().port}`,holding:async i=>Number(await heldBalance(i,true))>0});
  let chatWindow=Date.now(),chatReads=0,chatWrites=0;
  const chatLimit=write=>{if(Date.now()-chatWindow>=60000){chatWindow=Date.now();chatReads=0;chatWrites=0;}return write?++chatWrites>120:++chatReads>600;};
  let terminalWindow=Date.now(),terminalCount=0,thesisCount=0;
  const uploadAdmission=new UploadAdmission({path:port===0?':memory:':dataFile('metadata-admission.sqlite')});
  let diagnosticWindow=Date.now(),diagnosticCount=0;
  let metadataWindow=Date.now(),metadataCount=0;
  const solana = solanaConfig();
  const connectSources = [...evmTestnets.map(net => net.rpcUrl), solana.rpcUrl, solana.wsUrl].filter(url => /^(https?|wss?):/.test(url ?? '')).join(' ');
  const rpcProxy = solana.mainnet ? createRpcProxy(process.env.SOLANA_RPC_URL) : null;
  const operationsStartedAt=Date.now();
  const backupRunner=configuredBackup({env:port===0?{}:process.env,dataDir,statePath:port===0?null:dataFile('ops-backup-state.json'),workDir:process.env.ELPIDA_BACKUP_WORK_DIR??resolve(tmpdir(),'elpida-backups-'+dataPrefix.replace(/[^a-z0-9-]/gi,'')),log:console.log});
  const operationsInput=()=>({graduation:graduationKeeper.status(),startedAt:operationsStartedAt,durable:Boolean(process.env.RAILWAY_VOLUME_MOUNT_PATH),storage:metadataStore.status().storage,networks:Object.fromEntries([...publicIndex.entries.keys()].map(key=>[key,publicIndex.status(key)])),prices:priceSnapshot(),backup:backupRunner.status()});
  const monitor=new OperationsMonitor({read:operationsInput});
  const operationsTimer=port===0?null:setInterval(()=>monitor.tick(),60000);operationsTimer?.unref();
  if(port!==0){backupRunner.start();monitor.tick();}
  const server = createServer(async (req, res) => {
    const actualPort = server.address().port;
    const requestId=randomBytes(8).toString('hex');res.setHeader('X-Request-Id',requestId);
    const send = (code, data) => { if(code>=400)console.error(JSON.stringify({event:'request_failed',requestId,status:code,method:req.method,path:String(req.url).split('?')[0].slice(0,160)}));res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self' ${connectSources}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    // Public read-only wallet assets allow cross-origin consumers; mutations retain origin checks.
    const walletRead=req.method==='GET'&&(String(req.url).split('?')[0]==='/api/wallet-tokenlist.json'||/^\/api\/wallet-logo\/[a-z0-9-]+\/0x[0-9a-fA-F]{40}$/.test(req.url)||/^\/api\/content\/(b[a-z2-7]{30,100}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/.test(req.url));
    if (!acceptsRequest({host:req.headers.host,origin:walletRead?undefined:req.headers.origin,method:req.method,path:req.url,port:actualPort,publicUrl})) return send(403, { error: 'Host or origin not allowed.' });
    if(walletRead)res.setHeader('Access-Control-Allow-Origin','*');
    if (req.method === 'GET' && req.url === '/health') return send(200, {status:'ok',mode:'simulation'});
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET') {
        if(url.pathname==='/api/creator-fees'){
          if(chatLimit(false))return send(429,{error:'Fee history is busy. Retry shortly.'});
          const network=url.searchParams.get('network')??'local',address=url.searchParams.get('token'),{index,sol}=indexedMarket(network,address);
          return send(200,sol?{status:'unavailable'}:creatorFeeTotals.read({index,provider:index.provider},address));
        }
        if(url.pathname==='/api/chat'){
          if(chatLimit(false))return send(429,{error:'Chat is busy. Retry shortly.'});
          const network=url.searchParams.get('network'),token=url.searchParams.get('token'),author=url.searchParams.get('author');
          const i=thesisIdentity(network,token,author??token);indexedMarket(i.network,i.token);
          const data=chat.list(i.network,i.token,{before:url.searchParams.has('before')?Number(url.searchParams.get('before')):null});
          const canPost=author?Number(await heldBalance(i,true))>0:false;
          return send(200,{...data,canPost});
        }
        const logoMatch=url.pathname.match(/^\/api\/wallet-logo\/([a-z0-9-]+)\/(0x[0-9a-fA-F]{40})$/);
        if(logoMatch){
          const [_,key,address]=logoMatch;
          if(!evmTestnets.some(n=>n.key===key))return send(400,{error:'Unknown EVM network.'});
          const entry=publicIndex.entryFor(key,address),token=publicIndex.detail(key,address);
          if(!entry?.validated||!token||!['creator-signed','published'].includes(token.metadataStatus))return send(404,{error:'No published token image.'});
          const image=normalizeMetadata(token.metadata).image;
          const data=image.match(/^data:(image\/(?:png|jpeg|webp|gif|avif|bmp));base64,([A-Za-z0-9+/]+=*)$/);
          if(!data)return send(404,{error:'Use the public image URL in the token list.'});
          res.writeHead(200,{'Content-Type':data[1],'Cache-Control':'public, max-age=3600'});return res.end(Buffer.from(data[2],'base64'));
        }
        if(url.pathname==='/api/wallet-tokenlist.json'){
          if(!publicUrl)return send(503,{error:'Configure ELPIDA_PUBLIC_URL or RAILWAY_PUBLIC_DOMAIN for public wallet metadata.'});
          const key=url.searchParams.get('network');
          if(key&&!evmTestnets.some(n=>n.key===key))return send(400,{error:'Unknown EVM network.'});
          const networks=evmTestnets.filter(n=>n.shared?.factory&&(!key||n.key===key));
          if(networks.some(n=>!publicIndex.all(n.key).length||publicIndex.all(n.key).some(e=>!e.validated||e.index.status().indexedBlock==null)))return send(503,{error:'Token index is not ready. Retry after synchronization.'});
          return send(200,walletTokenLists.publish(key??'all',walletTokenEntries(networks,n=>publicIndex.listings(n),publicUrl)));
        }
        if(url.pathname==='/api/terminal'){
          if(Date.now()-terminalWindow>=60000){terminalWindow=Date.now();terminalCount=0;thesisCount=0;}if(++terminalCount>120)return send(429,{error:'Terminal data is busy. Retry shortly.'});
          const network=url.searchParams.get('network')??'local',rawToken=url.searchParams.get('token'),author=url.searchParams.get('author'),i=thesisIdentity(network,rawToken,author??(network.startsWith('solana-')?rawToken:rawToken)),{token,index,sol}=indexedMarket(network,i.token);
          const holders=sol?await index.holders(i.token):index.holders(i.token,Number.MAX_SAFE_INTEGER),balances=new Map();for(const h of holders)balances.set(h.address,formatUnits(parseUnits(balances.get(h.address)??'0',18)+parseUnits(h.balance,18),18));
          let position=null;
          if(author){const balance=await heldBalance(i),rows=sol?index.db.prepare("SELECT data FROM trades WHERE mint=? AND json_extract(data,'$.account')=? ORDER BY slot,idx").iterate(i.token,i.author):index.db.prepare("SELECT data FROM trades WHERE address=? AND lower(json_extract(data,'$.account'))=? ORDER BY height,idx").iterate(i.token,i.author),trades=[];for(const r of rows){if(trades.length>=100000)throw new Error('Position history exceeds review capacity.');trades.push(JSON.parse(r.data));}
            const tradeHashes=new Set(trades.map(t=>t.hash));let untrackedTransfers=sol;if(!sol)for(const r of index.db.prepare("SELECT tx,data FROM events WHERE lower(json_extract(data,'$.address'))=? AND json_extract(data,'$.name')='Transfer'").iterate(i.token)){const event=JSON.parse(r.data);if(event.args.slice(0,2).some(a=>String(a).toLowerCase()===i.author)&&!tradeHashes.has(r.tx)){untrackedTransfers=true;break;}}
            position=positionSummary({trades,balance,price:token.spotPrice??'0',supply:token.supply??'1000000000',untrackedTransfers});balances.set(i.author,balance);
          }
          const feed=theses.list(network,i.token).map(r=>({...r,balance:balances.get(r.author)??(sol?null:'0')})).filter(r=>r.balance===null||Number(r.balance)>0).sort((a,b)=>Number(b.balance??-1)-Number(a.balance??-1)||a.author.localeCompare(b.author)).slice(0,100);
          let volume=0;const volumeRows=sol?index.db.prepare('SELECT data FROM trades WHERE mint=? AND timestamp>=?').iterate(i.token,Math.floor(Date.now()/1000)-86400):index.db.prepare('SELECT data FROM trades WHERE address=? AND timestamp>=?').iterate(i.token,Math.floor(Date.now()/1000)-86400);for(const r of volumeRows)volume+=Number(JSON.parse(r.data).quoteAmount);
          return send(200,{position,theses:feed,volume24hQuote:String(volume),holderCoverage:sol?'Solana ranking covers the largest indexed token accounts; other authors are unranked.':'Ranked by current confirmed indexed wallet balances.',indexedBlock:sol?index.status().cursorSlot:index.tip()?.height,own:author?theses.latest(i):null});
        }
        if(url.pathname==='/api/theses/history'){const i=thesisIdentity(url.searchParams.get('network'),url.searchParams.get('token'),url.searchParams.get('author'));indexedMarket(i.network,i.token);return send(200,theses.history(i));}
        if(url.pathname==='/api/operations/status'){const result=evaluateOperations(operationsInput());return send(result.status==='critical'?503:200,{...result,backup:backupRunner.status(),metadataStorage:metadataStore.status().storage});}
        if(url.pathname==='/api/metadata/challenge'){
          let client=String(req.headers.cookie??'').split(';').map(v=>v.trim()).find(v=>v.startsWith('elpida_upload='))?.slice(14);
          if(!/^[a-f0-9]{64}$/.test(client??'')){client=randomBytes(32).toString('hex');res.setHeader('Set-Cookie',`elpida_upload=${client}; HttpOnly; SameSite=Strict; Path=/api/metadata; Max-Age=86400${cookieSecurity}`);}
          return send(200,uploadAdmission.issue({digest:url.searchParams.get('digest'),client,transport:req.socket.remoteAddress??'unknown'}));
        }
        if(url.pathname==='/api/rewards/x/callback'){
          try{const cookie=String(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith('elpida_x='))?.slice(9);await runtime.transact('reward-x-finish',{state:url.searchParams.get('state'),code:url.searchParams.get('code'),cookie});res.writeHead(200,{'Content-Type':'text/html','Set-Cookie':`elpida_x=; HttpOnly; SameSite=Lax; Path=/api/rewards/x/callback; Max-Age=0${cookieSecurity}`});return res.end('<!doctype html><title>X verified</title><h1>X profile verified</h1><p>Your rewards are bound to the signed payout wallet. Return to Creator rewards and refresh to claim.</p><a href="/">Return to Elpida</a>');}catch{ return send(400,{error:'X verification failed or expired. Return to the dashboard and try again.'});}
        }
        if (url.pathname === '/api/rewards') return send(200,await runtime.rewards.dashboard());
        if(url.pathname==='/api/prices')return send(200,priceSnapshot());
        if(url.pathname==='/api/public/analytics'){
          const sources=evmTestnets.map(net=>({key:net.key,name:net.name,status:publicIndex.status(net.key),tokens:publicIndex.listings(net.key),trades:publicIndex.tradeRows(net.key)}));
          if(solanaIndex)sources.push({key:solanaIndex.network.key,name:solanaIndex.network.name,status:{enabled:true,...solanaIndex.status(),scope:'Elpida curves and PumpSwap swaps on migrated Elpida pools'},tokens:solanaIndex.listings(),trades:solanaIndex.db.prepare('SELECT data FROM trades ORDER BY timestamp').iterate()});
          if(!solanaIndex)sources.push({key:solanaNet.key,name:solanaNet.name,status:{enabled:false,reason:'No public Solana deployment configured.'},tokens:[],trades:[]});
          for(const source of sources){const rows=source.trades;source.trades=(function*(){for(const row of rows)yield JSON.parse(row.data);})();}
          try{return send(200,protocolAnalytics({sources,prices:priceSnapshot(),period:url.searchParams.get('period')??'7d',network:url.searchParams.get('network')??'all'}));}catch(error){return send(400,{error:error.message});}
        }
        if(url.pathname==='/api/public/tokenized-equity'){const view=tokenizedEquity.describeNetwork(url.searchParams.get('network')??'');return view?send(200,{...view,live:false,note:'Tokenized stocks are disabled until each capability is verified with the provider. Nothing here is an official partnership.'}):send(404,{error:'No tokenized-stock provider is designated for this network.'});}
        if(url.pathname==='/api/graduation/status')return send(200,graduationKeeper.status());
        if(url.pathname==='/api/public/status')return send(200,{graduation:graduationKeeper.status(),storage:{durable:Boolean(process.env.RAILWAY_VOLUME_MOUNT_PATH),simulationEphemeral:!runtime.config.simulation?.durable,simulation:runtime.config.simulation},networks:{...Object.fromEntries(evmTestnets.map(n=>[n.key,publicIndex.status(n.key)])),...(solanaIndex?{[solanaIndex.network.key]:{enabled:true,...solanaIndex.status()}}:{})}});
        if(url.pathname==='/api/public/recent-trades'){
          // Newest trades across every public index, for the "Last sale" strip: token identity, side and time only.
          const limit=Math.max(1,Math.min(50,Number(url.searchParams.get('limit'))||20)),list=publicIndex.recentTrades(limit);
          if(solanaIndex){const tokens=new Map(solanaIndex.listings().map(t=>[t.address,t]));for(const trade of solanaIndex.recentTrades(limit)){const t=tokens.get(trade.token);if(t)list.push(recentTrade(solanaIndex.network.key,t,trade));}}
          return send(200,list.sort((a,b)=>b.timestamp-a.timestamp).slice(0,limit));
        }
        if(url.pathname==='/api/public/quotes'){const data=publicIndex.quotes(url.searchParams.get('network')??'base-sepolia');return data?send(200,data):send(503,{error:'Trading pair index is catching up. Retry shortly.'});}
        const solanaMatch=url.pathname.match(/^\/api\/public\/tokens(?:\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:\/(trades|candles|holders))?)?$/);
        if(solanaMatch&&url.searchParams.get('network')?.startsWith('solana-')){
          if(!solanaIndex||url.searchParams.get('network')!==solanaIndex.network.key)return send(404,{error:'No public Solana index for this network.'});
          if(!solanaMatch[1]){const activity=indexedActivity(solanaIndex.db);return send(200,solanaIndex.listings().map(t=>({...t,priceChange24h:indexedChange(solanaIndex.db,t),...activityOf(activity,t.address)})));}
          const token=solanaIndex.token(solanaMatch[1]);if(!token)return send(404,{error:'Token not indexed yet. Check indexer status and retry.'});
          return send(200,solanaMatch[2]==='trades'?solanaIndex.trades(token.address):solanaMatch[2]==='candles'?solanaIndex.candles(token.address,Number(url.searchParams.get('interval')??60)):solanaMatch[2]==='holders'?await solanaIndex.holders(token.address):token);
        }
        const publicMatch=url.pathname.match(/^\/api\/public\/tokens(?:\/(0x[a-fA-F0-9]{40})(?:\/(trades|candles|holders))?)?$/);
        if(publicMatch){const key=url.searchParams.get('network')??'base-sepolia';if(!evmTestnets.some(n=>n.key===key))return send(400,{error:'Unknown public network.'});if(!publicMatch[1]){const activity=new Map();return send(200,publicIndex.listings(key,(e,t)=>{if(!activity.has(e))activity.set(e,indexedActivity(e.index.db));return {priceChange24h:indexedChange(e.index.db,t),...activityOf(activity.get(e),t.address)};}));}const data=publicIndex.detail(key,publicMatch[1],publicMatch[2],Number(url.searchParams.get('interval')??60));return data===null?send(404,{error:'Token not indexed yet. Check indexer status and retry.'}):send(200,data);}
        if (url.pathname === '/api/config') return send(200, { ...runtime.config, serverTime: Date.now()/1000, vanity: vanity.status(), circle: circle.status(), prices:priceSnapshot(), hostedSimulation:Boolean(publicUrl), metadataPublishing:metadataStore.status(), solana: solanaConfig(), csrf });
        if(url.pathname==='/api/metadata/resolve')return send(200,await metadataStore.resolve(url.searchParams.get('uri')));
        if(url.pathname.startsWith('/api/content/')){const record=metadataStore.get(url.pathname.slice('/api/content/'.length));if(!record)return send(404,{error:'Content not found.'});res.writeHead(200,{'Content-Type':record.type,'Cache-Control':'public, max-age=31536000, immutable'});return res.end(Buffer.from(record.data,'base64'));}
        if (url.pathname === '/api/indexer/status') { await runtime.indexer.sync(); return send(200,runtime.indexer.status()); }
        if (url.pathname === '/api/tokens') { await runtime.indexer.sync(); return send(200,runtime.listings()); }
        const indexed = url.pathname.match(/^\/api\/tokens\/(0x[a-fA-F0-9]{40})(?:\/(trades|candles|holders))?$/);
        if (indexed) { await runtime.indexer.sync(); const token=runtime.listings().find(t=>t.address===indexed[1].toLowerCase()); if(!token)return send(404,{error:'Token not found.'}); return send(200,indexed[2]==='trades'?runtime.indexer.trades(token.address):indexed[2]==='holders'?runtime.indexer.holders(token.address):indexed[2]==='candles'?runtime.indexer.candles(token.address,Number(url.searchParams.get('interval')??60)):token); }
        if (url.pathname === '/api/state') return send(200, await runtime.state(url.searchParams.get('account') ?? '0'));
        // Simulation buys for the Explore live feed: the same public shape as /api/public/recent-trades.
        if (url.pathname === '/api/recent-trades') { const limit=Math.max(1,Math.min(50,Number(url.searchParams.get('limit'))||20)),tokens=new Map(runtime.listings().map(t=>[t.address.toLowerCase(),t])); return send(200, runtime.indexer.recentTrades(limit).flatMap(trade=>{const t=tokens.get(String(trade.token).toLowerCase());return t?[recentTrade('local',t,trade)]:[];})); }
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
      // A disabled route must not parse large bodies or spend the protected upload budget.
      if(publicUrl&&url.pathname==='/api/metadata/publish')return send(410,{error:'Public metadata uploads must use the launch staging flow; retention is verified from the launch transaction.'});
      let uploadDigest;
      if(url.pathname==='/api/metadata/stage'){
        const client=String(req.headers.cookie??'').split(';').map(v=>v.trim()).find(v=>v.startsWith('elpida_upload='))?.slice(14)??'';
        uploadDigest=uploadAdmission.consume({id:req.headers['x-elpida-upload-id'],nonce:req.headers['x-elpida-upload-nonce'],client,transport:req.socket.remoteAddress??'unknown'});
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > (['/api/launch','/api/metadata/stage','/api/metadata/publish','/api/public/metadata/prepare','/api/public/metadata/save'].includes(url.pathname) ? MAX_METADATA_REQUEST_BYTES : 8192)) { send(413, { error: 'Request too large.' }); return; } chunks.push(chunk); }
      let body;
      const rawBody=Buffer.concat(chunks);if(uploadDigest&&keccak256(rawBody)!==uploadDigest)return send(403,{error:'Upload payload changed. Prepare it again; no launch was submitted.'});
      try { body = JSON.parse(rawBody.toString()); } catch { return send(400, { error: 'Invalid request.' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return send(400, { error: 'Invalid request.' });
      const action = url.pathname.slice('/api/'.length);
      if(['chat/report/prepare','chat/report/save'].includes(action)){if(chatLimit(true))return send(429,{error:'Chat reporting is busy. Retry shortly.'});return send(200,action==='chat/report/prepare'?await chat.prepareReport(body):await chat.saveReport(body));}
      if(['chat/prepare','chat/save'].includes(action)){if(chatLimit(true))return send(429,{error:'Chat publishing is busy. Retry shortly.'});return send(200,action==='chat/prepare'?await chat.prepare(body):await chat.save(body));}
      if(['theses/prepare','theses/save'].includes(action)){if(Date.now()-terminalWindow>=60000){terminalWindow=Date.now();terminalCount=0;thesisCount=0;}if(++thesisCount>30)return send(429,{error:'Thesis publishing is busy. Retry in a minute.'});return send(200,action==='theses/prepare'?await theses.prepare(body):await theses.save(body));}
      if(action==='public/metadata/prepare')return send(200,{message:publicIndex.metadataMessage(body).message});
      if(action==='public/metadata/save')return send(200,publicIndex.saveMetadata(body));
      if(action==='client-error'){if(Date.now()-diagnosticWindow>=60000){diagnosticWindow=Date.now();diagnosticCount=0;}if(++diagnosticCount>60)return send(429,{error:'Diagnostics request limit reached.'});const stage=String(body.stage??'unknown').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,40),code=String(body.code??'UNKNOWN').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,40),rpcMethod=/^eth_[a-zA-Z]{1,40}$/.test(body.rpcMethod??'')?body.rpcMethod:undefined,rpcCode=Number.isSafeInteger(body.rpcCode)?body.rpcCode:undefined;console.error(JSON.stringify({event:'client_error',requestId,stage,code,rpcMethod,rpcCode}));return send(200,{recorded:true,requestId});}
      if (action === 'circle/funding') {
        try { return send(200, await circle.execute(req.headers.authorization, body)); }
        catch (error) { return send(error.status ?? 502, { error: error.message }); }
      }
      if(['metadata/publish','metadata/stage'].includes(action)){
        if(Date.now()-metadataWindow>=60000){metadataWindow=Date.now();metadataCount=0;}
        if(++metadataCount>20)return send(429,{error:'Metadata upload limit reached. Wait a minute before retrying; no launch was submitted.'});
      }
      if(action==='metadata/publish'){if(publicUrl)return send(410,{error:'Public metadata uploads must use the launch staging flow; retention is verified from the launch transaction.'});return send(200,await metadataStore.publish(body,true));}
      if(action==='metadata/stage'){
        const net=evmTestnets.find(n=>n.key===body.network);
        // Solana launches write the staged IPFS URI into immutable Metaplex metadata (program D11 build).
        const solana=body.network===solanaNet.key&&Boolean(solanaNet.deployment);
        if(!solana&&(!net||net.mainnet||!isDexModel(net.shared?.model)))return send(400,{error:'On-chain launch metadata staging is unavailable on this network.'});
        const pinned=metadataStore.status().publicEnabled;
        // Mainnet tokens must point at publicly pinned IPFS content, never Elpida-hosted storage alone.
        if(solana&&solanaNet.mainnet&&!pinned)return send(503,{error:'Mainnet token details need public IPFS pinning. Configure PINATA_JWT on the server first; no launch was submitted.'});
        if(!pinned&&!process.env.RAILWAY_VOLUME_MOUNT_PATH)return send(503,{error:'Configure public IPFS pinning or a persistent testnet data volume before launching with metadata.'});
        return send(200,{...(await metadataStore.publish(body,pinned,{provisional:true})),storage:pinned?'public-ipfs':'elpida-hosted',retention:'pending-chain-verification'});
      }
      if(action==='solana/vanity-mint')return send(200,vanity.reserve({wallet:String(body.wallet??''),address:clientAddress(req)}));
      if(action==='solana/vanity-sign')return send(200,vanity.sign({id:String(body.id??''),wallet:String(body.wallet??''),message:body.message}));
      if(action==='reward-x-start'){const result=await runtime.transact(action,body);res.setHeader('Set-Cookie',`elpida_x=${result.cookie}; HttpOnly; SameSite=Lax; Path=/api/rewards/x/callback; Max-Age=600${cookieSecurity}`);return send(200,{url:result.url});}
      if (action === 'quote') return send(200, await runtime.getQuote(body));
      if (action === 'conversion-quote') return send(200, await runtime.getConversionQuote(body));
      if (action === 'convert-usdc') return send(200, await runtime.transact(action,body));
      if (!['launch', 'buy', 'sell', 'withdraw', 'graduate', 'reopen', 'reward-claim', 'reward-challenge', 'reward-verify', 'reward-process', 'reward-stock-faucet'].includes(action)) return send(404, { error: 'Action not found.' });
      return send(200, await runtime.transact(action, body));
    } catch (error) {
      const message = error.reason ?? error.shortMessage ?? error.message ?? 'Request failed.';
      console.error(JSON.stringify({event:'request_error',requestId,code:String(error.code??error.name??'UNKNOWN').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,40),reason:error.reason?'Contract reverted':'Request rejected'}));
      return send(error.code==='METADATA_QUOTA'?503:[400,403,429].includes(error.status)?error.status:400, { error: String(message).slice(0, 250) });
    }
  });
  const rewardTimer=port===0?null:setInterval(()=>runtime.transact('reward-process',{}).catch(()=>{}),30000);rewardTimer?.unref();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, host, done); });
  return { url: `http://localhost:${server.address().port}`, runtime, publicIndex, vanity, async close() {vanity.stop();clearInterval(priceTimer);clearInterval(rewardTimer);clearInterval(solanaTimer);clearInterval(operationsTimer);try{solanaIndex?.close();}catch{} await new Promise(done => server.close(done));await backupRunner.close();await creatorFeeTotals.close(); await graduationKeeper.close(); await publicIndex.close();uploadAdmission.close();theses.close();chat.close();await runtime.close(); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log('Starting Elpida API, private simulation and public chain indexer…');
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
  console.log('Simulation state is journaled to the data directory and replayed on restart. Public token history is indexed from chain and stored in SQLite.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
