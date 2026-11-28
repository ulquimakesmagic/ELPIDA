import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transaction, Wallet, keccak256, parseEther } from 'ethers';
import { createElysiumRelay, ELYSIUM_ORACLE, relayHistoryLogs } from '../apps/api/elysium-relay.mjs';
import { evaluateOperations } from '../apps/api/operations-health.mjs';

const time = 1_795_835_000_000;
const timestamp = time / 1000;
const oracleRound = (id, age) => [BigInt(id), parseEther('63'), BigInt(timestamp - age - 1), BigInt(timestamp - age), BigInt(id)];
const snapshot = (round, delivered) => ({ head: { timestamp }, childHead: { timestamp }, round, delivered });

test('the publisher can still look for queued rounds when the configured RPC limits block ranges', async () => {
  const filter = { address: ELYSIUM_ORACLE.publisher, fromBlock: 52_470_000, toBlock: 52_474_999, topics: ['event', 'round'] };
  const rangeError = Object.assign(new Error('RPC request failed'), { error: { code: -32602, message: 'eth_getLogs block range is too large' } });
  const configured = { async getLogs() { throw rangeError; } };
  const records = [{ transactionHash: 'queued-transaction' }];
  const history = { async getLogs(query) { assert.deepEqual(query, filter); return records; } };
  assert.equal(await relayHistoryLogs(configured, history, filter), records);
  const failure = new Error('History endpoint unavailable');
  await assert.rejects(relayHistoryLogs(configured, { async getLogs() { throw failure; } }, filter), failure);
});

test('monitoring reports lag, an expiring round, and recovery without quoting or signing a transaction', async () => {
  let data = snapshot(oracleRound(8, 1200), oracleRound(7, 82_800));
  const relay = createElysiumRelay({ enabled: true, now: () => time, log: () => {}, reader: {
    read: async () => data,
    quote: () => assert.fail('Monitoring must never quote a paid relay.'),
    broadcast: () => assert.fail('Monitoring must never broadcast.'),
  } });
  const incident = () => evaluateOperations({ now: time, startedAt: time - 200_000, durable: true,
    elysiumRelay: relay.status() }).incidents.find(item => item.code === 'elysium_price_relay');
  await relay.tick();
  assert.equal(relay.status().mode, 'monitor');
  assert.equal(relay.status().state, 'awaiting_delivery');
  assert.match(incident().message, /within two hours/);
  data = snapshot(oracleRound(8, 1200), oracleRound(8, 1200));
  await relay.tick();
  assert.equal(relay.status().state, 'current');
  assert.equal(incident(), undefined);
  data = snapshot(oracleRound(9, 60), null);
  await relay.tick();
  assert.match(incident().message, /expired or is missing/);
  await relay.close();
});

test('paid relay skips already queued rounds and persists a capped attempt before broadcast', async t => {
  const path = join(tmpdir(), `elpida-relay-test-${randomUUID()}.sqlite`);
  const wallet = Wallet.createRandom();
  const env = { ELPIDA_ELYSIUM_RELAY_MODE: 'publish', ELPIDA_ELYSIUM_RELAY_KEY: wallet.privateKey,
    ELPIDA_ELYSIUM_RELAY_TX_CAP_HYPE: '0.00025', ELPIDA_ELYSIUM_RELAY_24H_CAP_HYPE: '0.0003' };
  let round = 9, ticket = '42', broadcasts = 0, quoted = 0, receipt = null, broadcastHash;
  const reader = {
    read: async () => snapshot(oracleRound(round, 120), oracleRound(7, 3000)),
    queued: async () => ticket,
    receipt: async hash => { assert.equal(hash, broadcastHash); return receipt; },
    quote: async (_snapshot, address) => {
      assert.equal(address, wallet.address);
      quoted++;
      return { baseFee: 500_000_000n, balance: parseEther('0.01'), transaction: {
        to: ELYSIUM_ORACLE.publisher, chainId: 999, type: 2, nonce: 4, value: parseEther('0.0001'), gasLimit: 150_000n,
        maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, data: '0x12345678',
      } };
    },
    broadcast: async raw => {
      broadcasts++;
      const tx = Transaction.from(raw);
      assert.equal(tx.value + tx.gasLimit * tx.maxFeePerGas, parseEther('0.00025'));
      assert.equal(tx.from, wallet.address);
      broadcastHash = keccak256(raw);
      assert.equal(relay.status().pendingHash, broadcastHash);
      throw new Error('Simulated network loss after broadcasting.');
    },
  };
  const connect = () => createElysiumRelay({ enabled: true, durable: true, env, ledgerPath: path, reader, now: () => time, log: () => {} });
  let relay = connect();
  t.after(async () => {
    await relay.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
  });
  await relay.tick();
  assert.equal(relay.status().ticket, '42');
  assert.equal(quoted, 0);
  ticket = null;
  await Promise.all([relay.tick(), relay.tick()]);
  assert.equal(broadcasts, 1);
  assert.equal(relay.status().error, 'broadcast_unconfirmed');

  await relay.close();
  relay = connect();
  await relay.tick();
  assert.equal(relay.status().pendingHash, broadcastHash);
  assert.equal(broadcasts, 1);
  receipt = { status: 0, confirmations: async () => 2 };
  await relay.tick();
  assert.equal(relay.status().error, 'parent_transaction_reverted');
  round++;
  await relay.tick();
  assert.equal(relay.status().error, 'daily_limit_reached');
  assert.equal(broadcasts, 1);
});
