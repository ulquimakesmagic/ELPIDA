// The gate in front of a V2 mainnet deployment.
//
// The operator panel deliberately refuses mainnet (apps/web/v2-launchpad.mjs). A mainnet release therefore needs its
// own path, and the expensive mistakes are not in the deploy mechanics: they are deploying at the test-sized $50
// starting market cap, deploying without a recorded approval, or deploying with a treasury that is one person's key.
// Those three checks live here, as pure functions, so they are testable without a chain or a wallet.
import { keccak256, toUtf8Bytes, ZeroAddress, getAddress, isAddress } from 'ethers';

export const MAINNET_START_MCAP_USD = 20_000;
export const TESTNET_START_MCAP_USD = 50;
/** An approval older than this is treated as stale: the code it approved may have moved since. */
export const APPROVAL_MAX_AGE_DAYS = 14;

const canonical = value => {
  // Stable serialisation: same plan, same hash, whatever the key order.
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};

/**
 * The deployment plan: everything a reviewer must see before a chain is touched. `planHash` is what an approval
 * signs, so a plan cannot be edited after approval without invalidating it.
 */
export function buildPlan({ chainId, chainName, mainnet, treasury, recipients, minFeeBps, metadataRequired = true, approver = null, approvedAt = null }) {
  if (!Number.isInteger(chainId) || chainId <= 0) throw Object.assign(new Error('chain id'), { code: 'CHAIN_MISSING' });
  if (!isAddress(treasury ?? '')) throw Object.assign(new Error('treasury'), { code: 'TREASURY_MISSING' });
  const startMcapUsd = mainnet ? MAINNET_START_MCAP_USD : TESTNET_START_MCAP_USD;
  const body = {
    chainId,
    network: chainName ?? String(chainId),
    mainnet: Boolean(mainnet),
    startMcapUsd,
    treasury: getAddress(treasury),
    recipients: (recipients ?? []).map(r => (r ? getAddress(r) : ZeroAddress)),
    minFeeBps: Number(minFeeBps),
    metadataRequired: Boolean(metadataRequired),
    approver: approver ?? null,
    approvedAt: approvedAt ?? null,
  };
  return { ...body, planHash: keccak256(toUtf8Bytes(canonical(body))) };
}

const refuse = (code, message) => { throw Object.assign(new Error(message), { code }); };

/**
 * Refuses unless this exact plan was approved, recently, by a named approver, with a treasury that is a contract.
 * `treasuryIsContract` is supplied by the caller (an eth_getCode check) so this stays pure.
 */
export function assertReady(plan, approval, { treasuryIsContract = false, now = Date.now() } = {}) {
  if (plan.mainnet && plan.startMcapUsd !== MAINNET_START_MCAP_USD) {
    refuse('START_MCAP_WRONG', `A mainnet V2 deployment starts at $${MAINNET_START_MCAP_USD}, not $${plan.startMcapUsd}.`);
  }
  if (plan.recipients.length !== 3 || plan.recipients.some(r => r === ZeroAddress)) {
    refuse('RECIPIENTS_UNSET', 'The three recipient vaults must be set before any deployment.');
  }
  if (!(plan.minFeeBps >= 1 && plan.minFeeBps <= 400)) {
    refuse('FEE_OUT_OF_RANGE', `minFeeBps must be 1..400, got ${plan.minFeeBps}.`);
  }
  if (plan.mainnet && !treasuryIsContract) {
    refuse('TREASURY_NOT_MULTISIG', 'The treasury must be a contract (a multisig), not an externally owned account.');
  }
  if (!approval || typeof approval !== 'object') refuse('APPROVAL_MISSING', 'No approval artefact was supplied.');
  if (approval.planHash !== plan.planHash) {
    refuse('APPROVAL_MISMATCH', 'The approval signs a different plan. Re-approve the plan you are deploying.');
  }
  if (!approval.approver || String(approval.approver).trim().length < 2) refuse('APPROVAL_UNSIGNED', 'The approval names no approver.');
  const approvedAt = Number(approval.approvedAt ?? 0);
  if (!Number.isFinite(approvedAt) || approvedAt <= 0) refuse('APPROVAL_UNSIGNED', 'The approval has no timestamp.');
  const ageDays = (now - approvedAt) / 86_400_000;
  if (ageDays > APPROVAL_MAX_AGE_DAYS) {
    refuse('APPROVAL_STALE', `The approval is ${Math.floor(ageDays)} days old; re-approve before deploying.`);
  }
  return true;
}

/**
 * Compares what the chain reports to what the plan promised. `read` returns the on-chain values; anything that does
 * not match is a mismatch, and a deployment with mismatches must not be recorded as complete.
 */
export function verifyDeployment(plan, read) {
  const mismatches = [];
  const expect = (label, actual, wanted) => {
    if (String(actual).toLowerCase() !== String(wanted).toLowerCase()) mismatches.push({ field: label, expected: wanted, actual });
  };
  if (read.treasury !== undefined) expect('treasury', read.treasury, plan.treasury);
  if (read.startMcapUsd !== undefined) expect('startMcapUsd', Number(read.startMcapUsd), plan.startMcapUsd);
  if (read.metadataRequired !== undefined) expect('metadataRequired', Boolean(read.metadataRequired), plan.metadataRequired);
  for (const [i, recipient] of plan.recipients.entries()) {
    if (read.recipients?.[i] !== undefined) expect(`recipient[${i}]`, read.recipients[i], recipient);
  }
  if (read.minFeeBps !== undefined) expect('minFeeBps', Number(read.minFeeBps), plan.minFeeBps);
  return mismatches;
}

/** The record written after a deployment: addresses, transactions and the plan they were built from. */
export function deploymentRecord(plan, { factory, hook, router, blockNumber, transactions = [] }) {
  return {
    recordedAt: new Date().toISOString(),
    plan,
    deployment: { factory, hook, router, blockNumber, transactions },
  };
}
