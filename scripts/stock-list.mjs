#!/usr/bin/env node
// Builds config/stocks/<network>.json, the verified stock list the operator panel approves on a V2 launchpad.
//   STOCK_LIST_RPC_URL=<rpc> node scripts/stock-list.mjs <network-key> <candidates.json> [--source "<where the list came from>"]
// candidates.json: [{ "symbol": "TSLAon", "name": "Tesla (Ondo)", "address": "0x…", "feed": "0x…", "maxAge": 345600 }]
// taken from the issuer's and the oracle's published lists. Every entry is checked on chain (packages/core/stock-list.mjs);
// rejects are printed with the reason and left out. Reads only: nothing is signed or sent.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Contract, JsonRpcProvider } from 'ethers';
import { buildStockList } from '../packages/core/stock-list.mjs';
import { testnets } from '../packages/core/networks.mjs';

// Mainnet chains are not in networks.mjs yet (mainnet is not approved); their stock lists can still be prepared and checked.
const MAINNETS = [{ key: 'ethereum', name: 'Ethereum', chainId: 1 }, { key: 'bnb', name: 'BNB Chain', chainId: 56 }, { key: 'base', name: 'Base', chainId: 8453 }];
const networks = [...testnets.filter(n => n.kind === 'evm'), ...MAINNETS];

const [key, file] = process.argv.slice(2), at = process.argv.indexOf('--source'), source = at > 0 ? process.argv[at + 1] : file;
const net = networks.find(n => n.key === key);
if (!net || !file) { console.error('Usage: STOCK_LIST_RPC_URL=<rpc> node scripts/stock-list.mjs <network-key> <candidates.json> [--source "…"]'); process.exit(2); }
const rpc = process.env.STOCK_LIST_RPC_URL ?? net.rpcUrl;
if (!rpc) { console.error(`No RPC for ${key}: set STOCK_LIST_RPC_URL.`); process.exit(2); }
const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true });
if (Number((await provider.getNetwork()).chainId) !== Number(net.chainId)) { console.error(`The RPC is not ${net.name} (chain ${net.chainId}).`); process.exit(2); }
const candidates = JSON.parse(readFileSync(file, 'utf8'));
if (!Array.isArray(candidates)) { console.error('candidates.json must be an array.'); process.exit(2); }
const { list, rejected } = await buildStockList({ Contract, provider, network: key, chainId: net.chainId, source, candidates, now: (await provider.getBlock('latest')).timestamp });
mkdirSync(new URL('../config/stocks/', import.meta.url), { recursive: true });
writeFileSync(new URL(`../config/stocks/${key}.json`, import.meta.url), JSON.stringify(list, null, 2) + '\n');
console.log(`${list.stocks.length} of ${candidates.length} stocks verified on ${net.name} → config/stocks/${key}.json`);
for (const r of rejected) console.log(`  rejected ${r.symbol} ${r.address ?? ''}: ${r.reason}`);
provider.destroy();
