// The mainnet gate: a plan cannot be deployed unless this exact plan was approved recently, the treasury is a
// multisig, the start cap is the mainnet one, and the chain reports back what the plan promised.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, assertReady, verifyDeployment, deploymentRecord, MAINNET_START_MCAP_USD, APPROVAL_MAX_AGE_DAYS } from '../packages/core/v2-deploy-gate.mjs';

const TREASURY = '0x' + '11'.repeat(20);
const RECIPIENTS = ['0x' + '22'.repeat(20), '0x' + '33'.repeat(20), '0x' + '44'.repeat(20)];
const NOW = 1_790_000_000_000;

const mainnetPlan = (overrides = {}) => buildPlan({ chainId: 8453, chainName: 'Base', mainnet: true, treasury: TREASURY, recipients: RECIPIENTS, minFeeBps: 100, ...overrides });
const approvalFor = (plan, overrides = {}) => ({ planHash: plan.planHash, approver: 'Malik', approvedAt: NOW - 86_400_000, ...overrides });
const ready = (plan, approval, opts = {}) => assertReady(plan, approval, { treasuryIsContract: true, now: NOW, ...opts });

test('a mainnet plan carries the mainnet start cap, a testnet plan carries the test one', () => {
  assert.equal(mainnetPlan().startMcapUsd, MAINNET_START_MCAP_USD);
  const testnet = buildPlan({ chainId: 84532, mainnet: false, treasury: TREASURY, recipients: RECIPIENTS, minFeeBps: 100 });
  assert.equal(testnet.startMcapUsd, 50);
});

test('the plan hash changes when anything in the plan changes, and not otherwise', () => {
  const a = mainnetPlan(), b = mainnetPlan();
  assert.equal(a.planHash, b.planHash, 'same plan, same hash');
  assert.notEqual(a.planHash, mainnetPlan({ minFeeBps: 400 }).planHash, 'a fee change invalidates the approval');
  assert.notEqual(a.planHash, mainnetPlan({ treasury: '0x' + '99'.repeat(20) }).planHash, 'a treasury change invalidates it');
  assert.notEqual(a.planHash, buildPlan({ chainId: 1, mainnet: true, treasury: TREASURY, recipients: RECIPIENTS, minFeeBps: 100 }).planHash, 'a chain change invalidates it');
});

test('an approved, sane mainnet plan passes', () => {
  const plan = mainnetPlan();
  assert.equal(ready(plan, approvalFor(plan)), true);
});

test('a mainnet deployment is refused without a matching approval', () => {
  const plan = mainnetPlan();
  assert.throws(() => ready(plan, null), { code: 'APPROVAL_MISSING' });
  assert.throws(() => ready(plan, approvalFor(mainnetPlan({ minFeeBps: 250 }))), { code: 'APPROVAL_MISMATCH' });
  assert.throws(() => ready(plan, approvalFor(plan, { approver: '' })), { code: 'APPROVAL_UNSIGNED' });
  assert.throws(() => ready(plan, approvalFor(plan, { approvedAt: 0 })), { code: 'APPROVAL_UNSIGNED' });
  const old = NOW - (APPROVAL_MAX_AGE_DAYS + 1) * 86_400_000;
  assert.throws(() => ready(plan, approvalFor(plan, { approvedAt: old })), { code: 'APPROVAL_STALE' });
});

test('the treasury must be a contract on mainnet', () => {
  const plan = mainnetPlan();
  assert.throws(() => assertReady(plan, approvalFor(plan), { treasuryIsContract: false, now: NOW }), { code: 'TREASURY_NOT_MULTISIG' });
  // A test network has no such requirement; test gas and a hot key are acceptable there.
  const testnet = buildPlan({ chainId: 84532, mainnet: false, treasury: TREASURY, recipients: RECIPIENTS, minFeeBps: 100 });
  assert.equal(assertReady(testnet, approvalFor(testnet), { treasuryIsContract: false, now: NOW }), true);
});

test('a plan that would launch at the test cap on mainnet is refused', () => {
  const plan = { ...mainnetPlan(), startMcapUsd: 50, planHash: 'x' };
  assert.throws(() => ready(plan, { planHash: 'x', approver: 'Malik', approvedAt: NOW }), { code: 'START_MCAP_WRONG' });
});

test('missing recipients and an out-of-range fee are refused', () => {
  const plan = mainnetPlan();
  assert.throws(() => ready({ ...plan, recipients: [RECIPIENTS[0]] }, approvalFor(plan)), { code: 'RECIPIENTS_UNSET' });
  assert.throws(() => ready({ ...plan, minFeeBps: 0 }, approvalFor(plan)), { code: 'FEE_OUT_OF_RANGE' });
  assert.throws(() => ready({ ...plan, minFeeBps: 401 }, approvalFor(plan)), { code: 'FEE_OUT_OF_RANGE' });
});

test('post-deploy verification reports every field that does not match the plan', () => {
  const plan = mainnetPlan();
  assert.deepEqual(verifyDeployment(plan, { treasury: TREASURY, startMcapUsd: 20_000, metadataRequired: true, recipients: RECIPIENTS, minFeeBps: 100 }), [], 'a faithful deployment has no mismatches');

  const mismatches = verifyDeployment(plan, { treasury: '0x' + '99'.repeat(20), startMcapUsd: 50, recipients: [RECIPIENTS[2], RECIPIENTS[1], RECIPIENTS[0]], minFeeBps: 400 });
  const fields = mismatches.map(m => m.field).sort();
  assert.deepEqual(fields, ['minFeeBps', 'recipient[0]', 'recipient[2]', 'startMcapUsd', 'treasury']);
});

test('a deployment record keeps the plan it was built from', () => {
  const plan = mainnetPlan();
  const record = deploymentRecord(plan, { factory: '0xf', hook: '0xh', router: '0xr', blockNumber: 12, transactions: ['0x1'] });
  assert.equal(record.plan.planHash, plan.planHash);
  assert.equal(record.deployment.blockNumber, 12);
  assert.equal(record.plan.startMcapUsd, 20_000);
});
