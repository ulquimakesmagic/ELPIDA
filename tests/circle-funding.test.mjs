import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCircleFunding, CIRCLE_NETWORKS } from '../apps/api/circle-test-wallets.mjs';

const env = { CIRCLE_API_KEY: 'TEST_API_KEY:example', CIRCLE_ENTITY_SECRET: 'a'.repeat(64), ELPIDA_CIRCLE_ADMIN_TOKEN: 'b'.repeat(32) };
const auth = 'Bearer ' + env.ELPIDA_CIRCLE_ADMIN_TOKEN;
const wallet = { id: 'wallet', walletSetId: 'set', accountType: 'EOA', address: '0x0000000000000000000000000000000000000001', blockchain: 'BASE-SEPOLIA' };
function fixture(options = {}) {
  const calls = [], client = {
    createWalletSet: async args => { calls.push(['set', args]); return { data: { walletSet: { id: 'set' } } }; },
    listWallets: async () => ({ data: { wallets: [] } }),
    createWallets: async args => { calls.push(['wallet', args]); return { data: { wallets: [wallet] } }; },
    getWallet: async () => ({ data: { wallet } }),
    requestTestnetTokens: async args => { calls.push(['drip', args]); },
    getWalletTokenBalance: async () => ({ data: { tokenBalances: [
      { amount: '0.1', token: { blockchain: 'BASE-SEPOLIA', isNative: true } },
      { amount: '20', token: { blockchain: 'BASE-SEPOLIA', tokenAddress: CIRCLE_NETWORKS['base-sepolia'].usdc } },
      { amount: '99', token: { blockchain: 'ETH', isNative: true } },
      { amount: '99', token: { blockchain: 'BASE-SEPOLIA', tokenAddress: wallet.address } },
    ] } }),
    createTransaction: async args => { calls.push(['send', args]); return { data: { id: 'tx', state: 'INITIATED' } }; },
    getTransaction: async () => ({ data: { transaction: { id: 'tx', state: 'COMPLETE', txHash: '0x123' } } }),
  };
  const service = createCircleFunding({ env, clientFactory: () => client, ...options });
  const run = body => service.execute(auth, { network: 'base-sepolia', ...body });
  return { service, client, calls, run };
}
test('Circle setup fails closed, rejects live keys and hides credentials', async () => {
  for (const config of [{}, { ...env, CIRCLE_API_KEY: 'LIVE_API_KEY:example' }, { ...env, ELPIDA_CIRCLE_ADMIN_TOKEN: 'short' }]) {
    const s = createCircleFunding({ env: config }); assert.equal(s.status().enabled, false);
    await assert.rejects(s.execute(auth, {}), e => e.status === 503);
  }
  const f = fixture(); assert.equal(f.service.status().enabled, true);
  assert.ok(!JSON.stringify(f.service.status()).includes(env.CIRCLE_ENTITY_SECRET));
  await assert.rejects(f.service.execute('Bearer wrong', { action: 'prepare' }), e => e.status === 401);
  await assert.rejects(f.run({ network: 'ethereum', action: 'prepare' }), e => e.status === 400);
  assert.equal(f.calls.length, 0);
});
test('Circle wallet is persisted and concurrent creation is idempotent', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'elpida-circle-')); t.after(() => rm(dir, { recursive: true }));
  const f = fixture({ path: join(dir, 'wallets.json') });
  const results = await Promise.all([f.run({ action: 'prepare' }), f.run({ action: 'prepare' })]);
  assert.equal(results[0].wallet.address, wallet.address); assert.equal(results[1].walletSetId, 'set');
  assert.equal(f.calls.filter(c => c[0] === 'wallet').length, 1);
  assert.match(f.calls[0][1].idempotencyKey, /^[a-f0-9-]{36}$/);
  const restored = fixture({ path: join(dir, 'wallets.json') }); await restored.run({ action: 'prepare' }); assert.equal(restored.calls.length, 0);
});
test('faucet requests only native and USDC on selected test network with cooldown', async () => {
  const f = fixture(); await f.run({ action: 'prepare' }); await f.run({ action: 'drip' });
  assert.deepEqual(f.calls.find(c => c[0] === 'drip')[1], { address: wallet.address, blockchain: 'BASE-SEPOLIA', native: true, usdc: true });
  await assert.rejects(f.run({ action: 'drip' }), e => e.status === 429);
  assert.deepEqual((await f.run({ action: 'balance' })).balances, [{ symbol: 'ETH', amount: '0.1' }, { symbol: 'USDC', amount: '20' }]);
});
test('transfers validate decimals, caps, destinations and stable retry IDs', async () => {
  const f = fixture(); await f.run({ action: 'prepare' });
  const body = { action: 'send', asset: 'USDC', amount: '10', destination: '0x0000000000000000000000000000000000000002', requestId: randomUUID() };
  for (const invalid of [{ amount: '0' }, { amount: '101' }, { amount: '0.0000001' }, { asset: 'OTHER' }, { destination: wallet.address }, { requestId: 'bad' }]) await assert.rejects(f.run({ ...body, ...invalid }), e => e.status === 400);
  await f.run(body); await f.run(body);
  assert.equal(f.calls.filter(c => c[0] === 'send').length, 1);
  const args = f.calls.find(c => c[0] === 'send')[1]; assert.equal(args.tokenAddress, CIRCLE_NETWORKS['base-sepolia'].usdc); assert.equal(args.idempotencyKey, body.requestId);
  await assert.rejects(f.run({ ...body, amount: '11' }), e => e.status === 409);
  assert.equal((await f.run({ action: 'transaction', id: 'tx' })).transaction.state, 'COMPLETE');
  await assert.rejects(f.run({ action: 'transaction', id: 'unrelated' }), e => e.status === 404);
  await f.run({ ...body, asset: 'ETH', amount: '0.02', requestId: randomUUID() });
  assert.equal(f.calls.filter(c => c[0] === 'send').at(-1)[1].tokenAddress, '');
});
test('wrong-chain wallets are rejected and SDK errors never disclose credentials', async () => {
  const f = fixture(); await f.run({ action: 'prepare' });
  f.client.getWallet = async () => ({ data: { wallet: { ...wallet, blockchain: 'ETH' } } });
  await assert.rejects(f.run({ action: 'drip' }), e => e.status === 409);
  f.client.getWallet = async () => { throw new Error('secret ' + env.CIRCLE_API_KEY); };
  await assert.rejects(f.run({ action: 'balance' }), e => e.status === 502 && !e.message.includes(env.CIRCLE_API_KEY));
});
test('uncertain transfers reuse their idempotency key and existing wallet sets recover wallets', async () => {
  const f = fixture({ env: { ...env, CIRCLE_WALLET_SET_ID: 'set' } });
  f.client.listWallets = async args => { assert.equal(args.walletSetId, 'set'); assert.equal(args.blockchain, 'BASE-SEPOLIA'); return { data: { wallets: [wallet] } }; };
  await f.run({ action: 'prepare' }); assert.equal(f.calls.length, 0);
  const keys = []; f.client.createTransaction = async args => {
    keys.push(args.idempotencyKey);
    if (keys.length === 1) throw new Error('response lost');
    return { data: { id: 'tx', state: 'INITIATED' } };
  };
  const body = { action: 'send', asset: 'ETH', amount: '0.02', destination: '0x0000000000000000000000000000000000000002', requestId: randomUUID() };
  await assert.rejects(f.run(body), e => e.status === 502);
  f.client.getWalletTokenBalance = async () => ({ data: { tokenBalances: [] } });
  await f.run(body); assert.deepEqual(keys, [body.requestId, body.requestId]);
});
test('unfunded wallets and whole-balance sends fail before submitting or recording a transfer', async () => {
  const f = fixture(); await f.run({ action: 'prepare' });
  const body = { action: 'send', asset: 'ETH', amount: '0.02', destination: '0x0000000000000000000000000000000000000002', requestId: randomUUID() };
  await assert.rejects(f.run({ ...body, amount: '0.1' }), e => e.status === 400 && /entire balance/.test(e.message));
  await assert.rejects(f.run({ ...body, asset: 'USDC', amount: '21' }), e => e.status === 400 && /balance is 20 USDC/.test(e.message));
  const original = f.client.getWalletTokenBalance;
  f.client.getWalletTokenBalance = async () => ({ data: { tokenBalances: [] } });
  await assert.rejects(f.run(body), e => e.status === 400 && /no test ETH/.test(e.message));
  assert.equal(f.calls.filter(c => c[0] === 'send').length, 0);
  f.client.getWalletTokenBalance = original; await f.run({ ...body, amount: '0.03' });
  assert.equal(f.calls.filter(c => c[0] === 'send').length, 1, 'rejected preflight did not lock the request details');
});
test('Circle SDK status errors are mapped without leaking API details', async () => {
  const f = fixture(); await f.run({ action: 'prepare' });
  for (const [status, expectedStatus, message] of [[429,429,/request limit/],[401,502,/denied access/],[400,502,/code 155101/]]) {
    f.client.getWalletTokenBalance = async () => { throw Object.assign(new Error(env.CIRCLE_API_KEY), { status, code: 155101 }); };
    await assert.rejects(f.run({ action: 'balance' }), e => e.status === expectedStatus && message.test(e.message) && !e.message.includes(env.CIRCLE_API_KEY));
  }
  f.client.requestTestnetTokens = async () => { throw Object.assign(new Error(env.CIRCLE_API_KEY), { status: 403, code: 3 }); };
  await assert.rejects(f.run({ action: 'drip' }), e => e.status === 502 && /Console faucet with wallet ID wallet/.test(e.message) && !e.message.includes(env.CIRCLE_API_KEY));
});
