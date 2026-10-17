import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { startServer, solanaConfig } from '../apps/api/server.mjs';
import {MAX_IMAGE_BYTES} from '../apps/web/metadata.mjs';
import {keccak256,toUtf8Bytes} from 'ethers';

test('localhost API exercises launch, trading, fee payout and request protection', async t => {
  const app = await startServer({ port: 0, seed: false, publicUrl: 'https://elpida-preview.up.railway.app' });
  t.after(() => app.close());
  const base = app.url;
  const config = await (await fetch(`${base}/api/config`)).json();
  const state = async account => (await fetch(`${base}/api/state?account=${account ?? '0'}`)).json();
  const request = async (action, body, headers = {}) => {
    const payload=JSON.stringify({account:'0',...body}),proof={};
    if(action==='metadata/stage'){
      const r=await fetch(`${base}/api/metadata/challenge?digest=${keccak256(toUtf8Bytes(payload))}`),c=await r.json();
      let nonce=0;while(!keccak256(toUtf8Bytes(`${c.id}:${c.digest}:${nonce}`)).slice(2).startsWith('0'.repeat(c.difficulty)))nonce++;
      Object.assign(proof,{Cookie:r.headers.get('set-cookie').split(';')[0],'X-Elpida-Upload-Id':c.id,'X-Elpida-Upload-Nonce':String(nonce)});
    }
    const response = await fetch(`${base}/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Elpida-Token': config.csrf,...proof, ...headers }, body: payload });
    return { status: response.status, body: await response.json() };
  };
  await t.test('serves the app and refuses unsigned or foreign-origin mutations', async () => {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Start something new/);
    assert.equal((await fetch(`${base}/launch`)).status,200);
    assert.equal((await fetch(`${base}/analytics`)).status,200);
    assert.equal((await fetch(`${base}/analytics-view.mjs`)).status,200);
    const operations=await(await fetch(`${base}/api/operations/status`)).json();assert.equal(operations.backup.enabled,false);assert.ok(operations.incidents.some(i=>i.code==='backup_disabled'));assert.ok(!JSON.stringify(operations).includes('secretAccessKey'));
    assert.equal((await fetch(`${base}/chain-ui.mjs`)).status,200);
    assert.equal((await fetch(`${base}/wallet-discovery.mjs`)).status,200);
    assert.equal((await fetch(`${base}/wallet-batch.mjs`)).status,200);
    assert.equal((await request('metadata/stage',{network:'unsupported',name:'Test',symbol:'TEST'})).status,400);
    assert.equal((await fetch(`${base}/api/metadata/stage?bypass=true`,{method:'POST',headers:{'Content-Type':'application/json','X-Elpida-Token':config.csrf},body:'{}'})).status,403,'query parameters cannot bypass upload admission');
    assert.equal((await fetch(`${base}/upload-proof.mjs`)).status,200);
    assert.equal((await fetch(`${base}/usdc-conversion.mjs`)).status,200);
    assert.equal((await fetch(`${base}/usdc-funding.mjs`)).status,200);
    assert.equal((await fetch(`${base}/payment-errors.mjs`)).status,200);
    const noRoute=await request('conversion-quote',{nativeAmount:'0.01'});
    assert.equal(noRoute.status,400,'conversion refuses an environment without a DEX route');
    assert.equal((await fetch(`${base}/api/public/quotes?network=unknown`)).status,503);
    assert.equal((await fetch(`${base}/discovery.mjs`)).status,200);
    const analytics=await (await fetch(`${base}/api/public/analytics`)).json();
    assert.equal(analytics.totals.trades,0,'simulation is excluded from public analytics');
    assert.equal((await fetch(`${base}/api/public/analytics?period=invalid`)).status,400);
    assert.equal((await fetch(`${base}/metadata.mjs`)).status,200);
    assert.equal((await fetch(`${base}/metadata-cache.mjs`)).status,200);
    assert.equal((await fetch(`${base}/launch-capabilities.mjs`)).status,200);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal((await request('withdraw', {}, { 'X-Elpida-Token': 'wrong' })).status, 403);
    assert.equal((await request('withdraw', {}, { Origin: 'https://foreign.example' })).status, 403);
    assert.equal((await request('faucet', {})).status, 404, 'legacy faucet endpoint remains absent');
    assert.equal((await fetch(`${base}/circle-funding.mjs`)).status, 200);
    assert.deepEqual(config.circle.networks.map(n => n.key), ['base-sepolia', 'ethereum-sepolia']);
    assert.equal((await request('circle/funding', { action: 'prepare', network: 'base-sepolia' }, { 'X-Elpida-Token': 'wrong' })).status, 403);
    assert.ok([401, 503].includes((await request('circle/funding', { action: 'prepare', network: 'base-sepolia' })).status), 'Circle funding requires operator setup and authorization');
    assert.equal(config.local.launchFee, '0.004');
    assert.ok(config.oracles['base-sepolia'].available, 'verified oracle configuration is served to the browser');
    // Fetch normalizes Host, so send this header with the raw HTTP client.
    const foreignHostStatus = await new Promise((done, reject) => {
      const req = httpRequest(`${base}/api/state`, { headers: { Host: 'foreign.example' } }, response => { response.resume(); done(response.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(foreignHostStatus, 403);
    const hostedStatus = async (path, headers) => new Promise((done, reject) => {
      const req = httpRequest(`${base}${path}`, {headers}, response => {response.resume(); done(response.statusCode);});
      req.on('error', reject); req.end();
    });
    assert.equal(await hostedStatus('/', {Host:'elpida-preview.up.railway.app',Origin:'https://elpida-preview.up.railway.app'}), 200);
    assert.equal(await hostedStatus('/', {Host:'elpida-preview.up.railway.app',Origin:'https://foreign.example'}), 403);
    assert.equal(await hostedStatus('/health', {Host:'healthcheck.railway.app'}), 200);
    assert.equal(await hostedStatus('/api/config', {Host:'healthcheck.railway.app'}), 403);
    assert.ok(Number((await state()).balance) > 9999, 'balances are native ETH');
    const bytes=Buffer.alloc(MAX_IMAGE_BYTES);bytes.write('GIF89a');
    const large=await request('launch',{name:'Upload boundary',symbol:'INVALID!',firstBuy:'25',image:'data:image/gif;base64,'+bytes.toString('base64')});
    assert.equal(large.status,400); // Valid body size reaches launch validation rather than HTTP 413.
  });
  let address;
  await t.test('launches with a mandatory first buy and rejects invalid input', async () => {
    assert.equal((await request('launch', { name: 'No buy', symbol: 'ZERO', firstBuy: '0' })).status, 400);
    assert.equal((await request('launch', { name: 'Invalid', symbol: '<script>', firstBuy: '0.025' })).status, 400);
    assert.equal((await request('launch', { name: 'Dollar', symbol: 'USD', firstBuy: '25', pair: 'usdc' })).status, 400, 'no USDC pair');
    const before = await state();
    assert.equal((await request('launch', {name:'Bad links',symbol:'BAD',firstBuy:'0.025',website:'javascript:alert(1)'})).status,400);
    assert.equal((await state()).balance,before.balance);
    const metadata = {description:'A garden for our community 🌱',image:'https://example.com/garden.png',website:'https://example.com/',twitter:'https://x.com/garden',telegram:'https://t.me/garden',discord:'https://discord.gg/garden'};
    const treasuryBefore = Number(before.treasuryBalance);
    const result = await request('launch', { name: 'API Garden', symbol: 'APIG', firstBuy: '0.025',...metadata });
    assert.equal(result.status, 200);
    address = result.body.token;
    const snapshot = await state();
    assert.equal(snapshot.tokens.length, 1);
    const spent = Number(before.balance) - Number(snapshot.balance);
    assert.ok(spent > 0.027 && spent < 0.1, 'creation fee 0.004 ETH + first buy 0.025 ETH + gas');
    assert.ok(Math.abs(Number(snapshot.treasuryBalance) - treasuryBefore - 0.004) < 1e-9, 'treasury received the $10 / 2500 = 0.004 ETH creation fee');
    assert.equal(snapshot.tokens[0].reserve, '0.0246875');
    assert.equal(snapshot.tokens[0].quoteSymbol, 'ETH');
    assert.ok(Number(snapshot.tokens[0].balance) > 0);
    assert.equal(snapshot.tokens[0].liquidityLocked, false);
    assert.equal(snapshot.tokens[0].pair, 'native');
    assert.equal(snapshot.tokens[0].graduated, false);
    assert.deepEqual(snapshot.tokens[0].metadata,metadata);
    assert.deepEqual((await (await fetch(`${base}/api/tokens/${address}`)).json()).metadata,metadata);
    assert.deepEqual((await (await fetch(`${base}/api/tokens`)).json())[0].metadata,metadata);
  });
  await t.test('terminal returns indexed position and validates wallet-signed holder publishing', async () => {
    const owner=await state(),url=`${base}/api/terminal?network=local&token=${address}&author=${owner.wallet}`;
    const response=await fetch(url);assert.equal(response.status,200);const terminal=await response.json();assert.ok(terminal.position.basisKnown);assert.ok(Number(terminal.position.balance)>0);assert.ok(Number(terminal.volume24hQuote)>0);
    assert.equal((await fetch(`${base}/terminal-chart.mjs`)).status,200);assert.equal((await fetch(`${base}/vendor/lightweight-charts.js`)).status,200);
    const body={network:'local',token:address,author:owner.wallet,text:'Simulation integration test thesis.'},prepared=await request('theses/prepare',body);assert.equal(prepared.status,200);
    assert.equal((await request('theses/save',{...body,nonce:prepared.body.nonce,signature:'0x00'})).status,400);
    const signer=await app.runtime.provider.getSigner(owner.wallet);{const signature=await signer.signMessage(prepared.body.message);assert.equal((await request('theses/save',{...body,nonce:prepared.body.nonce,signature})).status,200);assert.equal((await (await fetch(url)).json()).theses.length,1);}
  });
  await t.test('quotes and executes a buy and full sell from the trader account', async () => {
    const quote = await request('quote', { token: address, side: 'buy', amount: '0.01' });
    assert.equal(quote.status, 200);
    assert.equal(quote.body.fee, '0.000125');
    assert.equal((await request('buy', { token: address, amount: '0.01', account: '1', slippage: '0.5' })).status, 200);
    const held = (await state('1')).tokens[0].balance;
    assert.equal(held, quote.body.out);
    const sell = await request('quote', { token: address, side: 'sell', amount: held });
    assert.equal(sell.status, 200);
    assert.equal((await request('sell', { token: address, amount: held, account: '1', slippage: '0.5' })).status, 200);
    assert.equal((await state('1')).tokens[0].balance, '0.0');
    assert.equal((await request('buy', { token: address, amount: '0.01', slippage: '50' })).status, 400);
    // Explore's 24h activity (launch buy, buy, sell) and the simulation's recent trades, public fields only.
    const listed = (await state('0')).tokens.find(t => t.address.toLowerCase() === address.toLowerCase());
    assert.deepEqual([listed.trades24h, listed.buys24h, listed.sells24h], [3, 2, 1]);
    assert.ok(listed.volume24h > 0.02 && listed.lastBuyAt > 0 && listed.lastTradeAt >= listed.lastBuyAt);
    const recent = await (await fetch(`${base}/api/recent-trades?limit=2`)).json();
    assert.deepEqual(recent.map(r => [r.address.toLowerCase(), r.side, r.network]), [[address.toLowerCase(), 'sell', 'local'], [address.toLowerCase(), 'buy', 'local']]);
    assert.deepEqual(Object.keys(recent[0]).sort(), ['address', 'image', 'name', 'network', 'side', 'symbol', 'timestamp']);
  });
  await t.test('pays accrued fees and survives rejected requests', async () => {
    const before = await state();
    assert.equal((await request('withdraw', { token: address, account: '1' })).status, 200);
    const after = await state();
    assert.equal(after.tokens[0].creatorFees, '0.0');
    assert.equal(after.tokens[0].protocolFees, '0.0');
    assert.equal(after.tokens[0].reserve, before.tokens[0].reserve);
    assert.equal((await request('withdraw', { token: address, account: '2' })).status, 400);
  });
  await t.test('a second native launch trades native currency', async () => {
    const result = await request('launch', { name: 'Native Garden', symbol: 'NATIVE', pair: 'native', firstBuy: '0.01' });
    assert.equal(result.status, 200);
    const snapshot = await state();
    const token = snapshot.tokens.find(t => t.address === result.body.token);
    assert.equal(token.quoteSymbol, 'ETH');
    assert.equal(token.reserve, '0.009875');
    assert.equal(token.liquidityLocked, false);
    const buy = await request('buy', { token: token.address, amount: '0.01', account: '1' });
    assert.equal(buy.status, 200);
    const held = (await state('1')).tokens.find(t => t.address === token.address).balance;
    assert.equal((await request('sell', {token:token.address, amount:held,account:'1'})).status, 200);
    assert.equal((await request('launch', {name:'Bad',symbol:'BAD',pair:'unknown',firstBuy:'1'})).status, 400);
  });
  await t.test('disabled publishing refuses bodies without consuming protected upload admission',async()=>{
    for(let i=0;i<21;i++)assert.equal((await fetch(`${base}/api/metadata/publish`,{method:'POST',headers:{'Content-Type':'application/json','X-Elpida-Token':config.csrf},body:'not json'})).status,410);
    assert.equal((await request('metadata/stage',{network:'unsupported'})).status,400);
  });
});

test('the Solana devnet deployment record keeps every pair kind, including USDC', () => {
  const record = JSON.parse(readFileSync(new URL('../deployments/solana-devnet.json', import.meta.url), 'utf8'));
  const pairs = solanaConfig().deployment?.pairs ?? [];
  assert.deepEqual(pairs.map(p => p.kind).sort(), record.pairs.map(p => p.kind).sort(), 'no recorded pair is dropped');
  const usdc = pairs.find(p => p.kind === 'usdc');
  assert.ok(usdc, 'USDC pair served to the browser');
  assert.equal(usdc.mint, '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
  assert.equal(usdc.decimals, 6);
});
