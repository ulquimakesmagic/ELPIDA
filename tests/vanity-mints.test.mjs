import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, randomBytes, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as web3 from '@solana/web3.js';
import { VanityMintPool, suffixTarget, endsWith, base58, decodeBase58, grind, seal, open, vanityKey, clientAddress, parseLegacyMessage } from '../apps/api/vanity-mints.mjs';
import { createElpidaSolana } from '../packages/solana/client.mjs';

const PROGRAM = 'ANkA5pytoVkiKQbjzd5NdPWKgmwfsihNJvSfg3vtKLNz';
const URI = 'ipfs://bafkreih6ilp3u4ue7fmqjnxdnq4ejxn6s5edsxqy7y5c3x2tsnkacsm4zu';
const pubOf = seed => { const der = createPublicKey(createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' }); return der.subarray(der.length - 32); };

test('suffix matching agrees with base58 and rejects characters base58 lacks', () => {
  assert.throws(() => suffixTarget('h0pe'), /base58/); assert.throws(() => suffixTarget('Iope'), /base58/); assert.throws(() => suffixTarget('lope'), /base58/);
  const goal = suffixTarget('hope');
  assert.equal(goal.modulus, 58 ** 4);
  for (let i = 0; i < 2000; i++) {
    const key = randomBytes(32), text = base58(key);
    assert.equal(endsWith(key, suffixTarget(text.slice(-3))), true);
    assert.equal(endsWith(key, goal), text.endsWith('hope'));
    assert.equal(base58(decodeBase58(text)), text);
    assert.equal(text, new web3.PublicKey(key).toBase58(), 'same encoding as web3');
  }
});

test('grinding yields a key pair whose address carries the suffix', () => {
  const found = grind('h', 100_000);
  assert.ok(found, 'one-character suffix found quickly');
  assert.ok(base58(found.pubkey).endsWith('h'));
  assert.deepEqual(pubOf(found.seed), found.pubkey, 'public key derives from the seed');
  assert.equal(grind('hope', 10), null, 'gives up after maxTries');
});

test('keys are sealed with AES-256-GCM bound to the public key', () => {
  const key = randomBytes(32), { seed, pubkey } = grind('h', 100_000), sealed = seal(key, Buffer.from(seed), pubkey);
  assert.deepEqual(open(key, sealed).seed, seed);
  assert.throws(() => open(randomBytes(32), sealed), 'wrong key');
  assert.throws(() => open(key, { ...sealed, data: Buffer.from('x'.repeat(32)).toString('base64') }), 'tampered ciphertext');
  assert.throws(() => open(key, { ...sealed, pubkey: base58(randomBytes(32)) }), 'swapped public key');
  assert.equal(vanityKey('ab'.repeat(32)).length, 32); assert.equal(vanityKey(randomBytes(32).toString('base64')).length, 32);
  assert.equal(vanityKey('short'), null); assert.equal(vanityKey(''), null);
});

function launchMessage({ wallet, mint, program = PROGRAM, extra = [] }) {
  const client = createElpidaSolana(web3, new web3.PublicKey(program));
  const config = { address: web3.Keypair.generate().publicKey, quoteMint: web3.Keypair.generate().publicKey, treasury: web3.Keypair.generate().publicKey };
  const tx = new web3.Transaction({ feePayer: wallet, recentBlockhash: base58(randomBytes(32)) }).add(client.computeBudget(),
    client.launch({ creator: wallet, config, mint, name: 'Hope', symbol: 'HOPE', firstBuy: 1n, minTokensOut: 0n, reward: wallet, uri: URI }), ...extra);
  return tx.serializeMessage();
}

test('the pool reserves single-use keys, never stores them in plaintext and signs only the reserved launch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elpida-vanity-')), path = join(dir, 'vanity.json');
  let clock = 1_000_000;
  const pool = new VanityMintPool({ path, key: randomBytes(32), programId: PROGRAM, suffix: 'h', target: 3, autoStart: false, perWalletPerHour: 2, perAddressPerHour: 100, ttlMs: 60_000, now: () => clock });
  try {
    assert.deepEqual(new VanityMintPool({ path, key: null, programId: PROGRAM }).reserve({ wallet: PROGRAM, address: 'a' }).fallback, true, 'disabled without a key');
    const seeds = [];
    for (let i = 0; i < 3; i++) { const g = grind('h', 100_000); seeds.push(Buffer.from(g.seed)); pool.add(g.seed, g.pubkey); }
    assert.equal(pool.status().available, 3);
    const disk = readFileSync(path, 'utf8');
    for (const seed of seeds) { assert.ok(!disk.includes(seed.toString('base64')) && !disk.includes(seed.toString('hex')), 'no plaintext seed on disk'); }
    const wallet = web3.Keypair.generate().publicKey, other = web3.Keypair.generate().publicKey;
    const r = pool.reserve({ wallet: wallet.toBase58(), address: '1.2.3.4' });
    assert.ok(r.mint.endsWith('h') && r.id && r.expiresAt === clock + 60_000);
    assert.equal(pool.status().available, 2, 'left the stored pool at reservation');
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).keys.length, 2, 'removed from disk too');
    const mint = new web3.PublicKey(r.mint);
    // Refused: another wallet, a foreign program, the mint used outside the launch, a v0 message.
    assert.throws(() => pool.sign({ id: r.id, wallet: other.toBase58(), message: launchMessage({ wallet: other, mint }).toString('base64') }), /another wallet/);
    assert.throws(() => pool.sign({ id: r.id, wallet: wallet.toBase58(), message: launchMessage({ wallet, mint, program: other.toBase58() }).toString('base64') }), /only sign an Elpida launch/);
    const drain = web3.SystemProgram.transfer({ fromPubkey: mint, toPubkey: other, lamports: 1 });
    assert.throws(() => pool.sign({ id: r.id, wallet: wallet.toBase58(), message: launchMessage({ wallet, mint, extra: [drain] }).toString('base64') }), /only sign an Elpida launch/);
    assert.throws(() => pool.sign({ id: r.id, wallet: wallet.toBase58(), message: Buffer.concat([Buffer.from([0x80]), launchMessage({ wallet, mint })]).toString('base64') }), /legacy|Invalid/);
    // Accepted: the launch by the reserving wallet. The signature verifies with the mint's public key.
    const message = launchMessage({ wallet, mint });
    assert.equal(parseLegacyMessage(message).keys[0], wallet.toBase58());
    const signed = pool.sign({ id: r.id, wallet: wallet.toBase58(), message: message.toString('base64') });
    assert.equal(signed.mint, r.mint);
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), mint.toBuffer()]);
    assert.ok(verify(null, message, { key: spki, format: 'der', type: 'spki' }, Buffer.from(signed.signature, 'base64')));
    assert.throws(() => pool.sign({ id: r.id, wallet: wallet.toBase58(), message: message.toString('base64') }), /expired/, 'destroyed after signing');
    // Rate limit per wallet (2 per hour), then expiry of an unused reservation.
    const second = pool.reserve({ wallet: wallet.toBase58(), address: '1.2.3.4' });
    assert.ok(second.id);
    assert.match(pool.reserve({ wallet: wallet.toBase58(), address: '1.2.3.4' }).reason, /limit/);
    clock += 61_000;
    assert.throws(() => pool.sign({ id: second.id, wallet: wallet.toBase58(), message: launchMessage({ wallet, mint: new web3.PublicKey(second.mint) }).toString('base64') }), /expired/);
    // A restart keeps the remaining encrypted key; a different key cannot open it.
    assert.equal(new VanityMintPool({ path, key: pool.key, programId: PROGRAM, suffix: 'h', autoStart: false }).status().available, 1);
    assert.equal(new VanityMintPool({ path: join(dir, 'other.json'), key: randomBytes(32), programId: PROGRAM, suffix: 'h', autoStart: false }).status().available, 0);
    const third = pool.reserve({ wallet: other.toBase58(), address: '5.6.7.8' });
    assert.ok(third.id);
    assert.match(pool.reserve({ wallet: web3.Keypair.generate().publicKey.toBase58(), address: '5.6.7.8' }).reason, /ready yet|random/, 'empty pool falls back');
  } finally { pool.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('the pool refills itself in a worker thread', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elpida-vanity-')), pool = new VanityMintPool({ path: join(dir, 'v.json'), key: randomBytes(32), programId: PROGRAM, suffix: 'h', target: 1, workers: 1 });
  try {
    for (let i = 0; i < 100 && pool.status().available < 1; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(pool.status().available, 1);
    assert.equal(pool.status().grinding, 0, 'stops at the target');
  } finally { pool.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('client address: right-most X-Forwarded-For behind Railway, the socket elsewhere', () => {
  const req = { headers: { 'x-forwarded-for': 'spoofed, 9.9.9.9' }, socket: { remoteAddress: '10.0.0.1' } };
  assert.equal(clientAddress(req, { RAILWAY_ENVIRONMENT_NAME: 'production' }), '9.9.9.9');
  assert.equal(clientAddress(req, {}), '10.0.0.1');
});
