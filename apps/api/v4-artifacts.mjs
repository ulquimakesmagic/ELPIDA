// Bytecode the launchpad owner's browser deploys for the Model 11 test launchpad (docs/MODEL_11_V4_PROTOTYPE.md,
// phase 4): the CREATE2 deployer the hook is placed with, the factory, the hook and the router, from the same pinned
// solc 0.8.26 build the tests run (scripts/compile-v4.mjs). Served on request only, so the site's config stays small.
// `poolManager` is Uniswap's own published v4-core PoolManager, unchanged: only for a test network without Uniswap v4
// (BNB Chain testnet), where the operator deploys a labelled test copy. Elsewhere Model 11 uses Uniswap's deployment.
import { compileV4, uniswapV4Artifact } from '../../scripts/compile-v4.mjs';

const pick = a => ({ abi: a.abi, bytecode: (b => b.startsWith('0x') ? b : '0x' + b)(a.evm.bytecode.object) });
let cached;
export function v4Artifacts() {
  if (cached) return cached;
  const out = compileV4(), find = name => Object.values(out).find(entries => entries[name]?.evm?.bytecode?.object)?.[name];
  cached = { create2: pick(find('ElpidaCreate2Deployer')), factory: pick(find('ElpidaV4Factory')), hook: pick(find('ElpidaV4Hook')), router: pick(find('ElpidaV4Router')), token: { abi: find('ElpidaToken').abi }, poolManager: (a => ({ abi: a.abi, bytecode: a.bytecode.startsWith('0x') ? a.bytecode : '0x' + a.bytecode }))(uniswapV4Artifact('PoolManager')), label: 'Model 11 test launchpad (Uniswap v4 hook). Not audited; test networks only.',
    // ELPIDA V2.0 (contracts/evm/v2): the factory, the hook, the two reward distributors and the flywheel vault.
    v2: { factory: pick(find('ElpidaV2Factory')), hook: pick(find('ElpidaV2Hook')), distributor: pick(find('ElpidaV2Distributor')), flywheel: pick(find('ElpidaV2FlywheelVault')), creatorRewards: pick(find('ElpidaV2CreatorRewards')), identityAllocation: pick(find('ElpidaV2IdentityAllocation')), usdcDistributor: pick(find('ElpidaV2UsdcDistributor')), token: { abi: find('ElpidaV2Token').abi }, label: 'ELPIDA V2 test launchpad (Uniswap v4 hook). Not audited; test networks only.' } };
  return cached;
}
