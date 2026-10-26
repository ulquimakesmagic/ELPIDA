// Early-partner applications (docs/DESIGN_PARTNER_TIERS.md section 3): each launching wallet is proven by a
// single-use signature, applications are validated and private, operators approve with a tier, a window and chains
// (or reject, note, end), and the registration is a setPartner call the treasury signs. On-chain status is read back,
// never assumed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, sign } from 'node:crypto';
import { Wallet, Interface, getAddress } from 'ethers';
import { Keypair } from '@solana/web3.js';
import { PartnerApplications, cleanApplication, registrationCall, registryStatus, walletOf, TIERS } from '../apps/api/partner-applications.mjs';

const form = { x: '@builder_1', telegram: 'builder_tg', email: '', tier: 'partner', pitch: 'We run a 20k community and launch a token every month.', links: ['https://x.com/builder_1'], acceptTerms: true };
const solSign = (keypair, message) => sign(null, Buffer.from(message), createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(keypair.secretKey.slice(0, 32))]), format: 'der', type: 'pkcs8' })).toString('base64');
const evmProof = async (apps, wallet) => { const c = apps.challenge({ kind: 'evm', address: wallet.address }); return { address: wallet.address, nonce: c.nonce, signature: await wallet.signMessage(c.message) }; };
const solProof = (apps, keypair) => { const c = apps.challenge({ kind: 'solana', address: keypair.publicKey.toBase58() }); return { address: c.wallet, nonce: c.nonce, signature: solSign(keypair, c.message) }; };

test('form validation: contact, tier, pitch, https links, terms', () => {
  assert.deepEqual(cleanApplication(form), { x: 'builder_1', telegram: 'builder_tg', email: '', tier: 'partner', pitch: form.pitch, links: ['https://x.com/builder_1'] });
  for (const [patch, error] of [
    [{ x: '', telegram: '' }, /X handle or a Telegram/], [{ x: 'has space' }, /valid X handle/], [{ telegram: 'abc' }, /Telegram/],
    [{ email: 'nope' }, /email/], [{ tier: 'gold' }, /Partner or Elite/], [{ pitch: 'hi' }, /at least a sentence/],
    [{ links: ['http://insecure.example'] }, /https/], [{ links: Array(6).fill('https://a.example') }, /five/], [{ acceptTerms: false }, /terms/],
  ]) assert.throws(() => cleanApplication({ ...form, ...patch }), error, JSON.stringify(patch));
  assert.equal(cleanApplication({ ...form, pitch: 'x'.repeat(5000) }).pitch.length, 1200);
  assert.throws(() => walletOf('evm', '0x123'), /EVM/); assert.throws(() => walletOf('solana', 'not-a-key'), /Solana/);
});

test('wallet proofs: single-use, bound to the wallet and kind, must be signed by it', async () => {
  let clock = 1_000_000;
  const apps = new PartnerApplications({ host: 'elpida.test', now: () => clock });
  const dev = Wallet.createRandom(), other = Wallet.createRandom(), sol = Keypair.generate();
  const c = apps.challenge({ kind: 'evm', address: dev.address });
  assert.match(c.message, /^Elpida partner application\nSite: elpida\.test\nWallet: 0x[0-9a-f]{40}\nNonce: [0-9a-f]{32}/);
  // Signed by someone else.
  assert.throws(() => apps.apply({ ...form, evm: { address: dev.address, nonce: c.nonce, signature: 'bad' } }), /does not match/);
  // A challenge is consumed by any attempt.
  assert.throws(() => apps.apply({ ...form, evm: { address: dev.address, nonce: c.nonce, signature: '0x' } }), /expired/);
  const c2 = apps.challenge({ kind: 'evm', address: dev.address });
  const forged = await other.signMessage(c2.message);
  assert.throws(() => apps.apply({ ...form, evm: { address: dev.address, nonce: c2.nonce, signature: forged } }), e => e.status === 401);
  // Another wallet cannot use this wallet's challenge.
  const c3 = apps.challenge({ kind: 'evm', address: dev.address });
  const borrowed = await other.signMessage(c3.message);
  assert.throws(() => apps.apply({ ...form, evm: { address: other.address, nonce: c3.nonce, signature: borrowed } }), /expired/);
  // Expired.
  const late = await evmProof(apps, dev); clock += 16 * 60 * 1000;
  assert.throws(() => apps.apply({ ...form, evm: late }), /expired/);
  // No wallet at all.
  assert.throws(() => apps.apply(form), /at least one launching wallet/);
  // A wrong Solana signature.
  const sc = apps.challenge({ kind: 'solana', address: sol.publicKey.toBase58() });
  assert.throws(() => apps.apply({ ...form, solana: { address: sc.wallet, nonce: sc.nonce, signature: solSign(Keypair.generate(), sc.message) } }), /Solana signature/);
  // Both wallets, properly signed.
  const r = apps.apply({ ...form, evm: await evmProof(apps, dev), solana: solProof(apps, sol) });
  assert.equal(r.status, 'pending');
  const row = apps.row(r.id);
  assert.equal(row.evm, dev.address.toLowerCase()); assert.equal(row.solana, sol.publicKey.toBase58()); assert.equal(row.terms, 1);
  // One open application per wallet.
  await assert.rejects(async () => apps.apply({ ...form, evm: await evmProof(apps, dev) }), e => e.status === 409);
  assert.throws(() => apps.apply({ ...form, solana: solProof(apps, sol) }), e => e.status === 409);
});

test('review: approve fixes tier, window and chains; reject, note and end are logged; contact data of old rejections is erased', async () => {
  let clock = Date.UTC(2026, 9, 26);
  const apps = new PartnerApplications({ now: () => clock });
  const op = '0x' + 'aa'.repeat(20);
  const a = apps.apply({ ...form, evm: await evmProof(apps, Wallet.createRandom()) });
  const b = apps.apply({ ...form, x: 'second', evm: await evmProof(apps, Wallet.createRandom()) });
  assert.throws(() => apps.review(a.id, { decision: 'approve', tier: 'gold', days: 60, chains: ['base-sepolia'] }, op), /Partner or Elite/);
  assert.throws(() => apps.review(a.id, { decision: 'approve', tier: 'elite', days: 181, chains: ['base-sepolia'] }, op), /1 to 180/);
  assert.throws(() => apps.review(a.id, { decision: 'approve', tier: 'elite', days: 60, chains: [] }, op), /at least one chain/);
  assert.throws(() => apps.review(a.id, { decision: 'approve', tier: 'elite', days: 60, chains: ['solana-devnet'] }, op), /no Solana wallet/);
  assert.throws(() => apps.review(a.id, { decision: 'note' }, op), /Write a note/);
  apps.review(a.id, { decision: 'note', note: 'Strong community, checked their last launch.' }, op);
  const approved = apps.review(a.id, { decision: 'approve', tier: 'elite', days: 60, chains: ['base-sepolia', 'bsc-testnet', 'base-sepolia'] }, op);
  assert.equal(approved.status, 'approved');
  assert.deepEqual(approved.approved, { tier: 'elite', buybackBps: TIERS.elite, expiresAt: clock / 1000 + 60 * 86400, chains: ['base-sepolia', 'bsc-testnet'] });
  assert.deepEqual(approved.notes.map(n => n.action), ['note', 'approve elite 60d']);
  assert.ok(approved.notes.every(n => n.by === op));
  assert.throws(() => apps.review(a.id, { decision: 'reject' }, op), e => e.status === 409, 'decided once');
  assert.equal(apps.review(a.id, { decision: 'end' }, op).status, 'ended');
  assert.equal(apps.review(b.id, { decision: 'reject', note: 'Not yet.' }, op).status, 'rejected');
  assert.deepEqual(apps.counts(), { ended: 1, rejected: 1 });
  assert.deepEqual(apps.list().map(r => r.status), ['ended', 'rejected']);
  clock += 181 * 86400 * 1000;
  const erased = apps.list({ status: 'rejected' })[0];
  assert.equal(erased.x, null); assert.equal(erased.pitch, null); assert.deepEqual(erased.links, []);
  assert.equal(erased.notes.at(-1).action, 'reject', 'the decision record stays');
});

test('registration calls encode setPartner exactly; ending is (0, 0)', () => {
  const factory = '0x' + '11'.repeat(20), creator = '0x' + 'ab'.repeat(20);
  const iface = new Interface(['function setPartner(address,uint16,uint64)']);
  const call = registrationCall(factory, creator, 2000, 1_800_000_000);
  assert.equal(call.to, factory); assert.equal(call.value, '0');
  assert.deepEqual([...iface.decodeFunctionData('setPartner', call.data)].map(String), [getAddress(creator), '2000', '1800000000']);
  assert.deepEqual([...iface.decodeFunctionData('setPartner', registrationCall(factory, creator, 0, 0).data)].slice(1).map(String), ['0', '0']);
});

test('on-chain status: registered, different, none, unsupported factory and RPC errors per network', async () => {
  const now = 1_800_000_000, exp = now + 30 * 86400;
  const apps = [
    { id: 'a', status: 'approved', evm: '0xa', approved: { buybackBps: 2000, expiresAt: exp, chains: ['n1', 'n2', 'n3', 'n4', 'solana-devnet'] } },
    { id: 'b', status: 'approved', evm: '0xb', approved: { buybackBps: 1000, expiresAt: exp, chains: ['n1'] } },
    { id: 'c', status: 'pending', evm: '0xc', approved: null },
    { id: 'd', status: 'ended', evm: '0xd', approved: { buybackBps: 1000, expiresAt: exp, chains: ['n1'] } },
  ];
  const onChain = { n1: { '0xa': [2000n, BigInt(exp)], '0xb': [1000n, BigInt(exp - 1)], '0xd': [0n, 0n] }, n3: {} };
  const contract = factory => ({
    PARTNER_TIERS_VERSION: async () => { if (factory === 'f2') throw Object.assign(new Error('missing revert data'), { code: 'CALL_EXCEPTION' }); if (factory === 'f4') throw new Error('socket hang up'); return 1n; },
    partners: async wallet => onChain[factory.replace('f', 'n')]?.[wallet] ?? [0n, 0n],
  });
  const networks = [{ key: 'n1', factory: 'f1' }, { key: 'n2', factory: 'f2' }, { key: 'n3', factory: 'f3' }, { key: 'n4', factory: 'f4' }];
  const s = await registryStatus(apps, networks, { contract, nowSeconds: () => now });
  assert.deepEqual(s.a.n1, { state: 'registered', live: true, buybackBps: 2000, expiresAt: exp });
  assert.deepEqual(s.a.n2, { state: 'unsupported' });
  assert.equal(s.a.n3.state, 'none');
  assert.equal(s.a.n4.state, 'error'); assert.match(s.a.n4.error, /socket/);
  assert.equal(s.a['solana-devnet'], undefined, 'Solana is not read until the program supports tiers');
  assert.equal(s.b.n1.state, 'different');
  assert.equal(s.c, undefined, 'pending applications have nothing on chain');
  assert.equal(s.d.n1.state, 'none', 'an ended partnership shows when the tier is cleared');
});

test('server: public apply is CSRF-protected; the queue and decisions need an operator session; nothing leaks publicly', async t => {
  const operator = Wallet.createRandom(), dev = Wallet.createRandom();
  const previous = process.env.ELPIDA_ADMIN_ADDRESSES;
  process.env.ELPIDA_ADMIN_ADDRESSES = operator.address;
  const { startServer } = await import('../apps/api/server.mjs');
  const app = await startServer({ port: 0, seed: false });
  t.after(() => { app.close(); if (previous === undefined) delete process.env.ELPIDA_ADMIN_ADDRESSES; else process.env.ELPIDA_ADMIN_ADDRESSES = previous; });
  const config = await (await fetch(app.url + '/api/config')).json();
  const post = (path, body, headers = {}) => fetch(app.url + '/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Elpida-Token': config.csrf, ...headers }, body: JSON.stringify(body) });

  assert.equal((await post('partners/challenge', { kind: 'evm', address: dev.address }, { 'X-Elpida-Token': 'bad' })).status, 403, 'CSRF token required');
  const c = await (await post('partners/challenge', { kind: 'evm', address: dev.address })).json();
  const bad = await post('partners/apply', { ...form, evm: { address: dev.address, nonce: c.nonce, signature: await operator.signMessage(c.message) } });
  assert.equal(bad.status, 401);
  const c2 = await (await post('partners/challenge', { kind: 'evm', address: dev.address })).json();
  const applied = await post('partners/apply', { ...form, evm: { address: dev.address, nonce: c2.nonce, signature: await dev.signMessage(c2.message) } });
  assert.equal(applied.status, 200);
  const { id } = await applied.json();

  assert.equal((await fetch(app.url + '/api/admin/partners')).status, 401, 'the queue is private');
  assert.equal((await post('admin/partners/review', { id, decision: 'reject' })).status, 401);
  const s = await (await fetch(app.url + '/api/admin/challenge')).json();
  const session = await post('admin/session', { nonce: s.nonce, address: operator.address, signature: await operator.signMessage(s.message) });
  const jar = session.headers.get('set-cookie').split(';')[0];
  const queue = await (await fetch(app.url + '/api/admin/partners', { headers: { Cookie: jar } })).json();
  assert.equal(queue.applications.length, 1);
  assert.equal(queue.applications[0].evm, dev.address.toLowerCase());
  assert.ok(queue.networks.some(n => n.kind === 'solana' && n.supported === false), 'Solana is listed as pending the program upgrade');
  const approved = await post('admin/partners/review', { id, decision: 'approve', tier: 'partner', days: 45, chains: ['base-sepolia'] }, { Cookie: jar });
  assert.equal(approved.status, 200);
  const decided = await approved.json();
  assert.equal(decided.decidedBy, operator.address.toLowerCase());
  assert.equal(decided.approved.buybackBps, 1000);
  const again = await post('admin/partners/review', { id, decision: 'approve', tier: 'partner', days: 45, chains: ['base-sepolia'] }, { Cookie: jar });
  assert.equal(again.status, 409);
});
