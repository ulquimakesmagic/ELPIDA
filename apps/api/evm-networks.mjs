// Which EVM networks this server runs (17 November 2026). ELPIDA_MODE=mainnet serves only mainnets whose V2 deployment
// record is "ready" (packages/core/mainnets.mjs); any other value, or none, serves the public testnets as before.
// The testnet site and the mainnet site run the same code as two services; a chain moves from one to the other when its
// mainnet record lands.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evmTestnets } from '../../packages/core/networks.mjs';
import { EVM_MAINNETS, mainnetNetwork } from '../../packages/core/mainnets.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const readJson = path => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);

/** `mainnet` when ELPIDA_MODE=mainnet, otherwise `testnet`. */
export const siteMode = (env = process.env) => (String(env.ELPIDA_MODE ?? '').trim().toLowerCase() === 'mainnet' ? 'mainnet' : 'testnet');

/**
 * The EVM networks for `env`: { mode, networks, skipped } where `skipped` lists each mainnet left out and why
 * (shown in the start-up log and refused by the production guard when none is ready).
 */
export function loadEvmNetworks({ env = process.env, root = ROOT, mainnets = EVM_MAINNETS } = {}) {
  const mode = siteMode(env);
  if (mode !== 'mainnet') return { mode, networks: evmTestnets, skipped: [] };
  const networks = [], skipped = [];
  for (const template of mainnets) {
    let result;
    try {
      result = mainnetNetwork(template, readJson(join(root, 'deployments', `${template.planKey}.json`)), readJson(join(root, 'deployments', 'plans', `${template.planKey}.json`)));
    } catch (error) { result = { net: null, reason: `${template.name}: the deployment files could not be read (${String(error.message).slice(0, 80)}).` }; }
    if (result.net) networks.push(result.net); else skipped.push({ key: template.key, reason: result.reason });
  }
  return { mode, networks, skipped };
}

/** This process's networks, read once at start-up. */
export const evm = loadEvmNetworks();
export const evmNetworks = evm.networks;
