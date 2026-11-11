// Public V2 rewards (analytics page, Rewards section): one read-only rewards index per network that has a pinned V2
// deployment in networks.mjs (`v2.shared`: hook, airdrop, holder, flywheel, block). No deployment, no section: the page
// hides it rather than showing invented figures. Never takes user RPCs or keys.
import { JsonRpcProvider, ZeroAddress, Contract } from 'ethers';
import { V2RewardsIndexer, toJson } from '../../packages/indexer/v2-rewards.mjs';
import { usdOracles } from '../../packages/core/usd-oracles.mjs';
import { payoutStable } from '../../packages/core/payout-stable.mjs';

const TICK_MS = 60_000, FEED_MAX_AGE = 4 * 86_400, PRICE_TTL_MS = 5 * 60_000;
const FEED_ABI = ['function decimals() view returns(uint8)', 'function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)'];

/**
 * USD per unit of a stock pair asset, from its price feed (Malik, 11 Nov: every reward figure in USD, never in the pair
 * asset). The feed is the one the V2 factory prices launches with (`quoteFeeds`), else the test stock's own
 * `referenceFeed`. Null when there is no feed, or its answer is invalid or older than four days.
 */
export async function stockUsd(provider, factory, asset) {
  let feed = null;
  if (factory) try { const q = await new Contract(factory, ['function quoteFeeds(address) view returns(address feed,uint256 maxAge)'], provider).quoteFeeds(asset); if (BigInt(q[0]) !== 0n) feed = q[0]; } catch {}
  if (!feed) try { feed = await new Contract(asset, ['function referenceFeed() view returns(address)'], provider).referenceFeed(); } catch {}
  if (!feed || BigInt(feed) === 0n) return null;
  try {
    const f = new Contract(feed, FEED_ABI, provider), [decimals, round] = await Promise.all([f.decimals(), f.latestRoundData()]);
    const age = Math.floor(Date.now() / 1000) - Number(round[3]);
    if (round[1] <= 0n || round[4] < round[0] || age > FEED_MAX_AGE) return null;
    return Number(round[1]) / 10 ** Number(decimals);
  } catch { return null; }
}

export class V2RewardsService {
  constructor({ networks, providerFactory = rpc => new JsonRpcProvider(rpc, undefined, { cacheTimeout: -1, batchMaxCount: 1 }), log = console.log, oracles = usdOracles() }) {
    this.log = log; this.entries = []; this.oracles = oracles;
    for (const net of networks.filter(n => !n.mainnet && n.v2?.shared?.hook)) {
      const d = net.v2.shared;
      const provider = providerFactory(net.rpcUrl);
      this.entries.push({ net, provider, prices: new Map(), index: new V2RewardsIndexer({ provider, contracts: { hook: d.hook, airdrop: d.airdrop, holder: d.holder, flywheel: d.flywheel, usdcAirdrop: d.usdcAirdrop, usdcHolder: d.usdcHolder }, keeper: d.keeper, fromBlock: d.block, batchSize: 100 }), busy: false });
    }
  }
  get deployed() { return this.entries.length > 0; }
  start() {
    if (!this.deployed) return this;
    const run = () => { for (const e of this.entries) if (!e.busy) { e.busy = true; e.index.sync().then(() => this.refreshPrices(e)).catch(err => this.log(`[v2-rewards] ${e.net.key}: ${err.message}`)).finally(() => { e.busy = false; }); } };
    run(); this.timer = setInterval(run, TICK_MS); this.timer.unref?.();
    return this;
  }
  stop() { clearInterval(this.timer); }

  /** Prices every non-native, non-stablecoin pair asset seen in the index from its feed (cached five minutes). */
  async refreshPrices(e, nowMs = Date.now()) {
    const stable = payoutStable(e.net, this.oracles)?.address?.toLowerCase(), usdc = this.oracles?.[e.net.key]?.usdc?.toLowerCase?.();
    const quotes = new Set([...e.index.tokens.values()].map(t => String(t.quote).toLowerCase()));
    for (const q of quotes) {
      if (BigInt(q) === 0n || q === stable || q === usdc) continue;
      const cached = e.prices.get(q);
      if (cached && nowMs - cached.at < PRICE_TTL_MS) continue;
      e.prices.set(q, { usd: await stockUsd(e.provider, e.net.v2.shared.factory, q), at: nowMs });
    }
  }

  /**
   * `prices`: the server's price snapshot (native USD per network); USD figures are only given with a fresh price.
   * `quotes(key)`: the network's V2 token records, for the symbol and decimals of ERC-20 pair assets (USDC at $1).
   */
  summary(prices = {}, now = Math.floor(Date.now() / 1000), quotes = () => []) {
    if (!this.deployed) return { deployed: false, chains: [] };
    return { deployed: true, updatedAt: now, chains: this.entries.map(({ net, index }) => {
      const p = prices[net.key], fresh = p?.status === 'fresh' && Number.isFinite(p.usd) && p.usd > 0;
      const assets = { [ZeroAddress]: { symbol: net.nativeCurrency.symbol, decimals: 18, usd: fresh ? p.usd : null } };
      // The payout stablecoin (USDC, USDG or a labelled test dollar) is always known, at $1.
      const stable = payoutStable(net, this.oracles);
      if (stable) assets[stable.address.toLowerCase()] = { symbol: stable.symbol, decimals: stable.decimals, usd: 1 };
      const priced = a => this.entries.find(x => x.net === net)?.prices.get(a)?.usd ?? null;
      for (const t of quotes(net.key) ?? []) if (t?.quoteAddress && t.pair !== 'native' && !assets[t.quoteAddress.toLowerCase()]) { const a = t.quoteAddress.toLowerCase(); assets[a] = { symbol: t.quoteSymbol ?? 'token', decimals: Number(t.quoteDecimals ?? 18), usd: t.pair === 'usdc' ? 1 : priced(a) }; }
      // Pair assets the index saw that the public listings have not (yet): still priced when their feed answers.
      for (const [a, p] of this.entries.find(x => x.net === net)?.prices ?? []) if (!assets[a] && p.usd) assets[a] = { symbol: 'stock', decimals: 18, usd: p.usd };
      return { key: net.key, name: net.name, explorer: net.explorer ?? null, testnet: true, assets, ...toJson(index.summary(now)) };
    }) };
  }

  /** The V2 flywheel's burns on one network (lowercase token → base units); empty where V2 is not deployed. */
  burnedByToken(key) { return this.entries.find(e => e.net.key === key)?.index.burnedByToken() ?? new Map(); }

  payouts(wallet) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(wallet ?? ''))) throw new Error('Enter a wallet address.');
    return { wallet: wallet.toLowerCase(), chains: this.entries.map(({ net, index }) => ({ key: net.key, name: net.name, payouts: toJson(index.payoutsOf(wallet)) })) };
  }
}
