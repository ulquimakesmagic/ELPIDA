import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { startServer } from '../apps/api/server.mjs';

test('localhost API exercises launch, trading, fee payout and request protection', async t => {
  const app = await startServer({ port: 0, seed: false });
  t.after(() => app.close());
  const base = app.url;
  const config = await (await fetch(`${base}/api/config`)).json();
  const state = async account => (await fetch(`${base}/api/state?account=${account ?? '0'}`)).json();
  const request = async (action, body, headers = {}) => {
    const response = await fetch(`${base}/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Elpida-Token': config.csrf, ...headers }, body: JSON.stringify({ account: '0', ...body }) });
    return { status: response.status, body: await response.json() };
  };
  await t.test('serves the app and refuses unsigned or foreign-origin mutations', async () => {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Start something new/);
    assert.equal((await fetch(`${base}/launch`)).status,200);
    assert.equal((await fetch(`${base}/metadata.mjs`)).status,200);
    assert.equal((await fetch(`${base}/launch-capabilities.mjs`)).status,200);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal((await request('faucet', {}, { 'X-Elpida-Token': 'wrong' })).status, 403);
    assert.equal((await request('faucet', {}, { Origin: 'https://foreign.example' })).status, 403);
    // Fetch normalizes Host, so send this header with the raw HTTP client.
    const foreignHostStatus = await new Promise((done, reject) => {
      const req = httpRequest(`${base}/api/state`, { headers: { Host: 'foreign.example' } }, response => { response.resume(); done(response.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(foreignHostStatus, 403);
    assert.equal((await state()).balance, '10000.0');
  });
  let address;
  await t.test('launches with a mandatory first buy and rejects invalid input', async () => {
    assert.equal((await request('launch', { name: 'No buy', symbol: 'ZERO', firstBuy: '0' })).status, 400);
    assert.equal((await request('launch', { name: 'Invalid', symbol: '<script>', firstBuy: '25', pair: 'usdc' })).status, 400);
    const before = await state();
    assert.equal((await request('launch', {name:'Bad links',symbol:'BAD',firstBuy:'25',website:'javascript:alert(1)'})).status,400);
    assert.equal((await state()).balance,before.balance);
    const metadata = {description:'A garden for our community 🌱',image:'https://example.com/garden.png',website:'https://example.com/',twitter:'https://x.com/garden',telegram:'https://t.me/garden',discord:'https://discord.gg/garden'};
    const result = await request('launch', { name: 'API Garden', symbol: 'APIG', firstBuy: '25', pair: 'usdc',...metadata });
    assert.equal(result.status, 200);
    address = result.body.token;
    const snapshot = await state();
    assert.equal(snapshot.tokens.length, 1);
    assert.equal(snapshot.balance, '9965.0');
    assert.equal(snapshot.treasuryBalance, '10.0');
    assert.equal(snapshot.tokens[0].reserve, '24.6875');
    assert.ok(Number(snapshot.tokens[0].balance) > 0);
    assert.equal(snapshot.tokens[0].liquidityLocked, false);
    assert.equal(snapshot.tokens[0].pair, 'usdc');
    assert.equal(snapshot.tokens[0].graduated, false);
    assert.deepEqual(snapshot.tokens[0].metadata,metadata);
    assert.deepEqual((await (await fetch(`${base}/api/tokens/${address}`)).json()).metadata,metadata);
    assert.deepEqual((await (await fetch(`${base}/api/tokens`)).json())[0].metadata,metadata);
  });
  await t.test('quotes and executes a buy and full sell from the trader account', async () => {
    const quote = await request('quote', { token: address, side: 'buy', amount: '10' });
    assert.equal(quote.status, 200);
    assert.equal(quote.body.fee, '0.125');
    assert.equal((await request('buy', { token: address, amount: '10', account: '1', slippage: '0.5' })).status, 200);
    const held = (await state('1')).tokens[0].balance;
    assert.equal(held, quote.body.out);
    const sell = await request('quote', { token: address, side: 'sell', amount: held });
    assert.equal(sell.status, 200);
    assert.equal((await request('sell', { token: address, amount: held, account: '1', slippage: '0.5' })).status, 200);
    assert.equal((await state('1')).tokens[0].balance, '0.0');
    assert.equal((await request('buy', { token: address, amount: '10', slippage: '50' })).status, 400);
  });
  await t.test('pays accrued fees, adds faucet balance and survives rejected requests', async () => {
    const before = await state();
    assert.equal((await request('withdraw', { token: address, account: '1' })).status, 200);
    const after = await state();
    assert.equal(after.tokens[0].creatorFees, '0.0');
    assert.equal(after.tokens[0].protocolFees, '0.0');
    assert.equal(after.tokens[0].reserve, before.tokens[0].reserve);
    assert.equal((await request('faucet', { account: '2' })).status, 400);
    assert.equal((await request('faucet', {})).status, 200);
    assert.equal(Number((await state()).balance), Number(after.balance) + 1000);
  });
  await t.test('native pairing pays only the creation fee in USDC and trades native currency', async () => {
    const before = await state();
    const result = await request('launch', { name: 'Native Garden', symbol: 'NATIVE', pair: 'native', firstBuy: '0.01' });
    assert.equal(result.status, 200);
    const snapshot = await state();
    assert.equal(Number(snapshot.balance), Number(before.balance) - 10);
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
});
