import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as web3 from '@solana/web3.js';
import { SolanaIndexer, programEventLogs, pumpSwapTrade, raydiumSwapTrade, metadataUri } from '../packages/indexer/solana-indexer.mjs';
import { EVENTS } from '../packages/solana/client.mjs';
import { SOLANA_GENESIS, validateSolanaRpc } from '../packages/solana/rpc-config.mjs';

const programId = web3.Keypair.generate().publicKey.toBase58();
const bs58 = bytes => { let n = 0n; for (const b of bytes) n = (n << 8n) | BigInt(b); let out = ''; const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; while (n > 0n) { out = A[Number(n % 58n)] + out; n /= 58n; } for (const b of bytes) { if (b) break; out = '1' + out; } return out; };
const pool = web3.Keypair.generate().publicKey.toBase58();
const mint = web3.Keypair.generate().publicKey.toBase58();
const buyer = web3.Keypair.generate().publicKey.toBase58();
function buyLog() {
  const spec = EVENTS.CurveBought;
  const bytes = Buffer.alloc(8 + spec.fields.reduce((n, [, type]) => n + (type === 'key' ? 32 : 8), 0));
  Buffer.from(spec.discriminator).copy(bytes); let offset = 8;
  for (const [field, type] of spec.fields) {
    if (type === 'key') new web3.PublicKey(field === 'pool' ? pool : buyer).toBuffer().copy(bytes, offset);
    else bytes.writeBigUInt64LE(field === 'quoteIn' ? 1_000_000n : 2_000_000n, offset);
    offset += type === 'key' ? 32 : 8;
  }
  return 'Program data: ' + bytes.toString('base64');
}
function fixture(path = ':memory:') {
  let transaction = null;
  const signature = { signature: 'transaction-one', slot: 10, err: null, blockTime: 100 };
  const connection = {
    async getGenesisHash() { return SOLANA_GENESIS.devnet; },
    async getSignaturesForAddress(_, options) { return options.until === signature.signature ? [] : [signature]; },
    async getTransaction() { return transaction; },
  };
  const index = new SolanaIndexer({ web3, connection, deployment: { programId }, network: { key: 'solana-devnet', cluster: 'devnet' }, spacingMs: 0, path });
  index.db.prepare('INSERT OR IGNORE INTO tokens VALUES(?,?,?)').run(mint, 100, JSON.stringify({ address: mint, pool, quoteDecimals: 6 }));
  return { index, signature, setTransaction(value) { transaction = value; } };
}
const success = () => ({ blockTime: 100, meta: { err: null, logMessages: [`Program ${programId} invoke [1]`, buyLog(), `Program ${programId} success`] } });

test('Solana index accepts only its own program logs across nested calls', () => {
  const other = web3.Keypair.generate().publicKey.toBase58(), log = buyLog();
  assert.deepEqual(programEventLogs([
    log, `Program ${other} invoke [1]`, log,
    `Program ${programId} invoke [2]`, log,
    `Program ${other} invoke [3]`, log, `Program ${other} success`,
    log, `Program ${programId} success`, log, `Program ${other} success`, log,
  ], programId), [log, log]);
});

test('unavailable Solana transaction retries after restart without losing history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elpida-solana-index-'));
  let f = fixture(join(dir, 'index.sqlite'));
  try {
    await assert.rejects(f.index.syncTrades(), { code: 'TRANSACTION_PENDING' });
    assert.equal(f.index.status().cursorSlot, null);
    f.index.close(); f = fixture(join(dir, 'index.sqlite')); f.setTransaction(success());
    assert.equal(await f.index.syncTrades(), 1);
    assert.equal(f.index.status().cursorSlot, 10);
    assert.equal(f.index.trades(mint).length, 1);
    assert.equal(await f.index.syncTrades(), 0);
  } finally { f.index.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Solana trade and checkpoint commit atomically and retry safely', async () => {
  const f = fixture(); f.setTransaction(success());
  try {
    f.index.db.exec("CREATE TRIGGER reject_cursor BEFORE INSERT ON cursor BEGIN SELECT RAISE(ABORT, 'checkpoint failure'); END");
    await assert.rejects(f.index.syncTrades(), /checkpoint failure/);
    assert.equal(f.index.trades(mint).length, 0);
    assert.equal(f.index.status().cursorSlot, null);
    f.index.db.exec('DROP TRIGGER reject_cursor');
    assert.equal(await f.index.syncTrades(), 1);
    assert.equal(f.index.trades(mint).length, 1);
  } finally { f.index.close(); }
});

test('failed Solana transactions advance the checkpoint without indexing emitted logs', async () => {
  const f = fixture(); f.setTransaction({ ...success(), meta: { err: { InstructionError: [0, 'Custom'] }, logMessages: [buyLog()] } });
  try {
    assert.equal(await f.index.syncTrades(), 0);
    assert.equal(f.index.status().cursorSlot, 10);
    assert.equal(f.index.trades(mint).length, 0);
  } finally { f.index.close(); }
});

test('Solana worker reports the failing phase without exposing RPC error details', async () => {
  const f = fixture();
  f.index.syncPools = async () => {};
  try {
    await assert.rejects(f.index.sync(), { code: 'TRANSACTION_PENDING' });
    assert.equal(f.index.status().errorPhase, 'transaction_history');
    assert.equal(f.index.status().error, 'TRANSACTION_PENDING');
    f.setTransaction(success()); await f.index.sync();
    assert.equal(f.index.status().errorPhase, null);
    assert.equal(f.index.status().error, null);
    assert.ok(f.index.status().lastSuccess);
  } finally { f.index.close(); }
});

test('Solana RPC configuration rejects pasted endpoint lists without leaking credentials', () => {
  for (const value of ['https://example.com/?api-key=secret,https://other.com', 'https://example.com\nhttps://other.com', 'not-a-url', 'http://remote.example.com', 'https://user:secret@example.com']) {
    assert.throws(() => validateSolanaRpc(value), e => e.code === 'RPC_CONFIG_INVALID' && !e.message.includes('secret'));
  }
  assert.equal(validateSolanaRpc('https://devnet.helius-rpc.com/?api-key=secret'), 'https://devnet.helius-rpc.com/?api-key=secret');
  assert.equal(validateSolanaRpc('http://127.0.0.1:8899'), 'http://127.0.0.1:8899/');
});

test('Solana RPC cluster mismatch prevents all pool reads and checkpoint changes', async () => {
  const f = fixture(); let reads = 0;
  f.index.connection.getGenesisHash = async () => SOLANA_GENESIS.mainnet;
  f.index.syncPools = async () => { reads++; };
  try {
    await assert.rejects(f.index.sync(), { code: 'RPC_CLUSTER_MISMATCH' });
    assert.equal(reads, 0); assert.equal(f.index.status().cursorSlot, null);
    assert.equal(f.index.status().errorPhase, 'network_identity');
    f.index.connection.getGenesisHash = async () => SOLANA_GENESIS.devnet;
    f.setTransaction(success()); await f.index.sync();
    assert.equal(reads, 2); assert.equal(f.index.status().error, null);
  } finally { f.index.close(); }
});

test('PumpSwap swaps: one swap instruction on the pool, consistent price and reserves, trader from the instruction', () => {
  const PUMP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
  const [pumpPool, poolBase, poolQuote, trader, payer, other] = Array.from({ length: 6 }, () => web3.Keypair.generate().publicKey.toBase58());
  const keys = [payer, poolBase, poolQuote, trader, other, pumpPool, PUMP].map(k => new web3.PublicKey(k));
  const BUY = [102, 6, 61, 18, 1, 218, 235, 234], SELL = [51, 230, 133, 164, 1, 127, 131, 173];
  // Swap instruction accounts: pool, user, ... ; indexes into `keys`.
  const swap = (disc, user = 3) => ({ programIdIndex: 6, accountKeyIndexes: [5, user, 1, 2], data: Uint8Array.from([...disc, ...new Array(16).fill(0)]) });
  const bal = (accountIndex, amount) => ({ accountIndex, mint: mint, owner: 'x', uiTokenAmount: { amount: String(amount) } });
  const tx = (ixs, pre, post, inner = []) => ({ transaction: { message: { staticAccountKeys: keys, compiledInstructions: ixs } }, meta: { err: null, preTokenBalances: pre, postTokenBalances: post, innerInstructions: inner } });
  const ids = { pool: pumpPool, poolBase, poolQuote };
  // Pool 1,000,000 base : 2,500,000 quote (price 2.5). A buy of 1,000 base for 2,506 quote (fees included).
  const pre = [bal(1, 1_000_000), bal(2, 2_500_000)], postBuy = [bal(1, 999_000), bal(2, 2_502_506)];
  assert.deepEqual(pumpSwapTrade(tx([swap(BUY)], pre, postBuy), ids), { side: 'buy', tokenRaw: 1_000n, quoteRaw: 2_506n, account: trader });
  // A sell routed through an aggregator (inner instruction); the trader is the swap's user.
  const inner = [{ index: 0, instructions: [{ programIdIndex: 6, accounts: [5, 4, 1, 2], data: bs58([...SELL, ...new Array(16).fill(0)]) }] }];
  assert.deepEqual(pumpSwapTrade(tx([], pre, [bal(1, 1_000_400), bal(2, 2_499_002)], inner), ids), { side: 'sell', tokenRaw: 400n, quoteRaw: 998n, account: other });
  // Two swaps on the pool in one transaction (buy X, sell X-1) are refused: the netted price would be fake.
  assert.equal(pumpSwapTrade(tx([swap(BUY), swap(SELL)], pre, [bal(1, 999_999), bal(2, 2_500_015)]), ids), null);
  // A swap plus a donation to a vault: the price falls outside the pool's range, or reserves grow too much.
  assert.equal(pumpSwapTrade(tx([swap(BUY)], pre, [bal(1, 999_000), bal(2, 2_700_000)]), ids), null);
  // No swap instruction (a plain transfer that moved vault balances), and liquidity moves, are not trades.
  assert.equal(pumpSwapTrade(tx([], pre, postBuy), ids), null);
  assert.equal(pumpSwapTrade(tx([swap(BUY)], pre, [bal(1, 1_100_000), bal(2, 2_750_000)]), ids), null);
  // A swap on another pool does not count for this one.
  assert.equal(pumpSwapTrade(tx([{ ...swap(BUY), accountKeyIndexes: [4, 3, 1, 2] }], pre, postBuy), ids), null);
});

test('Raydium CPMM swaps on graduated SOL-pair pools: the same checks, the trader is the swap payer', () => {
  const RAY = 'DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb', PUMP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
  const [rayPool, baseVault, quoteVault, trader, payer, other] = Array.from({ length: 6 }, () => web3.Keypair.generate().publicKey.toBase58());
  const keys = [payer, baseVault, quoteVault, trader, other, rayPool, RAY, PUMP].map(k => new web3.PublicKey(k));
  const BASE_IN = [143, 190, 90, 218, 196, 30, 51, 222], BASE_OUT = [55, 217, 98, 86, 163, 74, 180, 173];
  // swap accounts: payer, authority, amm_config, pool_state, input, output, input_vault, output_vault, ...
  const swap = (disc, user = 3, program = 6) => ({ programIdIndex: program, accountKeyIndexes: [user, 4, 4, 5, 4, 4, 2, 1], data: Uint8Array.from([...disc, ...new Array(16).fill(0)]) });
  const bal = (accountIndex, amount) => ({ accountIndex, mint: 'm', owner: 'x', uiTokenAmount: { amount: String(amount) } });
  const tx = (ixs, pre, post) => ({ transaction: { message: { staticAccountKeys: keys, compiledInstructions: ixs } }, meta: { err: null, preTokenBalances: pre, postTokenBalances: post, innerInstructions: [] } });
  const ids = { pool: rayPool, poolBase: baseVault, poolQuote: quoteVault };
  const pre = [bal(1, 1_000_000), bal(2, 2_500_000)], postBuy = [bal(1, 999_000), bal(2, 2_502_530)];
  assert.deepEqual(raydiumSwapTrade(tx([swap(BASE_IN)], pre, postBuy), ids), { side: 'buy', tokenRaw: 1_000n, quoteRaw: 2_530n, account: trader }, 'swap_base_input');
  assert.equal(raydiumSwapTrade(tx([swap(BASE_IN)], pre, [bal(1, 999_000), bal(2, 2_525_300)]), ids), null, 'a price far outside the pool range is refused');
  assert.equal(raydiumSwapTrade(tx([swap(BASE_OUT, 4)], pre, [bal(1, 1_000_400), bal(2, 2_499_002)]), ids).account, other, 'swap_base_output');
  assert.equal(raydiumSwapTrade(tx([swap(BASE_IN), swap(BASE_OUT)], pre, [bal(1, 999_999), bal(2, 2_500_015)]), ids), null, 'two swaps refused');
  assert.equal(raydiumSwapTrade(tx([swap(BASE_IN, 3, 7)], pre, [bal(1, 999_000), bal(2, 2_502_530)]), ids), null, 'another program does not count');
  assert.equal(pumpSwapTrade(tx([swap(BASE_IN)], pre, [bal(1, 999_000), bal(2, 2_502_530)]), ids), null, 'nor does a Raydium swap for PumpSwap');
});

test('Metaplex metadata URI is read from a MetadataV1 account and ignored otherwise', () => {
  const data = Buffer.alloc(679); data[0] = 4;
  const uri = 'ipfs://bafkreih6ilp3u4ue7fmqjnxdnq4ejxn6s5edsxqy7y5c3x2tsnkacsm4zu';
  data.writeUInt32LE(200, 115); data.write(uri, 119, 'utf8');
  assert.equal(metadataUri(data), uri, 'padding removed');
  assert.equal(metadataUri(Buffer.alloc(679)), '', 'wrong account key');
  assert.equal(metadataUri(Buffer.alloc(100)), '', 'too short');
  assert.equal(metadataUri(null), '');
});

test('the fast pass reads new transactions, reloads pools only when something traded, and feeds new rows once', async () => {
  const f = fixture(); f.setTransaction(success());
  let poolLoads = 0, dexReads = 0;
  f.index.syncPools = async () => { poolLoads++; };
  f.index.syncPumpTrades = async () => { dexReads++; return 0; };
  f.index.networkValidated = true; f.index.lastSuccess = new Date().toISOString();
  try {
    const before = f.index.lastTradeRow();
    await f.index.syncRecent();
    assert.equal(poolLoads, 1, 'a trade happened: prices reload');
    assert.equal(dexReads, 1, 'swaps on migrated pools are read every pass');
    const { trades, last } = f.index.tradesAfter(before);
    assert.equal(trades.length, 1); assert.equal(trades[0].hash, 'transaction-one'); assert.equal(trades[0].idx, 0);
    assert.equal(f.index.tradesAfter(last).trades.length, 0, 'nothing is fed twice');
    await f.index.syncRecent();
    assert.equal(poolLoads, 1, 'an idle pass does not reload the pools');
  } finally { f.index.close(); }
});

test('a launch newer than the pool snapshot reloads the pools before its trades are read, so none is skipped', async () => {
  const f = fixture(); f.setTransaction(success());
  f.index.db.prepare('DELETE FROM tokens').run();
  let loads = 0;
  f.index.syncPools = async () => { loads++; f.index.db.prepare('INSERT OR IGNORE INTO tokens VALUES(?,?,?)').run(mint, 100, JSON.stringify({ address: mint, pool, quoteDecimals: 6 })); };
  try {
    assert.equal(await f.index.syncTrades(), 1, 'the trade of the pool unknown at the start is kept');
    assert.equal(loads, 1);
  } finally { f.index.close(); }
});
