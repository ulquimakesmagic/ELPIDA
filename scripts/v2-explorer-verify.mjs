// Publishes the source of a V2 deployment on the chain's explorer (BaseScan through the Etherscan V2 API), so anyone can
// read the contracts behind elpida.fun and so the guardian and the Safe can use the explorer's Read and Write tabs.
//
//   node scripts/v2-explorer-verify.mjs --plan deployments/plans/base-sepolia-rehearsal.json
//
// Needs ELPIDA_MAINNET_RPC_URL (the chain the plan names) and ETHERSCAN_API_KEY (a free key from etherscan.io; one key
// covers every chain). Both may live in .env; the key is never printed. Run it on the machine that deployed: the
// creation bytecode is compared with this checkout's build before anything is submitted, so a different commit is
// reported instead of failing on the explorer. Line endings are part of the metadata hash: a Windows checkout (git
// autocrlf) builds with CRLF sources, so when the build on disk does not match, the other line ending is tried and the
// sources are submitted the way they were deployed. The Base Sepolia rehearsal (13 November) was built with CRLF.
// Constructor arguments are taken from the creation transactions themselves, so they are exactly what was deployed.
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Interface, JsonRpcProvider, getAddress } from 'ethers';
import { V4_SETTINGS } from './compile-v4.mjs';
import { artifacts, readPlan } from './v2-mainnet-deploy.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const solc = require('solc-0.8.26');

/** Record key → the fully qualified contract name the explorer compiles. */
export const CONTRACTS = {
  create2: 'contracts/evm/v4/ElpidaV4Factory.sol:ElpidaCreate2Deployer',
  factory: 'contracts/evm/v2/ElpidaV2Factory.sol:ElpidaV2Factory',
  airdrop: 'contracts/evm/v2/ElpidaV2Distributor.sol:ElpidaV2Distributor',
  holder: 'contracts/evm/v2/ElpidaV2Distributor.sol:ElpidaV2Distributor',
  flywheel: 'contracts/evm/v2/ElpidaV2FlywheelVault.sol:ElpidaV2FlywheelVault',
  hook: 'contracts/evm/v2/ElpidaV2Hook.sol:ElpidaV2Hook',
  router: 'contracts/evm/v4/ElpidaV4Router.sol:ElpidaV4Router',
};
const ART_KEY = { create2: 'create2', factory: 'factory', airdrop: 'distributor', holder: 'distributor', flywheel: 'flywheel', hook: 'hook', router: 'router' };
export const EXPLORERS = { 8453: 'https://basescan.org', 84532: 'https://sepolia.basescan.org', 1: 'https://etherscan.io', 11155111: 'https://sepolia.etherscan.io', 56: 'https://bscscan.com', 97: 'https://testnet.bscscan.com' };
export const compilerVersion = () => 'v' + solc.version().replace(/\.Emscripten.*$/, '');
const API = 'https://api.etherscan.io/v2/api';
const CREATE2 = new Interface(['function deploy(bytes,bytes32) returns(address)']);

const IMPORT = /^\s*import\s+(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/gm;
const readSource = key => readFileSync(key.startsWith('@') ? join(root, 'node_modules', key) : join(root, key), 'utf8');

/**
 * The Standard JSON input for one contract: its file and every file it imports, read from disk exactly as the build
 * reads them, with the build's settings. Source keys match the build's (`contracts/…`, `@uniswap/…`), so the metadata
 * hash the explorer computes is the one in the deployed bytecode.
 */
export function standardInput(contractName, { eol = 'disk' } = {}) {
  const sources = {}, queue = [contractName.split(':')[0]];
  while (queue.length) {
    const key = queue.pop(); if (sources[key]) continue;
    let content = readSource(key);
    // Only this repository's files follow the checkout's line endings; packages come from npm as published.
    if (eol !== 'disk' && !key.startsWith('@')) content = content.replace(/\r?\n/g, eol === 'crlf' ? '\r\n' : '\n');
    sources[key] = { content };
    for (const [, spec] of content.matchAll(IMPORT)) queue.push(spec.startsWith('.') ? posix.normalize(posix.join(posix.dirname(key), spec)) : spec);
  }
  const { outputSelection, ...settings } = V4_SETTINGS;
  return { language: 'Solidity', sources, settings: { ...settings, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'] } } } };
}

/** Creation bytecode (hex, no 0x) of one contract built from `standardInput(contractName, { eol })`, no import callback. */
export function buildBytecode(contractName, eol) {
  const out = JSON.parse(solc.compile(JSON.stringify(standardInput(contractName, { eol }))));
  const errors = (out.errors ?? []).filter(e => e.severity === 'error');
  if (errors.length) throw new Error(errors[0].formattedMessage);
  const [file, name] = contractName.split(':');
  return out.contracts[file][name].evm.bytecode.object.toLowerCase();
}

/**
 * One job per deployed contract: its address, its creation code from the chain, whether that code starts with this
 * checkout's build, and the constructor arguments that follow it. The hook went through the CREATE2 deployer, so its
 * creation code is the `deploy(bytes,bytes32)` call's first argument.
 */
export async function explorerJobs({ provider, record, art = artifacts(), build = buildBytecode }) {
  const jobs = [], built = new Map(), build1 = build;
  build = (cn, eol) => { const k = `${cn}|${eol}`; if (!built.has(k)) built.set(k, build1(cn, eol)); return built.get(k); };
  for (const [key, contractName] of Object.entries(CONTRACTS)) {
    const address = record.contracts?.[key], hash = record.txs?.[key]?.hash;
    if (!address) continue;
    if (!hash) { jobs.push({ key, address, contractName, ok: false, detail: 'no creation transaction in the record' }); continue; }
    const tx = await provider.getTransaction(hash);
    if (!tx) { jobs.push({ key, address, contractName, ok: false, detail: `creation transaction ${hash} not found on this RPC` }); continue; }
    let initCode = tx.data.toLowerCase();
    if (key === 'hook') { try { initCode = CREATE2.decodeFunctionData('deploy', tx.data)[0].toLowerCase(); } catch { /* not a CREATE2 deployment: use the data as is */ } }
    let eol = 'disk', bytecode = '0x' + art[ART_KEY[key]].bytecode.replace(/^0x/, '').toLowerCase();
    for (const other of ['crlf', 'lf']) {
      if (initCode.startsWith(bytecode)) break;
      const built = '0x' + build(contractName, other);
      if (initCode.startsWith(built)) { eol = other; bytecode = built; }
    }
    const ok = initCode.startsWith(bytecode);
    jobs.push({ key, address: getAddress(address), contractName, ok, eol, args: ok ? initCode.slice(bytecode.length) : null,
      detail: ok ? null : 'the deployed creation code differs from this checkout\'s build with either line ending: check out the commit in the deployment record (gitCommit) and run this again' });
  }
  return jobs;
}

const form = o => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();

/** The explorer's answer, without ever echoing the request (it carries the API key). */
async function call(fetchImpl, chainId, params, post) {
  const res = await fetchImpl(`${API}?chainid=${chainId}${post ? '' : '&' + form(params)}`, post ? { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(params) } : {});
  if (!res.ok) throw new Error(`explorer answered HTTP ${res.status}`);
  const body = await res.json();
  return { status: String(body.status), result: typeof body.result === 'string' ? body.result : body.result, message: body.message };
}

/** True when the explorer already shows this address's source. */
export async function isVerified({ fetch: fetchImpl = fetch, chainId, apiKey, address }) {
  const r = await call(fetchImpl, chainId, { module: 'contract', action: 'getsourcecode', address, apikey: apiKey }, false);
  return Array.isArray(r.result) && Boolean(r.result[0]?.SourceCode);
}

/** Submits one job and waits for the explorer's verdict. Returns { ok, detail }. */
export async function submit({ fetch: fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), chainId, apiKey, job, input = standardInput(job.contractName, { eol: job.eol ?? 'disk' }), polls = 40 }) {
  if (await isVerified({ fetch: fetchImpl, chainId, apiKey, address: job.address })) return { ok: true, detail: 'already verified' };
  const sent = await call(fetchImpl, chainId, { apikey: apiKey, module: 'contract', action: 'verifysourcecode', contractaddress: job.address, sourceCode: JSON.stringify(input),
    codeformat: 'solidity-standard-json-input', contractname: job.contractName, compilerversion: compilerVersion(), constructorArguements: job.args ?? '' }, true);
  if (sent.status !== '1') return /already verified/i.test(String(sent.result)) ? { ok: true, detail: 'already verified' } : { ok: false, detail: String(sent.result ?? sent.message).slice(0, 200) };
  for (let i = 0; i < polls; i++) {
    await sleep(i === 0 ? 5_000 : 3_000);
    const r = await call(fetchImpl, chainId, { module: 'contract', action: 'checkverifystatus', guid: sent.result, apikey: apiKey }, false);
    const text = String(r.result);
    if (/pending|queue/i.test(text)) continue;
    if (/^pass|already verified/i.test(text)) return { ok: true, detail: 'verified' };
    return { ok: false, detail: text.slice(0, 200) };
  }
  return { ok: false, detail: 'the explorer has not answered yet; run this again in a few minutes' };
}

export async function verifyOnExplorer({ provider, plan, record, apiKey, fetch: fetchImpl = fetch, sleep, build, log = () => {} }) {
  const chainId = Number(plan.chainId), site = EXPLORERS[chainId];
  if (!site) throw new Error(`No explorer configured for chain ${chainId}.`);
  const net = Number((await provider.getNetwork()).chainId);
  if (net !== chainId) throw new Error(`The RPC is chain ${net}, the plan is chain ${chainId}.`);
  log('comparing the deployed bytecode with this checkout\'s build…');
  const jobs = await explorerJobs({ provider, record, build }), out = [];
  for (const job of jobs) {
    const link = `${site}/address/${job.address}#code`;
    if (!job.ok) { out.push({ check: job.key, ok: false, detail: job.detail }); continue; }
    log(`submitting ${job.key} (${job.contractName.split(':')[1]}${job.eol === 'disk' ? '' : `, ${job.eol.toUpperCase()} sources`})…`);
    const r = await submit({ fetch: fetchImpl, sleep, chainId, apiKey, job });
    out.push({ check: job.key, ok: r.ok, detail: r.ok ? `${r.detail}: ${link}` : r.detail });
  }
  return out;
}

async function main() {
  const rest = process.argv.slice(2), arg = n => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : null; };
  const planPath = arg('plan'); if (!planPath) { console.log('usage: node scripts/v2-explorer-verify.mjs --plan deployments/plans/<key>.json'); process.exit(2); }
  const envFile = join(root, '.env');
  if ((!process.env.ETHERSCAN_API_KEY || !process.env.ELPIDA_MAINNET_RPC_URL) && existsSync(envFile)) { try { process.loadEnvFile(envFile); } catch { /* unreadable .env: the checks below say what is missing */ } }
  const apiKey = (process.env.ETHERSCAN_API_KEY ?? '').trim(), rpc = process.env.ELPIDA_MAINNET_RPC_URL;
  if (!apiKey) throw new Error('Set ETHERSCAN_API_KEY (a free key from etherscan.io/myapikey) in .env or the shell. Nothing was submitted.');
  if (!rpc) throw new Error('Set ELPIDA_MAINNET_RPC_URL to the plan\'s chain. Nothing was submitted.');
  const { plan } = readPlan(planPath), recordPath = join(root, 'deployments', `${plan.key}.json`);
  if (!existsSync(recordPath)) throw new Error(`No deployment record at deployments/${plan.key}.json.`);
  const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true });
  console.log(`plan ${plan.key} (${plan.name}), compiler ${compilerVersion()}`);
  const out = await verifyOnExplorer({ provider, plan, record: JSON.parse(readFileSync(recordPath, 'utf8')), apiKey, log: m => console.log(m) });
  for (const c of out) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.check}${c.detail ? `: ${c.detail}` : ''}`);
  provider.destroy();
  process.exit(out.every(c => c.ok) ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(e => { console.error(e.message); process.exit(1); });
