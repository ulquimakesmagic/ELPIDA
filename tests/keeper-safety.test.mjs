// Keeper safety fixes from the pre-mainnet audit of 11 November 2026 (docs/AUDIT_TRIAGE_2026-11-11.md):
// BE-01 signing lease, BE-02 confirmations and canonical receipts, BE-03 same-byte Solana resend, BE-04 manifests
// published only once their root is on chain, BE-05 keeper journals in backups and a stop when local totals are behind
// the chain, BE-07 replay cap and gas budget, BE-11 sanitised errors, EVM-01/02 payouts that one recipient cannot
// block, and the first mainnet release's "creator rewards only" switch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ZeroAddress, parseEther, Wallet } from 'ethers';
import { KeeperLease, safeError } from '../packages/core/keeper-lease.mjs';
import { V2Keeper } from '../apps/api/v2-keeper.mjs';
import { send } from '../packages/solana/deploy.mjs';
import { createPublicBackup } from '../apps/api/storage-operations.mjs';
import { buildRound } from '../packages/core/v2-rounds.mjs';
import { v2Fixture, launchV2, trade, mined } from './helpers/v2-fixture.mjs';
import * as web3 from '@solana/web3.js';

const tmp = t => { const d = mkdtempSync(join(tmpdir(), 'elpida-keeper-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };

test('BE-01: one signing lease per keeper file; the other process stays idle, and a lapsed holder cannot sign over a new one', t => {
  const file = join(tmp(t), 'k.sqlite'); let now = 1_000;
  const a = new KeeperLease(new DatabaseSync(file), 'v2k_lock', { now: () => now, ttl: 60 }), b = new KeeperLease(new DatabaseSync(file), 'v2k_lock', { now: () => now, ttl: 60 });
  assert.equal(a.acquire(), true); assert.equal(b.acquire(), false, 'the second process waits');
  now += 30; a.renew(); assert.throws(() => b.renew(), /lease_lost/);
  now += 120; assert.equal(b.acquire(), true, 'a lease nobody renews lapses');
  assert.throws(() => a.renew(), /lease_lost/, 'the old holder may not sign any more');
  b.release(); assert.equal(a.acquire(), true);
});

test('BE-01: two V2 keepers on one database: only one works, the other reports why it is idle', async t => {
  const file = join(tmp(t), 'v2-keeper.sqlite');
  const one = new V2Keeper({ workers: [], path: file }), two = new V2Keeper({ workers: [], path: file });
  await one.tick(); await two.tick();
  assert.equal(one.status().idle, null); assert.equal(two.status().idle, 'lease_held_elsewhere');
  await one.close(); await two.tick(); assert.equal(two.status().idle, null, 'released on close');
});

test('BE-02/BE-07: every send waits for confirmations, rejects a reorganised receipt and stops at the daily gas budget', async () => {
  let hash = '0xaa';
  const w = { chain: 'x', net: { chainId: 84532 }, provider: { getBlock: async () => ({ hash }) } };
  const tx = { hash: '0x1', wait: async n => { tx.waited = n; return { status: 1, gasUsed: 100n, gasPrice: 10n, blockNumber: 5, blockHash: '0xaa' }; } };
  const k = new V2Keeper({ workers: [], dailyGas: 1_500n });
  await k.send(w, async () => tx); assert.equal(tx.waited, 2, 'two confirmations by default');
  await k.send(w, async () => tx); assert.equal(k.spent('x'), 2_000n);
  await assert.rejects(k.send(w, async () => tx), /budget_reached/);
  const k2 = new V2Keeper({ workers: [] }); hash = '0xbb';
  await assert.rejects(k2.send(w, async () => tx), /reorganised/);
});

test('BE-11: errors on public status carry no URLs or long hex', () => {
  const e = { shortMessage: `could not reach https://rpc.example/v2/SECRETKEY?apikey=abc while sending 0x${'ab'.repeat(60)}` };
  const s = safeError(e);
  assert.ok(!s.includes('://') && !s.includes('SECRETKEY') && !s.includes('apikey'), s);
  assert.ok(s.length <= 200);
});

test('first mainnet release: creator rewards only; the airdrop, holder rewards and flywheel accrue', () => {
  assert.deepEqual(new V2Keeper({ workers: [], network: 'mainnet' }).jobs(), ['fees', 'creator']);
  assert.deepEqual(new V2Keeper({ workers: [] }).jobs(), ['fees', 'airdrop', 'holder', 'creator', 'flywheel']);
  assert.equal(new V2Keeper({ workers: [], network: 'mainnet' }).status().distributions, false);
});

test('BE-05: the graduation, buyback and flywheel keeper journals are backed up', async t => {
  const dir = tmp(t), source = join(dir, 'data'); mkdirSync(source);
  for (const n of ['graduation-keeper.sqlite', 'buyback-keeper.sqlite', 'flywheel-keeper.sqlite', 'v2-keeper.sqlite', 'circle-test-wallets.json']) writeFileSync(join(source, n), 'x');
  const manifest = await createPublicBackup(source, join(dir, 'snap')), paths = manifest.files.map(f => f.path);
  for (const n of ['graduation-keeper.sqlite', 'buyback-keeper.sqlite', 'flywheel-keeper.sqlite', 'v2-keeper.sqlite']) assert.ok(paths.includes(n), n);
  assert.ok(!paths.includes('circle-test-wallets.json'));
});

test('BE-03: after an ambiguous timeout the Solana sender resends the same signed bytes, never a second transaction', async () => {
  const payer = web3.Keypair.generate(), sent = [], blockhashes = [];
  let statusCalls = 0;
  const connection = {
    getLatestBlockhash: async () => { blockhashes.push(1); return { blockhash: web3.Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }; },
    sendRawTransaction: async raw => { sent.push(Buffer.from(raw).toString('hex')); if (sent.length === 1) throw new Error('request timed out'); return 'sig'; },
    getSignatureStatuses: async () => ({ value: [statusCalls++ < 1 ? null : { confirmationStatus: 'confirmed', err: null }] }),
    getBlockHeight: async () => 50,
  };
  const ix = web3.SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 });
  const journal = [];
  await send(connection, payer, [ix], [], 3, { journal: j => journal.push(j) });
  assert.equal(blockhashes.length, 1, 'signed once');
  assert.equal(sent.length, 2); assert.equal(sent[0], sent[1], 'the retry carries the same bytes');
  assert.equal(journal.length, 1, 'the signature was journalled before the first broadcast');
});

test('BE-04/BE-05/EVM-02 on the real contracts: lists go public only with their root, pushes resume, and a round already on chain stops the holder job', async t => {
  const f = await v2Fixture(t, { vaults: true }), drop = f.contracts.airdrop;
  let chainTime = await f.now();
  const keeper = new V2Keeper({ workers: [{ chain: 'local', net: { chainId: 31337, key: 'local' }, provider: f.provider, signer: f.signers[4],
    deployment: { hook: f.hook.target, airdrop: drop.target, holder: f.contracts.holder.target, flywheel: f.contracts.flywheel.target }, index: () => null, usdPerUnit: () => null }], now: () => chainTime, distributions: false });
  const w = keeper.workers[0], keeperDrop = drop.connect(f.signers[4]);
  const l = await launchV2(f, { feeBps: 300 }); await f.advance(61);
  await trade(f, l, { buy: true, amount: parseEther('1') }); await mined(f.hook.withdrawFees(l.token.target));
  const round = Number(await drop.currentRound()), pool = await f.provider.getBalance(drop.target), wallets = Array.from({ length: 5 }, () => Wallet.createRandom().address);
  const payouts = new Map(wallets.map(a => [a.toLowerCase(), pool / 5n]));
  // The round has not ended: postRoot reverts, and the list is not served.
  await assert.rejects(keeper.post(w, keeperDrop, round, ZeroAddress, payouts));
  assert.equal(keeper.manifest(31337, drop.target, round, ZeroAddress), null, 'a list whose root never landed is not public');
  assert.ok(keeper.manifest(31337, drop.target, round, ZeroAddress, { pending: true }));
  // After the round: the root lands, the list is public, and its root matches the chain.
  await f.provider.send('evm_setNextBlockTimestamp', [Number(await drop.roundEnd(round))]); await f.provider.send('evm_mine', []); chainTime = await f.now();
  const m = buildRound({ chainId: 31337, distributor: drop.target, round, asset: ZeroAddress }, payouts);
  await keeper.send(w, () => keeperDrop.postRoot(round, ZeroAddress, m.root, m.total, m.recipients, keeper.publish(w, drop.target, m)));
  keeper.confirmPublished(w, drop.target, m, (await drop.rounds(round, ZeroAddress)).root);
  assert.equal(keeper.manifest(31337, drop.target, round, ZeroAddress).root, (await drop.rounds(round, ZeroAddress)).root);
  // One wallet claims for itself, then the process "dies" before pushing: the next tick finishes every other payout.
  const self = m.entries[2];
  await mined(drop.claim(round, ZeroAddress, self.account, self.amount, self.proof));
  keeper.db.prepare("INSERT INTO v2k_pushes VALUES('local',?,?,?,'distributor',0)").run(drop.target.toLowerCase(), round, ZeroAddress);
  await keeper.tick();
  assert.equal((await drop.rounds(round, ZeroAddress)).claimed, BigInt(m.total), 'every payout pushed, the self-claimed one skipped');
  assert.equal(keeper.db.prepare('SELECT COUNT(*) n FROM v2k_pushes').get().n, 0);
  // A holder round already posted on chain while the local cursor is at it: the job stops instead of paying twice.
  await assert.rejects(keeper.refuseIfBehind(w, round, [[drop, ZeroAddress]]), /state_behind_chain/);
});
