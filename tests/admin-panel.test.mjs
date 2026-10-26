// Operator panel: wallet sign-in (single-use challenge, signature must match, allowlist decides), an HttpOnly session
// cookie scoped to /api/admin, a read-only overview behind it, and treasury reads that fail per network, never guessed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { AdminAuth, parseAdminAddresses, sessionCookie, clearCookie } from '../apps/api/admin-auth.mjs';
import { readTreasuries, operatorAddresses, cachedLoader } from '../apps/api/admin-overview.mjs';

const operator = Wallet.createRandom(), stranger = Wallet.createRandom();

test('admin addresses parse from a comma or space separated setting and ignore junk', () => {
  assert.deepEqual(parseAdminAddresses(` ${operator.address},nope  ${operator.address.toLowerCase()} 0x123 `), [operator.address.toLowerCase()]);
  assert.deepEqual(parseAdminAddresses(undefined), []);
});

test('sign-in: single-use, expiring, signature must match, allowlist decides; sessions expire and sign out', async () => {
  let clock = 1_000_000;
  const auth = new AdminAuth({ host: 'elpida.test', now: () => clock });
  const allowed = async a => a === operator.address.toLowerCase();
  const c = auth.challenge();
  assert.match(c.message, /Elpida operator sign-in\nSite: elpida\.test\nNonce: [0-9a-f]{32}/);
  const signature = await operator.signMessage(c.message);
  await assert.rejects(auth.signIn({ nonce: c.nonce, signature, address: stranger.address }, allowed), /does not match/);
  await assert.rejects(auth.signIn({ nonce: c.nonce, signature, address: operator.address }, allowed), /expired/, 'a challenge is consumed by any attempt');
  const c2 = auth.challenge();
  await assert.rejects(auth.signIn({ nonce: c2.nonce, signature: await stranger.signMessage(c2.message), address: stranger.address }, allowed), e => e.status === 403);
  const c3 = auth.challenge(); clock += 6 * 60 * 1000;
  await assert.rejects(auth.signIn({ nonce: c3.nonce, signature: await operator.signMessage(c3.message), address: operator.address }, allowed), /expired/);
  const c4 = auth.challenge();
  const session = await auth.signIn({ nonce: c4.nonce, signature: await operator.signMessage(c4.message), address: operator.address }, allowed);
  assert.match(session.token, /^[0-9a-f]{64}$/);
  const cookie = `other=1; elpida_admin=${session.token}`;
  assert.equal(auth.session(cookie).address, operator.address.toLowerCase());
  assert.equal(auth.session('elpida_admin=' + 'f'.repeat(64)), null);
  clock += 9 * 60 * 60 * 1000;
  assert.equal(auth.session(cookie), null, 'sessions expire after eight hours');
  const c5 = auth.challenge();
  const again = await auth.signIn({ nonce: c5.nonce, signature: await operator.signMessage(c5.message), address: operator.address }, allowed);
  assert.equal(auth.signOut(`elpida_admin=${again.token}`), true);
  assert.equal(auth.session(`elpida_admin=${again.token}`), null);
  assert.match(sessionCookie('a'.repeat(64), { secure: true }), /HttpOnly; SameSite=Strict; Path=\/api\/admin; Max-Age=28800; Secure$/);
  assert.match(clearCookie(), /Max-Age=0$/);
});

test('challenges are bounded', () => {
  const auth = new AdminAuth();
  for (let i = 0; i < 250; i++) auth.challenge();
  assert.equal(auth.challenges.size, 200);
});

test('treasuries: read from each factory, balances formatted, one broken network does not hide the others', async () => {
  const T = '0x' + 'ab'.repeat(20), USDC = '0x' + 'cd'.repeat(20);
  const contract = (address, abi) => address === USDC
    ? { balanceOf: async () => 12_500_000n, decimals: async () => 6 }
    : address === '0xbad' ? { treasury: async () => { throw new Error('execution reverted'); } }
    : { treasury: async () => T.toUpperCase().replace('0X', '0x'), feeUsdc: async () => (address === '0xusdc' ? USDC : '0x' + '0'.repeat(40)) };
  const provider = { getBalance: async () => 2n * 10n ** 17n };
  const rows = await readTreasuries([
    { key: 'a', name: 'A', factory: '0xusdc', provider, nativeSymbol: 'ETH' },
    { key: 'b', name: 'B', factory: '0xplain', provider },
    { key: 'c', name: 'C', factory: '0xbad', provider },
    { key: 'd', name: 'D', factory: null, provider },
  ], { contract });
  assert.equal(rows[0].treasury, T); assert.equal(rows[0].native, '0.2'); assert.deepEqual(rows[0].usdc, { address: USDC, balance: '12.5' });
  assert.equal(rows[1].usdc, null);
  assert.match(rows[2].error, /reverted/); assert.equal(rows[2].native, null, 'no guessed balance');
  assert.equal(rows[3].error, 'No factory configured.');
  assert.deepEqual([...operatorAddresses(['0xAA'], rows)], ['0xaa', T]);
  const slow = await readTreasuries([{ key: 's', factory: '0xslow', provider }], { timeoutMs: 20, contract: () => ({ treasury: () => new Promise(() => {}) }) });
  assert.match(slow[0].error, /timed out/);
});

test('the loader caches and shares one request in flight', async () => {
  let calls = 0, now = 0;
  const load = cachedLoader(async () => ++calls, 1000, () => now);
  assert.deepEqual(await Promise.all([load(), load()]), [1, 1]);
  now = 500; assert.equal(await load(), 1);
  now = 1500; assert.equal(await load(), 2);
  assert.equal(await load({ fresh: true }), 3);
});

test('HTTP: challenge, signed session cookie, overview behind it, CSRF and sign-out', async t => {
  const previous = process.env.ELPIDA_ADMIN_ADDRESSES;
  process.env.ELPIDA_ADMIN_ADDRESSES = operator.address;
  const { startServer } = await import('../apps/api/server.mjs');
  const app = await startServer({ port: 0, seed: false });
  t.after(() => { app.close(); if (previous === undefined) delete process.env.ELPIDA_ADMIN_ADDRESSES; else process.env.ELPIDA_ADMIN_ADDRESSES = previous; });
  const config = await (await fetch(app.url + '/api/config')).json();
  const post = (path, body, headers = {}) => fetch(app.url + '/api/' + path, { method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json', 'X-Elpida-Token': config.csrf, ...headers }, body: JSON.stringify(body) });
  assert.equal((await fetch(app.url + '/api/admin/overview')).status, 401);
  assert.deepEqual(await (await fetch(app.url + '/api/admin/session')).json(), { signedIn: false });
  const c = await (await fetch(app.url + '/api/admin/challenge')).json();
  const body = { nonce: c.nonce, address: operator.address, signature: await operator.signMessage(c.message) };
  assert.equal((await post('admin/session', body, { 'X-Elpida-Token': 'bad' })).status, 403, 'CSRF token required');
  const c2 = await (await fetch(app.url + '/api/admin/challenge')).json();
  const refused = await post('admin/session', { nonce: c2.nonce, address: stranger.address, signature: await stranger.signMessage(c2.message) });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers.get('set-cookie'), null);
  const ok = await post('admin/session', body);
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, /^elpida_admin=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/api\/admin/);
  const jar = cookie.split(';')[0];
  const overview = await fetch(app.url + '/api/admin/overview', { headers: { Cookie: jar } });
  assert.equal(overview.status, 200);
  const data = await overview.json();
  assert.equal(data.operator, operator.address.toLowerCase());
  for (const key of ['health', 'backup', 'relay', 'graduation', 'storage', 'prices', 'networks', 'treasury', 'activity']) assert.ok(key in data, key);
  assert.ok(data.activity['24h'] && data.activity.all);
  assert.equal((await post('admin/logout', {}, { Cookie: jar })).status, 200);
  assert.equal((await fetch(app.url + '/api/admin/overview', { headers: { Cookie: jar } })).status, 401, 'signed out');
});
