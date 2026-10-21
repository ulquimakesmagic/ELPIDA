// Tokenized stocks and ETFs as quote assets, pool pairs and reward assets.
// Pure logic, no I/O and no secrets, so it runs in the API, the tests and (read-only) the browser.
// The data lives in config/tokenized-equity-registry.json and is passed in.
//
// Rules this file enforces:
//  - One designated provider per network. A lookup never falls back to another provider.
//  - An asset is identified by network + provider + canonical address, never by ticker.
//  - Each capability is tracked separately and is OFF until a verification record exists for it AND
//    operator flags are set. Simulated fixtures are the only assets enabled without evidence.
//  - A price is only usable when fresh; the equity reference price is not the executable token price.
//  - A corporate-action multiplier is applied once, and only when the balance model says it must be.

export const CAPABILITIES = ['launchQuote', 'secondaryTrading', 'graduatedPool', 'rewardConversion', 'rewardDistribution', 'issuanceRedemption'];
export const CAPABILITY_LABELS = {
  launchQuote: 'Launch quote reserve', secondaryTrading: 'Secondary trading', graduatedPool: 'Graduated liquidity pool',
  rewardConversion: 'Reward conversion', rewardDistribution: 'Reward distribution', issuanceRedemption: 'Issuance and redemption',
};
export const BALANCE_MODELS = ['rebased-balance', 'raw-with-multiplier'];
export const WAD = 10n ** 18n;

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Canonical form of an address for a network, or null if malformed. EVM addresses compare case-insensitively. */
export function normalizeAddress(network, address) {
  const a = String(address ?? '').trim();
  if (network === 'solana') return BASE58.test(a) ? a : null;
  return EVM_ADDRESS.test(a) ? a.toLowerCase() : null;
}
export const assetKey = (network, provider, address) => `${network}:${provider}:${normalizeAddress(network, address) ?? String(address).toLowerCase()}`;

const flagName = (provider, capability) => `ELPIDA_TOKENIZED_EQUITY_${provider.toUpperCase()}_${capability.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`;

/** Sandbox assets. They carry no value, use the `fixture` network, and are always labelled simulated. */
export function sandboxFixtures() {
  const base = { network: 'fixture', mode: 'simulated', decimals: 18, verified: true };
  return [
    { ...base, provider: 'fixture-rebasing', symbol: 'SIM-RB', underlying: 'Simulated stock (rebasing balance)', address: '0x00000000000000000000000000000000000000a1', model: 'rebased-balance', feedIncludesMultiplier: null },
    { ...base, provider: 'fixture-multiplier', symbol: 'SIM-MX', underlying: 'Simulated stock (raw balance + multiplier)', address: '0x00000000000000000000000000000000000000a2', model: 'raw-with-multiplier', feedIncludesMultiplier: true, balanceOfKind: 'raw' },
  ];
}

export function createTokenizedEquity(config, { env = {}, fixtures = false } = {}) {
  const providers = config.providers ?? {};
  const networkToProvider = new Map();
  const networkAlias = new Map();
  for (const [net, def] of Object.entries(config.networks ?? {})) {
    networkToProvider.set(net, def.provider);
    networkAlias.set(net, net);
    for (const t of def.testnets ?? []) networkAlias.set(t, net);
    for (const k of def.networkKeys ?? []) networkAlias.set(k, net);
  }
  const assets = new Map();
  const add = a => { const n = normalizeAddress(a.network === 'fixture' ? 'ethereum' : a.network, a.address); if (n) assets.set(assetKey(a.network, a.provider, n), { ...a, address: n, mode: a.mode ?? 'live' }); };
  for (const a of config.assets ?? []) add(a);
  if (fixtures) for (const a of sandboxFixtures()) add(a);
  const verification = config.verification ?? [];
  const globalOn = env.ELPIDA_TOKENIZED_EQUITY === '1';

  /** The mainnet network a testnet or mainnet key belongs to, or null. */
  const mainnetFor = key => networkAlias.get(key) ?? null;
  /** Designated provider for a network (mainnet or testnet key). Never substitutes. */
  const providerForNetwork = key => { const n = mainnetFor(key); return n ? networkToProvider.get(n) ?? null : null; };

  /** Canonical lookup. Throws when the address is malformed, unknown, or belongs to a different provider. */
  function getAsset(network, provider, address) {
    const net = mainnetFor(network) ?? network, designated = net === 'fixture' ? provider : networkToProvider.get(net);
    if (!designated) throw new Error(`No tokenized-equity provider is designated for ${network}.`);
    if (provider !== designated) throw new Error(`${network} uses ${providers[designated]?.name ?? designated}; ${provider} is not an accepted substitute.`);
    const n = normalizeAddress(net === 'fixture' ? 'ethereum' : net, address);
    if (!n) throw new Error('Not a valid token address for this network.');
    const found = assets.get(assetKey(net, provider, n));
    if (!found) throw new Error('This address is not in the verified registry for that provider. Tickers and look-alike tokens are not accepted.');
    return found;
  }

  /** Why a capability is on or off for an asset. Disabled by default; explains the first missing requirement. */
  function capabilityState(asset, capability) {
    if (!CAPABILITIES.includes(capability)) throw new Error(`Unknown capability ${capability}.`);
    if (asset.mode === 'simulated') return { enabled: true, mode: 'simulated', reason: 'Simulated fixture with no value; for tests and demos only.' };
    const label = CAPABILITY_LABELS[capability], name = providers[asset.provider]?.name ?? asset.provider;
    // An excluded provider stays off whatever is verified or flagged; lifting it needs a registry change and review.
    const excluded = providers[asset.provider]?.excluded;
    if (excluded) return { enabled: false, mode: 'live', excluded: true, reason: `${name} is excluded from Elpida: ${excluded.reason}` };
    if (!globalOn) return { enabled: false, mode: 'live', reason: 'Tokenized stocks are switched off on this deployment (ELPIDA_TOKENIZED_EQUITY).' };
    const rec = verification.find(v => v.network === asset.network && v.provider === asset.provider && v.capability === capability && (!v.address || normalizeAddress(asset.network, v.address) === asset.address));
    if (!rec) return { enabled: false, mode: 'live', reason: `${label} for ${name} on ${asset.network} is not verified yet. It needs a recorded test against the real contracts and written provider confirmation.` };
    if (env[flagName(asset.provider, capability)] !== '1') return { enabled: false, mode: 'live', reason: `${label} is verified but not switched on (${flagName(asset.provider, capability)}).` };
    return { enabled: true, mode: 'live', reason: `Verified ${rec.verifiedAt}: ${rec.evidence}` };
  }
  const capabilities = asset => Object.fromEntries(CAPABILITIES.map(c => [c, capabilityState(asset, c)]));

  /** Eligibility is deny-by-default: a holder must be outside the excluded groups AND in a confirmed country. */
  function evaluateEligibility(provider, { country, usPerson = false, kycVerified = false } = {}) {
    const p = providers[provider];
    if (!p) return { allowed: false, reasons: [`Unknown provider ${provider}.`] };
    if (p.excluded) return { allowed: false, reasons: [`${p.name} is excluded from Elpida: ${p.excluded.reason}`] };
    const reasons = [];
    if (usPerson || String(country).toUpperCase() === 'US') reasons.push(`${p.name} is not offered to US persons.`);
    const confirmed = (p.eligibility?.confirmedCountries ?? []).map(c => c.toUpperCase());
    if (!country) reasons.push('Country of residence is required.');
    else if (!confirmed.includes(String(country).toUpperCase())) reasons.push(`${String(country).toUpperCase()} is not on ${p.name}'s confirmed eligible list${String(country).toUpperCase() === 'NG' ? ' (Nigeria is unconfirmed; ask the provider)' : ''}.`);
    if (p.eligibility?.requiresKyc && !kycVerified) reasons.push('Identity verification is required.');
    return { allowed: reasons.length === 0, reasons };
  }

  /** What the interface shows: provider identity, requirements, per-capability state, unresolved questions. */
  function describeNetwork(key) {
    const net = mainnetFor(key), pid = net ? networkToProvider.get(net) : null, p = pid ? providers[pid] : null;
    if (!p) return null;
    return {
      network: net, provider: pid, providerName: p.name, issuer: p.issuer, eligibility: p.eligibility.summary, nigeria: p.eligibility.nigeria,
      excluded: p.excluded ? { since: p.excluded.since, reason: p.excluded.reason } : null,
      marketHours: p.marketHours, balanceSemantics: p.balanceSemantics[net], unresolved: p.unresolved, sources: p.sources,
      assets: [...assets.values()].filter(a => a.network === net).map(a => ({ symbol: a.symbol, underlying: a.underlying, address: a.address, capabilities: capabilities(a) })),
    };
  }
  return { providerForNetwork, mainnetFor, getAsset, capabilityState, capabilities, evaluateEligibility, describeNetwork, assets: () => [...assets.values()] };
}

// ---------- balances, multipliers and valuation ----------

/**
 * Share exposure in token base units. A rebasing token's balanceOf already includes the corporate-action
 * multiplier, so it is returned as is. A raw+multiplier token needs to know what balanceOf returns
 * ('raw' or 'ui'); an unverified kind is refused instead of guessed, so a multiplier is never applied twice.
 */
export function shareExposure({ model, balance, multiplierWad = WAD, balanceOfKind = null }) {
  if (!BALANCE_MODELS.includes(model)) throw new Error('Unknown balance model.');
  const b = BigInt(balance), m = BigInt(multiplierWad);
  if (b < 0n || m <= 0n) throw new Error('Invalid balance or multiplier.');
  if (model === 'rebased-balance') return b;
  if (balanceOfKind === 'ui') return b;
  if (balanceOfKind === 'raw') return (b * m) / WAD;
  throw new Error('What balanceOf returns (raw or multiplied) is unverified for this token, so exposure cannot be computed.');
}

/**
 * USD value of a balance. `priceBasis` says what the price is per:
 *   'per-share'      a plain equity price; value = shares x price
 *   'per-raw-token'  a total-return feed that already includes the multiplier (Coinbase and Robinhood feeds);
 *                    value = raw balance x price, and the multiplier must NOT be applied again.
 */
export function tokenValueUsd({ model, balance, decimals, multiplierWad = WAD, balanceOfKind = null, price, priceBasis }) {
  if (!(Number.isFinite(price) && price > 0)) throw new Error('A positive price is required.');
  const scale = 10 ** decimals;
  if (priceBasis === 'per-raw-token') {
    if (model !== 'raw-with-multiplier') throw new Error('A per-raw-token price only applies to raw+multiplier tokens.');
    if (balanceOfKind !== 'raw') throw new Error('A per-raw-token price needs a raw balance; refusing to guess.');
    return Number(BigInt(balance)) / scale * price;
  }
  if (priceBasis === 'per-share') return Number(shareExposure({ model, balance, multiplierWad, balanceOfKind })) / scale * price;
  throw new Error('The price basis is unresolved (per-share or per-raw-token), so no value is produced.');
}

/** Status of an equity reference price. Only `fresh` is usable for graduation or reward conversion. */
export function referencePriceStatus({ price, updatedAt, now, maxAgeSec, marketOpen = null }) {
  if (!(Number.isFinite(price) && price > 0) || !Number.isFinite(updatedAt)) return { status: 'outage', usable: false, reason: 'No valid price from the feed.' };
  const age = now - updatedAt;
  if (age < 0) return { status: 'outage', usable: false, reason: 'Feed timestamp is in the future.' };
  if (age <= maxAgeSec) return { status: 'fresh', usable: true, age };
  if (marketOpen === false) return { status: 'market-closed', usable: false, age, reason: 'Market is closed; the last price is shown for reference but nothing executes against it.' };
  return { status: 'stale', usable: false, age, reason: 'The feed is older than the allowed age while the market is open.' };
}

/**
 * Conservative executable valuation: the equity reference and the token's own pool TWAP must agree.
 * The lower of the two is used for reserves, so pushing a thin pool up cannot satisfy a graduation test.
 */
export function executableValuation({ reference, twapPriceUsd, maxDivergenceBps = 300 }) {
  if (!reference?.usable) return { usable: false, status: reference?.status ?? 'outage', reason: reference?.reason ?? 'No usable reference price.' };
  if (!(Number.isFinite(twapPriceUsd) && twapPriceUsd > 0)) return { usable: false, status: 'no-twap', reason: 'No pool TWAP to cross-check the reference.' };
  const bps = Math.abs(twapPriceUsd - reference.price) / reference.price * 10000;
  if (bps > maxDivergenceBps) return { usable: false, status: 'diverged', divergenceBps: Math.round(bps), reason: 'Pool price and reference price disagree by more than the limit.' };
  return { usable: true, status: 'ok', priceUsd: Math.min(reference.price, twapPriceUsd), divergenceBps: Math.round(bps) };
}

// ---------- graduation and migration ----------

/** Real reserve excludes the virtual reserve. Never negative. */
export const realQuoteReserve = ({ totalQuoteRaw, virtualQuoteRaw }) => { const r = BigInt(totalQuoteRaw) - BigInt(virtualQuoteRaw); return r > 0n ? r : 0n; };

/**
 * Dual requirement: minimum USD market cap AND minimum real quote reserves in USD. A null threshold is
 * unresolved and blocks graduation, so a missing decision never turns into a silent default.
 */
/**
 * Graduation for a stock-paired curve. Rule 'on-completion' (decided 21 Oct 2026): graduate when the Model 10 curve has
 * completed AND the stock's valuation is usable (fresh reference price that agrees with the pool TWAP). There is no
 * separate USD minimum: Model 10 completes at a $50,000 cap with about $12,013 of real reserve, so a higher reserve
 * floor could never be met. Any other or missing rule blocks instead of defaulting. Reserve and cap are reported only.
 */
export function checkGraduation({ rule, complete, valuation, marketCapUsd = null, realQuoteRaw = null, quoteDecimals = null, quotePriceUsd = null }) {
  if (rule !== 'on-completion') return { ok: false, status: 'unresolved-rule', rule: rule ?? null };
  const reserveUsd = realQuoteRaw != null && quoteDecimals != null && Number.isFinite(quotePriceUsd) ? Number(BigInt(realQuoteRaw)) / 10 ** quoteDecimals * quotePriceUsd : null;
  const info = { marketCapUsd, reserveUsd };
  if (complete !== true) return { ok: false, status: 'curve-open', ...info };
  if (!valuation?.usable) return { ok: false, status: `valuation-${valuation?.status ?? 'unavailable'}`, reason: valuation?.reason, ...info };
  return { ok: true, status: 'ready', ...info };
}

/** Migration must conserve value and must not straddle a corporate action. */
export function verifyMigration({ curveQuoteRaw, curveTokenRaw, poolQuoteRaw, poolTokenRaw, feeQuoteRaw = 0n, feeTokenRaw = 0n, multiplierBeforeWad = null, multiplierAfterWad = null, model }) {
  const problems = [];
  if (BigInt(poolQuoteRaw) + BigInt(feeQuoteRaw) !== BigInt(curveQuoteRaw)) problems.push('Quote reserve is not conserved.');
  if (BigInt(poolTokenRaw) + BigInt(feeTokenRaw) !== BigInt(curveTokenRaw)) problems.push('Token supply is not conserved.');
  if (model === 'raw-with-multiplier') {
    if (multiplierBeforeWad == null || multiplierAfterWad == null) problems.push('The multiplier at migration was not recorded.');
    else if (BigInt(multiplierBeforeWad) !== BigInt(multiplierAfterWad)) problems.push('The multiplier changed during migration; retry after the corporate action settles.');
  }
  return { ok: problems.length === 0, problems };
}

// ---------- reward ledger ----------

/**
 * Idempotent, in-memory reward ledger. The runtime persists snapshots of it. Rules:
 *  - accrue(epoch) is idempotent: the same entitlements again do nothing; different ones throw.
 *  - restricted or failed recipients stay owed. Their share is never moved to other holders.
 *  - recordBatch(batchId) is idempotent, so a retried callback cannot pay twice.
 */
export function createRewardLedger({ maxAttempts = 3, maxBatch = 64 } = {}) {
  const epochs = new Map(), batches = new Map();
  const fingerprint = list => list.map(e => `${e.wallet.toLowerCase()}:${BigInt(e.amountRaw)}`).sort().join('|');
  function accrue(epochId, entitlements) {
    const fp = fingerprint(entitlements), cur = epochs.get(epochId);
    if (cur) { if (cur.fp !== fp) throw new Error('This reward epoch already exists with different entitlements.'); return { created: false }; }
    const rows = new Map();
    for (const e of entitlements) { const w = e.wallet.toLowerCase(), amt = BigInt(e.amountRaw); if (amt < 0n) throw new Error('Negative entitlement.'); rows.set(w, { wallet: w, owed: amt, paid: 0n, attempts: 0, status: amt === 0n ? 'paid' : 'pending', note: null }); }
    epochs.set(epochId, { fp, rows });
    return { created: true };
  }
  function nextBatch(epochId, { isTransferable = () => true } = {}) {
    const ep = epochs.get(epochId); if (!ep) throw new Error('Unknown epoch.');
    const out = [];
    for (const r of ep.rows.values()) {
      if (r.status !== 'pending') continue;
      if (!isTransferable(r.wallet)) { r.status = 'restricted'; r.note = 'Recipient cannot receive this token; the amount stays owed.'; continue; }
      if (out.length < maxBatch) out.push({ wallet: r.wallet, amountRaw: r.owed - r.paid });
    }
    const batchId = `${epochId}#${[...batches.keys()].filter(k => k.startsWith(`${epochId}#`)).length + 1}`;
    batches.set(batchId, { epochId, items: out, recorded: false });
    return { batchId, items: out };
  }
  function recordBatch(batchId, results) {
    const b = batches.get(batchId); if (!b) throw new Error('Unknown batch.');
    if (b.recorded) return { duplicate: true };
    const ep = epochs.get(b.epochId);
    for (const item of b.items) {
      const r = ep.rows.get(item.wallet), res = results[item.wallet];
      if (res?.ok === true) { r.paid += item.amountRaw; r.status = r.paid >= r.owed ? 'paid' : 'pending'; }
      else { r.attempts += 1; r.status = r.attempts >= maxAttempts ? 'held' : 'pending'; r.note = res?.error ?? 'No result recorded.'; }
    }
    b.recorded = true;
    return { duplicate: false };
  }
  function summary(epochId) {
    const ep = epochs.get(epochId); let owed = 0n, paid = 0n; const byStatus = {};
    for (const r of ep.rows.values()) { owed += r.owed; paid += r.paid; byStatus[r.status] = (byStatus[r.status] ?? 0) + 1; }
    return { owed, paid, outstanding: owed - paid, byStatus };
  }
  const row = (epochId, wallet) => ({ ...epochs.get(epochId).rows.get(wallet.toLowerCase()) });
  return { accrue, nextBatch, recordBatch, summary, row };
}
