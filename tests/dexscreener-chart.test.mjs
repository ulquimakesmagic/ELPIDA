// Mainnet token pages embed DexScreener's chart once DexScreener lists the pair (Malik, 20 November 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pickPair, createDexscreener, dexscreenerEmbed, DEXSCREENER_CHAINS } from '../apps/api/dexscreener.mjs';

const EBD = '0x674771d7974872db15bb9beab4d4b1f8aca379ad';
const POOL = '0xcd9cf6ae7447da8622f70ad98b056cdbcb2c14da3964582307a3d0000000000000000000';
const v4Pair = '0xcd9cf6ae7447da8622f70ad98b056cdbcb2c14da3964582307a3d1234567890abcdef0'.slice(0, 66);

test('pickPair takes the most liquid pair of this token on this chain', () => {
  const json = [
    { chainId: 'base', pairAddress: '0x' + '1'.repeat(40), baseToken: { address: EBD }, liquidity: { usd: 5 } },
    { chainId: 'base', pairAddress: v4Pair, baseToken: { address: EBD.toUpperCase().replace('0X', '0x') }, liquidity: { usd: 20000 } },
    { chainId: 'bsc', pairAddress: '0x' + '2'.repeat(40), baseToken: { address: EBD }, liquidity: { usd: 99999 } },
    { chainId: 'base', pairAddress: '0x' + '3'.repeat(40), baseToken: { address: '0x' + '9'.repeat(40) }, liquidity: { usd: 99999 } },
    { chainId: 'base', pairAddress: 'javascript:alert(1)', baseToken: { address: EBD } },
  ];
  assert.equal(pickPair(json, 'base', EBD), v4Pair);
  assert.equal(pickPair({}, 'base', EBD), null);
  assert.equal(DEXSCREENER_CHAINS['base-mainnet'], 'base');
  assert.match(dexscreenerEmbed('base', v4Pair), /^https:\/\/dexscreener\.com\/base\/0x[0-9a-f]{64}\?embed=1&/);
  assert.ok(POOL);
});

test('lookup: mainnets only, cached, and a failure means no embed', async () => {
  let calls = 0;
  const ds = createDexscreener({ fetchImpl: async url => { calls++; assert.equal(url, `https://api.dexscreener.com/token-pairs/v1/base/${EBD}`); return new Response(JSON.stringify([{ chainId: 'base', pairAddress: v4Pair, baseToken: { address: EBD } }])); } });
  const a = await ds.lookup('base-mainnet', EBD), b = await ds.lookup('base-mainnet', EBD);
  assert.equal(a.pair, v4Pair); assert.equal(b.embed, a.embed); assert.equal(calls, 1);
  assert.deepEqual(await ds.lookup('base-sepolia', EBD), { pair: null, embed: null });
  const down = createDexscreener({ fetchImpl: async () => { throw new Error('down'); } });
  assert.equal((await down.lookup('base-mainnet', EBD)).embed, null);
});

test('the server serves /api/public/dex-chart and lets pages frame dexscreener.com only; the token page swaps the chart', async t => {
  const server = readFileSync(new URL('../apps/api/server.mjs', import.meta.url), 'utf8');
  assert.match(server, /frame-src https:\/\/dexscreener\.com; frame-ancestors 'none'/);
  const { startServer } = await import('../apps/api/server.mjs');
  const fake = { lookup: async (n, tk) => ({ pair: v4Pair, embed: dexscreenerEmbed('base', v4Pair), page: 'https://dexscreener.com/base/' + v4Pair, n, tk }) };
  const app = await startServer({ port: 0, seed: false, publicUrl: 'https://elpida-preview.up.railway.app', dexscreener: fake });
  t.after(() => app.close());
  const r = await fetch(`${app.url}/api/public/dex-chart?network=base-mainnet&token=${EBD}`);
  assert.equal(r.status, 200); assert.equal((await r.json()).pair, v4Pair);
  assert.equal((await fetch(`${app.url}/api/public/dex-chart?network=base-mainnet&token=nope`)).status, 400);
  const page = readFileSync(new URL('../apps/web/token-page.mjs', import.meta.url), 'utf8');
  assert.match(page, /\/api\/public\/dex-chart\?network=/);
  assert.match(page, /chart\.replaceWith\(frame\)/);
  assert.match(page, /\^https:\\\/\\\/dexscreener\\\.com\\\//);
});
