// Checks this environment against the production guard before a deploy. Prints setting names only, never values.
//   npm run check:production              uses the current ELPIDA_SOLANA_CLUSTER
//   npm run check:production -- --as-mainnet   previews the result as if the server were switched to mainnet
// Exit code 1 when the guard would refuse to start.
const asMainnet = process.argv.includes('--as-mainnet');
if (asMainnet) process.env.ELPIDA_SOLANA_CLUSTER = 'mainnet';
const { solanaConfig } = await import('../apps/api/server.mjs');
const { productionGuard, formatGuardReport } = await import('../apps/api/production-guard.mjs');
const report = productionGuard({ env: process.env, solana: solanaConfig() });
console.log(formatGuardReport(report));
process.exit(report.ok ? 0 : 1);
