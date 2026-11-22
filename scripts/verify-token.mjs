#!/usr/bin/env node
// Publishes one launched token's source on its explorer now, without waiting for the keeper's hourly job
// (apps/api/token-verifier.mjs). Needs ELPIDA_MAINNET_RPC_URL (that chain) and ETHERSCAN_API_KEY (or ELPIDA_EXPLORER_API_KEY).
//   node scripts/verify-token.mjs --plan deployments/plans/bnb-mainnet.json --token 0xEEcA39F2aF81296De89685e6dDdA58acD5BA1053
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider } from 'ethers';
import { TokenVerifier } from '../apps/api/token-verifier.mjs';
import { EXPLORERS } from './v2-explorer-verify.mjs';

const rest = process.argv.slice(2), arg = n => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : null; };
const planPath = arg('plan'), tokens = (arg('token') ?? '').split(',').map(x => x.trim()).filter(Boolean);
if (!planPath || !tokens.length) { console.log('usage: node scripts/verify-token.mjs --plan deployments/plans/<key>.json --token 0x…[,0x…]'); process.exit(2); }
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const record = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'deployments', `${plan.key}.json`), 'utf8'));
const apiKey = process.env.ETHERSCAN_API_KEY ?? process.env.ELPIDA_EXPLORER_API_KEY, rpc = process.env.ELPIDA_MAINNET_RPC_URL;
if (!apiKey || !rpc) { console.error('Set ELPIDA_MAINNET_RPC_URL and ETHERSCAN_API_KEY.'); process.exit(1); }
const memory = new Map(), v = new TokenVerifier({ apiKey, perTick: tokens.length });
const r = await v.run({ chainId: Number(plan.chainId), provider: new JsonRpcProvider(rpc, undefined, { staticNetwork: true }), hook: record.contracts.hook, tokens: tokens.map(address => ({ address })),
  state: { get: (k, f) => memory.get(k) ?? f, set: (k, x) => memory.set(k, x) }, now: Math.floor(Date.now() / 1000) });
for (const x of r.submitted) console.log(`${x.ok ? 'ok  ' : 'FAIL'} ${x.address}: ${x.detail}${x.ok ? ` ${EXPLORERS[Number(plan.chainId)]}/address/${x.address}#code` : ''}`);
process.exit(r.submitted.every(x => x.ok) ? 0 : 1);
