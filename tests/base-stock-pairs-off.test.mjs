// Stock pairs per chain. Base was ETH/USDC only until the Coinbase stocks passed a fork rehearsal (16 November 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './helpers/browser-modules.mjs';
const { stockPairsBlocked, STOCK_PAIRS_OFF } = await import('../packages/core/pairs.mjs');
const { stockApprovalGate } = await import('../apps/web/stock-approval.mjs');

const ready = { symbol: 'NVDAc', address: '0x' + '1'.repeat(40), feed: '0x' + '2'.repeat(40), capabilities: { launchQuote: { enabled: true }, graduatedPool: { enabled: true } } };

test('existing chains keep stock pairing rules while Elysium awaits the xStocks rollout', () => {
  for (const id of [8453, '8453', 1, 56, 84532, 11155111, 97, null, undefined]) assert.equal(stockPairsBlocked(id), null);
  assert.match(stockPairsBlocked(99901), /Elysium.*xStocks/);
  assert.ok(Object.isFrozen(STOCK_PAIRS_OFF));
});

test('on Base the operator panel approves only a stock whose launch quote and graduated pool are both on', () => {
  assert.equal(stockApprovalGate(ready, { mainnet: true, chainId: 8453 }), null);
  const off = { ...ready, capabilities: { launchQuote: { enabled: true }, graduatedPool: { enabled: false, reason: 'Graduated liquidity pool is verified but not switched on.' } } };
  assert.match(stockApprovalGate(off, { mainnet: true, chainId: 8453 }), /not switched on/);
});

test('the Base Coinbase stocks have fork evidence for launch quote and graduated pool, and stay off until switched on', async () => {
  const registry = JSON.parse(readFileSync(new URL('../config/tokenized-equity-registry.json', import.meta.url), 'utf8'));
  const { createTokenizedEquity } = await import('../packages/core/tokenized-equity.mjs');
  const evidence = JSON.parse(readFileSync(new URL('../docs/evidence/base-coinbase-stock-rehearsal-2026-11-16.json', import.meta.url), 'utf8'));
  const coinbase = registry.assets.filter(a => a.network === 'base' && a.provider === 'coinbase');
  assert.equal(coinbase.length, 10);
  for (const a of coinbase) {
    const run = evidence.stocks.find(s => s.address.toLowerCase() === a.address.toLowerCase());
    assert.ok(run?.graduated && run.startMcapUsd > 19_960 && run.startMcapUsd < 20_060 && run.raisedUsd > 30_000, `${a.symbol} rehearsal`);
    for (const capability of ['launchQuote', 'graduatedPool']) {
      const rec = registry.verification.find(v => v.network === 'base' && v.provider === 'coinbase' && v.capability === capability && v.address.toLowerCase() === a.address.toLowerCase());
      assert.ok(rec && rec.verifiedAt === '2026-11-16' && /base-coinbase-stock-rehearsal-2026-11-16\.json/.test(rec.evidence) && /no written provider confirmation/.test(rec.evidence), `${a.symbol} ${capability}`);
    }
  }
  assert.ok(registry.verification.every(v => ['launchQuote', 'graduatedPool'].includes(v.capability)), 'nothing else is claimed');
  // Evidence alone switches nothing on: the global flag and each capability flag are still needed.
  const t = createTokenizedEquity(registry), nvda = t.assets().find(a => a.network === 'base' && a.symbol === 'NVDAc');
  assert.match(t.capabilityState(nvda, 'launchQuote').reason, /switched off on this deployment/);
  const on = createTokenizedEquity(registry, { env: { ELPIDA_TOKENIZED_EQUITY: '1', ELPIDA_TOKENIZED_EQUITY_COINBASE_LAUNCH_QUOTE: '1', ELPIDA_TOKENIZED_EQUITY_COINBASE_GRADUATED_POOL: '1' } });
  assert.equal(on.capabilityState(on.assets().find(a => a.symbol === 'NVDAc' && a.network === 'base'), 'graduatedPool').enabled, true);
  assert.equal(on.capabilityState(on.assets().find(a => a.symbol === 'NVDAc' && a.network === 'base'), 'secondaryTrading').enabled, false);
});

test('the launch flow, the EVM wallet and the stock-list script all consult the gate (chain rule, then the visitor region)', () => {
  const flow = readFileSync(new URL('../apps/web/launch-flow.mjs', import.meta.url), 'utf8');
  assert.match(flow, /V2_PAIRS\.filter\(k => k !== 'xstock' \|\| !stockPairsBlocked/);
  assert.match(flow, /draft\.pair === 'xstock' && !solana\(\) && stockPairsBlocked/);
  assert.match(flow, /approvedQuotes \?\? \[\]\)\.filter\(a => a\.kind !== 'xstock' \|\| !stockPairsBlocked/);
  const wallet = readFileSync(new URL('../apps/web/wallet.mjs', import.meta.url), 'utf8');
  assert.match(wallet, /xstock: stockPairsBlocked\(this\.net\.chainId\) \?/);
  assert.match(wallet, /kind === 'xstock' && stockPairsBlocked\(this\.net\.chainId\)\) throw/);
  assert.match(readFileSync(new URL('../scripts/stock-list.mjs', import.meta.url), 'utf8'), /stockPairsOff\(net\.chainId\)/);
});

test('Coinbase stocks on Base: ticker matching and the rehearsal candidates', async () => {
  const { underlying } = await import('../packages/core/stock-list.mjs');
  assert.equal(underlying('NVDAc'), 'NVDA'); assert.equal(underlying('TSLAon'), 'TSLA'); assert.equal(underlying('BAC'), 'BAC'); assert.equal(underlying('SPCXc'), 'SPCX');
  const list = JSON.parse(readFileSync(new URL('../config/stocks/candidates/base-coinbase.json', import.meta.url), 'utf8'));
  const registry = JSON.parse(readFileSync(new URL('../config/tokenized-equity-registry.json', import.meta.url), 'utf8'));
  const known = new Map(registry.assets.filter(a => a.network === 'base' && a.provider === 'coinbase').map(a => [a.symbol, a]));
  assert.equal(list.length, 10);
  for (const s of list) {
    assert.match(s.symbol, /^[A-Z]{2,5}c$/);
    assert.equal(s.address, known.get(s.symbol).address); assert.equal(s.feed, known.get(s.symbol).feed);
    assert.equal(s.maxAge, 345600);
  }
});

test('a Base fork rehearsal runs before the Safe exists, but the real deploy still needs every role', async () => {
  const { readPlan } = await import('../scripts/v2-mainnet-deploy.mjs');
  const plan = new URL('../deployments/plans/base-mainnet.json', import.meta.url);
  assert.equal(readPlan(plan, { forkRehearsal: true }).plan.explorerApi, 'https://base.blockscout.com');
  assert.equal(readPlan(plan).plan.treasury, '0x8bB68257d69c717779B7f5c52DfEDDDb4c31Fd01', 'the real deploy has every role since 18 Nov 2026');
  const src = readFileSync(new URL('../scripts/v2-mainnet-deploy.mjs', import.meta.url), 'utf8');
  assert.match(src, /forkRehearsal \? \['treasury', 'keeper', 'guardian'\]/);
});

test('stock lists are saved under the mainnet site\'s network key, the file the site asks for', () => {
  const src = readFileSync(new URL('../scripts/stock-list.mjs', import.meta.url), 'utf8');
  assert.match(src, /EVM_MAINNETS/);
  for (const [short, key] of [['base', 'base-mainnet'], ['bnb', 'bnb-mainnet'], ['ethereum', 'ethereum-mainnet'], ['robinhood', 'robinhood-mainnet']]) assert.ok(src.includes(`${short}: '${key}'`), short);
  assert.match(src, /config\/stocks\/\$\{key\}\.json/);
  assert.match(readFileSync(new URL('../apps/web/v2-launchpad.mjs', import.meta.url), 'utf8'), /stock-list\?network=\$\{encodeURIComponent\(w\.net\.key\)\}/);
});
