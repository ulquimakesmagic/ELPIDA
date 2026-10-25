// The Solana program decodes PumpSwap's pool account at hard-coded offsets (C8). That is fast and brittle: if PumpSwap
// changes its layout, `migrate_to_pumpswap` and `harvest_lp_fees` read the wrong bytes *after* the funds are in the pool.
//
// contracts/solana/fixtures/pumpswap_pool.json is a live mainnet pool (301 bytes) with what the chain said about it:
// the two vault addresses, their owners and mints, lp_supply and the two fee counters. This test takes the offsets and
// the u64 positions *from lib.rs itself*, decodes the fixture with them, and requires the result to match. Change the
// Rust offsets and the test decodes different bytes and fails; refresh the fixture with scripts/pumpswap-fixture.mjs and
// it has to decode under the same rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = readFileSync(join(root, 'contracts/solana/programs/elpida_launchpad/src/lib.rs'), 'utf8');
const fixture = JSON.parse(readFileSync(join(root, 'contracts/solana/fixtures/pumpswap_pool.json'), 'utf8'));
const data = Buffer.from(fixture.data, 'base64');

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(buffer) {
  let value = 0n;
  for (const byte of buffer) value = value * 256n + BigInt(byte);
  let out = '';
  while (value > 0n) { out = BASE58[Number(value % 58n)] + out; value /= 58n; }
  for (const byte of buffer) { if (byte !== 0) break; out = '1' + out; }
  return out;
}

/** The offsets exactly as the program states them, so a change in lib.rs is what the test follows. */
function offsetsFromProgram() {
  const constant = name => {
    const match = source.match(new RegExp(`const ${name}: usize = (\\d+);`));
    assert.ok(match, `${name} is no longer a constant in lib.rs`);
    return Number(match[1]);
  };
  const vaults = source.match(/data\[(\d+)\.\.(\d+)\] == base_vault\.key\.to_bytes\(\) && data\[(\d+)\.\.(\d+)\] == quote_vault\.key\.to_bytes\(\)/);
  assert.ok(vaults, 'the vault-key check in PumpState::read changed shape; update this test with it');
  return {
    baseVault: [Number(vaults[1]), Number(vaults[2])],
    quoteVault: [Number(vaults[3]), Number(vaults[4])],
    lpSupply: constant('PUMP_POOL_LP_SUPPLY'),
    protocolFees: constant('PUMP_POOL_PROTOCOL_FEES'),
    creatorFees: constant('PUMP_POOL_CREATOR_FEES'),
  };
}

test('the offsets the program hard-codes decode a real PumpSwap pool', () => {
  const offsets = offsetsFromProgram();

  const discriminator = createHash('sha256').update('account:Pool').digest().subarray(0, 8);
  assert.deepEqual([...data.subarray(0, 8)], [...discriminator], 'the fixture is an Anchor `Pool` account');
  assert.equal(data.length, fixture.length, 'the fixture length matches what the chain returned');

  assert.equal(base58(data.subarray(...offsets.baseVault)), fixture.decoded.baseVault, 'base vault offset');
  assert.equal(base58(data.subarray(...offsets.quoteVault)), fixture.decoded.quoteVault, 'quote vault offset');
  assert.equal(data.readBigUInt64LE(offsets.lpSupply).toString(), fixture.decoded.lpSupply, 'lp_supply offset');
  assert.equal(data.readBigUInt64LE(offsets.protocolFees).toString(), fixture.decoded.protocolFees, 'protocol fee offset');
  assert.equal(data.readBigUInt64LE(offsets.creatorFees).toString(), fixture.decoded.creatorFees, 'creator fee offset');
});

test('the decoded vaults were real token accounts when the fixture was taken', () => {
  // A wrong offset would decode to bytes that are not accounts at all. Both were resolved on chain when the fixture
  // was written, and one of them is a Token-2022 account - the program has to handle both programs.
  for (const side of ['base', 'quote']) {
    const vault = fixture.vaults[side];
    assert.match(vault.owner, /^(TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA|TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb)$/, `${side} vault owner is an SPL token program`);
    assert.ok(vault.mint && vault.mint.length >= 32, `${side} vault has a mint`);
    assert.match(vault.amount, /^\d+$/, `${side} vault balance is a number`);
  }
  assert.notEqual(fixture.vaults.base.owner, fixture.vaults.quote.owner, 'a legacy and a Token-2022 vault are both covered');
});

test('the layout leaves room for every field the program reads', () => {
  const offsets = offsetsFromProgram();
  const last = Math.max(offsets.creatorFees, offsets.lpSupply, offsets.protocolFees) + 8;
  assert.ok(data.length >= last, `the account is ${data.length} bytes but the program reads up to ${last}`);
  // The vault ranges must not overlap the counters, or the program would read a key as a number.
  assert.ok(offsets.baseVault[1] <= offsets.quoteVault[0], 'base and quote vault ranges are adjacent');
  assert.ok(offsets.quoteVault[1] <= offsets.lpSupply, 'the quote vault ends before lp_supply');
});
