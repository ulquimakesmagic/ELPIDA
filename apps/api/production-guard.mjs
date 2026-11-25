// Production guard (mainnet checklist C4). When the server is configured for mainnet it refuses to start with test-only
// features or missing safety configuration. Testnet and local runs are never affected. Reports name settings only;
// no environment value is ever printed or returned.
import { solanaRpcList } from '../../packages/solana/rpc-config.mjs';
import { publicOrigin } from './network-policy.mjs';
import { Wallet } from 'ethers';

/** Data survives restarts: a Railway volume, or an explicit data directory on a host's own disk (Oracle hosting). */
export const durableStorage = (env = process.env) => Boolean(env.RAILWAY_VOLUME_MOUNT_PATH || env.ELPIDA_DATA_DIR);

/**
 * @param {object} input
 * @param {Record<string,string|undefined>} input.env  process environment
 * @param {object} input.solana  result of solanaConfig(): the active Solana network and its deployment record
 * @param {object} [input.evm]  apps/api/evm-networks.mjs: { mode, networks, skipped }. mode 'mainnet' is the mainnet site.
 * @returns {{ mainnet: boolean, ok: boolean, errors: {code:string,message:string}[], warnings: {code:string,message:string}[] }}
 */
export function productionGuard({ env = {}, solana = null, evm = null } = {}) {
  const solanaMainnet = solana?.mainnet === true && !solana.disabled, evmMainnet = evm?.mode === 'mainnet';
  const mainnet = solanaMainnet || evmMainnet;
  const errors = [], warnings = [];
  const error = (code, message) => errors.push({ code, message });
  const warn = (code, message) => warnings.push({ code, message });
  if (!mainnet) return { mainnet, ok: true, errors, warnings };
  // A staging copy (deploy/oracle/start.sh while /etc/elpida/staging.env exists) runs next to the live site with the
  // keeper key removed and backups off. Only those two checks relax; every other mainnet check still applies.
  const staging = env.ELPIDA_STAGING === '1';
  if (staging) warn('staging_mode', 'Staging copy: no keeper and no backups. Remove /etc/elpida/staging.env at cut-over.');

  // The mainnet site (ELPIDA_MODE=mainnet, 17 Nov 2026): only EVM mainnets whose V2 record is ready, each with a private
  // RPC, and the keeper named in its plan (fee collection and creator rewards from day one; distributions stay off).
  if (evmMainnet) {
    const nets = evm.networks ?? [];
    if (!nets.length) error('evm_mainnet_none', `No EVM mainnet is ready for the mainnet site. ${(evm.skipped ?? []).map(s => s.reason).join(' ') || 'Deploy one with scripts/v2-mainnet-deploy.mjs first.'}`);
    if (nets.some(n => !n.mainnet)) error('evm_testnet_on_mainnet_site', 'A test network is configured on the mainnet site.');
    for (const n of nets) {
      // ELPIDA_RPC_<chainId> may list several URLs (comma-separated) to rotate through; every one must be hosted HTTPS.
      const rpc = env[`ELPIDA_RPC_${n.chainId}`], hosts = String(rpc ?? '').split(',').map(x => x.trim()).filter(Boolean).map(x => { try { const u = new URL(x); return u.protocol === 'https:' ? u.hostname : null; } catch { return null; } });
      const host = hosts.length && hosts.every(h => h && !['127.0.0.1', 'localhost'].includes(h)) ? hosts[0] : null;
      if (!rpc) error('evm_rpc_missing', `Set ELPIDA_RPC_${n.chainId} to a private HTTPS ${n.name} RPC (for example Alchemy): the server's indexer, prices and keeper use it; browsers never see it.`);
      else if (!host || ['127.0.0.1', 'localhost'].includes(host)) error('evm_rpc_invalid', `ELPIDA_RPC_${n.chainId} must be a hosted HTTPS ${n.name} RPC.`);
    }
    const key = env.ELPIDA_V2_KEEPER_KEY;
    let keeper = null; try { keeper = /^(0x)?[0-9a-fA-F]{64}$/.test(String(key ?? '')) ? new Wallet(key).address.toLowerCase() : null; } catch {}
    if (!key && staging) warn('staging_no_keeper', 'Staging copy: the keeper key is removed on purpose, so this copy collects no fees and pays no rewards.');
    else if (!key) error('keeper_missing', 'Set ELPIDA_V2_KEEPER_KEY to the keeper wallet named in the deployment plan: it collects fees and pays creator rewards.');
    else if (!keeper) error('keeper_invalid', 'ELPIDA_V2_KEEPER_KEY is not a 64-character hex private key.');
    else for (const n of nets) if (n.v2?.shared?.keeper && n.v2.shared.keeper.toLowerCase() !== keeper) error('keeper_mismatch', `ELPIDA_V2_KEEPER_KEY is not the keeper in the ${n.name} deployment plan.`);
    // Option B (11 Nov) kept these off; Malik turned them on for mainnet on 20 Nov. Still flagged so the log shows it.
    if (env.ELPIDA_V2_DISTRIBUTIONS === 'airdrop') warn('distributions_airdrop', 'ELPIDA_V2_DISTRIBUTIONS=airdrop: the keeper pays the monthly EWPR trader airdrop in USDC (USDG on Robinhood Chain) with real funds; V2.3 has no holder rewards or flywheel. Keep its gas budget (ELPIDA_V2_KEEPER_DAILY_GAS) small.');
    if (env.ELPIDA_V2_DISTRIBUTIONS === 'on') warn('distributions_on', 'ELPIDA_V2_DISTRIBUTIONS=on: the keeper pays the trader airdrop, holder rewards and flywheel with real funds. Keep its gas budget (ELPIDA_V2_KEEPER_DAILY_GAS) small.');
    // Keys of test-network workers (Model 10 graduation, flywheel and buyback, the testnet price relay) never belong on it.
    const testKeys = ['ELPIDA_GRADUATION_KEY_FILE', 'ELPIDA_FLYWHEEL_EVM_KEY', 'ELPIDA_BUYBACK_EVM_KEY', 'ELPIDA_BUYBACK_SOLANA_KEY', 'ELPIDA_TESTNET_RELAY_KEY'].filter(k => env[k]);
    if (testKeys.length) error('testnet_worker_keys', `Test-network worker keys are set on the mainnet site (${testKeys.join(', ')}). Remove them; they belong to the testnet site.`);
    if (solana && !solanaMainnet && !solana.disabled) error('solana_devnet_on_mainnet_site', 'Solana devnet is configured on the mainnet site. Set ELPIDA_SOLANA_CLUSTER=mainnet once Solana is on mainnet; until then Solana stays off here.');
  }

  // The program itself: a recorded mainnet deployment whose build rejects test instructions.
  if (solanaMainnet) {
  const d = solana.deployment;
  if (!d?.programId) error('solana_deployment_missing', 'No Solana mainnet deployment record. Run the mainnet deploy (see MAINNET_BETA.md) before switching the server to mainnet.');
  else if (d.build !== 'mainnet') error('solana_test_build', `The Solana deployment record is the "${d.build ?? 'unknown'}" build. Mainnet needs the build that rejects test faucet instructions (build "mainnet").`);

  // A private RPC so the browser never talks to a public, rate-limited endpoint or sees the provider key.
  const rpcs = solanaRpcList(env);
  if (!rpcs.urls.length) error('solana_rpc_missing', 'Set SOLANA_RPC_URL (and optionally more in SOLANA_RPC_URLS) to hosted HTTPS mainnet RPCs (for example Helius).');
  else if (rpcs.urls.some(u => ['127.0.0.1', 'localhost'].includes(new URL(u).hostname))) error('solana_rpc_local', 'A Solana RPC points at a local validator; mainnet needs hosted HTTPS RPCs.');
  if (rpcs.invalid) error('solana_rpc_invalid', `${rpcs.invalid} SOLANA_RPC_URL(S) entr${rpcs.invalid === 1 ? 'y is' : 'ies are'} not a single HTTPS URL.`);
  }

  // Public identity, pinned metadata, durable state and verified off-site backups.
  try { if (!publicOrigin(env)) error('public_url_missing', 'Set ELPIDA_PUBLIC_URL (or RAILWAY_PUBLIC_DOMAIN) so origin checks and link previews use the real domain.'); }
  catch { error('public_url_invalid', 'ELPIDA_PUBLIC_URL must be an HTTPS origin without a path, query or credentials.'); }
  if (!env.PINATA_JWT) error('pinning_missing', 'Set PINATA_JWT: mainnet token details must be pinned to public IPFS before a launch.');
  if (!durableStorage(env)) error('storage_ephemeral', 'Attach a persistent volume: indexes, journals and holder data must survive restarts.');
  if (env.ELPIDA_BACKUP_ENABLED !== 'true' && staging) warn('staging_no_backups', 'Staging copy: backups are off on purpose so it never writes over the live site\'s snapshots.');
  else if (env.ELPIDA_BACKUP_ENABLED !== 'true') error('backup_disabled', 'Enable verified off-site backups (ELPIDA_BACKUP_ENABLED=true with the ELPIDA_BACKUP_S3_* settings) before mainnet.');
  else if (!env.ELPIDA_BACKUP_MIRROR_S3_ENDPOINT) warn('backup_single_provider', 'Backups are stored at one provider only. Add ELPIDA_BACKUP_MIRROR_S3_* (for example Cloudflare R2) so a hosting outage cannot also take the backups.');

  // Test-only features that must be off.
  if (env.CIRCLE_API_KEY || env.ELPIDA_CIRCLE_ADMIN_TOKEN) error('circle_test_funding', 'Circle test-wallet funding is configured. Remove CIRCLE_API_KEY and ELPIDA_CIRCLE_ADMIN_TOKEN from the mainnet service.');
  // Stock pairs (Malik, 18 November 2026: allowed on mainnet). A stock is still only offered once its registry
  // capability flag is on, it is in the verified stock list and the chain's Safe has approved it.
  const flags = Object.keys(env).filter(k => /^ELPIDA_TOKENIZED_EQUITY_[A-Z_]+$/.test(k) && env[k] === '1');
  if (env.ELPIDA_TOKENIZED_EQUITY === '1') warn('tokenized_equity_on', `Stock pairs are switched on${flags.length ? ` (${flags.join(', ')})` : ' but no capability flag is set, so none is offered'}. Only stocks the Safe approved from the verified list are offered.`);
  else if (flags.length) warn('tokenized_equity_flags_unused', `Stock capability flags are set (${flags.join(', ')}) but ELPIDA_TOKENIZED_EQUITY is not 1, so no stock pair is offered.`);

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
