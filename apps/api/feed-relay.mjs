// Testnet price relay. Some test chains have no Chainlink feed (Robinhood Chain testnet), and an Elpida factory needs
// a Chainlink-compatible USD feed no older than its maximum price age. This copies Chainlink's ETH / USD rounds from
// another test network into that chain's ElpidaRelayFeed (contracts/evm/testnet), keeping each source round's own
// timestamp: a relayed price is never fresher than Chainlink's, so a stopped relay shows up as a stale price and the
// factory refuses launches, exactly as with Chainlink.
//
// It signs with a TESTNET-ONLY key (ELPIDA_TESTNET_RELAY_KEY), refuses any chain that is not a known test network, and
// only ever calls `post` on a feed whose on-chain updater, source and source chain match this configuration.
import { Contract, JsonRpcProvider, Wallet, formatEther } from 'ethers';

/** Chain IDs the relay may sign on. Everything else, mainnets included, is refused. */
export const RELAY_TEST_CHAINS = Object.freeze(new Set([46630]));
const SOURCE_TEST_CHAINS = new Set([84532, 11155111, 97]);
const feedAbi = ['function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)', 'function decimals() view returns(uint8)'];
const relayAbi = [...feedAbi, 'function updater() view returns(address)', 'function source() view returns(address)', 'function sourceChainId() view returns(uint256)', 'function latestRound() view returns(uint80)', 'function post(int256,uint256,uint80)'];
const KEY = /^0x[0-9a-fA-F]{64}$/;
/** Below this the relay wallet warns: about 1,500 posts at Robinhood testnet's 0.01 gwei. */
export const RELAY_LOW_BALANCE = 10n ** 15n;

export class FeedRelay {
  constructor({ networks, env = process.env, providerFactory = url => new JsonRpcProvider(url, undefined, { batchMaxCount: 1 }), log = console.log, now = () => Date.now() / 1000, testChains = RELAY_TEST_CHAINS, sourceChains = SOURCE_TEST_CHAINS } = {}) {
    this.log = log; this.now = now; this.testChains = testChains; this.sourceChains = sourceChains; this.providerFactory = providerFactory; this.state = new Map(); this.providers = new Map();
    const key = String(env.ELPIDA_TESTNET_RELAY_KEY ?? '').trim();
    this.configured = KEY.test(key);
    this.misconfigured = !!key && !this.configured;
    this.wallet = this.configured ? new Wallet(key) : null;
    const byKey = new Map(networks.map(n => [n.key, n]));
    this.targets = networks.filter(n => n.relay).map(net => {
      const src = byKey.get(net.relay.source?.network);
      return { net, source: src, feed: net.relay.feed ?? null, sourceFeed: net.relay.source?.feed, maxAge: net.relay.maxAge };
    });
    for (const t of this.targets) this.state.set(t.net.key, { feed: t.feed, error: null, lastPost: null, relayedUpdatedAt: null, sourceUpdatedAt: null, answer: null, balance: null });
  }
  get address() { return this.wallet?.address ?? null; }
  provider(url) { if (!this.providers.has(url)) this.providers.set(url, this.providerFactory(url)); return this.providers.get(url); }
  /** Public, safe view: the relay's address (never the key) and each feed's state. */
  status() {
    return { enabled: this.configured, misconfigured: this.misconfigured, address: this.address, networks: Object.fromEntries([...this.state].map(([k, s]) => [k, { ...s, maxAge: this.targets.find(t => t.net.key === k)?.maxAge ?? null }])) };
  }
  /** What the browser needs to deploy a relay feed: the updater address and the source feed. */
  publicConfig() {
    return { address: this.address, networks: Object.fromEntries(this.targets.map(t => [t.net.key, { feed: t.feed, source: { network: t.source?.key ?? null, chainId: t.source?.chainId ?? null, feed: t.sourceFeed ?? null }, maxAge: t.maxAge }])) };
  }
  async tick() {
    if (this.running) return; this.running = true;
    try { for (const t of this.targets) await this.relay(t).catch(error => this.fail(t, error)); }
    finally { this.running = false; }
  }
  fail(t, error) {
    const s = this.state.get(t.net.key), code = String(error?.relayCode ?? error?.code ?? 'RELAY_ERROR').replace(/[^A-Za-z0-9_]/g, '').slice(0, 64);
    if (s.error !== code) this.log(JSON.stringify({ event: 'price_relay_error', network: t.net.key, code }));
    s.error = code;
  }
  async relay(t) {
    const s = this.state.get(t.net.key), refuse = code => { throw Object.assign(new Error(code), { relayCode: code }); };
    if (!this.testChains.has(t.net.chainId) || t.net.mainnet) refuse('NOT_A_TEST_CHAIN');
    if (!t.source || !this.sourceChains.has(t.source.chainId) || !t.sourceFeed) refuse('SOURCE_NOT_CONFIGURED');
    if (!t.feed) { s.error = 'FEED_NOT_DEPLOYED'; return; }
    if (!this.wallet) refuse('RELAY_KEY_MISSING');
    const target = this.provider(t.net.rpcUrl), source = new Contract(t.sourceFeed, feedAbi, this.provider(t.source.rpcUrl));
    const feed = new Contract(t.feed, relayAbi, target);
    if (Number((await target.getNetwork()).chainId) !== t.net.chainId) refuse('WRONG_CHAIN');
    const [updater, recorded, recordedChain, decimals, sourceDecimals] = await Promise.all([feed.updater(), feed.source(), feed.sourceChainId(), feed.decimals(), source.decimals()]);
    if (updater.toLowerCase() !== this.wallet.address.toLowerCase()) refuse('NOT_THE_UPDATER');
    if (recorded.toLowerCase() !== t.sourceFeed.toLowerCase() || Number(recordedChain) !== t.source.chainId) refuse('SOURCE_MISMATCH');
    if (Number(decimals) !== Number(sourceDecimals)) refuse('DECIMALS_MISMATCH');
    const [round, answer, , updatedAt, answeredIn] = await source.latestRoundData();
    if (!(answer > 0n && round > 0n && answeredIn >= round && updatedAt > 0n)) refuse('INVALID_SOURCE_ROUND');
    const latest = await feed.latestRound(), relayed = latest > 0n ? (await feed.latestRoundData())[3] : 0n;
    s.sourceUpdatedAt = Number(updatedAt); s.relayedUpdatedAt = Number(relayed);
    s.balance = formatEther(await target.getBalance(this.wallet.address));
    if (updatedAt <= relayed) { s.error = null; return; }
    if (BigInt(Math.floor(this.now())) - updatedAt > BigInt(t.maxAge)) refuse('SOURCE_STALE');
    const tx = await feed.connect(this.wallet.connect(target)).post(answer, updatedAt, round);
    const receipt = await tx.wait(1, 120000);
    if (receipt?.status !== 1) refuse('POST_REVERTED');
    Object.assign(s, { error: null, lastPost: { hash: receipt.hash, at: new Date(this.now() * 1000).toISOString() }, relayedUpdatedAt: Number(updatedAt), answer: answer.toString(), balance: formatEther(await target.getBalance(this.wallet.address)) });
    this.log(JSON.stringify({ event: 'price_relay_posted', network: t.net.key, round: round.toString(), updatedAt: Number(updatedAt), hash: receipt.hash }));
  }
  start(intervalMs = 60000) { this.job = this.tick(); this.timer = setInterval(() => { this.job = this.tick(); }, intervalMs); this.timer.unref?.(); return this; }
  async close() { clearInterval(this.timer); await this.job; for (const p of this.providers.values()) p.destroy?.(); }
}
