// Checks this environment against the production guard before a deploy. Prints setting names only, never values.
//   npm run check:production                      uses the current ELPIDA_MODE and ELPIDA_SOLANA_CLUSTER
//   npm run check:production -- --as-mainnet      previews Solana switched to mainnet (ELPIDA_SOLANA_CLUSTER=mainnet)
//   npm run check:production -- --as-mainnet-site previews the EVM mainnet site (ELPIDA_MODE=mainnet)
// Exit code 1 when the guard would refuse to start.
if (process.argv.includes('--as-mainnet')) process.env.ELPIDA_SOLANA_CLUSTER = 'mainnet';
if (process.argv.includes('--as-mainnet-site')) process.env.ELPIDA_MODE = 'mainnet';
const { solanaConfig } = await import('../apps/api/server.mjs');
const { evm } = await import('../apps/api/evm-networks.mjs');
const { productionGuard, formatGuardReport } = await import('../apps/api/production-guard.mjs');
const report = productionGuard({ env: process.env, solana: solanaConfig(), evm });
console.log(formatGuardReport(report));
for (const s of evm.skipped) console.log(`  NOTE  ${s.key}: ${s.reason}`);
process.exit(report.ok ? 0 : 1);
