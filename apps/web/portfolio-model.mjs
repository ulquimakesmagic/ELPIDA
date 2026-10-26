// Pure figures behind the Portfolio page: holdings with values, positions merged in, and totals. No DOM and no
// network, so it can be tested directly. Values are in each token's trading-pair asset; a total in US dollars is
// only given for the rows that have a USD rate, and the summary says how many rows that covers.

const num = value => { const n = Number(value); return Number.isFinite(n) ? n : null; };

/** Tokens the wallet holds on this network, largest value first. `rate(token)` returns the pair asset's USD price or null. */
export function holdingRows(tokens, { price, rate }) {
  return (tokens ?? [])
    .filter(token => num(token.balance) > 0)
    .map(token => {
      const balance = num(token.balance), unit = num(price(token)) ?? 0, usdRate = rate(token);
      const value = balance * unit, supply = num(token.supply) || 1e9;
      return { token, balance, value, usd: usdRate === null || usdRate === undefined ? null : value * usdRate, rate: usdRate ?? null, share: balance / supply * 100, position: null };
    })
    .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || b.value - a.value);
}

/** Attach the indexed position (`/api/terminal`) for a token, matched case-insensitively; with `network`, only on that network. */
export function withPosition(rows, address, position, network) {
  const key = String(address ?? '').toLowerCase();
  return rows.map(row => row.token.address?.toLowerCase() === key && (network === undefined || row.token.network === network) ? { ...row, position: position ?? null } : row);
}

/**
 * Cross-chain holdings: indexed balances (`/api/public/balances`) joined to the token list from every network.
 * The current network's own state wins for its tokens, because it reads the wallet directly and is fresher than the
 * index. Balances for tokens the list does not know are left out, never shown without a price.
 */
export function crossChainTokens(balances, allTokens, current = { network: null, tokens: [] }) {
  const key = (network, address) => `${network}:${String(address).toLowerCase()}`;
  const byKey = new Map((allTokens ?? []).map(t => [key(t.network, t.address), t]));
  const out = new Map();
  for (const b of balances ?? []) {
    const token = byKey.get(key(b.network, b.address));
    if (token) out.set(key(b.network, b.address), { ...token, network: b.network, balance: b.balance });
  }
  for (const t of current.tokens ?? []) {
    const k = key(current.network, t.address), listed = byKey.get(k);
    if (Number(t.balance) > 0) out.set(k, { ...listed, ...t, network: current.network });
    else out.delete(k);
  }
  return [...out.values()];
}

/** Networks present in a set of tokens, with counts, in first-seen order. */
export function networkCounts(tokens) {
  const counts = new Map();
  for (const t of tokens ?? []) if (t.network) counts.set(t.network, (counts.get(t.network) ?? 0) + 1);
  return [...counts].map(([network, count]) => ({ network, count }));
}

/**
 * Totals for the summary bar. `value` and `pnl` are US dollars over the rows that have a rate (and, for P&L, a known
 * cost basis); `valueCovered` and `pnlCovered` say how many rows that is, so the page can say "of 3".
 */
export function summarize(rows) {
  let value = 0, valueCovered = 0, pnl = 0, cost = 0, pnlCovered = 0, realized = 0;
  for (const row of rows) {
    if (row.usd !== null) { value += row.usd; valueCovered++; }
    const p = row.position;
    if (row.rate !== null && p?.basisKnown) {
      const u = num(p.unrealizedQuote), c = num(p.costQuote);
      if (u !== null && c !== null) { pnl += u * row.rate; cost += c * row.rate; pnlCovered++; }
    }
    if (row.rate !== null && p && num(p.realizedQuote) !== null) realized += num(p.realizedQuote) * row.rate;
  }
  return {
    count: rows.length,
    value: valueCovered ? value : null, valueCovered,
    pnl: pnlCovered ? pnl : null, pnlPercent: pnlCovered && cost > 0 ? pnl / cost * 100 : null, pnlCovered,
    realized: rows.some(r => r.position) ? realized : null,
  };
}

/** Lifetime creator fees across launches, summed per asset symbol: [{ symbol, amount }], largest first. */
export function sumFees(results) {
  const totals = new Map();
  for (const result of results ?? []) {
    if (result?.status !== 'ready') continue;
    for (const asset of result.assets ?? []) {
      const amount = num(asset.amount);
      if (!(amount > 0) || !asset.symbol) continue;
      totals.set(asset.symbol, (totals.get(asset.symbol) ?? 0) + amount);
    }
  }
  return [...totals].map(([symbol, amount]) => ({ symbol, amount })).sort((a, b) => b.amount - a.amount);
}
