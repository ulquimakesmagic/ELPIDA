// Solana creator vaults (16 November 2026) without a validator: the account decoder, what a row is owed, and the X and
// website verification flow for Solana (signed by the payout wallet, bound by the keeper). The program itself runs in
// tests/solana.test.mjs ("Solana creator vault: …").
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import * as web3 from '@solana/web3.js';
const { Keypair, PublicKey } = web3;
import { createHash } from 'node:crypto';
import { DISCRIMINATORS, CREATOR_VAULT_SIZE, decodeCreatorVault, creatorRowDue } from '../packages/solana/client.mjs';
import { V2Identities } from '../apps/api/v2-identities.mjs';

const disc = name => [...createHash('sha256').update(name).digest().subarray(0, 8)];

/** A creator vault account as the program lays it out (Borsh, fixed rows). */
function vaultBytes({ mint, quote, payout, operator, mode = 0, rows = [], totalClaimed = 0n, reserved = 0n, rounds = 0 }) {
  const b = new Uint8Array(CREATOR_VAULT_SIZE), v = new DataView(b.buffer);
  b.set(DISCRIMINATORS.CreatorVault, 0);
  let o = 8;
  for (const k of [mint, quote, payout, operator]) { b.set(k.toBytes(), o); o += 32; }
  b[o++] = mode; o += 32; b[o++] = rows.length;
  rows.forEach((r, i) => {
    const at = o + i * 108, label = new TextEncoder().encode(r.label ?? '');
    b[at] = r.kind; b[at + 1] = label.length; b.set(label, at + 2); if (r.wallet) b.set(r.wallet.toBytes(), at + 66);
    v.setUint16(at + 98, r.shareBps, true); v.setBigUint64(at + 100, r.claimed ?? 0n, true);
  });
  o += 108 * 8; v.setBigUint64(o, totalClaimed, true); v.setBigUint64(o + 8, reserved, true); v.setUint32(o + 16, rounds, true);
  return b;
}

test('the client knows the program\'s creator vault instructions and accounts', () => {
  for (const [k, n] of [['createCreatorVault', 'global:create_creator_vault'], ['bindCreatorRow', 'global:bind_creator_row'], ['claimCreatorRow', 'global:claim_creator_row'],
    ['postCreatorRoot', 'global:post_creator_root'], ['claimCreator', 'global:claim_creator'], ['creatorSwapRaydium', 'global:creator_swap_raydium'], ['creatorSwapTest', 'global:creator_swap_test'],
    ['CreatorVault', 'account:CreatorVault'], ['CreatorRound', 'account:CreatorRound']]) assert.deepEqual(DISCRIMINATORS[k], disc(n), k);
});

test('decodes a vault and computes what a row is owed of everything received', () => {
  const [mint, quote, op, w] = [0, 1, 2, 3].map(() => Keypair.generate().publicKey);
  const v = decodeCreatorVault(web3 && vaultBytes({ mint, quote, payout: quote, operator: op, rows: [{ kind: 0, wallet: w, shareBps: 5000, claimed: 50n }, { kind: 1, label: 'x:elpida_fun', shareBps: 5000 }], totalClaimed: 50n }), web3);
  assert.equal(v.mode, 0); assert.equal(v.rows.length, 2); assert.equal(v.rows[1].label, 'x:elpida_fun'); assert.equal(v.rows[1].wallet, null);
  // 150 held + 50 paid = 200 received: each half is 100; the wallet row was paid 50.
  assert.equal(creatorRowDue(v, v.rows[0], 150n), 50n); assert.equal(creatorRowDue(v, v.rows[1], 150n), 100n);
});

test('Solana X and website rows: a challenge, the payout wallet\'s ed25519 signature, the DNS record, then the keeper binds', async () => {
  const keeperKey = Keypair.generate(), mint = Keypair.generate().publicKey, quote = Keypair.generate().publicKey;
  const bytes = vaultBytes({ mint, quote, payout: quote, operator: keeperKey.publicKey, rows: [{ kind: 0, wallet: Keypair.generate().publicKey, shareBps: 5000 }, { kind: 2, label: 'domain:community.org', shareBps: 5000 }] });
  const bound = [];
  const keeper = { enabled: true, payer: keeperKey, client: { creatorVaultFor: m => m }, connection: { getAccountInfo: async () => ({ data: bytes }) }, bindCreatorRow: async (...a) => bound.push(a) };
  let txt = null;
  const ids = new V2Identities({ signerFor: () => null, solanaKeeper: () => keeper, dnsResolver: async () => (txt ? [[txt]] : []) });
  // A payout wallet whose key we hold (ed25519), as Phantom's signMessage produces.
  const { publicKey, privateKey } = generateKeyPairSync('ed25519'), raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12), wallet = new PublicKey(raw).toBase58();
  await assert.rejects(ids.challenge({ network: 'solana-devnet', vault: mint.toBase58(), index: 0, wallet }), /need no verification/);
  const c = await ids.challenge({ network: 'solana-devnet', vault: mint.toBase58(), index: 1, wallet });
  assert.equal(c.kind, 'domain'); assert.equal(c.name, '_elpida.community.org');
  const signature = sign(null, Buffer.from(c.message), privateKey).toString('base64');
  await assert.rejects(ids.verifyDomain({ nonce: c.nonce, signature: sign(null, Buffer.from('other'), privateKey).toString('base64') }), /does not match/);
  await assert.rejects(ids.verifyDomain({ nonce: c.nonce, signature }), /not visible yet/);
  txt = c.txt;
  const done = await ids.verifyDomain({ nonce: c.nonce, signature });
  assert.match(done.message, /community\.org verified/);
  assert.deepEqual(bound, [[mint.toBase58(), 1, wallet]]);
});
