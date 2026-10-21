import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTokenizedEquity, normalizeAddress, shareExposure, tokenValueUsd, referencePriceStatus, executableValuation, checkGraduation, realQuoteReserve, verifyMigration, createRewardLedger, CAPABILITIES, WAD } from '../packages/core/tokenized-equity.mjs';

const config = JSON.parse(readFileSync(new URL('../config/tokenized-equity-registry.json', import.meta.url)));
const te = (env = {}, extra = {}) => createTokenizedEquity({ ...config, ...extra }, { env });

test('provider routing follows the designated mapping and accepts test networks', () => {
  const t = te();
  const expected = { ethereum: 'xstocks', 'ethereum-sepolia': 'xstocks', solana: 'xstocks', 'solana-mainnet': 'xstocks', 'solana-devnet': 'xstocks', robinhood: 'robinhood', 'robinhood-testnet': 'robinhood', bnb: 'bstocks', 'bnb-testnet': 'bstocks', base: 'coinbase', 'base-sepolia': 'coinbase' };
  for (const [net, p] of Object.entries(expected)) assert.equal(t.providerForNetwork(net), p, net);
  assert.equal(t.providerForNetwork('polygon'), null);
  assert.equal(JSON.stringify(config).toLowerCase().includes('dinari'), false);
});

test('a different provider is never substituted', () => {
  const t = te(), a = config.assets[0];
  assert.throws(() => t.getAsset('base', 'xstocks', a.address), /not an accepted substitute/);
  assert.throws(() => t.getAsset('ethereum', 'coinbase', a.address), /not an accepted substitute/);
  assert.equal(t.getAsset('base', 'coinbase', a.address).symbol, 'NVDAc');
  assert.equal(t.getAsset('base-sepolia', 'coinbase', a.address.toUpperCase().replace('0X', '0x')).symbol, 'NVDAc', 'address case does not matter');
});

test('canonical validation rejects tickers, malformed and look-alike addresses', () => {
  const t = te();
  assert.throws(() => t.getAsset('base', 'coinbase', 'TSLA'), /valid token address/);
  assert.throws(() => t.getAsset('base', 'coinbase', '0x1234'), /valid token address/);
  assert.throws(() => t.getAsset('base', 'coinbase', '0x' + 'ab'.repeat(20)), /not in the verified registry/);
  assert.equal(normalizeAddress('solana', 'not base58 0OIl'), null);
  assert.ok(normalizeAddress('solana', 'So11111111111111111111111111111111111111112'));
});

test('registry holds only addresses taken from the issuer page and never repeats one across symbols', () => {
  const t = te(), coinbase = t.assets().filter(a => a.provider === 'coinbase');
  assert.equal(coinbase.length, 10);
  assert.equal(new Set(coinbase.map(a => a.address)).size, 10);
  for (const a of coinbase) { assert.match(a.address, /^0xb2[0-9a-f]{38}$/); assert.match(a.feed, /^0x[0-9a-fA-F]{40}$/); assert.equal(a.source, 'https://www.base.org/stocks'); }
  for (const p of ['xstocks', 'bstocks']) assert.equal(t.assets().filter(a => a.provider === p).length, 0, `${p} has no retrievable official list, so none is invented`);
  const rh = t.assets().filter(a => a.provider === 'robinhood');
  assert.ok(rh.length > 150); assert.equal(new Set(rh.map(a => a.address)).size, rh.length); assert.equal(new Set(rh.map(a => a.symbol)).size, rh.length);
  for (const a of rh) { assert.equal(a.source, 'https://docs.robinhood.com/chain/contracts'); assert.equal(a.decimals, 18); }
  assert.equal(t.getAsset('robinhood', 'robinhood', '0x322F0929c4625eD5bAd873c95208D54E1c003b2d').symbol, 'TSLA');
  assert.throws(() => t.getAsset('robinhood', 'robinhood', config.assets.find(a => a.provider === 'coinbase').address), /not in the verified registry/, 'a Coinbase token is not a Robinhood token');
});

test('every capability is off for every real asset by default, with an explanation', () => {
  const t = te();
  for (const a of t.assets()) for (const c of CAPABILITIES) { const s = t.capabilityState(a, c); assert.equal(s.enabled, false); assert.ok(s.reason.length > 20); }
});

test('a capability needs the global flag, a verification record and its own flag, independently', () => {
  const asset = config.assets[0];
  const rec = { network: 'base', provider: 'coinbase', capability: 'secondaryTrading', verifiedAt: '2026-11-01', evidence: 'test run on the real contract' };
  const env = { ELPIDA_TOKENIZED_EQUITY: '1', ELPIDA_TOKENIZED_EQUITY_COINBASE_SECONDARY_TRADING: '1' };
  assert.equal(te({}, { verification: [rec] }).capabilityState(te().assets()[0], 'secondaryTrading').enabled, false, 'global flag off');
  assert.match(te({ ELPIDA_TOKENIZED_EQUITY: '1' }).capabilityState(te().assets()[0], 'secondaryTrading').reason, /not verified/);
  assert.match(te({ ELPIDA_TOKENIZED_EQUITY: '1' }, { verification: [rec] }).capabilityState(te().assets()[0], 'secondaryTrading').reason, /not switched on/);
  const on = te(env, { verification: [rec] }), a = on.assets()[0];
  assert.equal(on.capabilityState(a, 'secondaryTrading').enabled, true);
  assert.equal(on.capabilityState(a, 'launchQuote').enabled, false, 'verifying trading does not enable launch quotes');
  assert.equal(on.capabilityState(a, 'graduatedPool').enabled, false);
  assert.equal(asset.network, 'base');
});

test('simulated fixtures work without evidence and are labelled', () => {
  const t = createTokenizedEquity(config, { fixtures: true }), sims = t.assets().filter(a => a.mode === 'simulated');
  assert.equal(sims.length, 2);
  for (const a of sims) for (const c of CAPABILITIES) { const s = t.capabilityState(a, c); assert.equal(s.enabled, true); assert.equal(s.mode, 'simulated'); }
});

test('eligibility is deny-by-default and never assumes Nigeria', () => {
  const t = te();
  assert.equal(t.evaluateEligibility('coinbase', { country: 'US' }).allowed, false);
  assert.equal(t.evaluateEligibility('coinbase', { country: 'DE', usPerson: true }).allowed, false);
  const ng = t.evaluateEligibility('xstocks', { country: 'NG' });
  assert.equal(ng.allowed, false); assert.match(ng.reasons.join(' '), /Nigeria is unconfirmed/);
  assert.equal(t.evaluateEligibility('xstocks', {}).allowed, false);
  const confirmed = createTokenizedEquity({ ...config, providers: { ...config.providers, coinbase: { ...config.providers.coinbase, eligibility: { ...config.providers.coinbase.eligibility, confirmedCountries: ['DE'], requiresKyc: true } } } });
  assert.equal(confirmed.evaluateEligibility('coinbase', { country: 'DE' }).allowed, false, 'KYC missing');
  assert.equal(confirmed.evaluateEligibility('coinbase', { country: 'DE', kycVerified: true }).allowed, true);
});

test('every provider records its sources, access date, Nigeria status and unresolved questions', () => {
  for (const [id, p] of Object.entries(config.providers)) {
    assert.ok(p.sources.length >= 2, id); assert.ok(p.unresolved.length >= 3, id);
    for (const s of p.sources) { assert.match(s.url, /^https:\/\//); assert.equal(s.accessed, '2026-10-19'); }
    assert.equal(p.eligibility.nigeria, 'unconfirmed', id); assert.equal(p.eligibility.usPersons, 'excluded', id);
    for (const net of p.networks) assert.ok(p.balanceSemantics[net], `${id}/${net}`);
  }
});

test('multiplier is applied once and only when the model requires it', () => {
  const two = 2n * WAD;
  assert.equal(shareExposure({ model: 'rebased-balance', balance: 500n, multiplierWad: two }), 500n, 'rebased balance already includes it');
  assert.equal(shareExposure({ model: 'raw-with-multiplier', balance: 500n, multiplierWad: two, balanceOfKind: 'raw' }), 1000n);
  assert.equal(shareExposure({ model: 'raw-with-multiplier', balance: 1000n, multiplierWad: two, balanceOfKind: 'ui' }), 1000n);
  assert.throws(() => shareExposure({ model: 'raw-with-multiplier', balance: 500n, multiplierWad: two }), /unverified/);
});

test('a total-return feed is not multiplied a second time', () => {
  const raw = 10n * 10n ** 18n, m = 2n * WAD;
  // Feed already includes the multiplier: $400 per raw token, so 10 raw tokens are worth $4000.
  assert.equal(tokenValueUsd({ model: 'raw-with-multiplier', balance: raw, decimals: 18, multiplierWad: m, balanceOfKind: 'raw', price: 400, priceBasis: 'per-raw-token' }), 4000);
  // A plain equity price of $200 needs the multiplier: 10 raw x 2 = 20 shares = $4000. Same value, applied once.
  assert.equal(tokenValueUsd({ model: 'raw-with-multiplier', balance: raw, decimals: 18, multiplierWad: m, balanceOfKind: 'raw', price: 200, priceBasis: 'per-share' }), 4000);
  assert.throws(() => tokenValueUsd({ model: 'rebased-balance', balance: raw, decimals: 18, price: 400, priceBasis: 'per-raw-token' }), /only applies/);
  assert.throws(() => tokenValueUsd({ model: 'raw-with-multiplier', balance: raw, decimals: 18, balanceOfKind: 'ui', price: 400, priceBasis: 'per-raw-token' }), /raw balance/);
  assert.throws(() => tokenValueUsd({ model: 'raw-with-multiplier', balance: raw, decimals: 18, balanceOfKind: 'raw', price: 400, priceBasis: null }), /unresolved/);
});

test('reference prices: fresh, stale, market closed and outage behave differently', () => {
  const now = 10_000;
  assert.equal(referencePriceStatus({ price: 100, updatedAt: now - 60, now, maxAgeSec: 3600, marketOpen: true }).usable, true);
  const stale = referencePriceStatus({ price: 100, updatedAt: now - 7200, now, maxAgeSec: 3600, marketOpen: true });
  assert.deepEqual([stale.status, stale.usable], ['stale', false]);
  const closed = referencePriceStatus({ price: 100, updatedAt: now - 7200, now, maxAgeSec: 3600, marketOpen: false });
  assert.deepEqual([closed.status, closed.usable], ['market-closed', false]);
  assert.equal(referencePriceStatus({ price: 0, updatedAt: now, now, maxAgeSec: 60 }).status, 'outage');
  assert.equal(referencePriceStatus({ price: 100, updatedAt: now + 500, now, maxAgeSec: 60 }).status, 'outage');
});

test('executable valuation cross-checks the pool TWAP and uses the lower price', () => {
  const ref = { ...referencePriceStatus({ price: 100, updatedAt: 1, now: 2, maxAgeSec: 60 }), price: 100 };
  const ok = executableValuation({ reference: ref, twapPriceUsd: 99 });
  assert.deepEqual([ok.usable, ok.priceUsd], [true, 99]);
  assert.equal(executableValuation({ reference: ref, twapPriceUsd: 130 }).status, 'diverged');
  assert.equal(executableValuation({ reference: ref, twapPriceUsd: NaN }).status, 'no-twap');
  assert.equal(executableValuation({ reference: { status: 'stale', usable: false }, twapPriceUsd: 100 }).usable, false);
});

test('stock-paired graduation follows curve completion; virtual reserves are excluded from the reported reserve', () => {
  const valuation = { usable: true, status: 'ok' };
  const real = realQuoteReserve({ totalQuoteRaw: 40n * 10n ** 18n, virtualQuoteRaw: 30n * 10n ** 18n });
  assert.equal(real, 10n * 10n ** 18n);
  assert.equal(realQuoteReserve({ totalQuoteRaw: 1n, virtualQuoteRaw: 5n }), 0n);
  const base = { rule: 'on-completion', valuation, realQuoteRaw: real, quoteDecimals: 18, quotePriceUsd: 1000, marketCapUsd: 50000 };
  const open = checkGraduation({ ...base, complete: false });
  assert.deepEqual([open.ok, open.status, open.reserveUsd], [false, 'curve-open', 10000]);
  const done = checkGraduation({ ...base, complete: true });
  assert.deepEqual([done.ok, done.status], [true, 'ready'], 'no separate USD floor once the curve completes');
});

test('a missing or unknown rule and unusable valuations block graduation instead of defaulting', () => {
  const r = checkGraduation({ complete: true, valuation: { usable: true } });
  assert.deepEqual([r.ok, r.status], [false, 'unresolved-rule']);
  assert.equal(checkGraduation({ rule: 'thresholds', complete: true, valuation: { usable: true } }).status, 'unresolved-rule');
  const s = checkGraduation({ rule: 'on-completion', complete: true, valuation: { usable: false, status: 'stale' } });
  assert.deepEqual([s.ok, s.status], [false, 'valuation-stale']);
  assert.equal(checkGraduation({ rule: 'on-completion', complete: true }).status, 'valuation-unavailable');
});

test('migration conserves reserves and refuses to straddle a multiplier change', () => {
  const ok = verifyMigration({ curveQuoteRaw: 100n, curveTokenRaw: 1000n, poolQuoteRaw: 99n, poolTokenRaw: 1000n, feeQuoteRaw: 1n, model: 'rebased-balance' });
  assert.equal(ok.ok, true);
  assert.equal(verifyMigration({ curveQuoteRaw: 100n, curveTokenRaw: 1000n, poolQuoteRaw: 98n, poolTokenRaw: 1000n, model: 'rebased-balance' }).ok, false);
  const m = verifyMigration({ curveQuoteRaw: 100n, curveTokenRaw: 1000n, poolQuoteRaw: 100n, poolTokenRaw: 1000n, model: 'raw-with-multiplier', multiplierBeforeWad: WAD, multiplierAfterWad: WAD + 1n });
  assert.match(m.problems.join(' '), /multiplier changed/);
  assert.match(verifyMigration({ curveQuoteRaw: 1n, curveTokenRaw: 1n, poolQuoteRaw: 1n, poolTokenRaw: 1n, model: 'raw-with-multiplier' }).problems.join(' '), /not recorded/);
});

test('reward ledger: idempotent epochs, restricted recipients stay owed, retries do not double pay', () => {
  const L = createRewardLedger({ maxAttempts: 2 }), a = '0xA1', b = '0xB2', c = '0xC3';
  const ent = [{ wallet: a, amountRaw: 100n }, { wallet: b, amountRaw: 50n }, { wallet: c, amountRaw: 25n }];
  assert.equal(L.accrue('e1', ent).created, true);
  assert.equal(L.accrue('e1', ent).created, false, 'same epoch twice is a no-op');
  assert.throws(() => L.accrue('e1', [{ wallet: a, amountRaw: 1n }]), /different entitlements/);
  const b1 = L.nextBatch('e1', { isTransferable: w => w !== c.toLowerCase() });
  assert.deepEqual(b1.items.map(i => i.wallet).sort(), [a.toLowerCase(), b.toLowerCase()]);
  assert.equal(L.row('e1', c).status, 'restricted');
  L.recordBatch(b1.batchId, { [a.toLowerCase()]: { ok: true }, [b.toLowerCase()]: { ok: false, error: 'reverted' } });
  assert.equal(L.recordBatch(b1.batchId, { [a.toLowerCase()]: { ok: true } }).duplicate, true, 'replayed callback ignored');
  assert.equal(L.row('e1', a).paid, 100n);
  const b2 = L.nextBatch('e1', { isTransferable: w => w !== c.toLowerCase() });
  assert.deepEqual(b2.items.map(i => i.wallet), [b.toLowerCase()], 'only the failed wallet is retried');
  L.recordBatch(b2.batchId, { [b.toLowerCase()]: { ok: false, error: 'reverted' } });
  assert.equal(L.row('e1', b).status, 'held');
  const s = L.summary('e1');
  assert.equal(s.paid, 100n); assert.equal(s.outstanding, 75n, 'unpaid rewards are not reallocated to other holders');
  assert.equal(L.row('e1', a).owed, 100n);
});

test('public API describes a network with provider identity and every capability disabled', async () => {
  const { createServer } = await import('node:net');
  assert.ok(createServer);
  const t = te(), v = t.describeNetwork('base-sepolia');
  assert.equal(v.providerName, 'Coinbase Tokenized Stocks'); assert.equal(v.nigeria, 'unconfirmed');
  assert.equal(v.assets.length, 10);
  for (const a of v.assets) for (const c of CAPABILITIES) assert.equal(a.capabilities[c].enabled, false);
  assert.equal(t.describeNetwork('polygon'), null);
  assert.ok(t.describeNetwork('robinhood-testnet').assets.length > 150);
  for (const net of ['ethereum', 'solana', 'bnb']) { const d = t.describeNetwork(net); assert.ok(d.providerName); assert.deepEqual(d.assets, []); assert.ok(d.unresolved.length); }
});

test('Robinhood semantics are verified raw balance plus multiplier, with a total-return feed', () => {
  const rh = config.providers.robinhood, sem = rh.balanceSemantics.robinhood;
  assert.deepEqual([sem.model, sem.balanceOfKind, sem.feedIncludesMultiplier], ['raw-with-multiplier', 'raw', true]);
  assert.equal(config.networks.robinhood.chainId, 4663);
  const m = 1000566080061092436n, raw = 3855116611030921434773n;
  assert.equal(shareExposure({ model: sem.model, balance: raw, multiplierWad: m, balanceOfKind: sem.balanceOfKind }), 3857298915677612283610n, 'matches the onchain balanceOfUI exactly');
  assert.ok(rh.onchainFindings.risks.includes('block any account'));
});

test('Coinbase on Base: eight decimals, raw balanceOf, and a total-return feed', () => {
  const sem = config.providers.coinbase.balanceSemantics.base;
  assert.deepEqual([sem.model, sem.balanceOfKind, sem.feedIncludesMultiplier], ['raw-with-multiplier', 'raw', true]);
  const cb = config.assets.filter(a => a.provider === 'coinbase');
  assert.equal(cb.length, 10); for (const a of cb) assert.equal(a.decimals, 8);
  const m = 1000538000000000000n, raw = 15154950535n;
  const shares = shareExposure({ model: sem.model, balance: raw, multiplierWad: m, balanceOfKind: sem.balanceOfKind });
  assert.ok(Math.abs(Number(shares - 15163102982n)) <= 1500, 'close to the onchain balanceOfUI (the multiplier here is rounded)');
  assert.equal(tokenValueUsd({ model: sem.model, balance: raw, decimals: 8, balanceOfKind: 'raw', price: 200, priceBasis: 'per-raw-token' }), 151.54950535 * 200);
});

test('an excluded provider (bStocks) stays off even when verified and every flag is on', () => {
  assert.ok(config.providers.bstocks.excluded?.reason, 'bStocks carries an exclusion with a reason');
  const nvdab = { network: 'bnb', provider: 'bstocks', symbol: 'NVDAB', underlying: 'NVIDIA Corp', address: '0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436', decimals: 18, source: 'test-only' };
  const verification = CAPABILITIES.map(capability => ({ network: 'bnb', provider: 'bstocks', capability, verifiedAt: '2026-11-01', evidence: 'test-only record' }));
  const env = { ELPIDA_TOKENIZED_EQUITY: '1', ...Object.fromEntries(CAPABILITIES.map(c => [`ELPIDA_TOKENIZED_EQUITY_BSTOCKS_${c.replace(/[A-Z]/g, x => `_${x}`).toUpperCase()}`, '1'])) };
  const t = createTokenizedEquity({ ...config, assets: [...config.assets, nvdab], verification: [...(config.verification ?? []), ...verification] }, { env });
  const asset = t.getAsset('bnb', 'bstocks', nvdab.address);
  for (const [cap, state] of Object.entries(t.capabilities(asset))) {
    assert.equal(state.enabled, false, cap);
    assert.equal(state.excluded, true, cap);
    assert.match(state.reason, /excluded from Elpida/);
  }
  const elig = t.evaluateEligibility('bstocks', { country: 'AE', kycVerified: true });
  assert.equal(elig.allowed, false); assert.match(elig.reasons[0], /excluded/);
  assert.equal(t.describeNetwork('bnb').excluded.since, '2026-10-20');
  assert.equal(t.describeNetwork('base').excluded, null, 'other providers are not excluded');
  const rec = { network: 'base', provider: 'coinbase', capability: 'secondaryTrading', verifiedAt: '2026-11-01', evidence: 'test' };
  const t2 = createTokenizedEquity({ ...config, verification: [rec] }, { env: { ELPIDA_TOKENIZED_EQUITY: '1', ELPIDA_TOKENIZED_EQUITY_COINBASE_SECONDARY_TRADING: '1' } });
  assert.equal(t2.capabilityState(t2.getAsset('base', 'coinbase', config.assets.find(a => a.symbol === 'NVDAc').address), 'secondaryTrading').enabled, true, 'exclusion does not leak to Coinbase');
});

test('registry: no bStocks asset is listed while the provider is excluded', () => {
  assert.equal(config.assets.filter(a => a.provider === 'bstocks').length, 0);
});
