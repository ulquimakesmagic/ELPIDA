// Mainnet preview on forks (3 November 2026): one command per chain runs Elpida against a local copy of that chain's
// REAL mainnet state. Nothing is signed with your keys, nothing is sent and no funds are used.
//
//   node --env-file=.env.ondo.local scripts/mainnet-preview.mjs                 # all four chains
//   node --env-file=.env.ondo.local scripts/mainnet-preview.mjs ethereum bnb    # some chains
//   node --env-file=.env.ondo.local scripts/mainnet-preview.mjs ethereum --stocks TSLAon,SPYon
//
// Per chain it runs, in order:
//   1. Model 10, native pair, on the chain's real DEX and Chainlink price feed (scripts/chain-fork-lifecycle.mjs):
//      launch, buys and sells, anti-snipe, atomic graduation into the real Uniswap/PancakeSwap factory, pool trades,
//      fee claims and the indexer.
//   2. Each registered tokenized stock as the trading pair (scripts/equity-cached-fork.mjs): the real stock contract,
//      funded from an existing holder on the fork only, through launch, trades, graduation and claims, with the
//      candidate Chainlink stock feeds read at the same block. Ethereum and BNB use Ondo's stocks; Robinhood Chain
//      uses its own stock tokens (Ondo's bridged ones are not in the registry yet). Base has no Ondo stocks.
//   3. Model 11 (the Uniswap v4 hook): added here when its phase 4 lands.
//
// RPCs: step 1 uses public RPCs (override with ELPIDA_FORK_RPC_<CHAIN>_MAINNET). Step 2 needs an ARCHIVE RPC per chain:
// ELPIDA_EQUITY_FORK_RPC_ETHEREUM, ELPIDA_EQUITY_FORK_RPC_BNB, ELPIDA_EQUITY_FORK_RPC_ROBINHOOD (or one
// ELPIDA_EQUITY_FORK_RPC for Ethereum). Without one, that chain's stock step is reported as SKIPPED, not passed.
// Writes backups/mainnet-preview/summary.md and summary.json. Send Claude the summary and the per-step reports it lists.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CHAINS = Object.freeze({
  ethereum: { fork: 'ethereum-mainnet', stocks: { provider: 'ondo', symbols: ['TSLAon', 'SPYon', 'NVDAon'] } },
  bnb: { fork: 'bnb-mainnet', stocks: { provider: 'ondo', symbols: ['TSLAon', 'SPYon', 'NVDAon'] } },
  robinhood: { fork: 'robinhood-mainnet', stocks: { provider: 'robinhood', symbols: ['TSLA', 'SPY', 'NVDA', 'AAPL'] } },
  base: { fork: 'base-mainnet', stocks: null },
});

/** The steps to run, from command-line arguments. Pure, so it is tested. */
export function plan(argv, env = {}) {
  const args = [...argv], at = args.indexOf('--stocks'), only = at >= 0 ? args.splice(at, 2)[1]?.split(',').map(s => s.trim()).filter(Boolean) : null;
  const chains = args.length ? args : Object.keys(CHAINS);
  for (const c of chains) if (!CHAINS[c]) throw new Error(`Unknown chain ${c}. Use: ${Object.keys(CHAINS).join(', ')}.`);
  const steps = [];
  for (const chain of chains) {
    const def = CHAINS[chain];
    steps.push({ chain, kind: 'native', label: `${chain}: Model 10, native pair, real DEX and feed`, cmd: ['scripts/chain-fork-lifecycle.mjs', def.fork], report: `backups/chain-fork/${def.fork}.json` });
    if (!def.stocks) { steps.push({ chain, kind: 'stocks', label: `${chain}: no Ondo stocks on this chain`, skip: 'Base has no canonical Ondo stock tokens.' }); continue; }
    const rpc = env[`ELPIDA_EQUITY_FORK_RPC_${chain.toUpperCase()}`] ?? (chain === 'ethereum' ? env.ELPIDA_EQUITY_FORK_RPC : null);
    for (const symbol of def.stocks.symbols.filter(s => !only || only.includes(s))) {
      const step = { chain, kind: 'stock', symbol, label: `${chain}: ${symbol} as the trading pair (${def.stocks.provider})`, cmd: ['scripts/equity-cached-fork.mjs', chain, symbol, def.stocks.provider], report: `backups/equity-fork/${chain}-${def.stocks.provider}-${symbol}-lifecycle-report.json` };
      if (!rpc) step.skip = `No archive RPC: set ELPIDA_EQUITY_FORK_RPC_${chain.toUpperCase()}.`;
      steps.push(step);
    }
  }
  steps.push({ chain: 'all', kind: 'model11', label: 'Model 11 (Uniswap v4 hook) on mainnet forks', skip: 'Added when Model 11 phase 4 lands.' });
  return steps;
}

/** One line of the summary table from a step and its report. */
export function summarize(step, report, exitCode) {
  if (step.skip) return { ...step, result: 'SKIPPED', detail: step.skip };
  const result = report?.result ?? (exitCode === 0 ? 'PASS' : 'FAIL');
  const checks = report?.results?.length ?? report?.checks?.length ?? null;
  const failed = (report?.checks ?? report?.results ?? []).find(c => c.ok === false);
  return { ...step, result, checks, block: report?.block ?? report?.forkBlock ?? null, detail: report?.error ?? failed?.name ?? '' };
}

const run = cmd => new Promise(done => { const child = spawn(process.execPath, cmd, { stdio: 'inherit', windowsHide: true, env: process.env }); child.once('exit', code => done(code ?? 1)); child.once('error', () => done(1)); });
const read = path => { try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; } catch { return null; } };

async function main() {
  const steps = plan(process.argv.slice(2), process.env), rows = [];
  for (const step of steps) {
    console.log(`\n=== ${step.label} ===`);
    if (step.skip) { console.log(`SKIPPED  ${step.skip}`); rows.push(summarize(step, null, null)); continue; }
    const code = await run(step.cmd);
    rows.push(summarize(step, read(step.report), code));
  }
  mkdirSync('backups/mainnet-preview', { recursive: true });
  const at = new Date().toISOString();
  writeFileSync('backups/mainnet-preview/summary.json', JSON.stringify({ scope: 'LOCAL FORKS OF MAINNET: nothing sent, no funds used', at, rows }, null, 2));
  const md = [`# Mainnet preview on forks (${at})`, '', 'Local forks of real mainnet state. Nothing was signed with your keys or sent to any chain.', '',
    '| Step | Result | Checks | Block | Detail | Report |', '|---|---|---|---|---|---|',
    ...rows.map(r => `| ${r.label} | ${r.result} | ${r.checks ?? ''} | ${r.block ?? ''} | ${String(r.detail ?? '').replace(/\|/g, '/').slice(0, 140)} | ${r.report ?? ''} |`)].join('\n');
  writeFileSync('backups/mainnet-preview/summary.md', md + '\n');
  console.log(`\n${md}\n\nSummary: backups/mainnet-preview/summary.md`);
  process.exitCode = rows.some(r => r.result === 'FAIL' || r.result === 'INCOMPLETE') ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
