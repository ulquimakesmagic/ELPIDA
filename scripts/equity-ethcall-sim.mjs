// Read-only simulation for tokens a local EVM cannot run (Coinbase Tokenized Stocks on Base are node precompiles).
//   node scripts/equity-ethcall-sim.mjs base [SYMBOL ...]
// Every step is an eth_call against the real node: nothing is signed, sent or changed, and no key or funds are used.
// A transfer is simulated "from" an existing holder, which an eth_call allows without a signature. State overrides give
// a recipient address contract code, to learn whether the token's policy accepts a contract as a recipient.
// Limits: each call is stateless, so a sequence (receive, then sweep, then pull) cannot be played; this only proves what
// the live token accepts or rejects one call at a time.
// Optional env: ELPIDA_EQUITY_FORK_RPC_BASE (or ELPIDA_EQUITY_FORK_RPC), ELPIDA_EQUITY_HOLDER, ELPIDA_EQUITY_EXPLORER.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Interface } from 'ethers';

const config = JSON.parse(readFileSync(new URL('../config/tokenized-equity-registry.json', import.meta.url), 'utf8'));
const IFACE = new Interface([
  'function symbol() view returns(string)', 'function decimals() view returns(uint8)',
  'function balanceOf(address) view returns(uint256)', 'function balanceOfUI(address) view returns(uint256)', 'function scaledBalanceOf(address) view returns(uint256)',
  'function transfer(address,uint256) returns(bool)', 'function approve(address,uint256) returns(bool)',
]);
export const SIM_EOA = '0x00000000000000000000000000000000c0de0001';
export const SIM_CONTRACT = '0x00000000000000000000000000000000c0de0002';
export const SIM_SPENDER = '0x00000000000000000000000000000000c0de0003';
export const SIM_EMPTY_SENDER = '0x00000000000000000000000000000000c0de0004';

/** Runs the simulations. `rpc(method, params)` must talk to a node that executes the token. Exported for the offline test. */
export async function runSimulation({ rpc, tokenAddress, holder, expect = {}, log = () => {} }) {
  const checks = [];
  const record = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail: String(detail) }); log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };
  const call = async (fn, args, { from, overrides } = {}) => {
    const tx = { to: tokenAddress, data: IFACE.encodeFunctionData(fn, args) }; if (from) tx.from = from;
    const params = [tx, 'latest']; if (overrides) params.push(overrides);
    try { return { ok: true, value: IFACE.decodeFunctionResult(fn, await rpc('eth_call', params)) }; }
    catch (e) { return { ok: false, error: e.shortMessage ?? e.message }; }
  };
  const reverts = r => !r.ok || (r.value?.[0] === false);

  const sym = await call('symbol', []), dec = await call('decimals', []);
  if (expect.symbol !== undefined) record('symbol matches registry', sym.ok && sym.value[0] === expect.symbol, sym.ok ? sym.value[0] : sym.error);
  if (expect.decimals !== undefined) record('decimals match registry', dec.ok && Number(dec.value[0]) === expect.decimals, dec.ok ? Number(dec.value[0]) : dec.error);

  const raw = await call('balanceOf', [holder]);
  assert.ok(raw.ok, `balanceOf failed: ${raw.error}`);
  const balance = raw.value[0];
  record('holder has a balance to test with', balance > 0n, balance);
  const ui = await call('balanceOfUI', [holder]), scaled = await call('scaledBalanceOf', [holder]);
  if (ui.ok && scaled.ok) record('balanceOfUI equals scaledBalanceOf and is raw x multiplier (not below raw)', ui.value[0] === scaled.value[0] && ui.value[0] >= balance, `raw ${balance}, ui ${ui.value[0]}`);
  else record('multiplier interface present', false, 'balanceOfUI/scaledBalanceOf missing');

  if (balance > 0n) {
    const one = 1n, part = balance / 100n > 0n ? balance / 100n : 1n;
    // Negative controls first: the simulation must really execute the token, otherwise a pass means nothing.
    const over = await call('transfer', [SIM_EOA, balance + 1n], { from: holder });
    record('control: transferring more than the balance is rejected', reverts(over), over.ok ? 'returned ' + over.value[0] : over.error);
    const empty = await call('transfer', [SIM_EOA, one], { from: SIM_EMPTY_SENDER });
    record('control: a sender with no balance is rejected', reverts(empty), empty.ok ? 'returned ' + empty.value[0] : empty.error);

    const toEoa = await call('transfer', [SIM_EOA, one], { from: holder });
    record('holder -> fresh EOA, one base unit, accepted', toEoa.ok && toEoa.value[0] === true, toEoa.ok ? '' : toEoa.error);
    const toEoaPart = await call('transfer', [SIM_EOA, part], { from: holder });
    record('holder -> fresh EOA, 1% of the balance, accepted', toEoaPart.ok && toEoaPart.value[0] === true, toEoaPart.ok ? '' : toEoaPart.error);
    const toContract = await call('transfer', [SIM_CONTRACT, part], { from: holder, overrides: { [SIM_CONTRACT]: { code: '0x00' } } });
    record('holder -> address that has contract code (curve/pool/vault stand-in), accepted', toContract.ok && toContract.value[0] === true, toContract.ok ? '' : toContract.error);
    const appr = await call('approve', [SIM_CONTRACT, part], { from: holder, overrides: { [SIM_CONTRACT]: { code: '0x00' } } });
    record('holder approves a contract spender, accepted', appr.ok && appr.value[0] === true, appr.ok ? '' : appr.error);
    const fromContract = await call('transfer', [SIM_EOA, one], { from: holder, overrides: { [holder]: { code: '0x00' } } });
    // Only meaningful when the holder is itself a contract on the node; the override makes the sender look like one either way.
    record('a contract as sender (holder given contract code) -> EOA, accepted', fromContract.ok && fromContract.value[0] === true, fromContract.ok ? '' : fromContract.error);
  }
  return { pass: checks.every(c => c.ok), checks };
}

async function findHolder({ explorer, address, balanceOf, log }) {
  if (process.env.ELPIDA_EQUITY_HOLDER) return process.env.ELPIDA_EQUITY_HOLDER;
  const r = await fetch(`${explorer}/api/v2/tokens/${address}/holders`, { signal: AbortSignal.timeout(30000), headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; elpida-fork-check)' } });
  if (!r.ok) throw new Error(`explorer HTTP ${r.status}; set ELPIDA_EQUITY_HOLDER=<address>`);
  for (const it of ((await r.json()).items ?? []).slice(0, 10)) { const a = it.address?.hash; if (a && await balanceOf(a) > 0n) { log(`  holder from explorer: ${a}${it.address?.name ? ' (' + it.address.name + ')' : ''}`); return a; } }
  throw new Error('no holder with a balance; set ELPIDA_EQUITY_HOLDER=<address>');
}

async function main() {
  const net = process.argv[2];
  assert.equal(net, 'base', 'Usage: node scripts/equity-ethcall-sim.mjs base [SYMBOL ...]');
  const def = config.networks[net], wanted = process.argv.slice(3);
  const assets = config.assets.filter(a => a.network === net && (wanted.length ? wanted.includes(a.symbol) : ['NVDAc', 'AAPLc', 'TSLAc'].includes(a.symbol)));
  assert.ok(assets.length, 'No matching registry assets.');
  const url = process.env[`ELPIDA_EQUITY_FORK_RPC_${net.toUpperCase()}`] ?? process.env.ELPIDA_EQUITY_FORK_RPC ?? def.rpc;
  const rpc = async (method, params = []) => { const r = await (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000) })).json(); if (r.error) { const e = new Error(`${method}: ${r.error.message}`); e.shortMessage = r.error.message; throw e; } return r.result; };
  assert.equal(Number(BigInt(await rpc('eth_chainId'))), def.chainId, `upstream must be chain ${def.chainId}`);
  const explorer = (process.env.ELPIDA_EQUITY_EXPLORER ?? def.explorer ?? 'https://base.blockscout.com').replace(/\/$/, '');
  const report = { scope: 'READ-ONLY eth_call simulations: nothing is signed or sent', network: net, chainId: def.chainId, results: [] };
  try {
    for (const a of assets) {
      console.log(`\n== ${a.symbol} ${a.address}`);
      const balanceOf = async addr => BigInt(await rpc('eth_call', [{ to: a.address, data: IFACE.encodeFunctionData('balanceOf', [addr]) }, 'latest']));
      const holder = await findHolder({ explorer, address: a.address, balanceOf, log: console.log });
      const res = await runSimulation({ rpc, tokenAddress: a.address, holder, expect: { symbol: a.symbol, decimals: a.decimals ?? undefined }, log: console.log });
      report.results.push({ symbol: a.symbol, address: a.address, holder, ...res });
    }
    report.result = report.results.every(r => r.pass) ? 'PASS' : 'FAIL';
  } catch (e) { report.result = 'ERROR'; report.error = e.message; console.log(`ERROR  ${e.message}`); }
  mkdirSync('backups/equity-fork', { recursive: true });
  writeFileSync(`backups/equity-fork/${net}-ethcall-report.json`, JSON.stringify(report, null, 2));
  console.log(`\nResult: ${report.result}. Report: backups/equity-fork/${net}-ethcall-report.json`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
