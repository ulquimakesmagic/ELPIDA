// Model 11 prototype build: Solidity 0.8.26 for the `cancun` EVM, as Uniswap v4 requires (transient storage). Kept apart
// from scripts/compile.mjs (0.8.24 / shanghai), which builds everything deployed today. Imports resolve from the pinned
// @uniswap/v4-core and @uniswap/v4-periphery packages; the PoolManager itself is Uniswap's published artifact.
import { readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const solc = require('solc-0.8.26');
const root = fileURLToPath(new URL('../', import.meta.url));
const CACHE_DIR = join(root, 'cache', 'solc-v4');
const ALLOWED = ['@uniswap/v4-core/', '@uniswap/v4-periphery/'];

export const V4_SETTINGS = {
  optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', viaIR: true,
  outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
};

function sources() {
  const out = {};
  for (const file of readdirSync(join(root, 'contracts/evm/v4')).filter(n => n.endsWith('.sol')))
    out[`contracts/evm/v4/${file}`] = { content: readFileSync(join(root, 'contracts/evm/v4', file), 'utf8') };
  out['contracts/evm/src/ElpidaToken.sol'] = { content: readFileSync(join(root, 'contracts/evm/src/ElpidaToken.sol'), 'utf8') };
  return out;
}

function resolveImport(path) {
  if (!ALLOWED.some(prefix => path.startsWith(prefix))) return { error: `Unsupported import: ${path}` };
  try { return { contents: readFileSync(join(root, 'node_modules', path), 'utf8') }; }
  catch { return { error: `Missing dependency: ${path}` }; }
}

export function compileV4() {
  const input = { language: 'Solidity', sources: sources(), settings: V4_SETTINGS };
  const hash = createHash('sha256').update(solc.version()).update(JSON.stringify(input));
  for (const pkg of ['v4-core', 'v4-periphery']) hash.update(readFileSync(join(root, 'node_modules/@uniswap', pkg, 'package.json')));
  const path = join(CACHE_DIR, hash.digest('hex') + '.json');
  if (process.env.ELPIDA_SOLC_CACHE !== '0') { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { /* miss */ } }
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: resolveImport }));
  const errors = (output.errors ?? []).filter(e => e.severity === 'error');
  if (errors.length) throw new Error(errors.map(e => e.formattedMessage).join('\n'));
  for (const [file, entries] of Object.entries(output.contracts)) for (const [name, a] of Object.entries(entries))
    if (file.startsWith('contracts/') && a.evm.deployedBytecode.object.length / 2 > 24576) throw new Error(`${name} exceeds the EVM contract size limit.`);
  try { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(path + '.tmp', JSON.stringify(output.contracts)); renameSync(path + '.tmp', path); } catch { /* best effort */ }
  return output.contracts;
}

/** Uniswap's own compiled v4 contracts (PoolManager and its test routers) from the pinned package. */
export function uniswapV4Artifact(name) {
  const a = require(`@uniswap/v4-core/out/${name}.sol/${name}.json`);
  return { abi: a.abi, bytecode: a.bytecode.object };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const started = Date.now(), c = compileV4();
  for (const [file, entries] of Object.entries(c)) if (file.startsWith('contracts/')) for (const [name, a] of Object.entries(entries))
    console.log(`${name}: ${a.evm.deployedBytecode.object.length / 2} runtime bytes`);
  console.log(`solc ${solc.version()} (cancun, via IR) in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}
