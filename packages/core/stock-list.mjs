// The verified stock list per chain (Malik, 10 November: 100+ stocks on mainnet). Candidates come from the issuer's and
// the oracle's published lists (Ondo's addresses page and API, Chainlink's Ondo GM feed list), never typed by hand, and
// each one is checked on chain before it can be approved on a V2 launchpad: the token is a contract with the expected
// symbol and sane decimals, and its feed is a contract whose description names the stock and whose latest answer is
// valid. The result is config/stocks/<network>.json; the operator panel turns it into Safe batches of
// approvePricedQuote calls (25 per transaction), skipping stocks already approved.

export const STOCK_LIST_SCHEMA = 'elpida-stock-list-v1';
export const STOCK_BATCH_SIZE = 25;
/** Default limit on a stock feed's age when it prices a launch: a weekend and a market holiday. */
export const STOCK_FEED_MAX_AGE = 4 * 86_400;

const TOKEN_ABI = ['function symbol() view returns(string)', 'function decimals() view returns(uint8)'];
const FEED_ABI = ['function decimals() view returns(uint8)', 'function description() view returns(string)', 'function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)'];
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** "TSLAon" → "TSLA": the underlying ticker, for matching the feed's description ("TSLAon / USD" or "TSLA / USD"). */
export const underlying = symbol => String(symbol).replace(/on$/, '').toUpperCase();

/**
 * Checks one candidate { symbol, name?, address, feed, maxAge? } on chain. `Contract` and `provider` are ethers'.
 * Returns { ok: true, stock } with what was read, or { ok: false, symbol, reason }.
 */
export async function verifyStock({ Contract, provider, now }, c) {
  const symbol = String(c?.symbol ?? '').trim(), fail = reason => ({ ok: false, symbol: symbol || '(no symbol)', address: c?.address ?? null, reason });
  if (!/^[A-Za-z0-9.]{1,16}$/.test(symbol)) return fail('symbol missing or malformed');
  if (!ADDRESS.test(c.address ?? '')) return fail('token address malformed');
  if (!ADDRESS.test(c.feed ?? '')) return fail('feed address malformed');
  const maxAge = Number(c.maxAge ?? STOCK_FEED_MAX_AGE);
  if (!Number.isInteger(maxAge) || maxAge <= 0 || maxAge > STOCK_FEED_MAX_AGE) return fail('maxAge must be 1 second to 4 days');
  try {
    if ((await provider.getCode(c.address)) === '0x') return fail('no contract at the token address');
    if ((await provider.getCode(c.feed)) === '0x') return fail('no contract at the feed address');
    const token = new Contract(c.address, TOKEN_ABI, provider), feed = new Contract(c.feed, FEED_ABI, provider);
    const [onSymbol, decimals, feedDecimals, description, round] = await Promise.all([token.symbol(), token.decimals(), feed.decimals(), feed.description(), feed.latestRoundData()]);
    if (onSymbol !== symbol) return fail(`the token's symbol is ${onSymbol}, not ${symbol}`);
    if (Number(decimals) < 6 || Number(decimals) > 18) return fail(`unsupported decimals ${decimals}`);
    if (Number(feedDecimals) > 18) return fail(`unsupported feed decimals ${feedDecimals}`);
    if (!new RegExp(`(^|[^A-Z])${underlying(symbol).replace('.', '\\.')}(ON)?\\s*/\\s*USD`, 'i').test(description)) return fail(`the feed is "${description}", not ${underlying(symbol)} / USD`);
    const [id, answer, , updatedAt, answered] = round;
    if (!(answer > 0n) || !(id > 0n) || answered < id || Number(updatedAt) <= 0 || Number(updatedAt) > now + 60) return fail('the feed has no valid answer');
    return { ok: true, stock: { symbol, name: c.name ?? null, address: c.address, decimals: Number(decimals), feed: c.feed, feedDecimals: Number(feedDecimals), feedDescription: description, maxAge,
      priceUsd: Number(answer) / 10 ** Number(feedDecimals), priceUpdatedAt: Number(updatedAt) } };
  } catch (e) { return fail(`read failed: ${String(e.shortMessage ?? e.message).slice(0, 160)}`); }
}

/** Checks every candidate (duplicates by address or symbol are refused) and returns the list file and the rejects. */
export async function buildStockList({ Contract, provider, network, chainId, source, candidates, now = Math.floor(Date.now() / 1000) }) {
  const stocks = [], rejected = [], seen = new Set();
  for (const c of candidates) {
    const keyA = String(c?.address ?? '').toLowerCase(), keyS = String(c?.symbol ?? '').toUpperCase();
    if (seen.has(keyA) || seen.has(keyS)) { rejected.push({ symbol: c?.symbol ?? null, address: c?.address ?? null, reason: 'duplicate' }); continue; }
    seen.add(keyA); seen.add(keyS);
    const r = await verifyStock({ Contract, provider, now }, c);
    if (r.ok) stocks.push(r.stock); else rejected.push(r);
  }
  stocks.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { list: { schema: STOCK_LIST_SCHEMA, network, chainId, source, checkedAt: new Date(now * 1000).toISOString(), stocks }, rejected };
}

/** Throws unless `list` is a stock list file for `chainId`. */
export function checkStockList(list, chainId) {
  if (list?.schema !== STOCK_LIST_SCHEMA || !Array.isArray(list.stocks)) throw new Error('Not an Elpida stock list.');
  if (Number(list.chainId) !== Number(chainId)) throw new Error(`This stock list is for chain ${list.chainId}, not ${chainId}.`);
  for (const s of list.stocks) if (!ADDRESS.test(s.address ?? '') || !ADDRESS.test(s.feed ?? '') || !(s.maxAge > 0 && s.maxAge <= STOCK_FEED_MAX_AGE)) throw new Error(`Stock list entry ${s.symbol ?? '?'} is malformed.`);
  return list;
}

/** The approvePricedQuote calls for the listed stocks not yet approved, in groups of STOCK_BATCH_SIZE. */
export function stockApprovalGroups({ iface, factory, list, approved }) {
  const todo = list.stocks.filter(s => !approved.has(s.address.toLowerCase()));
  const calls = todo.map(s => ({ to: factory, value: 0n, data: iface.encodeFunctionData('approvePricedQuote', [s.address, s.feed, s.maxAge]), symbol: s.symbol }));
  const groups = [];
  for (let i = 0; i < calls.length; i += STOCK_BATCH_SIZE) groups.push(calls.slice(i, i + STOCK_BATCH_SIZE));
  return groups;
}
