// Bytecode the launchpad owner's browser deploys for the Model 11 test launchpad (docs/MODEL_11_V4_PROTOTYPE.md,
// phase 4): the CREATE2 deployer the hook is placed with, the factory, the hook and the router, from the same pinned
// solc 0.8.26 build the tests run (scripts/compile-v4.mjs). Served on request only, so the site's config stays small.
// Uniswap's PoolManager is not here: Model 11 uses Uniswap's own deployment on each network (networks.mjs `v4`).
import { compileV4 } from '../../scripts/compile-v4.mjs';

const pick = a => ({ abi: a.abi, bytecode: (b => b.startsWith('0x') ? b : '0x' + b)(a.evm.bytecode.object) });
let cached;
export function v4Artifacts() {
  if (cached) return cached;
  const out = compileV4(), find = name => Object.values(out).find(entries => entries[name]?.evm?.bytecode?.object)?.[name];
  cached = { create2: pick(find('ElpidaCreate2Deployer')), factory: pick(find('ElpidaV4Factory')), hook: pick(find('ElpidaV4Hook')), router: pick(find('ElpidaV4Router')), token: { abi: find('ElpidaToken').abi }, label: 'Model 11 test launchpad (Uniswap v4 hook). Not audited; test networks only.' };
  return cached;
}
