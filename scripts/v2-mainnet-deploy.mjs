#!/usr/bin/env node
// ELPIDA V2 mainnet deployment (audit DEP-01, 11 November 2026; docs/V2_MAINNET_DEPLOY.md). The only path that deploys
// V2 with real funds. It refuses to run unless:
//  - the plan (deployments/plans/<key>.json) passes every on-chain preflight check: the treasury is a Safe with at least
//    two owners and a threshold of two, the keeper is a plain wallet distinct from the treasury, guardian and deployer,
//    the PoolManager, the ETH/USD feed and USDC are what they claim, the start is $20,000 and a daily launch cap is set;
//  - an approval file for exactly that plan (its SHA-256) is merged in deployments/approvals/ (Malik's sign-off).
//
//   node scripts/v2-mainnet-deploy.mjs check    --plan deployments/plans/base-mainnet.json
//   node scripts/v2-mainnet-deploy.mjs rehearse --plan deployments/plans/base-mainnet.json [--fork <rpc url>]
//   node scripts/v2-mainnet-deploy.mjs deploy   --plan deployments/plans/base-mainnet.json
//   node scripts/v2-mainnet-deploy.mjs verify   --plan deployments/plans/base-mainnet.json
//
// `deploy` needs ELPIDA_MAINNET_RPC_URL and asks for the deployer key with a hidden prompt (or reads
// ELPIDA_MAINNET_DEPLOYER_KEY): a fresh wallet holding only gas; never
// printed). It deploys the contracts, checks every constructor argument by reading it back, writes the deployment record
// (deployments/<key>.json, resumable) and the Safe batch (deployments/<key>-safe-batch.json) for the treasury-only
// wiring. After the Safe executes that batch, `verify` checks the wiring and marks the record ready.
// `rehearse` runs the whole sequence on a local chain (mock PoolManager, feed, USDC and Safe), or on a fork of the real
// network with --fork, without any key: the Safe's batch is sent by impersonation.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { AbiCoder, Contract, ContractFactory, Interface, JsonRpcProvider, Wallet, ZeroAddress, concat, getAddress, getBytes, isAddress, keccak256, toBeHex, zeroPadValue, formatEther, parseEther } from 'ethers';
import { compileV4, uniswapV4Artifact } from './compile-v4.mjs';
import { V4_HOOK_FLAGS, V4_FLAG_MASK } from '../packages/core/v4-model.mjs';
// One set of rules (#234): the start cap, the approval's age limit and the plan-versus-chain comparison come from the gate.
import { MAINNET_START_MCAP_USD, APPROVAL_MAX_AGE_DAYS, buildPlan, verifyDeployment as gateVerify, deploymentRecord } from '../packages/core/v2-deploy-gate.mjs';

/** A CREATE2 salt that gives the hook an address whose low bits are its Uniswap v4 permissions (as the panel does). */
export function mineHookSalt(deployer, initCode, maxTries = 4_000_000) {
  const buf = new Uint8Array(85); buf.set(getBytes(concat(['0xff', deployer])), 0); buf.set(getBytes(keccak256(initCode)), 53);
  for (let i = 0; i < maxTries; i++) {
    const salt = zeroPadValue(toBeHex(i), 32); buf.set(getBytes(salt), 21);
    const address = BigInt('0x' + keccak256(buf).slice(26));
    if ((address & V4_FLAG_MASK) === V4_HOOK_FLAGS) return { salt, address: getAddress('0x' + address.toString(16).padStart(40, '0')) };
  }
  throw new Error('No hook address found. Nothing was deployed for the hook.');
}

const root = fileURLToPath(new URL('../', import.meta.url));
export { MAINNET_START_MCAP_USD };
export const APPROVAL_STATEMENT = 'I approve deploying exactly this plan to mainnet with real funds.';
const DAY = 86_400, Z = ZeroAddress;

const SAFE = ['function getThreshold() view returns(uint256)', 'function getOwners() view returns(address[])'];
const FEED = ['function decimals() view returns(uint8)', 'function description() view returns(string)', 'function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)'];
const ERC20 = ['function decimals() view returns(uint8)', 'function symbol() view returns(string)'];
const FACTORY_READ = ['function treasury() view returns(address)', 'function startMcapUsd() view returns(uint256)', 'function requiresMetadata() view returns(bool)', 'function hook() view returns(address)', 'function usdFeed() view returns(address)',
  'function approvedQuotes(address) view returns(uint256)', 'function guardian() view returns(address)', 'function dailyLaunchCap() view returns(uint256)', 'function launchesPaused() view returns(bool)', 'function nativeVirtualQuote() view returns(uint256)', 'function LAUNCH_CONTROLS_VERSION() view returns(uint256)'];
const FACTORY_WRITE = ['function setHook(address)', 'function configureUsdPricing(address,uint256,address)', 'function approveQuote(address,uint256)', 'function setGuardian(address)', 'function setDailyLaunchCap(uint256)'];
const HOOK_READ = ['function factory() view returns(address)', 'function protocolTreasury() view returns(address)', 'function traderAirdropVault() view returns(address)', 'function flywheelVault() view returns(address)', 'function holderRewardVault() view returns(address)', 'function minFeeBps() view returns(uint256)', 'function poolManager() view returns(address)'];
const DIST_READ = ['function operator() view returns(address)', 'function period() view returns(uint256)', 'function genesis() view returns(uint256)', 'function convertible() view returns(address)'];
const FLYWHEEL_READ = ['function operator() view returns(address)', 'function factory() view returns(address)', 'function router() view returns(address)'];
const ROUTER_READ = ['function hook() view returns(address)', 'function poolManager() view returns(address)'];

/** SHA-256 of the plan file's bytes: what an approval signs off. */
export const planHash = text => createHash('sha256').update(text).digest('hex');

/** `local`: a rehearsal on a local chain fills the wallets and mocks itself, so they may still be blank. */
export function readPlan(path, { local = false } = {}) {
  const text = readFileSync(path, 'utf8'), plan = JSON.parse(text);
  const required = ['key', 'name', 'chainId', 'treasury', 'keeper', 'guardian', 'poolManager', 'usdFeed', 'usdc', 'feedMaxAge', 'minFeeBps', 'dailyLaunchCap', 'startMcapUsd'];
  for (const k of local ? required.filter(k => !['treasury', 'keeper', 'guardian', 'poolManager', 'usdFeed', 'usdc'].includes(k)) : required)
    if (plan[k] === undefined || plan[k] === null || plan[k] === '') throw new Error(`The plan has no ${k}. Fill it in before anything runs.`);
  if (!/^[a-z0-9-]+$/.test(plan.key)) throw new Error('The plan key must be lowercase letters, digits and dashes.');
  return { plan, text, hash: planHash(text) };
}

/** The approval for this exact plan, or an error saying what is missing. */
export function approvalFor(key, hash, dir = join(root, 'deployments', 'approvals'), now = Date.now()) {
  const file = join(dir, `${key}-${hash.slice(0, 16)}.json`);
  if (!existsSync(file)) throw new Error(`No approval for this plan. Malik merges ${join('deployments/approvals', basename(file))} with {"planSha256":"${hash}","approvedBy":"…","date":"YYYY-MM-DD","statement":"${APPROVAL_STATEMENT}"}. Nothing was deployed.`);
  const a = JSON.parse(readFileSync(file, 'utf8'));
  if (a.planSha256 !== hash) throw new Error('The approval names a different plan. Nothing was deployed.');
  if (!a.approvedBy || !/^\d{4}-\d{2}-\d{2}$/.test(a.date ?? '') || a.statement !== APPROVAL_STATEMENT) throw new Error('The approval is incomplete (approvedBy, date and the exact statement). Nothing was deployed.');
  const ageDays = (now - Date.parse(`${a.date}T00:00:00Z`)) / 86_400_000;
  if (!(ageDays >= -1 && ageDays <= APPROVAL_MAX_AGE_DAYS)) throw new Error(`The approval is dated ${a.date}: older than ${APPROVAL_MAX_AGE_DAYS} days (or in the future). Re-approve before deploying. Nothing was deployed.`);
  return { ...a, file };
}

/**
 * Every check that must pass before anything is sent. Returns [{ check, ok, detail }]; `failed` lists the failures.
 * `deployer` is optional (`check` runs without a key).
 */
export async function preflight({ provider, plan, deployer = null }) {
  const native = nativeSymbol(plan);
  const out = [], add = (check, ok, detail = '') => out.push({ check, ok: !!ok, detail });
  const code = async a => (await provider.getCode(a)) !== '0x';
  const net = await provider.getNetwork();
  add('network', Number(net.chainId) === Number(plan.chainId), `chain ${net.chainId}, plan ${plan.chainId}`);
  add('start market cap $20,000', Number(plan.startMcapUsd) === MAINNET_START_MCAP_USD, `${plan.startMcapUsd}`);
  add('minimum fee 0.01–1.25%', Number.isInteger(plan.minFeeBps) && plan.minFeeBps >= 1 && plan.minFeeBps <= 125, `${plan.minFeeBps} bps`);
  add('daily launch cap set', Number.isInteger(plan.dailyLaunchCap) && plan.dailyLaunchCap > 0, `${plan.dailyLaunchCap}`);
  const addrs = { treasury: plan.treasury, keeper: plan.keeper, guardian: plan.guardian, poolManager: plan.poolManager, usdFeed: plan.usdFeed, usdc: plan.usdc };
  for (const [k, v] of Object.entries(addrs)) add(`${k} is an address`, isAddress(v), String(v));
  if (out.some(c => !c.ok)) return Object.assign(out, { failed: out.filter(c => !c.ok) });
  const roles = [plan.treasury, plan.keeper, plan.guardian, deployer].filter(Boolean).map(a => a.toLowerCase());
  add('treasury, keeper, guardian and deployer are four different wallets', new Set(roles).size === roles.length);
  // Treasury: a Safe with at least two owners and a threshold of at least two.
  let threshold = 0n, owners = [];
  try { const safe = new Contract(plan.treasury, SAFE, provider); [threshold, owners] = await Promise.all([safe.getThreshold(), safe.getOwners()]); } catch { /* not a Safe */ }
  add('treasury is a Safe, 2-of-N or stricter', await code(plan.treasury) && threshold >= BigInt(plan.minSafeThreshold ?? 2) && owners.length >= Number(threshold), `threshold ${threshold}, owners ${owners.length}`);
  add('keeper is a plain wallet', !await code(plan.keeper));
  add('Uniswap v4 PoolManager has code', await code(plan.poolManager));
  try {
    const feed = new Contract(plan.usdFeed, FEED, provider), [decimals, round] = await Promise.all([feed.decimals(), feed.latestRoundData()]);
    let description = ''; try { description = await feed.description(); } catch { /* optional */ }
    const block = await provider.getBlock('latest'), age = block.timestamp - Number(round[3]);
    add(`${native}/USD feed answers fresh`, round[1] > 0n && age >= 0 && age <= Number(plan.feedMaxAge), `${Number(round[1]) / 10 ** Number(decimals)} USD, ${age} s old${description ? `, "${description}"` : ''}`);
    add(`${native}/USD feed is ${native} / USD`, !description || new RegExp(`^\\s*${native}\\s*/\\s*USD\\s*$`, 'i').test(description), description);
  } catch (e) { add(`${native}/USD feed answers fresh`, false, e.shortMessage ?? e.message); }
  // USDC: 6 decimals on Base and Ethereum, 18 on BNB Chain (13 November). The plan states which; the chain must agree.
  const wantDecimals = usdcDecimals(plan);
  try { const u = new Contract(plan.usdc, ERC20, provider); add(`USDC has ${wantDecimals} decimals`, Number(await u.decimals()) === wantDecimals, await u.symbol().catch(() => '')); } catch (e) { add(`USDC has ${wantDecimals} decimals`, false, e.shortMessage ?? e.message); }
  if (deployer) { const bal = await provider.getBalance(deployer); add('deployer holds gas', bal >= parseEther(String(plan.minDeployerBalance ?? '0.01')), `${formatEther(bal)}`); }
  return Object.assign(out, { failed: out.filter(c => !c.ok) });
}

/** Contract bytecode from the pinned build (scripts/compile-v4.mjs, solc 0.8.26, cancun, via IR). */
export function artifacts() {
  const out = compileV4(), find = n => Object.values(out).find(e => e[n]?.evm?.bytecode?.object)?.[n];
  const pick = n => { const a = find(n); return { abi: a.abi, bytecode: '0x' + a.evm.bytecode.object.replace(/^0x/, '') }; };
  return { create2: pick('ElpidaCreate2Deployer'), factory: pick('ElpidaV2Factory'), hook: pick('ElpidaV2Hook'), distributor: pick('ElpidaV2Distributor'), flywheel: pick('ElpidaV2FlywheelVault'), router: pick('ElpidaV4Router'), compiler: 'solc 0.8.26 (cancun, via IR, 200 runs)' };
}

const saveJson = (path, value) => { writeFileSync(path + '.tmp', JSON.stringify(value, null, 2) + '\n'); renameSync(path + '.tmp', path); };
const gitCommit = () => { try { return execSync('git rev-parse HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; } };

/**
 * Deploys the plan with `signer` (the deployer). Resumable: every finished step is written to `recordPath` and reused
 * if its contract is on chain. Returns the record (status 'awaiting_safe') and writes the Safe batch beside it.
 */
export async function deployPlan({ provider, signer, plan, hash, approval, recordPath, art = artifacts(), log = () => {} }) {
  const record = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) : { network: plan.key, name: plan.name, chainId: plan.chainId, planSha256: hash, approval: approval ? basename(approval.file) : null, model: 'v2-hook', compiler: art.compiler, gitCommit: gitCommit(), startMcapUsd: MAINNET_START_MCAP_USD, contracts: {}, txs: {} };
  if (record.planSha256 !== hash) throw new Error(`${recordPath} belongs to another plan. Nothing was deployed.`);
  const save = () => saveJson(recordPath, record);
  const have = async k => record.contracts[k] && (await provider.getCode(record.contracts[k])) !== '0x';
  const deployer = await signer.getAddress();
  record.deployer = deployer;
  const deploy = async (k, a, args) => {
    if (await have(k)) return;
    log(`deploying ${k}…`);
    const c = await new ContractFactory(a.abi, a.bytecode, signer).deploy(...args); const tx = c.deploymentTransaction(); const r = await tx.wait(plan.confirmations ?? 2);
    record.contracts[k] = await c.getAddress(); record.txs[k] = { hash: tx.hash, block: r.blockNumber }; if (k === 'factory') record.block = r.blockNumber; save();
  };
  const t = (await provider.getBlock('latest')).timestamp, d = new Date(t * 1000);
  const month = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000, today = t - (t % DAY);
  await deploy('create2', art.create2, []);
  await deploy('factory', art.factory, [plan.treasury, MAINNET_START_MCAP_USD, true]);
  // The airdrop (monthly) and holder (weekly) distributors and the flywheel vault, operated by the keeper. In the first
  // release the keeper does not run their jobs: the shares accrue (docs/AUDIT_TRIAGE_2026-11-11.md).
  await deploy('airdrop', art.distributor, [plan.keeper, 0, record.airdropGenesis ??= month, 'trader-airdrop', Z, Z, Z]);
  await deploy('holder', art.distributor, [plan.keeper, 7 * DAY, record.holderGenesis ??= today, 'holder-rewards', Z, Z, Z]);
  await deploy('flywheel', art.flywheel, [plan.keeper, record.contracts.factory]);
  if (!await have('hook')) {
    const args = AbiCoder.defaultAbiCoder().encode(['address', 'address', 'address', 'address', 'address', 'address', 'uint256'], [plan.poolManager, record.contracts.factory, plan.treasury, record.contracts.airdrop, record.contracts.flywheel, record.contracts.holder, plan.minFeeBps]);
    const initCode = concat([art.hook.bytecode, args]);
    log('mining the hook address…');
    const { salt, address } = await mineHookSalt(record.contracts.create2, initCode);
    if ((await provider.getCode(address)) === '0x') {
      const tx = await new Contract(record.contracts.create2, ['function deploy(bytes,bytes32) returns(address)'], signer).deploy(initCode, salt); const r = await tx.wait(plan.confirmations ?? 2);
      record.txs.hook = { hash: tx.hash, block: r.blockNumber };
    }
    record.contracts.hook = address; record.hookSalt = salt; save();
  }
  await deploy('router', art.router, [plan.poolManager, record.contracts.hook]);
  // Read every constructor argument back before handing over to the Safe: this script's checks, then #234's gate
  // comparison of the deployed factory and hook against a gate plan built from what was deployed.
  const checks = await constructorChecks({ provider, plan, record });
  const gatePlan = buildPlan({ chainId: Number(plan.chainId), chainName: plan.name, mainnet: true, treasury: plan.treasury, recipients: [record.contracts.airdrop, record.contracts.flywheel, record.contracts.holder], minFeeBps: plan.minFeeBps, metadataRequired: true, approver: approval?.approvedBy ?? null, approvedAt: approval ? Date.parse(`${approval.date}T00:00:00Z`) : null });
  const f = new Contract(record.contracts.factory, FACTORY_READ, provider), h = new Contract(record.contracts.hook, HOOK_READ, provider);
  const mismatches = gateVerify(gatePlan, { treasury: await f.treasury(), startMcapUsd: await f.startMcapUsd(), metadataRequired: await f.requiresMetadata(), recipients: [await h.traderAirdropVault(), await h.flywheelVault(), await h.holderRewardVault()], minFeeBps: await h.minFeeBps() });
  checks.push({ check: 'gate (#234) verifyDeployment: no mismatches', ok: mismatches.length === 0, detail: mismatches.map(m => m.field).join(', ') });
  record.gate = deploymentRecord(gatePlan, { factory: record.contracts.factory, hook: record.contracts.hook, router: record.contracts.router, blockNumber: record.block, transactions: Object.values(record.txs).map(t => t.hash) });
  record.constructorChecks = checks; save();
  if (checks.some(c => !c.ok)) throw new Error(`Deployed, but a constructor check failed: ${checks.filter(c => !c.ok).map(c => c.check).join('; ')}. Do not execute the Safe batch.`);
  record.safeBatch = basename(safeBatchPath(recordPath)); record.status = 'awaiting_safe';
  record.pending = { safe: 'Execute the Safe batch (setHook, configureUsdPricing, approveQuote USDC, setGuardian, setDailyLaunchCap), then run verify.', keeper: 'flywheel.setRouter(router) from the keeper, before the flywheel is switched on (it stays off in the first release).' };
  save(); saveJson(safeBatchPath(recordPath), safeBatch(plan, record));
  return record;
}

/** The chain's native coin for the price-feed check: ETH on Base and Ethereum, BNB on BNB Chain. */
export const nativeSymbol = plan => { const s = String(plan.nativeSymbol ?? 'ETH').toUpperCase(); if (!/^[A-Z]{2,6}$/.test(s)) throw new Error('nativeSymbol: 2 to 6 letters'); return s; };
/** USDC's decimals on the plan's chain: 6 unless the plan says otherwise (BNB Chain: 18). */
export const usdcDecimals = plan => { const d = Number(plan.usdcDecimals ?? 6); if (!Number.isInteger(d) || d < 6 || d > 18) throw new Error('usdcDecimals must be 6 to 18'); return d; };
/** The USDC pair's virtual quote: $20,000 × 5/4 = $25,000 of USDC in its own units. */
export const usdcVirtualQuote = plan => BigInt(MAINNET_START_MCAP_USD) * 5n / 4n * 10n ** BigInt(usdcDecimals(plan));

export const safeBatchPath = recordPath => recordPath.replace(/\.json$/, '-safe-batch.json');

/** Reads every constructor argument back from the chain. */
export async function constructorChecks({ provider, plan, record }) {
  const c = record.contracts, out = [], eq = (check, a, b) => out.push({ check, ok: String(a).toLowerCase() === String(b).toLowerCase(), detail: `${a}` });
  const f = new Contract(c.factory, FACTORY_READ, provider), h = new Contract(c.hook, HOOK_READ, provider), r = new Contract(c.router, ROUTER_READ, provider), fw = new Contract(c.flywheel, FLYWHEEL_READ, provider);
  eq('factory treasury', await f.treasury(), plan.treasury); eq('factory start $20,000', await f.startMcapUsd(), MAINNET_START_MCAP_USD); eq('factory requires metadata', await f.requiresMetadata(), true);
  eq('factory has launch controls', await f.LAUNCH_CONTROLS_VERSION(), 1);
  eq('hook factory', await h.factory(), c.factory); eq('hook treasury', await h.protocolTreasury(), plan.treasury); eq('hook PoolManager', await h.poolManager(), plan.poolManager);
  eq('hook airdrop vault', await h.traderAirdropVault(), c.airdrop); eq('hook flywheel vault', await h.flywheelVault(), c.flywheel); eq('hook holder vault', await h.holderRewardVault(), c.holder); eq('hook minimum fee', await h.minFeeBps(), plan.minFeeBps);
  for (const [k, period] of [['airdrop', 0], ['holder', 7 * DAY]]) { const d = new Contract(c[k], DIST_READ, provider); eq(`${k} operator is the keeper`, await d.operator(), plan.keeper); eq(`${k} period`, await d.period(), period); }
  eq('flywheel operator is the keeper', await fw.operator(), plan.keeper); eq('flywheel factory', await fw.factory(), c.factory);
  eq('router hook', await r.hook(), c.hook); eq('router PoolManager', await r.poolManager(), plan.poolManager);
  return out;
}

/** The treasury-only wiring as a Safe Transaction Builder batch (Safe app → Transaction Builder → load JSON). */
export function safeBatch(plan, record) {
  const i = new Interface(FACTORY_WRITE), f = record.contracts.factory;
  const usdcVirtual = usdcVirtualQuote(plan);
  const calls = [['setHook', [record.contracts.hook]], ['configureUsdPricing', [plan.usdFeed, plan.feedMaxAge, plan.usdc]], ['approveQuote', [plan.usdc, usdcVirtual]], ['setGuardian', [plan.guardian]], ['setDailyLaunchCap', [plan.dailyLaunchCap]]];
  return { version: '1.0', chainId: String(plan.chainId), createdAt: Date.now(), meta: { name: `ELPIDA V2 ${plan.name} wiring`, description: `Plan ${record.planSha256.slice(0, 16)}: connect the hook, set USD pricing, approve USDC ($25,000 virtual quote), name the guardian, cap launches at ${plan.dailyLaunchCap} a day.`, txBuilderVersion: '1.16.5', createdFromSafeAddress: plan.treasury },
    transactions: calls.map(([name, args]) => ({ to: f, value: '0', data: i.encodeFunctionData(name, args), contractMethod: null, contractInputsValues: null, description: `${name}(${args.join(', ')})` })) };
}

/** After the Safe batch: checks the wiring on chain and marks the record ready. */
export async function verifyDeployment({ provider, plan, record, recordPath }) {
  const c = record.contracts, f = new Contract(c.factory, FACTORY_READ, provider), out = [], eq = (check, a, b) => out.push({ check, ok: String(a).toLowerCase() === String(b).toLowerCase(), detail: `${a}` });
  eq('factory hook', await f.hook(), c.hook); eq('USD feed', await f.usdFeed(), plan.usdFeed);
  eq('USDC approved at $25,000 virtual', await f.approvedQuotes(plan.usdc), usdcVirtualQuote(plan));
  eq('guardian', await f.guardian(), plan.guardian); eq('daily launch cap', await f.dailyLaunchCap(), plan.dailyLaunchCap); eq('launches paused', await f.launchesPaused(), false);
  let vq = 0n; try { vq = await f.nativeVirtualQuote(); } catch { /* feed */ }
  out.push({ check: 'native start price readable', ok: vq > 0n, detail: `${formatEther(vq)} native = $25,000 virtual` });
  const flyRouter = await new Contract(c.flywheel, FLYWHEEL_READ, provider).router();
  out.push({ check: 'flywheel router (keeper, before the flywheel is switched on)', ok: true, detail: flyRouter === Z ? 'not set yet (flywheel off in the first release)' : flyRouter });
  record.verify = { at: new Date().toISOString(), checks: out };
  if (out.every(x => x.ok)) record.status = 'ready';
  if (recordPath) saveJson(recordPath, record);
  return out;
}

/**
 * The whole sequence on a local chain (mocks) or on a fork of the real network, without keys: deploy, send the Safe
 * batch by impersonation, verify, then launch a token and check it starts at $20,000 and that the guardian can stop
 * new launches. Returns { record, checks, launch }.
 */
export async function rehearse({ plan: given, fork = null, log = () => {}, recordPath, stocks = [], findHolder = null }) {
  const { network } = await import('hardhat');
  const { BrowserProvider } = await import('ethers');
  const connection = await network.create(fork ? { network: 'localCancun', override: { forking: { url: fork, enabled: true } } } : 'localCancun');
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 10;
  try {
    const signers = await Promise.all([0, 1, 2, 3, 4].map(i => provider.getSigner(i))), addrs = await Promise.all(signers.map(s => s.getAddress()));
    const art = artifacts(), plan = { ...given, confirmations: 1 };
    const deployMock = async (name, args) => { const a = name === 'PoolManager' ? uniswapV4Artifact('PoolManager') : Object.values(compileV4({ includeMocks: true })).find(e => e[name]?.evm?.bytecode?.object)[name]; const c = await new ContractFactory(a.abi, a.bytecode ?? a.evm.bytecode.object, signers[0]).deploy(...args); await c.waitForDeployment(); return c.getAddress(); };
    if (!fork) {
      const safe = await deployMock('MockSafe', [[addrs[1], addrs[2]], 2]);
      Object.assign(plan, { chainId: Number((await provider.getNetwork()).chainId), treasury: safe, keeper: addrs[3], guardian: addrs[4], poolManager: await deployMock('PoolManager', [addrs[0]]), usdFeed: await deployMock('MockUsdFeed', [2500n * 10n ** 8n]), usdc: await deployMock('MockUSDC', []) });
      if (usdcDecimals(plan) !== 6) await (await new Contract(plan.usdc, ['function setDecimals(uint8)'], signers[0]).setDecimals(usdcDecimals(plan))).wait();
      if (nativeSymbol(plan) !== 'ETH') await (await new Contract(plan.usdFeed, ['function setDescription(string)'], signers[0]).setDescription(`${nativeSymbol(plan)} / USD`)).wait();
      // Local stand-ins for `{ mock: true, price }` stocks (tests): an issuer-controlled stock and its feed, held by signer 1.
      for (const s of stocks.filter(x => x.mock)) {
        s.address = await deployMock('MockIssuerStock', []); s.feed = await deployMock('MockUsdFeed', [BigInt(Math.round(s.price * 1e8))]); s.holder = addrs[1]; s.symbol = 'mSTK';
        await (await new Contract(s.address, ['function mint(address,uint256)'], signers[0]).mint(addrs[1], 10n ** 24n)).wait();
        await (await new Contract(s.feed, ['function setDescription(string)'], signers[0]).setDescription('mSTK / USD')).wait();
      }
    }
    const checks = await preflight({ provider, plan, deployer: addrs[0] });
    if (checks.failed.length) throw new Error(`Preflight failed: ${checks.failed.map(c => `${c.check} (${c.detail})`).join('; ')}`);
    const record = await deployPlan({ provider, signer: signers[0], plan, hash: planHash(JSON.stringify(plan)), approval: null, recordPath, art, log });
    // The Safe's batch, sent by impersonating the treasury.
    await provider.send('hardhat_impersonateAccount', [plan.treasury]); await provider.send('hardhat_setBalance', [plan.treasury, '0x' + (10n ** 18n).toString(16)]);
    for (const tx of safeBatch(plan, record).transactions) { const hash = await provider.send('eth_sendTransaction', [{ from: plan.treasury, to: tx.to, data: tx.data }]); await provider.waitForTransaction(hash); }
    const verified = await verifyDeployment({ provider, plan, record, recordPath });
    if (verified.some(c => !c.ok)) throw new Error(`Verify failed: ${verified.filter(c => !c.ok).map(c => c.check).join('; ')}`);
    // A real launch: $10 fee, no first buy; the pool must start at the $20,000 market cap at the feed's price.
    const factory = new Contract(record.contracts.factory, art.factory.abi, signers[0]);
    const fee = await factory.nativeUsdAmount(10), receipt = await (await factory.launch('Rehearsal', 'REHEARSE', Z, 125, 0n, 0n, addrs[0], 'ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy', false, { value: fee })).wait();
    const launched = receipt.logs.map(l => { try { return factory.interface.parseLog(l); } catch { return null; } }).find(e => e?.name === 'Launched');
    const hook = new Contract(record.contracts.hook, art.hook.abi, provider), info = await hook.launchOf(launched.args.token);
    const [, answer] = await new Contract(plan.usdFeed, FEED, provider).latestRoundData(), feedDecimals = Number(await new Contract(plan.usdFeed, FEED, provider).decimals());
    const ethUsd = Number(answer) / 10 ** feedDecimals, sqrtLower = 1.0001 ** (Number(info.upperTick) / 2), priceTokensPerEth = sqrtLower ** 2;
    const startMcap = 1e9 / priceTokensPerEth * ethUsd;
    // Real tokenized stocks on a fork (Malik, 13 November: Ondo stocks on mainnet): each one approved by the treasury,
    // launched against, bought and sold through the router, so the pool and the router are shown to hold and move it.
    const stockResults = [];
    for (const s of stocks) stockResults.push(await rehearseStock({ provider, signer: signers[0], plan, record, art, stock: s, findHolder, log }));
    // The guardian can stop new launches.
    await (await new Contract(record.contracts.factory, ['function pauseLaunches()'], signers.find((_, i) => addrs[i] === plan.guardian) ?? signers[4]).pauseLaunches()).wait();
    const paused = await new Contract(record.contracts.factory, FACTORY_READ, provider).launchesPaused();
    return { record, checks, verified, launch: { token: launched.args.token, startMcapUsd: startMcap }, stocks: stockResults, guardianPaused: paused };
  } finally { provider.destroy(); await connection.close(); }
}

/**
 * The deployer key from whatever was pasted: terminals such as VS Code's wrap a paste in invisible bracketed-paste
 * markers, and a copy may carry spaces or a newline. Takes the one 64-hex key out of it, or explains what is wrong
 * without ever printing the input.
 */
const ERC20_RW = ['function balanceOf(address) view returns(uint256)', 'function transfer(address,uint256) returns(bool)', 'function approve(address,uint256) returns(bool)', 'function decimals() view returns(uint8)', 'function symbol() view returns(string)'];
const ROUTER_TRADE = ['function buy(address token,uint256 quoteIn,uint256 minTokensOut,address recipient,uint256 deadline) payable returns(uint256)', 'function sell(address token,uint256 tokensIn,uint256 minQuoteOut,address recipient,uint256 deadline) returns(uint256)'];

/**
 * One real stock on a fork: the treasury approves it priced by its feed, a launch pairs with it at the $20,000 start
 * (read back from the pool's starting tick at the feed's price), and a buy and a full sell move the stock through the
 * router and the v4 pool. The stock is funded by impersonating an existing holder on the fork only. Returns
 * { symbol, ok, startMcapUsd, bought, returned, error }.
 */
export async function rehearseStock({ provider, signer, plan, record, art, stock, findHolder, log = () => {} }) {
  const out = { symbol: stock.symbol, address: stock.address, feed: stock.feed, ok: false };
  try {
    const me = await signer.getAddress(), token = new Contract(stock.address, ERC20_RW, provider);
    if ((await token.symbol()) !== stock.symbol) throw new Error(`the token's symbol is not ${stock.symbol}`);
    const decimals = Number(await token.decimals()), unit = 10n ** BigInt(decimals);
    const [, answer] = await new Contract(stock.feed, FEED, provider).latestRoundData(), feedDecimals = Number(await new Contract(stock.feed, FEED, provider).decimals());
    const priceUsd = Number(answer) / 10 ** feedDecimals;
    // Approve as the Safe would: impersonating the treasury on the fork.
    await provider.send('hardhat_impersonateAccount', [plan.treasury]);
    const approve = new Interface(['function approvePricedQuote(address,address,uint256)']).encodeFunctionData('approvePricedQuote', [stock.address, stock.feed, stock.maxAge ?? 4 * DAY]);
    await provider.waitForTransaction(await provider.send('eth_sendTransaction', [{ from: plan.treasury, to: record.contracts.factory, data: approve }]));
    // About $300 of the stock from an existing holder (fork only).
    const want = BigInt(Math.ceil(300 / priceUsd * 1e6)) * unit / 1_000_000n;
    const holder = stock.holder ?? (findHolder ? await findHolder(stock.address, want) : null);
    if (!holder) throw new Error('no holder to fund the test (set ELPIDA_STOCK_HOLDER_<SYMBOL>)');
    await provider.send('hardhat_impersonateAccount', [holder]); await provider.send('hardhat_setBalance', [holder, '0x' + (10n ** 18n).toString(16)]);
    const data = new Interface(ERC20_RW).encodeFunctionData('transfer', [me, want]);
    await provider.waitForTransaction(await provider.send('eth_sendTransaction', [{ from: holder, to: stock.address, data }]));
    if ((await token.balanceOf(me)) < want) throw new Error('the holder transfer did not arrive (transfer restricted?)');
    // Launch paired with the stock: no first buy, $10 fee in the native coin.
    const factory = new Contract(record.contracts.factory, art.factory.abi, signer), fee = await factory.nativeUsdAmount(10);
    const receipt = await (await factory.launch(`Rehearsal ${stock.symbol}`, 'RSTK', stock.address, 125, 0n, 0n, me, 'ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy', false, { value: fee })).wait();
    const launched = receipt.logs.map(l => { try { return factory.interface.parseLog(l); } catch { return null; } }).find(e => e?.name === 'Launched');
    const info = await new Contract(record.contracts.hook, art.hook.abi, provider).launchOf(launched.args.token);
    const sqrtLower = 1.0001 ** (Number(info.upperTick) / 2), tokensPerQuoteRaw = sqrtLower ** 2;
    out.startMcapUsd = 1e9 * 1e18 / tokensPerQuoteRaw / Number(unit) * priceUsd;
    // Past the 60-second anti-snipe window, buy with half and sell everything back.
    await provider.send('evm_increaseTime', [61]); await provider.send('evm_mine', []);
    const router = new Contract(record.contracts.router, ROUTER_TRADE, signer), launchedToken = new Contract(launched.args.token, ERC20_RW, signer);
    const deadline = (await provider.getBlock('latest')).timestamp + 600, half = want / 2n, before = await token.balanceOf(me);
    await (await new Contract(stock.address, ERC20_RW, signer).approve(record.contracts.router, half)).wait();
    await (await router.buy(launched.args.token, half, 1n, me, deadline)).wait();
    out.bought = (await launchedToken.balanceOf(me)).toString();
    await (await launchedToken.approve(record.contracts.router, BigInt(out.bought))).wait();
    await (await router.sell(launched.args.token, BigInt(out.bought), 1n, me, deadline)).wait();
    out.returned = ((await token.balanceOf(me)) - (before - half)).toString();
    const back = Number(BigInt(out.returned) * 10_000n / half) / 100;
    out.ok = out.startMcapUsd >= 20_000 * 0.998 && out.startMcapUsd <= 20_000 * 1.003 && back > 95 && back < 100;
    out.detail = `starts at $${out.startMcapUsd.toFixed(0)}, a ${stock.symbol} buy and full sell returned ${back}% after both fees`;
    log(`${out.ok ? 'ok  ' : 'FAIL'} stock ${stock.symbol}: ${out.detail}`);
  } catch (e) { out.error = String(e.shortMessage ?? e.message).slice(0, 200); log(`FAIL stock ${stock.symbol}: ${out.error}`); }
  return out;
}

/** A holder of `address` with at least `want`, from a Blockscout explorer (read only; impersonated on the fork only). */
export const blockscoutHolder = (explorer, provider) => async (address, want) => {
  const r = await fetch(`${explorer.replace(/\/$/, '')}/api/v2/tokens/${address}/holders`, { signal: AbortSignal.timeout(30000), headers: { accept: 'application/json' } });
  if (!r.ok) return null;
  const token = new Contract(address, ERC20_RW, provider);
  for (const it of ((await r.json()).items ?? []).slice(0, 25)) { const a = it.address?.hash; if (a && !it.address?.is_contract && await token.balanceOf(a) >= want) return a; }
  return null;
};

export function deployerKey(input) {
  const text = String(input ?? '');
  // A recovery phrase (12–24 words) unlocks every account in the wallet, the Safe signer included. Refuse it at once,
  // never echo it, and say where the one-account private key is.
  const words = text.replace(/\x1b\[[0-9;]*[~A-Za-z]/g, ' ').trim().split(/\s+/).filter(w => /^[a-z]+$/i.test(w));
  if (words.length >= 12 && !/[0-9a-fA-F]{64}/.test(text)) throw new Error('That looks like a recovery phrase (words), not a private key. It was not used or stored. Never paste the recovery phrase: it controls every account in the wallet. Use the deployer account\'s private key instead: MetaMask → the Elpida Deployer account → ⋮ → Account details → Show private key (64 letters and numbers). If the phrase was pasted somewhere it could be seen, treat it as exposed. Nothing was deployed.');
  const found = text.match(/(?<![0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/g) ?? [];
  if (found.length !== 1) throw new Error(found.length ? 'More than one key-like value was pasted. Paste only the deployer key. Nothing was deployed.'
    : `That is not a private key (${text.replace(/\x1b\[[0-9;]*[~A-Za-z]/g, '').trim().length} characters; a key is 64 hexadecimal characters, optionally starting with 0x). Nothing was deployed.`);
  return '0x' + found[0].replace(/^0x/, '');
}

/** Reads one line from the terminal without echoing it. */
async function askHidden(prompt) {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) throw new Error('Run deploy in a terminal (it asks for the deployer key), or set ELPIDA_MAINNET_DEPLOYER_KEY.');
  stdout.write(prompt);
  return new Promise((resolve, reject) => {
    let buf = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const done = v => { stdin.setRawMode(false); stdin.pause(); stdin.off('data', on); stdout.write('\n'); v instanceof Error ? reject(v) : resolve(v); };
    const on = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(buf);
        if (ch === '\u0003') return done(new Error('Cancelled. Nothing was deployed.'));
        if (ch === '\u007f' || ch === '\b') { buf = buf.slice(0, -1); continue; }
        buf += ch;
      }
    };
    stdin.on('data', on);
  });
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2), arg = n => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : null; };
  const planPath = arg('plan'); if (!cmd || !planPath) { console.log('usage: node scripts/v2-mainnet-deploy.mjs check|rehearse|deploy|verify --plan deployments/plans/<key>.json [--fork <rpc>]'); process.exit(2); }
  const { plan, hash } = readPlan(planPath, { local: cmd === 'rehearse' && !arg('fork') }), recordPath = join(root, 'deployments', `${plan.key}.json`);
  const print = list => { for (const c of list) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.check}${c.detail ? `: ${c.detail}` : ''}`); };
  console.log(`plan ${plan.key} (${plan.name}), sha256 ${hash}`);
  if (cmd === 'rehearse') {
    // --stocks <config/stocks/candidates/….json>: also launch against each real stock on the fork (fork only).
    const stocksFile = arg('stocks'), stocks = stocksFile ? JSON.parse(readFileSync(stocksFile, 'utf8')).map(s => ({ ...s, holder: process.env[`ELPIDA_STOCK_HOLDER_${String(s.symbol).toUpperCase()}`] ?? null })) : [];
    if (stocks.length && !arg('fork')) throw new Error('--stocks needs --fork <rpc>: real stocks exist only on the real chain.');
    if (stocks.some(s => !s.holder) && !plan.explorerApi) throw new Error('The plan has no explorerApi (a Blockscout URL) to find stock holders; set ELPIDA_STOCK_HOLDER_<SYMBOL> per stock.');
    const r = await rehearse({ plan, fork: arg('fork'), log: m => console.log(m), recordPath: join(dirname(recordPath), `${plan.key}.rehearsal.json`), stocks,
      findHolder: plan.explorerApi ? (address, want) => blockscoutHolder(plan.explorerApi, new JsonRpcProvider(arg('fork'), undefined, { staticNetwork: true }))(address, want) : null });
    print(r.checks); print(r.verified);
    console.log(`rehearsal launch ${r.launch.token}: starts at $${r.launch.startMcapUsd.toFixed(2)}; guardian stop works: ${r.guardianPaused}`);
    if (r.stocks.length) {
      const evidence = { network: plan.key, chainId: plan.chainId, at: new Date().toISOString(), scope: 'LOCAL FORK ONLY: nothing was sent to the public chain', gitCommit: gitCommit(), stocks: r.stocks };
      saveJson(join(root, 'deployments', `${plan.key}-stock-rehearsal.json`), evidence);
      console.log(`${r.stocks.filter(s => s.ok).length} of ${r.stocks.length} stocks passed. Evidence: deployments/${plan.key}-stock-rehearsal.json`);
    }
    return;
  }
  const rpc = process.env.ELPIDA_MAINNET_RPC_URL; if (!rpc) throw new Error('Set ELPIDA_MAINNET_RPC_URL.');
  const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true });
  if (cmd === 'check') { const c = await preflight({ provider, plan }); print(c); process.exit(c.failed.length ? 1 : 0); }
  if (cmd === 'verify') { const out = await verifyDeployment({ provider, plan, record: JSON.parse(readFileSync(recordPath, 'utf8')), recordPath }); print(out); process.exit(out.every(c => c.ok) ? 0 : 1); }
  if (cmd === 'deploy') {
    const approval = approvalFor(plan.key, hash);
    const key = deployerKey(process.env.ELPIDA_MAINNET_DEPLOYER_KEY ?? await askHidden('Deployer private key (hidden, then Enter): '));
    const signer = new Wallet(key, provider), c = await preflight({ provider, plan, deployer: signer.address }); print(c);
    if (c.failed.length) throw new Error('Preflight failed. Nothing was deployed.');
    const record = await deployPlan({ provider, signer, plan, hash, approval, recordPath, log: m => console.log(m) });
    print(record.constructorChecks);
    console.log(`deployed. Record: deployments/${plan.key}.json. Safe batch: deployments/${record.safeBatch}. Next: execute it in the Safe, then run verify.`);
    return;
  }
  throw new Error(`unknown command ${cmd}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(e => { console.error(e.message); process.exit(1); });
