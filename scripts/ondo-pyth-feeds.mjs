#!/usr/bin/env node
// Ondo stocks priced by Pyth (Malik, 20 November 2026: every Ondo stock Pyth covers, beyond the 13 Chainlink covers on
// BNB Chain). One ElpidaPythOndoStockFeed per stock answers Pyth's share price × Ondo's multiplier (sValue) like a
// Chainlink feed, so the V2 factory approves it unchanged (stock list → operator panel → Safe batches).
//
//   node scripts/ondo-pyth-feeds.mjs map    --network bnb --list config/stocks/candidates/bnb-ondo-all.json
//   node scripts/ondo-pyth-feeds.mjs check  --network bnb
//   node scripts/ondo-pyth-feeds.mjs push   --network bnb
//   node scripts/ondo-pyth-feeds.mjs deploy --network bnb
//
// `map` (reads Pyth's public Hermes API only) pairs each Ondo token with Pyth's "Equity.US.<TICKER>/USD" feed and writes
// config/stocks/candidates/<network>-ondo-pyth.json; stocks Chainlink already prices (<network>-ondo-underlying.json)
// are left to Chainlink. `check` reads each token, Ondo's multiplier and Hermes' latest price (needs
// ELPIDA_MAINNET_RPC_URL). `push` stores the latest signed Pyth prices in Pyth Core (real transactions, a tiny fee per
// batch): the approval and the stock list read the stored price, so run it just before both. `deploy` sends one adapter
// per stock (a few cents each on BNB Chain) after a hidden key prompt and a typed DEPLOY, writes
// deployments/<network>-ondo-pyth-feeds.json (resumable) and config/stocks/candidates/<network>-ondo-feeds-all.json:
// the Chainlink adapters plus these, the input for scripts/stock-list.mjs.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract, ContractFactory, JsonRpcProvider, Wallet, getAddress } from 'ethers';
import { compileV4 } from './compile-v4.mjs';
import { askHidden, askTyped, deployerKey } from './v2-mainnet-deploy.mjs';
import { ONDO_NETWORKS, adaptedCandidates as chainlinkCandidates } from './ondo-stock-feeds.mjs';
import { HERMES, PYTH_ID as ID, pythHex as hex, hermesJson, latestUpdate } from '../apps/api/pyth-hermes.mjs';
export { HERMES, latestUpdate };

const root = fileURLToPath(new URL('../', import.meta.url));
/** Pyth Core per chain (docs.pyth.network contract addresses: stores the latest verified price per feed id). */
export const PYTH_CORE = { bnb: '0x4D7E825f80bDf85e913E0DD2A2D54927e9dE1594' };
/** Refuse a price whose confidence interval is wider than 2% of it. */
export const MAX_CONF_BPS = 200;
const TOKEN = ['function symbol() view returns(string)', 'function decimals() view returns(uint8)'];
const SHARES = ['function getSValue(address) view returns(uint128,bool)'];
export const PYTH_ABI = ['function getPriceUnsafe(bytes32) view returns((int64 price,uint64 conf,int32 expo,uint256 publishTime))', 'function getUpdateFee(bytes[]) view returns(uint256)', 'function updatePriceFeeds(bytes[]) payable'];
export const ticker = symbol => String(symbol).replace(/on$/, '').toUpperCase();
export const pythDescription = symbol => `${symbol} / USD (Pyth ${ticker(symbol)}/USD x Ondo sValue)`;

/**
 * Pairs Ondo tokens with Pyth's US equity feeds from Hermes' feed list (`feeds`: GET /v2/price_feeds?asset_type=equity).
 * Only the regular "Equity.US.<TICKER>/USD" feed is used (not the pre-, post- or overnight-session ones); a class share
 * written BRK.B by Ondo may be BRK-B or BRK.B at Pyth. `skip`: symbols already priced another way.
 */
export function mapPythFeeds(tokens, feeds, { skip = new Set() } = {}) {
  const bySymbol = new Map();
  for (const f of Array.isArray(feeds) ? feeds : []) {
    const s = f?.attributes?.symbol;
    if (typeof s === 'string' && ID.test(String(f.id ?? ''))) bySymbol.set(s.toUpperCase(), hex(f.id));
  }
  const mapped = [], missing = [];
  for (const t of tokens) {
    if (skip.has(t.symbol)) continue;
    const k = ticker(t.symbol), id = [k, k.replace('.', '-'), k.replace('.', '')].map(x => bySymbol.get(`EQUITY.US.${x}/USD`)).find(Boolean);
    if (id) mapped.push({ symbol: t.symbol, name: t.name ?? null, address: t.address, type: t.type ?? 'Stock', pythId: id, pythSymbol: `Equity.US.${k}/USD` });
    else missing.push(t.symbol);
  }
  return { mapped, missing };
}

/** Reads each mapped stock: the token's symbol and decimals, Ondo's multiplier and pause, and Pyth's latest price. */
export async function checkPythFeeds({ provider, sharesOracle, pyth, entries, latest, now }) {
  const shares = new Contract(sharesOracle, SHARES, provider), core = pyth ? new Contract(pyth, PYTH_ABI, provider) : null, out = [];
  for (const e of entries) {
    const r = { symbol: e.symbol, address: e.address, pythId: e.pythId, ok: false };
    try {
      getAddress(e.address);
      const token = new Contract(e.address, TOKEN, provider);
      const [symbol, decimals, [sValue, paused]] = await Promise.all([token.symbol(), token.decimals(), shares.getSValue(e.address)]);
      if (symbol !== e.symbol) throw new Error(`the token's symbol is ${symbol}`);
      if (Number(decimals) < 6 || Number(decimals) > 18) throw new Error(`unsupported decimals ${decimals}`);
      if (!(sValue > 0n)) throw new Error('Ondo has no multiplier for this token');
      const p = latest.get(hex(e.pythId));
      if (!p || p.price <= 0n) throw new Error('Pyth has no price for it now');
      if (p.conf * 10_000n > p.price * BigInt(MAX_CONF_BPS)) throw new Error(`Pyth's confidence is wider than ${MAX_CONF_BPS / 100}% of the price`);
      let stored = null; try { const s = await core?.getPriceUnsafe(e.pythId); stored = s ? Number(s.publishTime) : null; } catch { stored = null; }
      const price = p.expo < 0 ? Number(p.price) / 10 ** -p.expo : Number(p.price) * 10 ** p.expo, multiplier = Number(sValue) / 1e18;
      Object.assign(r, { ok: true, paused, priceUsd: price * multiplier, underlyingUsd: price, multiplier, ageSec: now - p.publishTime, storedAgeSec: stored ? now - stored : null });
    } catch (err) { r.reason = String(err.shortMessage ?? err.message).slice(0, 160); }
    out.push(r);
  }
  return out;
}

/** Stores the latest signed prices in Pyth Core, `batch` feeds per transaction. */
export async function pushPythPrices({ signer, pyth, ids, batch = 50, fetchImpl = fetch, log = () => {} }) {
  const core = new Contract(pyth, PYTH_ABI, signer), hashes = [];
  for (let i = 0; i < ids.length; i += batch) {
    const { data } = await latestUpdate(ids.slice(i, i + batch), { fetchImpl });
    const fee = await core.getUpdateFee(data);
    const tx = await core.updatePriceFeeds(data, { value: fee }); await tx.wait();
    hashes.push(tx.hash); log(`pushed ${Math.min(i + batch, ids.length)} of ${ids.length} prices (${tx.hash})`);
  }
  return hashes;
}

/** Deploys one adapter per entry not yet in the record and returns the record. */
export async function deployPythFeeds({ signer, pyth, sharesOracle, entries, record = { feeds: {} }, save = () => {}, log = () => {} }) {
  const art = Object.values(compileV4()).find(c => c.ElpidaPythOndoStockFeed)?.ElpidaPythOndoStockFeed;
  for (const e of entries) {
    if (record.feeds[e.symbol]?.adapter) continue;
    const c = await new ContractFactory(art.abi, art.evm.bytecode.object, signer).deploy(pyth, e.pythId, sharesOracle, e.address, MAX_CONF_BPS, pythDescription(e.symbol));
    await c.waitForDeployment();
    record.feeds[e.symbol] = { symbol: e.symbol, name: e.name ?? null, token: e.address, pythId: e.pythId, adapter: await c.getAddress(), tx: c.deploymentTransaction().hash };
    save(record); log(`${e.symbol}: ${record.feeds[e.symbol].adapter}`);
  }
  return record;
}

/** Stock-list candidates: the Chainlink adapters, then the Pyth ones for stocks Chainlink does not price. */
export function allFeedCandidates(chainlinkRecord, pythRecord) {
  const out = chainlinkRecord ? chainlinkCandidates(chainlinkRecord) : [], have = new Set(out.map(c => c.symbol));
  for (const f of Object.values(pythRecord?.feeds ?? {})) if (!have.has(f.symbol)) out.push({ symbol: f.symbol, name: f.name, address: f.token, feed: f.adapter, maxAge: 345600 });
  return out;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2), arg = n => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : null; };
  const key = arg('network'), net = ONDO_NETWORKS[key], pyth = PYTH_CORE[key];
  if (!['map', 'check', 'push', 'deploy'].includes(cmd) || !net || !pyth) { console.log('usage: node scripts/ondo-pyth-feeds.mjs map|check|push|deploy --network bnb [--list <ondo tokens.json>]'); process.exit(2); }
  const mappedPath = join(root, 'config', 'stocks', 'candidates', `${key}-ondo-pyth.json`);
  if (cmd === 'map') {
    const list = JSON.parse(readFileSync(arg('list') ?? join(root, 'config', 'stocks', 'candidates', `${key}-ondo-all.json`), 'utf8'));
    let skip = new Set(); try { skip = new Set(JSON.parse(readFileSync(join(root, 'config', 'stocks', 'candidates', `${key}-ondo-underlying.json`), 'utf8')).map(c => c.symbol)); } catch { /* no Chainlink list */ }
    const feeds = await hermesJson(fetch, '/v2/price_feeds?asset_type=equity');
    const { mapped, missing } = mapPythFeeds(list, feeds, { skip });
    writeFileSync(mappedPath, JSON.stringify(mapped, null, 1) + '\n');
    console.log(`${mapped.length} of ${list.length - skip.size} Ondo tokens have a Pyth feed (${skip.size} left to Chainlink) → config/stocks/candidates/${key}-ondo-pyth.json`);
    if (missing.length) console.log(`no Pyth feed: ${missing.join(', ')}`);
    return;
  }
  const rpc = process.env.ELPIDA_MAINNET_RPC_URL; if (!rpc) throw new Error(`Set ELPIDA_MAINNET_RPC_URL to a ${net.name} RPC.`);
  const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true, batchMaxCount: 1 });
  if (Number((await provider.getNetwork()).chainId) !== net.chainId) throw new Error(`The RPC is not ${net.name}.`);
  if ((await provider.getCode(pyth)) === '0x') throw new Error(`No Pyth Core contract at ${pyth} on ${net.name}.`);
  const entries = JSON.parse(readFileSync(mappedPath, 'utf8')), now = (await provider.getBlock('latest')).timestamp;
  const latest = new Map();
  for (let i = 0; i < entries.length; i += 100) for (const [k, v] of (await latestUpdate(entries.slice(i, i + 100).map(e => e.pythId))).parsed) latest.set(k, v);
  const checked = await checkPythFeeds({ provider, sharesOracle: net.sharesOracle, pyth, entries, latest, now });
  const good = entries.filter(e => checked.find(c => c.symbol === e.symbol)?.ok);
  if (cmd === 'check') {
    for (const c of checked) console.log(c.ok ? `ok   ${c.symbol}: $${c.priceUsd.toFixed(2)} (${c.underlyingUsd.toFixed(4)} × ${c.multiplier.toFixed(6)}), ${Math.round(c.ageSec / 3600)} h old${c.storedAgeSec == null ? ', not stored in Pyth Core yet' : `, stored ${Math.round(c.storedAgeSec / 3600)} h ago`}${c.paused ? ', PAUSED by Ondo now' : ''}` : `FAIL ${c.symbol}: ${c.reason}`);
    console.log(`${good.length} of ${entries.length} pass.`); provider.destroy(); return;
  }
  const recordPath = join(root, 'deployments', `${key}-ondo-pyth-feeds.json`);
  const record = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) : { network: key, chainId: net.chainId, pyth, sharesOracle: net.sharesOracle, maxConfBps: MAX_CONF_BPS, feeds: {} };
  if (cmd === 'push') {
    const ids = [...new Set((Object.keys(record.feeds).length ? Object.values(record.feeds) : good).map(e => e.pythId))];
    const answer = await askTyped(`Store the latest Pyth prices for ${ids.length} stocks in Pyth Core on ${net.name} (${Math.ceil(ids.length / 50)} transactions, a small fee each)? Type PUSH to continue: `);
    if (answer.trim() !== 'PUSH') { console.log('Nothing was sent.'); process.exit(1); }
    const signer = new Wallet(deployerKey(process.env.ELPIDA_MAINNET_DEPLOYER_KEY ?? await askHidden('Wallet private key for the fees (hidden, then Enter): ')), provider);
    await pushPythPrices({ signer, pyth, ids, log: m => console.log(m) }); provider.destroy(); return;
  }
  const todo = good.filter(e => !record.feeds[e.symbol]?.adapter);
  if (!todo.length) console.log('Every passing stock already has its feed.');
  else {
    const answer = await askTyped(`Deploy ${todo.length} Pyth price feed contracts to ${net.name} with real gas? Type DEPLOY to continue: `);
    if (answer.trim() !== 'DEPLOY') { console.log('Nothing was deployed.'); process.exit(1); }
    const signer = new Wallet(deployerKey(process.env.ELPIDA_MAINNET_DEPLOYER_KEY ?? await askHidden('Deployer private key (hidden, then Enter): ')), provider);
    await deployPythFeeds({ signer, pyth, sharesOracle: net.sharesOracle, entries: todo, record, save: r => writeFileSync(recordPath, JSON.stringify(r, null, 2) + '\n'), log: m => console.log(m) });
  }
  const chainlinkPath = join(root, 'deployments', `${key}-ondo-feeds.json`);
  const chainlink = existsSync(chainlinkPath) ? JSON.parse(readFileSync(chainlinkPath, 'utf8')) : null;
  const out = join(root, 'config', 'stocks', 'candidates', `${key}-ondo-feeds-all.json`);
  mkdirSync(join(root, 'config', 'stocks', 'candidates'), { recursive: true });
  writeFileSync(out, JSON.stringify(allFeedCandidates(chainlink, record), null, 2) + '\n');
  console.log(`Record: deployments/${key}-ondo-pyth-feeds.json. Next: push, then STOCK_LIST_RPC_URL=<rpc> node scripts/stock-list.mjs ${key} config/stocks/candidates/${key}-ondo-feeds-all.json`);
  provider.destroy();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(e => { console.error(e.message); process.exit(1); });
