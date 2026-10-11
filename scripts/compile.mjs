import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import solc from 'solc';

const root = fileURLToPath(new URL('../', import.meta.url));

export function compileContracts({ includeMocks = false } = {}) {
  const sources = {};
  // contracts/evm/testnet holds the labelled testnet-only quote token the browser can deploy.
  const folders = ['contracts/evm/src', 'contracts/evm/testnet', ...(includeMocks ? ['tests/fixtures'] : [])];
  for (const folder of folders) {
    for (const file of readdirSync(join(root, folder)).filter(name => name.endsWith('.sol'))) {
      sources[`${folder}/${file}`] = { content: readFileSync(join(root, folder, file), 'utf8') };
    }
  }
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity', sources,
    settings: {
      optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
    },
  }), { import: path => {
    if (!path.startsWith('@openzeppelin/contracts/')) return { error: 'Unsupported external import' };
    try { return { contents: readFileSync(join(root,'node_modules',path),'utf8') }; }
    catch { return { error: `Missing dependency: ${path}` }; }
  } }));
  const errors = (output.errors ?? []).filter(item => item.severity === 'error');
  if (errors.length) throw new Error(errors.map(item => item.formattedMessage).join('\n'));
  for (const warning of output.errors ?? []) console.warn(warning.formattedMessage);
  return output.contracts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const contracts = compileContracts();
  const destination = join(root, 'artifacts');
  mkdirSync(destination, { recursive: true });
  for (const [source, entries] of Object.entries(contracts)) {
    for (const [name, artifact] of Object.entries(entries)) {
      writeFileSync(join(destination, `${name}.json`), JSON.stringify({ source, contractName: name, compiler: solc.version(), ...artifact }, null, 2));
      console.log(`Compiled ${name} (${artifact.evm.deployedBytecode.object.length / 2} runtime bytes)`);
    }
  }
}
