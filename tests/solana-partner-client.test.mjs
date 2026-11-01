// Solana partner tiers, client side (no validator): instruction encoding, the partner record, the pool extension,
// the launch layout (the partner account takes the rent sysvar's place so the largest launch still fits one
// transaction), both pool sizes listed, and the CLI's term checks match the program's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as web3 from '@solana/web3.js';
import { createElpidaSolana, DISCRIMINATORS, EVENTS, PROGRAM_ERRORS, POOL_SIZE, POOL_SIZE_PARTNER, SYSVAR_RENT, WSOL_MINT, decodeEvents, explainError } from '../packages/solana/client.mjs';
import { partnerTerms } from '../scripts/solana-partner.mjs';

const { Keypair, PublicKey } = web3;
const client = createElpidaSolana(web3, 'ANkA5pytoVkiKQbjzd5NdPWKgmwfsihNJvSfg3vtKLNz');
const disc = name => [...createHash('sha256').update(name).digest().subarray(0, 8)];

test('discriminators, events and the PartnerTerms error', () => {
  for (const [key, name] of [['setPartner', 'global:set_partner'], ['partnerTiersVersion', 'global:partner_tiers_version'], ['PartnerConfig', 'account:PartnerConfig']]) assert.deepEqual(DISCRIMINATORS[key], disc(name), key);
  for (const name of ['PartnerSet', 'PartnerPoolLaunched', 'PartnerBuyback', 'PartnerHarvest']) assert.deepEqual(EVENTS[name].discriminator, disc(`event:${name}`), name);
  assert.match(explainError(new Error('custom program error: 0x1790')), /10% or 20%/);
  assert.equal(PROGRAM_ERRORS.length, 38);
  // Raydium (SOL pairs): instructions, events and errors 6033-6035.
  for (const [key, name] of [['migrateToRaydium', 'global:migrate_to_raydium'], ['harvestRaydiumFees', 'global:harvest_raydium_fees'], ['raydiumBuyback', 'global:raydium_buyback'], ['raydiumSwapBaseInput', 'global:swap_base_input'], ['RaydiumPoolState', 'account:PoolState']]) assert.deepEqual(DISCRIMINATORS[key], disc(name), key);
  for (const name of ['RaydiumMigrated', 'PartnerLpBuyback']) assert.deepEqual(EVENTS[name].discriminator, disc(`event:${name}`), name);
  assert.match(explainError(new Error('custom program error: 0x1791')), /SOL pairs graduate to Raydium/);
  assert.match(explainError(new Error('custom program error: 0x1793')), /No queued partner buyback/);
  // Buyback price guard (review finding S-1): errors 6036-6037, and the S-2 release event.
  assert.match(explainError(new Error('custom program error: 0x1794')), /away from its recent average/);
  assert.match(explainError(new Error('custom program error: 0x1795')), /enough price history/);
  assert.deepEqual(EVENTS.StrandedBuybackReleased.discriminator, disc('event:StrandedBuybackReleased'));
  // A u16 field decodes in place, and the fields after it stay aligned.
  const creator = Keypair.generate().publicKey;
  const bytes = Buffer.concat([Buffer.from(EVENTS.PartnerSet.discriminator), creator.toBuffer(), Buffer.from([0xd0, 0x07]), Buffer.from(new BigUint64Array([1_800_000_000n]).buffer)]);
  const [e] = decodeEvents([`Program data: ${bytes.toString('base64')}`], PublicKey);
  assert.deepEqual({ ...e }, { name: 'PartnerSet', creator: creator.toBase58(), buybackBps: 2000, expiresAt: 1_800_000_000n });
});

test('set_partner: treasury signer, SOL pair config, the creator\'s partner PDA, exact data', () => {
  const authority = Keypair.generate().publicKey, creator = Keypair.generate().publicKey;
  const ix = client.setPartner({ authority, creator, buybackBps: 1000, expiresAt: 1_800_000_000 });
  assert.deepEqual(ix.keys.map(k => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), [
    [authority.toBase58(), true, true], [client.configFor(WSOL_MINT).toBase58(), false, false], [client.partnerPda(creator).toBase58(), false, true], [web3.SystemProgram.programId.toBase58(), false, false]]);
  assert.equal(client.partnerPda(creator).toBase58(), PublicKey.findProgramAddressSync([Buffer.from('partner'), creator.toBuffer()], client.programId)[0].toBase58());
  const data = Buffer.from(ix.data);
  assert.deepEqual([...data.subarray(0, 8)], DISCRIMINATORS.setPartner);
  assert.equal(new PublicKey(data.subarray(8, 40)).toBase58(), creator.toBase58());
  assert.equal(data.readUInt16LE(40), 1000); assert.equal(data.readBigInt64LE(42), 1_800_000_000n); assert.equal(data.length, 50);
});

test('the partner record decodes and expires', () => {
  const creator = Keypair.generate().publicKey;
  const raw = Buffer.concat([Buffer.from(DISCRIMINATORS.PartnerConfig), creator.toBuffer(), Buffer.from([0xd0, 0x07]), Buffer.from(new BigInt64Array([1_000n]).buffer), Buffer.from([254])]);
  assert.equal(client.decodePartner(raw, 999).live, true);
  assert.equal(client.decodePartner(raw, 1_000).live, false, 'expired at the expiry second');
  assert.equal(client.decodePartner(raw, 0).buybackBps, 2000);
  assert.equal(client.decodePartner(null), null); assert.equal(client.decodePartner(Buffer.alloc(51)), null);
});

test('pools: both sizes are listed and decoded; only partner-era pools carry the extension', async () => {
  const pool = Buffer.alloc(POOL_SIZE); Buffer.from(DISCRIMINATORS.CurvePool).copy(pool);
  assert.equal(client.decodePool(pool).buybackBps, 0);
  const partner = Buffer.concat([pool, Buffer.alloc(POOL_SIZE_PARTNER - POOL_SIZE)]);
  partner[POOL_SIZE] = 1; partner.writeUInt16LE(2000, POOL_SIZE + 1); partner.writeBigUInt64LE(77n, POOL_SIZE + 3); partner.writeBigUInt64LE(9n, POOL_SIZE + 11);
  assert.ok(client.isPool(partner));
  assert.deepEqual((({ buybackBps, buybackBurned, buybackQuoteSpent }) => ({ buybackBps, buybackBurned, buybackQuoteSpent }))(client.decodePool(partner)), { buybackBps: 2000, buybackBurned: 77n, buybackQuoteSpent: 9n });
  assert.throws(() => client.decodePool(Buffer.concat([pool, Buffer.alloc(5)])), /Not an Elpida curve pool/);
  const asked = [];
  await client.poolAccounts({ getProgramAccounts: async (_, options) => { asked.push(options.filters[0].dataSize); return [{ size: options.filters[0].dataSize }]; } });
  assert.deepEqual(asked, [POOL_SIZE, POOL_SIZE_PARTNER]);
});

test('launch layout: the partner account takes the rent sysvar\'s place; trades and harvests mark the mint writable', () => {
  const creator = Keypair.generate().publicKey, mint = Keypair.generate().publicKey;
  const config = { address: client.configFor(WSOL_MINT), quoteMint: new PublicKey(WSOL_MINT), treasury: Keypair.generate().publicKey };
  const base = { creator, config, mint, name: 'A'.repeat(32), symbol: 'ABCDEFGHIJ', firstBuy: 1n, minTokensOut: 1n, reward: creator, uri: 'ipfs://bafkreih6ilp3u4ue7fmqjnxdnq4ejxn6s5edsxqy7y5c3x2tsnkacsm4zu' };
  const partner = client.launch(base), earlier = client.launch({ ...base, partnerTiers: false });
  assert.equal(partner.keys.length, earlier.keys.length);
  assert.equal(partner.keys[20].pubkey.toBase58(), client.partnerPda(creator).toBase58());
  assert.equal(earlier.keys[20].pubkey.toBase58(), SYSVAR_RENT);
  assert.throws(() => client.launch({ ...base, legacy: true, partnerTiers: true }), /always takes token metadata/);
  assert.equal(client.launch({ ...base, legacy: true }).keys.length, 18, 'the pre-metadata layout is unchanged');
  assert.equal(client.buy({ buyer: creator, config, mint, grossIn: 1n, minTokensOut: 1n }).keys[3].isWritable, true);
  const harvest = client.harvestLpFees({ payer: creator, config, mint, reward: creator }).at(-1);
  assert.equal(harvest.keys[3].pubkey.toBase58(), mint.toBase58()); assert.equal(harvest.keys[3].isWritable, true);
});

test('CLI terms match the program: 10% or 20%, future expiry within 180 days, or (0, 0)', () => {
  const now = 1_800_000_000;
  assert.deepEqual(partnerTerms({ bps: '2000', days: '60' }, now), { buybackBps: 2000, expiresAt: now + 60 * 86_400 });
  assert.deepEqual(partnerTerms({ bps: '1000', expires: String(now + 5) }, now), { buybackBps: 1000, expiresAt: now + 5 });
  assert.deepEqual(partnerTerms({ bps: '0', expires: '0' }, now), { buybackBps: 0, expiresAt: 0 });
  for (const bad of [{ bps: '1500', days: '10' }, { bps: '2000', days: '181' }, { bps: '2000', expires: String(now) }, { bps: '0', expires: '5' }]) assert.throws(() => partnerTerms(bad, now), /bps|expiry|Ending/, JSON.stringify(bad));
});
