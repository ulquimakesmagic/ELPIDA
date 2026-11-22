// Real tokenized stocks as pair assets on mainnet, wired into the listings (Malik, 21 Nov 2026: SPIDERMAN/AAPLon on BNB
// Chain showed no price, market cap or liquidity, and Explore filed it under "Tokens"). Test stocks describe themselves
// (pairKind() === 'xstock'); real Ondo and Coinbase tokens do not, so the index called the pair 'token' and had no
// dollar rate for it. The network's verified stock list (config/stocks/<network>.json) says which pair assets are
// stocks; each stock's own feed, the one the V2 factory approved it with, is read once a minute through
// packages/core/stock-prices.mjs (#346: the reference shape and a cache that keeps the last good reading). Reads only.
import { Contract } from 'ethers';
import { StockReferences } from '../../packages/core/stock-prices.mjs';

const FEED = ['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)', 'function decimals() view returns (uint8)'];
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export class StockPrices {
  constructor({ networks = [], listFor, providerFor, refreshMs = 60_000, now = () => Math.floor(Date.now() / 1000), log = () => {} }) {
    Object.assign(this, { networks, listFor, providerFor, refreshMs });
    this.stocks = new Map();
    this.refs = new StockReferences({ now, log, read: (quote, network) => this.read(network, quote) });
  }
  /** The verified stocks of a network, by lowercase address. */
  stocksOf(key) {
    if (!this.stocks.has(key)) {
      const out = new Map();
      for (const s of this.listFor(key)?.stocks ?? []) if (ADDRESS.test(String(s.address ?? '')) && ADDRESS.test(String(s.feed ?? ''))) out.set(s.address.toLowerCase(), s);
      this.stocks.set(key, out);
    }
    return this.stocks.get(key);
  }
  isStock(key, address) { return this.stocksOf(key).has(String(address ?? '').toLowerCase()); }
  reference(key, address) { return this.refs.get(key, address); }
  /** One reading of a stock's approved feed, in the shape StockReferences expects. */
  async read(key, address) {
    const s = this.stocksOf(key).get(String(address).toLowerCase()), provider = this.providerFor(key);
    if (!s || !provider) return null;
    const feed = new Contract(s.feed, FEED, provider);
    const decimals = Number.isInteger(s.feedDecimals) ? s.feedDecimals : Number(await feed.decimals());
    const [, answer, , updatedAt] = await feed.latestRoundData();
    return { price: Number(answer) / 10 ** decimals, updatedAt: Number(updatedAt), maxAge: Number(s.maxAge ?? 345_600), feed: s.feed, source: `${s.symbol} price feed (${s.feedDescription ?? 'the feed the launchpad approved'})` };
  }
  refresh() { return this.refs.refresh(this.networks.flatMap(network => [...this.stocksOf(network).keys()].map(quote => ({ network, quote })))); }
  start() { const run = () => this.refresh().catch(() => {}); run(); this.timer = setInterval(run, this.refreshMs); this.timer.unref?.(); return this; }
  stop() { clearInterval(this.timer); }
  /** A listing row with a real stock pair marked 'xstock' and given its dollar rate. Other rows unchanged. */
  decorate(key, t) {
    if (!t || t.pair === 'native' || t.pair === 'usdc' || !this.isStock(key, t.quoteAddress)) return t;
    const ref = this.reference(key, t.quoteAddress), s = this.stocksOf(key).get(String(t.quoteAddress).toLowerCase());
    return { ...t, pair: 'xstock', stock: { ...(t.stock ?? {}), provider: s.provider ?? null, symbol: s.symbol, feed: s.feed }, ...(ref ? { usdReference: ref } : {}) };
  }
}
