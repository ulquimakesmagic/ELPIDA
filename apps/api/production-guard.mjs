// Production guard (mainnet checklist C4). When the server is configured for mainnet it refuses to start with test-only
// features or missing safety configuration. Testnet and local runs are never affected. Reports name settings only;
// no environment value is ever printed or returned.
import { solanaRpcList } from '../../packages/solana/rpc-config.mjs';
import { publicOrigin } from './network-policy.mjs';

/**
 * @param {object} input
 * @param {Record<string,string|undefined>} input.env  process environment
 * @param {object} input.solana  result of solanaConfig(): the active Solana network and its deployment record
 * @returns {{ mainnet: boolean, ok: boolean, errors: {code:string,message:string}[], warnings: {code:string,message:string}[] }}
 */
export function productionGuard({ env = {}, solana = null } = {}) {
  const mainnet = solana?.mainnet === true;
  const errors = [], warnings = [];
  const error = (code, message) => errors.push({ code, message });
  const warn = (code, message) => warnings.push({ code, message });
  if (!mainnet) return { mainnet, ok: true, errors, warnings };

  // The program itself: a recorded mainnet deployment whose build rejects test instructions.
  const d = solana.deployment;
  if (!d?.programId) error('solana_deployment_missing', 'No Solana mainnet deployment record. Run the mainnet deploy (see MAINNET_BETA.md) before switching the server to mainnet.');
  else if (d.build !== 'mainnet') error('solana_test_build', `The Solana deployment record is the "${d.build ?? 'unknown'}" build. Mainnet needs the build that rejects test faucet instructions (build "mainnet").`);

  // A private RPC so the browser never talks to a public, rate-limited endpoint or sees the provider key.
  const rpcs = solanaRpcList(env);
  if (!rpcs.urls.length) error('solana_rpc_missing', 'Set SOLANA_RPC_URL (and optionally more in SOLANA_RPC_URLS) to hosted HTTPS mainnet RPCs (for example Helius).');
  else if (rpcs.urls.some(u => ['127.0.0.1', 'localhost'].includes(new URL(u).hostname))) error('solana_rpc_local', 'A Solana RPC points at a local validator; mainnet needs hosted HTTPS RPCs.');
  if (rpcs.invalid) error('solana_rpc_invalid', `${rpcs.invalid} SOLANA_RPC_URL(S) entr${rpcs.invalid === 1 ? 'y is' : 'ies are'} not a single HTTPS URL.`);

  // Public identity, pinned metadata, durable state and verified off-site backups.
  try { if (!publicOrigin(env)) error('public_url_missing', 'Set ELPIDA_PUBLIC_URL (or RAILWAY_PUBLIC_DOMAIN) so origin checks and link previews use the real domain.'); }
  catch { error('public_url_invalid', 'ELPIDA_PUBLIC_URL must be an HTTPS origin without a path, query or credentials.'); }
  if (!env.PINATA_JWT) error('pinning_missing', 'Set PINATA_JWT: mainnet token details must be pinned to public IPFS before a launch.');
  if (!env.RAILWAY_VOLUME_MOUNT_PATH && !env.ELPIDA_DATA_DIR) error('storage_ephemeral', 'Attach a persistent volume: indexes, journals and holder data must survive restarts.');
  if (env.ELPIDA_BACKUP_ENABLED !== 'true') error('backup_disabled', 'Enable verified off-site backups (ELPIDA_BACKUP_ENABLED=true with the ELPIDA_BACKUP_S3_* settings) before mainnet.');
  else if (!env.ELPIDA_BACKUP_MIRROR_S3_ENDPOINT) warn('backup_single_provider', 'Backups are stored at one provider only. Add ELPIDA_BACKUP_MIRROR_S3_* (for example Cloudflare R2) so a hosting outage cannot also take the backups.');

  // Test-only features that must be off.
  if (env.CIRCLE_API_KEY || env.ELPIDA_CIRCLE_ADMIN_TOKEN) error('circle_test_funding', 'Circle test-wallet funding is configured. Remove CIRCLE_API_KEY and ELPIDA_CIRCLE_ADMIN_TOKEN from the mainnet service.');
  if (env.ELPIDA_TOKENIZED_EQUITY === '1') error('tokenized_equity_on', 'Tokenized stocks are switched on (ELPIDA_TOKENIZED_EQUITY=1). They stay off for the mainnet beta.');
  const flags = Object.keys(env).filter(k => /^ELPIDA_TOKENIZED_EQUITY_[A-Z_]+$/.test(k) && env[k] === '1');
  if (flags.length) error('tokenized_equity_flags', `Tokenized-stock capability flags are set (${flags.join(', ')}). Remove them for the mainnet beta.`);

  // Allowed, but worth seeing in the deploy log.
  warn('simulation_present', 'The local simulation (fake funds, labelled as a simulation) is still served alongside mainnet.');
  return { mainnet, ok: errors.length === 0, errors, warnings };
}

/** Plain-text report for the deploy log and the check:production command. */
export function formatGuardReport(report) {
  if (!report.mainnet) return 'Production guard: not a mainnet configuration; nothing to check.';
  const lines = [`Production guard: ${report.ok ? 'PASS' : 'FAIL'} (mainnet configuration)`];
  for (const e of report.errors) lines.push(`  ERROR ${e.code}: ${e.message}`);
  for (const w of report.warnings) lines.push(`  NOTE  ${w.code}: ${w.message}`);
  return lines.join('\n');
}
