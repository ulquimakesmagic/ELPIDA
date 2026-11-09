// Public V2 rewards (analytics page, Rewards section): one read-only rewards index per network that has a pinned V2
// deployment in networks.mjs (`v2.shared`: hook, airdrop, holder, flywheel, block). No deployment, no section: the page
// hides it rather than showing invented figures. Never takes user RPCs or keys.
import { JsonRpcProvider, ZeroAddress } from 'ethers';
import { V2RewardsIndexer, toJson } from '../../packages/indexer/v2-rewards.mjs';

const TICK_MS = 60_000;

export class V2RewardsService {
  constructor({ networks, providerFactory = rpc => new JsonRpcProvider(rpc, undefined, { cacheTimeout: -1, batchMaxCount: 1 }), log = console.log }) {
    this.log = log; this.entries = [];
    for (const net of networks.filter(n => !n.mainnet && n.v2?.shared?.hook)) {
      const d = net.v2.shared;
      this.entries.push({ net, index: new V2RewardsIndexer({ provider: providerFactory(net.rpcUrl), contracts: { hook: d.hook, airdrop: d.airdrop, holder: d.holder, flywheel: d.flywheel }, fromBlock: d.block, batchSize: 2000 }), busy: false });
    }
  }
  get deployed() { return this.entries.length > 0; }
  start() {
    if (!this.deployed) return this;
    const run = () => { for (const e of this.entries) if (!e.busy) { e.busy = true; e.index.sync().catch(err => this.log(`[v2-rewards] ${e.net.key}: ${err.message}`)).finally(() => { e.busy = false; }); } };
    run(); this.timer = setInterval(run, TICK_MS); this.timer.unref?.();
    return this;
  }
  stop() { clearInterval(this.timer); }

  /** `prices`: the server's price snapshot (native USD per network); USD figures are only given with a fresh price. */
  summary(prices = {}, now = Math.floor(Date.now() / 1000)) {
    if (!this.deployed) return { deployed: false, chains: [] };
    return { deployed: true, updatedAt: now, chains: this.entries.map(({ net, index }) => {
      const p = prices[net.key], fresh = p?.status === 'fresh' && Number.isFinite(p.usd) && p.usd > 0;
      const assets = { [ZeroAddress]: { symbol: net.nativeCurrency.symbol, decimals: 18, usd: fresh ? p.usd : null } };
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
