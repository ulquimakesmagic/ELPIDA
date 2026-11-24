#!/usr/bin/env node
// Builds config/stocks/<network>.json, the verified stock list the operator panel approves on a V2 launchpad.
//   STOCK_LIST_RPC_URL=<rpc> node scripts/stock-list.mjs <network-key> <candidates.json>[,<more.json>] [--source "<where the list came from>"]
// candidates.json: [{ "symbol": "TSLAon", "name": "Tesla (Ondo)", "address": "0x…", "feed": "0x…", "maxAge": 345600 }]
// taken from the issuer's and the oracle's published lists. Every entry is checked on chain (packages/core/stock-list.mjs);
// rejects are printed with the reason and left out. Reads only: nothing is signed or sent.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Contract, JsonRpcProvider } from 'ethers';
import { buildStockList } from '../packages/core/stock-list.mjs';
import { testnets } from '../packages/core/networks.mjs';
import { stockPairsOff } from '../packages/core/pairs.mjs';
import { EVM_MAINNETS } from '../packages/core/mainnets.mjs';

// Mainnet lists are saved under the mainnet site's network key (config/stocks/base-mainnet.json), the file the site
// asks for; the short names base, bnb, ethereum and robinhood still work.
const ALIASES = { base: 'base-mainnet', bnb: 'bnb-mainnet', ethereum: 'ethereum-mainnet', robinhood: 'robinhood-mainnet' };
const networks = [...testnets.filter(n => n.kind === 'evm'), ...EVM_MAINNETS.map(n => ({ key: n.key, name: n.name, chainId: n.chainId, rpcUrl: n.rpcUrl }))];

const [given, file] = process.argv.slice(2), at = process.argv.indexOf('--source'), source = at > 0 ? process.argv[at + 1] : file;
const key = ALIASES[given] ?? given;
const net = networks.find(n => n.key === key);
if (net && stockPairsOff(net.chainId)) { console.error(stockPairsOff(net.chainId)); process.exit(2); }
if (!net || !file) { console.error('Usage: STOCK_LIST_RPC_URL=<rpc> node scripts/stock-list.mjs <network-key> <candidates.json> [--source "…"]'); process.exit(2); }
const rpc = process.env.STOCK_LIST_RPC_URL ?? net.rpcUrl;
if (!rpc) { console.error(`No RPC for ${key}: set STOCK_LIST_RPC_URL.`); process.exit(2); }
const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true });
if (Number((await provider.getNetwork()).chainId) !== Number(net.chainId)) { console.error(`The RPC is not ${net.name} (chain ${net.chainId}).`); process.exit(2); }
// Several candidate files may be joined with commas (Ethereum: the Chainlink-priced Ondo tokens plus the adapters).
const candidates = file.split(',').flatMap(f => { const c = JSON.parse(readFileSync(f.trim(), 'utf8')); if (!Array.isArray(c)) { console.error(`${f} must be an array.`); process.exit(2); } return c; });
const { list, rejected } = await buildStockList({ Contract, provider, network: key, chainId: net.chainId, source, candidates, now: (await provider.getBlock('latest')).timestamp });
mkdirSync(new URL('../config/stocks/', import.meta.url), { recursive: true });
writeFileSync(new URL(`../config/stocks/${key}.json`, import.meta.url), JSON.stringify(list, null, 2) + '\n');
console.log(`${list.stocks.length} of ${candidates.length} stocks verified on ${net.name} → config/stocks/${key}.json`);
for (const r of rejected) console.log(`  rejected ${r.symbol} ${r.address ?? ''}: ${r.reason}`);
provider.destroy();
