// Devnet V2 stock pairs (15 November 2026): the test build's round test price, the launch preview's starting reserve
// and the setup step, checked without a validator (tests/solana.test.mjs runs the program itself).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as web3 from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { createElpidaSolana, parseTestStockPrice, stockVirtualQuote, usdToQuote, mintMultiplierE12, DISCRIMINATORS, TOKEN_SUPPLY, TOKEN_2022_PROGRAM } from '../packages/solana/client.mjs';
import { V2_TEST_STOCK_PRICES, testStockFeedId, v2StockParams, ensureV2Stocks } from '../packages/solana/v2-setup.mjs';

const disc = name => [...createHash('sha256').update(name).digest().subarray(0, 8)];

test('the client uses the program\'s discriminators for the test price', () => {
  assert.deepEqual(DISCRIMINATORS.setTestStockPrice, disc('global:set_test_stock_price'));
  assert.deepEqual(DISCRIMINATORS.TestStockPrice, disc('account:TestStockPrice'));
});

test('a test price account parses like a Pyth update and is current at every read', () => {
  const raw = new Uint8Array(8 + 32 + 32 + 8 + 4 + 8 + 1), view = new DataView(raw.buffer);
  raw.set(DISCRIMINATORS.TestStockPrice, 0); raw.fill(0xab, 40, 72);
  view.setBigInt64(72, 41_000n, true); view.setInt32(80, -2, true); view.setBigInt64(84, 1_700_000_000n, true);
  const p = parseTestStockPrice(raw, 1_800_000_000);
  assert.deepEqual({ feedId: p.feedId, price: p.price, exponent: p.exponent, publishTime: p.publishTime, updatedAt: p.updatedAt, test: p.test },
    { feedId: 'ab'.repeat(32), price: 41_000n, exponent: -2, publishTime: 1_800_000_000, updatedAt: 1_700_000_000, test: true });
  raw[0] ^= 1;
  assert.equal(parseTestStockPrice(raw), null, 'another account type is not a test price');
});

test('the set_test_stock_price instruction: authority, mint, its PDA, program data; feed, price, exponent', () => {
  const programId = web3.Keypair.generate().publicKey, client = createElpidaSolana(web3, programId);
  const authority = web3.Keypair.generate().publicKey, mint = web3.Keypair.generate().publicKey;
  const ix = client.setTestStockPrice({ authority, quoteMint: mint, feedId: 'cd'.repeat(32), price: 41_000n, exponent: -2 });
  assert.equal(ix.keys[2].pubkey.toBase58(), web3.PublicKey.findProgramAddressSync([Buffer.from('test-price'), mint.toBytes()], programId)[0].toBase58());
  assert.equal(client.testPriceFor(mint).toBase58(), ix.keys[2].pubkey.toBase58());
  const data = Buffer.from(ix.data);
  assert.equal(data.length, 8 + 32 + 8 + 4);
  assert.equal(data.readBigInt64LE(40), 41_000n); assert.equal(data.readInt32LE(48), -2);
});

test('the preview starts a stock pair where stock_start_quote does: $ at price × multiplier', () => {
  const vt = 1_250_000_000_000_000n;
  const start = usdToQuote(50_000_000n, { price: 41_000n, exponent: -2 }, 9);
  assert.equal(stockVirtualQuote(50_000_000n, { price: 41_000n, exponent: -2 }, 1_000_000_000_000n, 9, vt), (start * vt + TOKEN_SUPPLY - 1n) / TOKEN_SUPPLY);
  // A 1.25 multiplier makes each token worth 1.25 shares, so fewer tokens make up the same dollars.
  assert.ok(stockVirtualQuote(50_000_000n, { price: 41_000n, exponent: -2 }, 1_250_000_000_000n, 9, vt) < stockVirtualQuote(50_000_000n, { price: 41_000n, exponent: -2 }, 1_000_000_000_000n, 9, vt));
});

test('mintMultiplierE12 reads the ScaledUiAmount multiplier in effect', () => {
  const data = new Uint8Array(166 + 4 + 56), view = new DataView(data.buffer);
  data[165] = 1; view.setUint16(166, 25, true); view.setUint16(168, 56, true);
  view.setFloat64(170 + 32, 1.25, true); view.setBigInt64(170 + 40, 2_000n, true); view.setFloat64(170 + 48, 1.5, true);
  assert.equal(mintMultiplierE12(data, TOKEN_2022_PROGRAM, 1_000), 1_250_000_000_000n);
  assert.equal(mintMultiplierE12(data, TOKEN_2022_PROGRAM, 3_000), 1_500_000_000_000n);
});

test('setup: fixed feed ids, ×5 curves at the 1.00% V2 minimum, test networks only', async () => {
  assert.equal(await testStockFeedId('tTSLAon'), createHash('sha256').update('elpida-test-price:tTSLAon/USD').digest('hex'));
  assert.equal(V2_TEST_STOCK_PRICES.tTSLAon, '410');
  const params = v2StockParams({ decimals: 9, launchFeeSol: '0.1' });
  assert.equal(params.baseFeeBps, 100); assert.equal(params.maxCreatorBuyBps, 300);
  await assert.rejects(ensureV2Stocks({ cluster: 'mainnet', stocks: [] }), /test networks only/);
});
