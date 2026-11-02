// Display identity for tokenized stocks: the underlying company or fund and the issuer, read from the token symbol
// (Ondo appends "on", xStocks "x"; Elpida's test stand-ins start with "t"). Display only: it never decides what can be
// launched or how anything is priced. Tiles show the ticker on a colour of their own; a logo appears only where one
// has been added to apps/web/assets/stocks/<TICKER>.png and listed in STOCK_LOGOS (the operator supplies the files,
// so nothing here reproduces a company's mark).

export const STOCK_UNDERLYINGS = Object.freeze({
  // `tone` is a colour slot (0-7, see styles.css), set by hand so stocks shown together never share a colour.
  AAPL: { company: 'Apple Inc.', type: 'Stock', tone: 7 },
  AMZN: { company: 'Amazon.com, Inc.', type: 'Stock', tone: 6 },
  COIN: { company: 'Coinbase Global, Inc.', type: 'Stock', tone: 0 },
  GOOGL: { company: 'Alphabet Inc. (Class A)', type: 'Stock', tone: 5 },
  HOOD: { company: 'Robinhood Markets, Inc.', type: 'Stock', tone: 2 },
  META: { company: 'Meta Platforms, Inc.', type: 'Stock', tone: 7 },
  MSFT: { company: 'Microsoft Corporation', type: 'Stock', tone: 5 },
  MSTR: { company: 'Strategy Inc.', type: 'Stock', tone: 1 },
  NFLX: { company: 'Netflix, Inc.', type: 'Stock', tone: 4 },
  NVDA: { company: 'NVIDIA Corporation', type: 'Stock', tone: 2 },
  TSLA: { company: 'Tesla, Inc.', type: 'Stock', tone: 4 },
  QQQ: { company: 'Invesco QQQ Trust', type: 'ETF', tone: 3 },
  SPY: { company: 'SPDR S&P 500 ETF Trust', type: 'ETF', tone: 0 },
});

/** Tickers with an operator-supplied logo at /assets/stocks/<TICKER>.png. Empty until files are added. */
export const STOCK_LOGOS = new Set([]);

const TONES = 8;

/** A stable colour slot (0..7) for a ticker, so the same stock always gets the same tile. */
export function stockTone(ticker) {
  let n = 0;
  for (const c of String(ticker)) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return n % TONES;
}

/**
 * Identity of a stock token from its symbol. `provider` is the token's own declaration where it has one
 * (`ondo-test` for Elpida's Ondo-style stand-in). Unknown tickers still get a tile; they just have no company name.
 */
export function stockIdentity(symbol, { provider = null, name = null } = {}) {
  const raw = String(symbol ?? '').trim();
  if (raw === 'TEST-STOCK') return { symbol: raw, ticker: 'TEST', company: 'Simulated stock', type: 'Stock', issuer: 'Test', test: true, tone: 'test', logo: null };
  let ticker = raw, issuer = null, test = provider === 'ondo-test';
  const ondo = raw.match(/^(t?)([A-Z.]{1,6})on$/);
  const xstock = raw.match(/^([A-Z.]{1,6})x$/);
  if (ondo) { ticker = ondo[2]; test = test || ondo[1] === 't'; issuer = 'Ondo'; }
  else if (xstock) { ticker = xstock[1]; issuer = 'xStocks'; }
  const known = STOCK_UNDERLYINGS[ticker];
  return {
    symbol: raw, ticker, issuer: test ? `${issuer ?? 'Stock'} (test)` : issuer, test,
    company: known?.company ?? (name || null), type: known?.type ?? 'Stock',
    tone: known?.tone ?? stockTone(ticker), logo: STOCK_LOGOS.has(ticker) ? `/assets/stocks/${ticker}.png` : null,
  };
}

/** True when a symbol reads as a tokenized stock (used where the pair kind is not at hand). */
export function looksLikeStock(symbol) {
  const s = String(symbol ?? '');
  if (s === 'TEST-STOCK') return true;
  const m = s.match(/^t?([A-Z.]{1,6})on$/) ?? s.match(/^([A-Z.]{1,6})x$/);
  return !!m && !!STOCK_UNDERLYINGS[m[1]];
}
