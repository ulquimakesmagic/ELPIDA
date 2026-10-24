// Bytecode the launchpad owner's browser deploys on a test chain with no DEX or Chainlink feed (Robinhood testnet):
// Uniswap's own published v3 artifacts (factory, position manager, SwapRouter02, QuoterV2), the labelled
// ElpidaTestWETH and the ElpidaRelayFeed. Served on request only, so the site's config stays small.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import solc from 'solc';
import { v3Artifacts } from '../../packages/core/uniswap.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pick = a => ({ abi: a.abi, bytecode: (b => b.startsWith('0x') ? b : '0x' + b)(a.bytecode?.object ?? a.bytecode ?? a.evm.bytecode.object) });
let cached;
export function testDexArtifacts() {
  if (cached) return cached;
  const files = ['ElpidaTestWETH', 'ElpidaRelayFeed'], sources = Object.fromEntries(files.map(f => [`contracts/evm/testnet/${f}.sol`, { content: readFileSync(root + `contracts/evm/testnet/${f}.sol`, 'utf8') }]));
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings: { optimizer: { enabled: true, runs: 1 }, evmVersion: 'shanghai', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
  const errors = (out.errors ?? []).filter(e => e.severity === 'error');
  if (errors.length) throw new Error(errors.map(e => e.formattedMessage).join('\n'));
  const art = f => out.contracts[`contracts/evm/testnet/${f}.sol`][f];
  cached = { weth: pick(art('ElpidaTestWETH')), factory: pick(v3Artifacts.factory), manager: pick(v3Artifacts.manager), router: pick(v3Artifacts.router), quoter: pick(v3Artifacts.quoter), relayFeed: pick(art('ElpidaRelayFeed')) };
  return cached;
}
