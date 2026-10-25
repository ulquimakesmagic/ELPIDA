import { readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import solc from 'solc';

const root = fileURLToPath(new URL('../', import.meta.url));

// Content-addressed compilation cache.
//
// Every test file that touches Solidity calls compileContracts() in its own process, and each call used to
// recompile all 36 contracts from scratch: ~48 s here, twelve times per suite run. The cache key covers the
// compiler identity, the exact settings, every source file and the OpenZeppelin tree, so a dependency bump or a
// settings change produces a new key instead of a stale artifact.
//
// Set ELPIDA_SOLC_CACHE=0 to force a clean compile (release and audit builds should use it). The directory is
// `cache/solc`, which .gitignore already covers.
const CACHE_VERSION = 1;
const CACHE_DIR = join(root, 'cache', 'solc');
const CACHE_LIMIT = 12;

function cacheEnabled() {
  return process.env.ELPIDA_SOLC_CACHE !== '0';
}

function collectSources(includeMocks) {
  const sources = {};
  // contracts/evm/testnet holds the labelled testnet-only quote token the browser can deploy.
  const folders = ['contracts/evm/src', 'contracts/evm/testnet', ...(includeMocks ? ['tests/fixtures'] : [])];
  for (const folder of folders) {
    for (const file of readdirSync(join(root, folder)).filter(name => name.endsWith('.sol'))) {
      sources[`${folder}/${file}`] = { content: readFileSync(join(root, folder, file), 'utf8') };
    }
  }
  return sources;
}

/** Hash of every .sol under node_modules/@openzeppelin/contracts, so a dependency bump cannot reuse a cache entry. */
function hashDependencies(hash) {
  const base = join(root, 'node_modules', '@openzeppelin', 'contracts');
  let files = [];
  try {
    const walk = dir => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.sol')) files.push(path);
      }
    };
    walk(base);
  } catch {
    hash.update('openzeppelin-unavailable');
    return;
  }
  files = files.sort();
  for (const path of files) hash.update(relative(path)).update('\0').update(readFileSync(path)).update('\0');
}

function relative(path) {
  return path.slice(root.length).replace(/\\/g, '/');
}

function cacheKey(sources, settings, includeMocks) {
  const hash = createHash('sha256');
  hash.update(`v${CACHE_VERSION}`).update('\0').update(solc.version()).update('\0');
  hash.update(JSON.stringify({ settings, includeMocks, compiler: solc.version() })).update('\0');
  for (const name of Object.keys(sources).sort()) hash.update(name).update('\0').update(sources[name].content).update('\0');
  hashDependencies(hash);
  return hash.digest('hex');
}

function readCache(path, key) {
  try {
    const entry = JSON.parse(readFileSync(path, 'utf8'));
    if (entry?.key !== key || !entry.contracts) return null;
    return entry;
  } catch {
    return null;
  }
}

/** Keeps the cache directory bounded; oldest entries are dropped once it grows past CACHE_LIMIT. */
function pruneCache() {
  try {
    const files = readdirSync(CACHE_DIR)
      .filter(name => name.endsWith('.json'))
      .map(name => ({ name, at: statSync(join(CACHE_DIR, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const stale of files.slice(CACHE_LIMIT)) {
      try { unlinkSync(join(CACHE_DIR, stale.name)); } catch { /* another process may have removed it */ }
    }
  } catch { /* pruning is best effort */ }
}

export function compileContracts({ includeMocks = false } = {}) {
  const sources = collectSources(includeMocks);
  const settings = {
    optimizer: { enabled: true, runs: 1 }, evmVersion: 'shanghai',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  };
  const key = cacheKey(sources, settings, includeMocks);
  const cachePath = join(CACHE_DIR, `${key}.json`);
  const useCache = cacheEnabled();

  if (useCache) {
    const hit = readCache(cachePath, key);
    // Warnings are replayed so a cached run is indistinguishable from a clean one.
    if (hit) {
      for (const warning of hit.warnings ?? []) console.warn(warning);
      assertSizes(hit.contracts);
      return hit.contracts;
    }
  }

  const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings }), { import: path => {
    if (!path.startsWith('@openzeppelin/contracts/')) return { error: 'Unsupported external import' };
    try { return { contents: readFileSync(join(root,'node_modules',path),'utf8') }; }
    catch { return { error: `Missing dependency: ${path}` }; }
  } }));
  const errors = (output.errors ?? []).filter(item => item.severity === 'error');
  if (errors.length) throw new Error(errors.map(item => item.formattedMessage).join('\n'));
  const warnings = (output.errors ?? []).filter(item => item.severity !== 'error').map(item => item.formattedMessage);
  for (const warning of warnings) console.warn(warning);
  assertSizes(output.contracts);

  if (useCache) {
    try {
      mkdirSync(CACHE_DIR, { recursive: true });
      const temporary = `${cachePath}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ key, version: CACHE_VERSION, compiler: solc.version(), warnings, contracts: output.contracts }));
      renameSync(temporary, cachePath);
      pruneCache();
    } catch { /* a read-only or full disk must not break the build */ }
  }
  return output.contracts;
}

/** EIP-170 and EIP-3860 limits. Applied on cache hits too, so a corrupted entry cannot slip through. */
function assertSizes(contracts) {
  for (const entries of Object.values(contracts)) for (const [name, artifact] of Object.entries(entries)) {
    if (artifact.evm.deployedBytecode.object.length / 2 > 24576) throw new Error(`${name} exceeds the EVM contract size limit.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const started = Date.now();
  const contracts = compileContracts();
  const destination = join(root, 'artifacts');
  mkdirSync(destination, { recursive: true });
  for (const [source, entries] of Object.entries(contracts)) {
    for (const [name, artifact] of Object.entries(entries)) {
      writeFileSync(join(destination, `${name}.json`), JSON.stringify({ source, contractName: name, compiler: solc.version(), ...artifact }, null, 2));
      console.log(`Compiled ${name} (${artifact.evm.deployedBytecode.object.length / 2} runtime bytes)`);
    }
  }
  console.log(`solc ${solc.version()} in ${((Date.now() - started) / 1000).toFixed(1)} s (ELPIDA_SOLC_CACHE=${cacheEnabled() ? 'on' : 'off'})`);
}
