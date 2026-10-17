import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as web3 from '@solana/web3.js';
import { SolanaIndexer, programEventLogs, pumpSwapTrade, metadataUri } from '../packages/indexer/solana-indexer.mjs';
import { EVENTS } from '../packages/solana/client.mjs';
import { SOLANA_GENESIS, validateSolanaRpc } from '../packages/solana/rpc-config.mjs';

const programId = web3.Keypair.generate().publicKey.toBase58();
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

test('PumpSwap swaps are read from the pool vault balance changes; liquidity moves are not trades', () => {
  const [poolBase, poolQuote, trader, payer, other] = Array.from({ length: 5 }, () => web3.Keypair.generate().publicKey.toBase58());
  const keys = [payer, poolBase, poolQuote, trader, other].map(k => new web3.PublicKey(k));
  const bal = (accountIndex, amount, owner, m = mint) => ({ accountIndex, mint: m, owner, uiTokenAmount: { amount: String(amount) } });
  const tx = (pre, post) => ({ transaction: { message: { staticAccountKeys: keys } }, meta: { err: null, preTokenBalances: pre, postTokenBalances: post } });
  const ids = { poolBase, poolQuote, baseMint: mint };
  // Buy: 1,000 tokens leave the pool, 2,500 quote units arrive; trader (account 3) receives the tokens.
  const buy = pumpSwapTrade(tx([bal(1, 10_000, 'pool'), bal(2, 50_000, 'pool', 'Q'), bal(3, 0, trader)], [bal(1, 9_000, 'pool'), bal(2, 52_500, 'pool', 'Q'), bal(3, 1_000, trader)]), ids);
  assert.deepEqual(buy, { side: 'buy', tokenRaw: 1_000n, quoteRaw: 2_500n, account: trader });
  // Sell routed through an aggregator: tokens arrive, quote leaves; the seller is the owner whose tokens fell.
  const sell = pumpSwapTrade(tx([bal(1, 9_000, 'pool'), bal(2, 52_500, 'pool', 'Q'), bal(4, 400, other)], [bal(1, 9_400, 'pool'), bal(2, 51_500, 'pool', 'Q'), bal(4, 0, other)]), ids);
  assert.deepEqual(sell, { side: 'sell', tokenRaw: 400n, quoteRaw: 1_000n, account: other });
  // Migration / deposits (both vaults up) and LP-fee harvests (both down) are not swaps.
  assert.equal(pumpSwapTrade(tx([bal(1, 0, 'pool'), bal(2, 0, 'pool', 'Q')], [bal(1, 9_000, 'pool'), bal(2, 50_000, 'pool', 'Q')]), ids), null);
  assert.equal(pumpSwapTrade(tx([bal(1, 9_000, 'pool'), bal(2, 50_000, 'pool', 'Q')], [bal(1, 8_990, 'pool'), bal(2, 49_900, 'pool', 'Q')]), ids), null);
  // A transaction that does not touch this pool's vaults.
  assert.equal(pumpSwapTrade(tx([bal(3, 0, trader)], [bal(3, 5, trader)]), ids), null);
  // Unknown trader falls back to the fee payer.
  assert.equal(pumpSwapTrade(tx([bal(1, 100, 'pool'), bal(2, 100, 'pool', 'Q')], [bal(1, 90, 'pool'), bal(2, 120, 'pool', 'Q')]), ids).account, payer);
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
