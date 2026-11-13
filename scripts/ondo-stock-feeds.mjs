#!/usr/bin/env node
// Ondo stock prices where Chainlink has no feed for the Ondo token but has one for the underlying share (BNB Chain:
// AAPL, TSLA, NVDA…). One ElpidaOndoStockFeed per stock answers price × Ondo's shares multiplier (sValue), and the stock
// list then approves it like any feed (scripts/stock-list.mjs → operator panel → Safe batches).
//
//   node scripts/ondo-stock-feeds.mjs check  --network bnb --list config/stocks/candidates/bnb-ondo-underlying.json
//   node scripts/ondo-stock-feeds.mjs deploy --network bnb --list config/stocks/candidates/bnb-ondo-underlying.json
//
// Needs ELPIDA_MAINNET_RPC_URL for that chain. `check` only reads. `deploy` sends real transactions (one per stock, a
// few cents each on BNB Chain): it asks for the deployer key with a hidden prompt and for a typed confirmation, writes
// deployments/<network>-ondo-feeds.json (resumable) and config/stocks/candidates/<network>-ondo-adapted.json, the input
// for scripts/stock-list.mjs. Candidates: [{ "symbol": "TSLAon", "name": "…", "address": "<Ondo token>",
// "underlyingFeed": "<Chainlink TSLA / USD>" }], addresses from Ondo's asset pages and Chainlink's feed directory.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { Contract, ContractFactory, JsonRpcProvider, Wallet, getAddress } from 'ethers';
import { compileV4 } from './compile-v4.mjs';
import { askHidden, deployerKey } from './v2-mainnet-deploy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
/** Ondo's SyntheticSharesOracle per chain (docs.ondo.finance/addresses). */
export const ONDO_NETWORKS = {
  ethereum: { name: 'Ethereum', chainId: 1, sharesOracle: '0x9BC39DB6fbB44B91a48b8D5A6C208B82B1741bE6' },
  bnb: { name: 'BNB Chain', chainId: 56, sharesOracle: '0xF4Fd8a1B412633e10527454137A29Db7Aa35F15e' },
};
const TOKEN = ['function symbol() view returns(string)', 'function decimals() view returns(uint8)'];
const FEED = ['function decimals() view returns(uint8)', 'function description() view returns(string)', 'function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)'];
const SHARES = ['function getSValue(address) view returns(uint128,bool)'];
export const underlyingTicker = symbol => String(symbol).replace(/on$/, '').toUpperCase();
export const adapterDescription = symbol => `${symbol} / USD (Chainlink ${underlyingTicker(symbol)} / USD x Ondo sValue)`;

/** Reads each candidate on chain: the token's symbol, the underlying feed's description and answer, Ondo's multiplier. */
export async function checkOndoFeeds({ provider, sharesOracle, entries, now }) {
  const shares = new Contract(sharesOracle, SHARES, provider), out = [];
  for (const e of entries) {
    const r = { symbol: e.symbol, address: e.address, underlyingFeed: e.underlyingFeed, ok: false };
    try {
      getAddress(e.address); getAddress(e.underlyingFeed);
      const token = new Contract(e.address, TOKEN, provider), feed = new Contract(e.underlyingFeed, FEED, provider);
      const [symbol, decimals, description, feedDecimals, round, [sValue, paused]] = await Promise.all([token.symbol(), token.decimals(), feed.description(), feed.decimals(), feed.latestRoundData(), shares.getSValue(e.address)]);
      // Chainlink names them "TSLA / USD" or, for its 24/5 equity feeds, "TSLA-USD (24/5)".
      const want = `${underlyingTicker(e.symbol)} / USD`, wantRe = new RegExp(`^\\s*${underlyingTicker(e.symbol)}\\s*[-/]\\s*USD(\\s*\\(24/5\\))?\\s*$`, 'i');
      if (symbol !== e.symbol) throw new Error(`the token's symbol is ${symbol}`);
      if (Number(decimals) < 6 || Number(decimals) > 18) throw new Error(`unsupported decimals ${decimals}`);
      if (!wantRe.test(description)) throw new Error(`the feed is "${description}", not ${want}`);
      if (!(round[1] > 0n) || round[4] < round[0]) throw new Error('the feed has no valid answer');
      if (!(sValue > 0n)) throw new Error('Ondo has no multiplier for this token');
      const price = Number(round[1]) / 10 ** Number(feedDecimals), multiplier = Number(sValue) / 1e18;
      Object.assign(r, { ok: true, paused, priceUsd: price * multiplier, underlyingUsd: price, multiplier, ageSec: now - Number(round[3]) });
    } catch (err) { r.reason = String(err.shortMessage ?? err.message).slice(0, 160); }
    out.push(r);
  }
  return out;
}

/** Deploys one adapter per passing candidate (skipping those already in the record) and returns the record. */
export async function deployOndoFeeds({ signer, sharesOracle, entries, record = { feeds: {} }, save = () => {}, log = () => {} }) {
  const art = Object.values(compileV4()).find(c => c.ElpidaOndoStockFeed)?.ElpidaOndoStockFeed;
  for (const e of entries) {
    if (record.feeds[e.symbol]?.adapter) continue;
    const c = await new ContractFactory(art.abi, art.evm.bytecode.object, signer).deploy(e.underlyingFeed, sharesOracle, e.address, adapterDescription(e.symbol));
    await c.waitForDeployment();
    record.feeds[e.symbol] = { symbol: e.symbol, name: e.name ?? null, token: e.address, underlyingFeed: e.underlyingFeed, adapter: await c.getAddress(), tx: c.deploymentTransaction().hash };
    save(record); log(`${e.symbol}: ${record.feeds[e.symbol].adapter}`);
  }
  return record;
}

/** The stock-list candidates: the Ondo token priced by its adapter, four days of staleness for weekends. */
export const adaptedCandidates = record => Object.values(record.feeds).map(f => ({ symbol: f.symbol, name: f.name, address: f.token, feed: f.adapter, maxAge: 345600 }));

async function main() {
  const [cmd, ...rest] = process.argv.slice(2), arg = n => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : null; };
  const net = ONDO_NETWORKS[arg('network')], listPath = arg('list');
  if (!['check', 'deploy'].includes(cmd) || !net || !listPath) { console.log('usage: node scripts/ondo-stock-feeds.mjs check|deploy --network ethereum|bnb --list <candidates.json>'); process.exit(2); }
  const rpc = process.env.ELPIDA_MAINNET_RPC_URL; if (!rpc) throw new Error(`Set ELPIDA_MAINNET_RPC_URL to a ${net.name} RPC.`);
  const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true });
  if (Number((await provider.getNetwork()).chainId) !== net.chainId) throw new Error(`The RPC is not ${net.name}.`);
  const entries = JSON.parse(readFileSync(listPath, 'utf8')), now = (await provider.getBlock('latest')).timestamp;
  const checked = await checkOndoFeeds({ provider, sharesOracle: net.sharesOracle, entries, now });
  for (const c of checked) console.log(c.ok ? `ok   ${c.symbol}: $${c.priceUsd.toFixed(2)} (${c.underlyingUsd} × ${c.multiplier.toFixed(6)}), ${Math.round(c.ageSec / 3600)} h old${c.paused ? ', PAUSED by Ondo now' : ''}` : `FAIL ${c.symbol}: ${c.reason}`);
  if (cmd === 'check') { provider.destroy(); process.exit(checked.every(c => c.ok) ? 0 : 1); }
  const good = entries.filter(e => checked.find(c => c.symbol === e.symbol)?.ok);
  const recordPath = join(root, 'deployments', `${arg('network')}-ondo-feeds.json`);
  const record = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) : { network: arg('network'), chainId: net.chainId, sharesOracle: net.sharesOracle, feeds: {} };
  const todo = good.filter(e => !record.feeds[e.symbol]?.adapter);
  if (!todo.length) console.log('Every passing stock already has its feed.');
  else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`Deploy ${todo.length} price feed contracts to ${net.name} with real gas? Type DEPLOY to continue: `); rl.close();
    if (answer.trim() !== 'DEPLOY') { console.log('Nothing was deployed.'); process.exit(1); }
    const signer = new Wallet(deployerKey(process.env.ELPIDA_MAINNET_DEPLOYER_KEY ?? await askHidden('Deployer private key (hidden, then Enter): ')), provider);
    await deployOndoFeeds({ signer, sharesOracle: net.sharesOracle, entries: todo, record, save: r => writeFileSync(recordPath, JSON.stringify(r, null, 2) + '\n'), log: m => console.log(m) });
  }
  const out = join(root, 'config', 'stocks', 'candidates', `${arg('network')}-ondo-adapted.json`);
  mkdirSync(join(root, 'config', 'stocks', 'candidates'), { recursive: true });
  writeFileSync(out, JSON.stringify(adaptedCandidates(record), null, 2) + '\n');
  console.log(`Record: deployments/${arg('network')}-ondo-feeds.json. Next: STOCK_LIST_RPC_URL=<rpc> node scripts/stock-list.mjs ${arg('network')} config/stocks/candidates/${arg('network')}-ondo-adapted.json`);
  provider.destroy();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(e => { console.error(e.message); process.exit(1); });
