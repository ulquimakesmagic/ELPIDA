// Solana deploy over a slow or unsteady connection (no validator): the program buffer is read in slices with
// retries, a network failure never makes the deploy pay for a second buffer, and an interrupted upload resumes
// by sending only the chunks that are not in the buffer yet.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as web3 from '@solana/web3.js';
import { LOADER_V3 } from '../packages/solana/client.mjs';
import { readAccountData, findExistingBuffer, uploadToBuffer, transientNetworkError, upgradeAuthority } from '../packages/solana/deploy.mjs';

const { Keypair, PublicKey, Transaction } = web3;
const fast = { tries: 4, delayMs: 1 };
const fetchFailed = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });

/** A fake RPC holding accounts; `failReads` / `dropSends` make that many calls fail like a dropped connection. */
function fakeConnection(accounts, { failReads = 0, dropSends = 0, maxResponse = Infinity } = {}) {
  const calls = { reads: [], sends: 0 };
  return {
    calls,
    async getAccountInfo(key, config) {
      const account = accounts.get(key.toBase58());
      const slice = config?.dataSlice;
      calls.reads.push(slice ? slice.length : account?.data.length ?? 0);
      if (failReads > 0) { failReads--; throw new Error(`failed to get info about account ${key.toBase58()}: TypeError: fetch failed`); }
      if (!account) return null;
      const data = slice ? account.data.subarray(Math.min(slice.offset, account.data.length), Math.min(slice.offset + slice.length, account.data.length)) : account.data;
      if (data.length > maxResponse) throw fetchFailed(); // the whole 1.2 MB buffer in one response never arrives
      return { owner: account.owner, lamports: account.lamports, executable: false, data: Buffer.from(data) };
    },
    async getLatestBlockhash() { return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }; },
    async sendRawTransaction(raw) {
      calls.sends++;
      if (dropSends > 0) { dropSends--; throw fetchFailed(); }
      const ix = Transaction.from(raw).instructions[0];
      const account = accounts.get(ix.keys[0].pubkey.toBase58());
      const offset = ix.data.readUInt32LE(4), length = Number(ix.data.readBigUInt64LE(8));
      ix.data.copy(account.data, 37 + offset, 16, 16 + length);
      return 'sig';
    },
  };
}

const bufferAccount = (authority, elfLength, fill = 0) => {
  const data = Buffer.alloc(37 + elfLength, fill);
  data.fill(0, 0, 37);
  data.writeUInt32LE(1, 0); data[4] = 1; authority.toBuffer().copy(data, 5);
  return { owner: new PublicKey(LOADER_V3), lamports: 8_000_000_000, data };
};

test('transient network errors include Node fetch failures, rate limits and resets', () => {
  assert.ok(transientNetworkError(fetchFailed()));
  assert.ok(transientNetworkError(new Error('failed to get info about account X: TypeError: fetch failed')));
  assert.ok(transientNetworkError(new Error('429 Too Many Requests')));
  assert.ok(!transientNetworkError(new Error('This keypair is not the program upgrade authority.')));
});

test('readAccountData reads a large account in slices and retries dropped reads', async () => {
  const key = Keypair.generate().publicKey;
  const data = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251));
  const connection = fakeConnection(new Map([[key.toBase58(), { owner: key, lamports: 5, data }]]), { failReads: 2, maxResponse: 131_072 });
  const read = await readAccountData(connection, key, { retry: fast });
  assert.ok(read.data.equals(data));
  assert.equal(read.lamports, 5);
  assert.ok(connection.calls.reads.every(length => length <= 131_072), 'never asks for more than one slice');
  assert.equal(await readAccountData(fakeConnection(new Map()), key, { retry: fast }), null);
});

test('readAccountData gives up after the retries and reports the network error', async () => {
  const key = Keypair.generate().publicKey;
  const connection = fakeConnection(new Map([[key.toBase58(), { owner: key, lamports: 1, data: Buffer.alloc(10) }]]), { failReads: 10 });
  await assert.rejects(readAccountData(connection, key, { retry: fast }), /fetch failed/);
});

test('a remembered buffer is recognised by its header and exact size, without reading the program bytes', async () => {
  const authority = Keypair.generate().publicKey;
  const key = Keypair.generate().publicKey;
  const accounts = new Map([[key.toBase58(), bufferAccount(authority, 1_177_704)]]);
  const connection = fakeConnection(accounts, { maxResponse: 64 });
  assert.equal((await findExistingBuffer(connection, authority, 1_177_704, key.toBase58(), { retry: fast }))?.toBase58(), key.toBase58());
  // a different size or a different authority is not ours
  const other = fakeConnection(accounts, { maxResponse: 64 });
  other.getSignaturesForAddress = async () => [];
  assert.equal(await findExistingBuffer(other, authority, 1_177_000, key.toBase58(), { retry: fast }), null);
  assert.equal(await findExistingBuffer(other, Keypair.generate().publicKey, 1_177_704, key.toBase58(), { retry: fast }), null);
});

test('a network failure while checking the remembered buffer stops the run instead of creating a second buffer', async () => {
  const authority = Keypair.generate().publicKey;
  const key = Keypair.generate().publicKey;
  const connection = fakeConnection(new Map([[key.toBase58(), bufferAccount(authority, 2000)]]), { failReads: 99 });
  connection.getSignaturesForAddress = async () => { throw new Error('should not fall back to a scan'); };
  await assert.rejects(findExistingBuffer(connection, authority, 2000, key.toBase58(), { retry: fast }), /fetch failed/);
});

test('an interrupted upload resumes into the same buffer and sends only the missing chunks, even when sends and reads drop', async () => {
  const payer = Keypair.generate();
  const elf = Buffer.from(Array.from({ length: 9_500 }, (_, i) => (i * 7 + 3) % 256)); // 10 chunks of 950 bytes
  const key = Keypair.generate().publicKey;
  const buffer = bufferAccount(payer.publicKey, elf.length);
  elf.copy(buffer.data, 37, 0, 950 * 6); // six chunks landed before the interruption
  const connection = fakeConnection(new Map([[key.toBase58(), buffer]]), { failReads: 1, dropSends: 2, maxResponse: 131_072 });
  const progress = [];
  const result = await uploadToBuffer({ connection, payer, elf, rememberedBuffer: key.toBase58(), sendsPerSecond: 1000, retry: fast, roundWaitMs: 1, onProgress: line => progress.push(line) });
  assert.equal(result.toBase58(), key.toBase58());
  assert.ok(buffer.data.subarray(37).equals(elf));
  assert.equal(connection.calls.sends, 4 + 2, 'four missing chunks, then the two dropped ones again');
  assert.ok(progress.some(line => line.startsWith('Resuming with existing program buffer')));
  assert.ok(progress.includes('6 of 10 program chunks are in the buffer.'));
  assert.ok(progress.some(line => /2 of 4 chunk sends were dropped by the network/.test(line)));
  assert.ok(progress.includes('All program chunks uploaded.'));
});

test('upgradeAuthority reads only the program data header', async () => {
  const programId = new PublicKey('ANkA5pytoVkiKQbjzd5NdPWKgmwfsihNJvSfg3vtKLNz');
  const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], new PublicKey(LOADER_V3));
  const authority = Keypair.generate().publicKey;
  const data = Buffer.alloc(45 + 1_177_704);
  data.writeUInt32LE(3, 0); data[12] = 1; authority.toBuffer().copy(data, 13);
  const connection = fakeConnection(new Map([[programData.toBase58(), { owner: new PublicKey(LOADER_V3), lamports: 1, data }]]), { maxResponse: 64, failReads: 1 });
  assert.equal((await upgradeAuthority(connection, programId)).toBase58(), authority.toBase58());
});
