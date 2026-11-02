// Tokenized-stock pairing: how each stock is represented in the launch picker (packages/core/stock-catalog.mjs), and
// the reference-feed observation the Ethereum fork rehearsal records for TSLAon and SPYon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { network } from 'hardhat';
import { BrowserProvider, ContractFactory } from 'ethers';
import { stockIdentity, looksLikeStock, STOCK_UNDERLYINGS, STOCK_LOGOS } from '../packages/core/stock-catalog.mjs';
import { EVM_TEST_PAIRS } from '../packages/core/pairs.mjs';
import { observeReferenceFeeds } from '../scripts/equity-lifecycle-fork.mjs';
import { compileContracts } from '../scripts/compile.mjs';

test('each stock reads as its company, its type and its issuer; test stand-ins are marked', () => {
  assert.deepEqual((({ ticker, company, type, issuer, test }) => ({ ticker, company, type, issuer, test }))(stockIdentity('TSLAon')),
    { ticker: 'TSLA', company: 'Tesla, Inc.', type: 'Stock', issuer: 'Ondo', test: false });
  assert.equal(stockIdentity('SPYon').type, 'ETF');
  assert.equal(stockIdentity('QQQon').company, 'Invesco QQQ Trust');
  assert.deepEqual((({ ticker, issuer, test }) => ({ ticker, issuer, test }))(stockIdentity('tNVDAon', { provider: 'ondo-test' })), { ticker: 'NVDA', issuer: 'Ondo (test)', test: true });
  assert.equal(stockIdentity('TSLAx').issuer, 'xStocks');
  assert.equal(stockIdentity('TEST-STOCK').test, true);
  assert.equal(stockIdentity('ZZZZ', { name: 'Unknown Co' }).company, 'Unknown Co', 'unknown tickers keep their own name');
  assert.ok(looksLikeStock('SPYon') && looksLikeStock('tNVDAon') && !looksLikeStock('USDC') && !looksLikeStock('Hope'));
});

test('stocks shown together never share a colour, and no logo is shown unless one was supplied', () => {
  for (const group of [['TSLA', 'SPY', 'NVDA', 'QQQ'], ['AAPL', 'TSLA', 'NVDA', 'SPY', 'QQQ']]) {
    const tones = group.map(t => STOCK_UNDERLYINGS[t].tone);
    assert.equal(new Set(tones).size, tones.length, group.join(','));
  }
  assert.equal(stockIdentity('TSLAon').logo, STOCK_LOGOS.has('TSLA') ? '/assets/stocks/TSLA.png' : null);
});

test('every stock the launchpad can pair with today has a company name in the picker', () => {
  const registry = JSON.parse(readFileSync(new URL('../config/tokenized-equity-registry.json', import.meta.url), 'utf8'));
  const symbols = [...EVM_TEST_PAIRS.filter(p => p.kind === 'xstock').map(p => p.symbol), ...registry.assets.filter(a => a.provider === 'ondo').map(a => a.symbol)];
  for (const s of new Set(symbols)) assert.ok(stockIdentity(s).company, `${s} has no company name`);
});

test('fork rehearsal: candidate reference feeds are read at the fork block, with age, heartbeat and spread', async t => {
  const connection = await network.create('localTest'), provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  t.after(async () => { provider.destroy(); await connection.close(); });
  const art = compileContracts({ includeMocks: true })['tests/fixtures/MockUsdFeed.sol'].MockUsdFeed, signer = await provider.getSigner(0);
  const deploy = async price => { const c = await new ContractFactory(art.abi, art.evm.bytecode.object, signer).deploy(price); await c.waitForDeployment(); return c; };
  const a = await deploy(401_59000000n), b = await deploy(402_00000000n);
  const now = Number((await provider.getBlock('latest')).timestamp);
  const evidence = { network: 'ethereum', assets: [{ symbol: 'TSLAon', candidates: [{ name: 'API', proxy: a.target, heartbeatSec: 86400 }, { name: 'Calculated', proxy: b.target, heartbeatSec: 86400 }, { name: 'missing', proxy: '0x' + '9'.repeat(40), heartbeatSec: 86400 }] }] };
  const feeds = await observeReferenceFeeds({ provider, network: 'ethereum', symbol: 'TSLAon', blockTimestamp: now, evidence });
  assert.equal(feeds.length, 3);
  assert.deepEqual(feeds.slice(0, 2).map(f => [f.price, f.decimals, f.fresh, f.approved]), [['401.5900', 8, true, false], ['402.0000', 8, true, false]]);
  assert.equal(feeds[0].candidateSpreadPct, 0.1021, 'the two variants differ by about 0.1%');
  assert.ok(feeds[2].error, 'an unreadable candidate is recorded, not fatal');
  assert.deepEqual(await observeReferenceFeeds({ provider, network: 'bnb', symbol: 'TSLAon', blockTimestamp: now, evidence }), [], 'no candidates recorded for BNB');
});
