// 20 November 2026: on elpida.fun the USDC and stock pairs were greyed out because the launch page read pairs from the
// curve launchpad, which mainnet does not have. Mainnet pairs now come from the V2 factory and the verified stock list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './helpers/browser-modules.mjs';
const { loadV2Pairs } = await import('../apps/web/v2-launchpad.mjs');

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const list = JSON.parse(readFileSync(new URL('../config/stocks/base-mainnet.json', import.meta.url), 'utf8'));
const net = { key: 'base-mainnet', chainId: 8453, mainnet: true, name: 'Base', usd: { usdc: USDC }, payoutStable: { symbol: 'USDC', decimals: 6 },
  v2: { shared: { factory: '0x29f0000000000000000000000000000000000001', hook: '0x29f0000000000000000000000000000000000002' } }, v4: { poolManager: '0x498581fF718922c3f8e6A244956aF099B2652b2b' } };
const uint = v => '0x' + BigInt(v).toString(16).padStart(64, '0');

test('loadV2Pairs: USDC when the factory approves it, plus every verified stock', async t => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  globalThis.fetch = async url => { assert.match(String(url), /\/api\/public\/stock-list\?network=base-mainnet$/); return new Response(JSON.stringify(list), { status: 200 }); };
  const w = { net, provider: { call: async () => uint(25_000_000_000n) } };
  const out = await loadV2Pairs(w);
  assert.equal(out[0].kind, 'usdc'); assert.equal(out[0].address, USDC); assert.equal(out[0].decimals, 6);
  const stocks = out.filter(a => a.kind === 'xstock');
  assert.equal(stocks.length, list.stocks.length);
  assert.ok(stocks.every(s => s.verified === true && !s.test));
  assert.equal(w.approvedQuotes, out);
  const none = { net, provider: { call: async () => uint(0) } };
  globalThis.fetch = async () => new Response('{}', { status: 404 });
  assert.deepEqual(await loadV2Pairs(none), [], 'no USDC approval and no list: nothing offered');
  globalThis.fetch = async () => new Response('oops', { status: 500 });
  await assert.rejects(loadV2Pairs(none), /stock list is unavailable/);
});

test('the wallet offers V2 pairs on mainnet and the launch page loads them; launches accept verified stocks', () => {
  const wallet = readFileSync(new URL('../apps/web/wallet.mjs', import.meta.url), 'utf8');
  const flow = readFileSync(new URL('../apps/web/launch-flow.mjs', import.meta.url), 'utf8');
  const v2 = readFileSync(new URL('../apps/web/v2-launchpad.mjs', import.meta.url), 'utf8');
  assert.match(wallet, /if \(this\.net\.mainnet && !this\.deployment\) \{/);
  assert.match(wallet, /Pairing with another token is not offered/);
  assert.match(flow, /ctx\.wallet\.loadV2Pairs\?\.\(\)\.then\(\(\) => draw\(\)\)/);
  assert.match(v2, /a\.kind === 'xstock' && \(a\.test \|\| a\.verified\)/);
  assert.match(v2, /launchStock\(w, body\.quoteAsset\)/);
  assert.match(flow, /'Mainnet beta: the contracts are new and not audited yet\.'/);
});
