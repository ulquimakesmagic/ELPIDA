// The gated V2 mainnet deployment path (audit DEP-01, 11 November 2026): refuses without an approval for the exact plan,
// refuses a treasury that is not a 2-of-N Safe, deploys at $20,000, reads every constructor argument back, writes the
// Safe batch, and after the batch the deployment is wired, starts tokens at $20,000 and can be stopped by the guardian.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPlan, planHash, approvalFor, rehearse, preflight, APPROVAL_STATEMENT } from '../scripts/v2-mainnet-deploy.mjs';

const PLAN = new URL('../deployments/plans/base-mainnet.json', import.meta.url);

test('the Base plan is incomplete until Malik fills the wallets, and nothing deploys without an approval for that exact plan', t => {
  assert.throws(() => readPlan(PLAN), /no treasury/);
  const { plan } = readPlan(PLAN, { local: true });
  assert.equal(plan.chainId, 8453); assert.equal(plan.startMcapUsd, 20_000);
  const dir = mkdtempSync(join(tmpdir(), 'elpida-approval-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hash = planHash('{"key":"base-mainnet"}');
  assert.throws(() => approvalFor('base-mainnet', hash, dir), /No approval for this plan/);
  const file = join(dir, `base-mainnet-${hash.slice(0, 16)}.json`);
  writeFileSync(file, JSON.stringify({ planSha256: planHash('another plan'), approvedBy: 'Malik', date: '2026-11-20', statement: APPROVAL_STATEMENT }));
  assert.throws(() => approvalFor('base-mainnet', hash, dir), /different plan/);
  writeFileSync(file, JSON.stringify({ planSha256: hash, approvedBy: 'Malik', date: '2026-11-20', statement: 'ok' }));
  assert.throws(() => approvalFor('base-mainnet', hash, dir), /incomplete/);
  writeFileSync(file, JSON.stringify({ planSha256: hash, approvedBy: 'Malik', date: '2026-11-20', statement: APPROVAL_STATEMENT }));
  assert.equal(approvalFor('base-mainnet', hash, dir, Date.parse('2026-11-21')).approvedBy, 'Malik');
  assert.throws(() => approvalFor('base-mainnet', hash, dir, Date.parse('2026-12-10')), /older than 14 days/, 'the gate\'s 14-day limit (#234)');
});

test('rehearsal: preflight, deploy at $20,000, constructor read-back, Safe batch, verify, a $20,000 launch and the guardian stop', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'elpida-rehearsal-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { plan } = readPlan(PLAN, { local: true }), recordPath = join(dir, 'base-mainnet.rehearsal.json');
  const r = await rehearse({ plan, recordPath });
  assert.equal(r.checks.failed.length, 0, JSON.stringify(r.checks.failed));
  assert.ok(r.record.constructorChecks.length >= 18 && r.record.constructorChecks.every(c => c.ok), JSON.stringify(r.record.constructorChecks.filter(c => !c.ok)));
  assert.ok(r.verified.every(c => c.ok)); assert.equal(r.record.status, 'ready');
  assert.ok(r.record.constructorChecks.some(c => /gate \(#234\)/.test(c.check) && c.ok), 'the #234 gate comparison ran and passed');
  assert.equal(r.record.gate.plan.startMcapUsd, 20_000);
  assert.ok(r.launch.startMcapUsd >= 20_000 * 0.999 && r.launch.startMcapUsd <= 20_000 * 1.002, `starts at $${r.launch.startMcapUsd}`);
  assert.equal(r.guardianPaused, true);
  const saved = JSON.parse(readFileSync(recordPath, 'utf8'));
  for (const k of ['create2', 'factory', 'airdrop', 'holder', 'flywheel', 'hook', 'router']) assert.match(saved.contracts[k], /^0x[0-9a-fA-F]{40}$/, k);
  assert.ok(existsSync(recordPath.replace(/\.json$/, '-safe-batch.json')));
  const batch = JSON.parse(readFileSync(recordPath.replace(/\.json$/, '-safe-batch.json'), 'utf8'));
  assert.deepEqual(batch.transactions.map(x => x.description.split('(')[0]), ['setHook', 'configureUsdPricing', 'approveQuote', 'setGuardian', 'setDailyLaunchCap']);
});

test('BNB Chain rehearsal: BNB / USD feed, 18-decimal USDC approved at 25,000e18, the same $20,000 launch and the guardian stop', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'elpida-bnb-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { plan } = readPlan(new URL('../deployments/plans/bnb-mainnet.json', import.meta.url), { local: true });
  assert.equal(plan.chainId, 56); assert.equal(plan.usdcDecimals, 18); assert.equal(plan.nativeSymbol, 'BNB');
  const r = await rehearse({ plan, recordPath: join(dir, 'bnb-mainnet.rehearsal.json') });
  assert.equal(r.checks.failed.length, 0, JSON.stringify(r.checks.failed));
  assert.ok(r.checks.some(c => c.check === 'BNB/USD feed is BNB / USD' && c.ok) && r.checks.some(c => c.check === 'USDC has 18 decimals' && c.ok));
  assert.ok(r.verified.some(c => c.check === 'USDC approved at $25,000 virtual' && c.ok && c.detail === String(25_000n * 10n ** 18n)), JSON.stringify(r.verified));
  assert.ok(r.launch.startMcapUsd >= 20_000 * 0.999 && r.launch.startMcapUsd <= 20_000 * 1.002, `starts at $${r.launch.startMcapUsd}`);
  assert.equal(r.guardianPaused, true);
});

test('preflight refuses a treasury that is a plain wallet or a 1-of-N Safe, and a shared keeper', async t => {
  const { network } = await import('hardhat'), { BrowserProvider, ContractFactory } = await import('ethers'), { compileV4 } = await import('../scripts/compile-v4.mjs');
  const connection = await network.create('localCancun'), provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  t.after(async () => { provider.destroy(); await connection.close(); });
  const signers = await Promise.all([0, 1, 2, 3].map(i => provider.getSigner(i))), a = await Promise.all(signers.map(s => s.getAddress()));
  const art = Object.values(compileV4({ includeMocks: true })).find(e => e.MockSafe)?.MockSafe;
  const deploySafe = async threshold => { const c = await new ContractFactory(art.abi, art.evm.bytecode.object, signers[0]).deploy([a[1], a[2]], threshold); await c.waitForDeployment(); return c.getAddress(); };
  const base = { key: 'x', name: 'x', chainId: Number((await provider.getNetwork()).chainId), startMcapUsd: 20_000, minFeeBps: 100, dailyLaunchCap: 10, feedMaxAge: 86_400, keeper: a[2], guardian: a[3], poolManager: a[0], usdFeed: a[0], usdc: a[0] };
  const failed = async plan => (await preflight({ provider, plan })).failed.map(c => c.check);
  assert.ok((await failed({ ...base, treasury: a[1] })).includes('treasury is a Safe, 2-of-N or stricter'), 'a plain wallet');
  assert.ok((await failed({ ...base, treasury: await deploySafe(1) })).includes('treasury is a Safe, 2-of-N or stricter'), '1-of-2');
  assert.ok(!(await failed({ ...base, treasury: await deploySafe(2) })).includes('treasury is a Safe, 2-of-N or stricter'), '2-of-2 passes');
  assert.ok((await failed({ ...base, treasury: await deploySafe(2), keeper: a[3] })).includes('treasury, keeper, guardian and deployer are four different wallets'));
  assert.ok((await failed({ ...base, treasury: await deploySafe(2), startMcapUsd: 50 })).includes('start market cap $20,000'));
});

test('the deployer key is taken cleanly from a messy paste, and never echoed in an error', async () => {
  const { deployerKey } = await import('../scripts/v2-mainnet-deploy.mjs');
  const hex = 'ab'.repeat(32);
  assert.equal(deployerKey(hex), '0x' + hex);
  assert.equal(deployerKey(`  0x${hex}\r\n`), '0x' + hex);
  assert.equal(deployerKey(`\x1b[200~${hex}\x1b[201~`), '0x' + hex, 'VS Code bracketed paste');
  assert.throws(() => deployerKey('not a key'), e => /not a private key/.test(e.message) && !e.message.includes('not a key'));
  assert.throws(() => deployerKey(`${hex} ${'cd'.repeat(32)}`), /More than one/);
  assert.throws(() => deployerKey('ab'.repeat(33)), e => /not a private key/.test(e.message) && !e.message.includes('abab'));
});

test('a pasted recovery phrase is refused at once and never echoed', async () => {
  const { deployerKey } = await import('../scripts/v2-mainnet-deploy.mjs');
  const phrase = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima';
  for (const input of [phrase, `\x1b[200~${phrase}\x1b[201~`, `${phrase} mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray`])
    assert.throws(() => deployerKey(input), e => /recovery phrase/.test(e.message) && !/alpha|bravo|lima/.test(e.message));
});
