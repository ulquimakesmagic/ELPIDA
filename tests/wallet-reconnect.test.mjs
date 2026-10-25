// 24 Oct, ITACHI: with a slow wallet, clicking connect again replaced the page's RPC connection and destroyed the old
// one at once, so a quote still in flight failed with "provider destroyed; cancelled request". Reconnecting on the same
// network now keeps the connection; a replaced one is closed only after in-flight requests have had time to finish.
import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/browser-modules.mjs';
const { TestnetWallet, RETIRE_AFTER_MS } = await import('../apps/web/wallet.mjs');

const ACCOUNT = '0x' + 'f5'.repeat(20);
function fakeWallet(chainId) {
  const state = { chainId };
  return { state, request: async ({ method, params }) => {
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ACCOUNT];
    if (method === 'eth_chainId') return '0x' + state.chainId.toString(16);
    if (method === 'wallet_switchEthereumChain') { state.chainId = Number(BigInt(params[0].chainId)); return null; }
    if (method === 'wallet_getCapabilities') return {};
    throw Object.assign(new Error('unsupported'), { code: 4200 });
  } };
}
const net = (chainId, rpcUrl) => ({ chainId, key: 'net-' + chainId, name: 'Net ' + chainId, rpcUrl, explorer: 'https://x', nativeCurrency: { symbol: 'ETH' } });

test('reconnecting on the same network keeps the read connection; another network replaces it and closes the old one later', async () => {
  try {
    const eth = fakeWallet(84532), store = new Map();
    globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
    globalThis.window = { ethereum: eth, addEventListener() {}, dispatchEvent() {} };
    const w = Object.create(TestnetWallet.prototype);
    Object.assign(w, { net: net(84532, 'https://sepolia.base.test'), onProgress: () => {}, launches: new Map(), retireAfterMs: 50 });
    assert.equal(RETIRE_AFTER_MS, 60000, 'a minute in the app');
    await w.connect();
    const first = w.provider;
    await w.connect(); await w.connect();   // a slow wallet, clicked again
    assert.equal(w.provider, first, 'same network: the same connection, so in-flight quotes are not cancelled');
    assert.equal(first.destroyed, false);
    w.net = net(46630, 'https://rpc.robinhood.test');
    await w.connect();
    assert.notEqual(w.provider, first, 'another network gets its own connection');
    assert.equal(first.destroyed, false, 'the old one stays open while its requests finish');
    await new Promise(r => setTimeout(r, 120));
    assert.equal(first.destroyed, true, 'and is closed afterwards');
    assert.equal(w.provider.destroyed, false);
    w.provider.destroy();
  } finally { delete globalThis.window; }
});
