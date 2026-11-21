#!/usr/bin/env node
// Builds config/swap/<network>.json, the extra tokens the Swap page offers (no price feed needed; Kyber prices swaps).
//   STOCK_LIST_RPC_URL=<rpc> node scripts/swap-list.mjs bnb config/stocks/candidates/bnb-ondo-all.json [--source "…"]
// Every entry is checked on chain (packages/core/swap-list.mjs); rejects are printed and left out. Reads only.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Contract, JsonRpcProvider } from 'ethers';
import { buildSwapList } from '../packages/core/swap-list.mjs';
import { EVM_MAINNETS } from '../packages/core/mainnets.mjs';

const ALIASES = { base: 'base-mainnet', bnb: 'bnb-mainnet', ethereum: 'ethereum-mainnet', robinhood: 'robinhood-mainnet' };
const [given, file] = process.argv.slice(2), at = process.argv.indexOf('--source'), source = at > 0 ? process.argv[at + 1] : file;
const key = ALIASES[given] ?? given, net = EVM_MAINNETS.find(n => n.key === key);
if (!net || !file) { console.error('Usage: STOCK_LIST_RPC_URL=<rpc> node scripts/swap-list.mjs <bnb|ethereum|…> <candidates.json> [--source "…"]'); process.exit(2); }
const rpc = process.env.STOCK_LIST_RPC_URL ?? process.env.ELPIDA_MAINNET_RPC_URL ?? net.rpcUrl;
const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true, batchMaxCount: 1 });
if (Number((await provider.getNetwork()).chainId) !== Number(net.chainId)) { console.error(`The RPC is not ${net.name} (chain ${net.chainId}).`); process.exit(2); }
const candidates = JSON.parse(readFileSync(file, 'utf8'));
console.log(`checking ${candidates.length} tokens on ${net.name}…`);
const { list, rejected } = await buildSwapList({ Contract, provider, network: key, chainId: net.chainId, source, candidates });
mkdirSync(new URL('../config/swap/', import.meta.url), { recursive: true });
writeFileSync(new URL(`../config/swap/${key}.json`, import.meta.url), JSON.stringify(list, null, 1) + '\n');
console.log(`${list.tokens.length} of ${candidates.length} tokens verified on ${net.name} → config/swap/${key}.json`);
for (const r of rejected) console.log(`  rejected ${r.symbol} ${r.address ?? ''}: ${r.reason}`);
provider.destroy();
