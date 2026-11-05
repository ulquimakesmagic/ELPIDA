// Solana stock pairing without a validator: the client mirrors of the program's locked pool (venue test on raw mint
// data, constant-product quotes after completion, the flat base fee) and the devnet stand-in template.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EVENTS, STATUS_LOCKED, STATUS_TRADING, STATUS_GRADUATED, TOKEN_SUPPLY, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, curveParams, lockedPoolVenue, poolStats, quoteBuy, quoteSell, tradeFeeBps } from '../packages/solana/client.mjs';
import { solanaPairTemplates, SOLANA_LAUNCH_KINDS } from '../packages/core/pairs.mjs';
import { solanaPricing } from '../packages/core/pricing.mjs';

/** Raw Token-2022 mint data: 165 padded bytes, account type 1, then (type, length, value) TLVs. */
function mint(extensions) {
  const parts = [Buffer.alloc(165), Buffer.from([1])];
  for (const [kind, len] of extensions) { const h = Buffer.alloc(4); h.writeUInt16LE(kind, 0); h.writeUInt16LE(len, 2); parts.push(h, Buffer.alloc(len, 7)); }
  return Buffer.concat(parts);
}

test('Solana stock pairs: the venue follows the quote mint\'s issuer controls', () => {
  // Ondo's TSLAon/SPYon/NVDAon: ConfidentialTransferMint, DefaultAccountState, TransferHook, metadata, ScaledUiAmount, Pausable.
  const ondo = mint([[4, 65], [6, 1], [14, 64], [18, 64], [19, 120], [25, 56], [26, 33]]);
  assert.equal(lockedPoolVenue(ondo, TOKEN_2022_PROGRAM), true);
  for (const kind of [4, 14, 25, 26]) assert.equal(lockedPoolVenue(mint([[18, 64], [kind, 8]]), TOKEN_2022_PROGRAM), true, `extension ${kind}`);
  assert.equal(lockedPoolVenue(mint([[18, 64], [19, 90]]), TOKEN_2022_PROGRAM), false, 'metadata alone graduates as before');
  assert.equal(lockedPoolVenue(ondo, TOKEN_PROGRAM), false, 'classic SPL mints never use the locked pool');
  assert.equal(lockedPoolVenue(Buffer.alloc(82), TOKEN_2022_PROGRAM), false);
  assert.equal(lockedPoolVenue(null, TOKEN_2022_PROGRAM), false);
});

test('Solana stock pairs: after completion the curve formulas price a constant-product pool at the base fee', () => {
  const params = curveParams({ startFdv: 50, endFdv: 500, quoteDecimals: 9, launchFee: '0.01', snipeWindowSecs: 4 });
  const fresh = { virtualQuote: params.virtualQuote, virtualToken: params.virtualToken, curveSupply: params.curveSupply, realQuote: 0n, sold: 0n, liquidityBonus: 0n, status: STATUS_TRADING, createdAt: 0n };
  const base = BigInt(params.baseFeeBps);
  const done = quoteBuy(fresh, 10n ** 15n, base);
  assert.equal(done.graduates, true);
  // What the program's open_locked_pool leaves behind.
  const locked = { ...fresh, realQuote: done.net, sold: done.tokens, virtualQuote: 0n, virtualToken: TOKEN_SUPPLY, status: STATUS_LOCKED };
  const curveClose = Number(fresh.virtualQuote + done.net) / Number(fresh.virtualToken - done.tokens);
  assert.ok(Math.abs(poolStats(locked, 9).price / (curveClose / 1000) - 1) < 0.02, 'the pool opens at the curve close');
  assert.equal(poolStats(locked, 9).locked, true); assert.equal(poolStats(locked, 9).progress, 1);
  const config = { baseFeeBps: params.baseFeeBps, snipeStartBps: params.snipeStartBps, snipeWindowSecs: params.snipeWindowSecs };
  assert.equal(tradeFeeBps(config, locked, 0), base, 'no anti-snipe fee in the locked pool');
  assert.ok(tradeFeeBps(config, fresh, 0) > base, 'the curve still starts with the anti-snipe fee');
  // A huge buy is filled in full (no completion point) and never empties the token side; k never falls.
  const big = quoteBuy(locked, 10n ** 18n, base);
  assert.equal(big.graduates, false); assert.equal(big.gross, 10n ** 18n);
  assert.ok(big.tokens < TOKEN_SUPPLY - locked.sold);
  const after = { ...locked, realQuote: locked.realQuote + big.net, sold: locked.sold + big.tokens };
  assert.ok(after.realQuote * (TOKEN_SUPPLY - after.sold) >= locked.realQuote * (TOKEN_SUPPLY - locked.sold));
  const back = quoteSell(after, big.tokens, base);
  assert.ok(back.gross < big.net, 'a round trip never returns more than was paid in');
  assert.throws(() => quoteBuy({ ...locked, status: STATUS_GRADUATED }, 1n, base), /complete|closed/i);
});

test('Solana stock pairs: LockedPoolOpened is decoded with the program\'s discriminator', () => {
  const expected = [...createHash('sha256').update('event:LockedPoolOpened').digest().subarray(0, 8)];
  assert.deepEqual(EVENTS.LockedPoolOpened.discriminator, expected);
  assert.deepEqual(EVENTS.LockedPoolOpened.fields.map(([name]) => name), ['pool', 'mint', 'quoteReserve', 'tokenReserve']);
});

test('Solana stock pairs: the devnet stand-in is opt-in and never on mainnet', () => {
  const native = solanaPricing('devnet');
  assert.ok(!solanaPairTemplates(native, { test: true }).some(t => t.ondoStandIn), 'not added by default');
  const stock = solanaPairTemplates(native, { test: true, stocks: true }).find(t => t.ondoStandIn);
  assert.equal(stock.symbol, 'tTSLAon'); assert.equal(stock.decimals, 9); assert.match(stock.name, /no value/);
  assert.ok(!solanaPairTemplates(native, { test: false, stocks: true }).some(t => t.ondoStandIn), 'never on mainnet');
  assert.deepEqual(SOLANA_LAUNCH_KINDS, ['native', 'xstock'], 'the devnet program runs the locked pool (5 November): approved stocks are offered');
});
