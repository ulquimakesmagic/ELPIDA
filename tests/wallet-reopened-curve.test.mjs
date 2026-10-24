// 24 Oct: the trade panel on every Base Sepolia token said the wallet "could not read this network". The wallet's read
// of the launchpad's tokens called completionQuote() on AIZEN's reopened, fully sold curve, which reverts (audit F-8),
// and one revert failed the whole read. The public indexer was fixed the day before; this is the wallet side.
import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/browser-modules.mjs';
import { dexFixture, launch, complete, mined, art } from './helpers/dex-fixture.mjs';
const { TestnetWallet } = await import('../apps/web/wallet.mjs');

const GRACE = 3600;
function walletOn(f, deployment) {
  const store = new Map(); globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  const c = n => ({ abi: art(n).abi, bytecode: '0x' + art(n).evm.bytecode.object });
  const net = { chainId: 31337, key: 'local-reopen', name: 'Local', nativeCurrency: { symbol: 'ETH' } };
  // As a launchpad set up from this browser is saved (not pinned for everyone, so no public pair index is needed).
  store.set('elpida:curve-dex-v10:deployment:31337', JSON.stringify(deployment));
  const w = Object.create(TestnetWallet.prototype);
  Object.assign(w, {
    net, provider: f.provider, onProgress: () => {}, launches: new Map(), address: f.addresses[0],
    _eth: { request: async ({ method }) => method === 'eth_chainId' ? '0x7a69' : method === 'eth_accounts' ? [w.address] : null },
    config: { oracles: { [net.key]: { feed: f.feed.target, maxAge: 86400, usdc: null, available: true } }, publicDexes: { [net.key]: f.dex.config },
      contracts: { adapter: c('ElpidaV3MigrationAdapter'), dexFactory: c('ElpidaDexFactory'), legacyFactory: c('ElpidaBetaFactory'), dexCurve: { abi: art('ElpidaDexCurve').abi }, legacyCurve: { abi: art('ElpidaBetaCurve').abi }, token: { abi: art('ElpidaToken').abi }, pool: { abi: art('ElpidaDexCurve').abi }, quote: { abi: art('ElpidaToken').abi } } },
  });
  Object.defineProperty(w, 'eth', { get: () => w._eth });
  return w;
}

test('the wallet reads a launchpad that has a reopened, fully sold curve; buying resumes after a holder sells', async t => {
  const f = await dexFixture(t, { grace: GRACE }), start = await f.provider.getBlockNumber();
  const reopened = await launch(f, { name: 'Aizen', symbol: 'AIZEN' }), other = await launch(f, { name: 'Other', symbol: 'OTHER' });
  await complete(f, reopened); await f.advance(GRACE + 1); await mined(reopened.curve.connect(f.signers[3]).reopen());
  await assert.rejects(reopened.curve.completionQuote(), 'the contract view reverts (F-8)');
  globalThis.fetch = async () => ({ ok: false });   // no public index here: the wallet scans the chain
  const w = walletOn(f, { factory: f.factory.target, block: start, model: 'curve-dex-v10' });
  const state = await w.state();
  const aizen = state.tokens.find(x => x.symbol === 'AIZEN'), live = state.tokens.find(x => x.symbol === 'OTHER');
  assert.equal(aizen.soldOut, true); assert.equal(aizen.complete, false); assert.equal(aizen.remainingBuy, '0'); assert.equal(aizen.remainingBase, '0');
  assert.equal(live.soldOut, false); assert.ok(Number(live.remainingBuy) > 0, 'other tokens read normally');
  // A holder sells: tokens are available again and the wallet shows what is left.
  const held = await reopened.token.balanceOf(f.addresses[0]);
  await mined(reopened.token.approve(reopened.curve.target, held)); await mined(reopened.curve.sell(held / 10n, 0n));
  const after = (await w.state()).tokens.find(x => x.symbol === 'AIZEN');
  assert.equal(after.soldOut, false); assert.ok(Number(after.remainingBuy) > 0);
});
