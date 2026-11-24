import test from 'node:test';
import assert from 'node:assert/strict';
import { createRobinhoodStockIcons, robinhoodLogoUrl } from '../apps/api/robinhood-stock-icons.mjs';
import { stockIdentity } from '../packages/core/stock-catalog.mjs';

const TSLA = '0x322F0929c4625eD5bAd873c95208D54E1c003b2d';
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(100).fill(1)]);

test('Robinhood stock tokens show Robinhood\'s logo, by token address, through this site', () => {
  const id = stockIdentity('TSLA', { name: 'Tesla (Robinhood)', address: TSLA });
  assert.equal(id.issuer, 'Robinhood'); assert.equal(id.ticker, 'TSLA');
  assert.equal(id.logo, `/api/public/robinhood-stock-icon/${TSLA.toLowerCase()}.png`);
  assert.equal(stockIdentity('TSLA', { name: 'Tesla (Robinhood)' }).logo, null, 'no address, no logo: the ticker tile');
  assert.equal(stockIdentity('TSLA', { name: 'Tesla' }).issuer, null, 'only Robinhood-named tokens');
  assert.equal(robinhoodLogoUrl(TSLA), `https://cdn.robinhood.com/ncw_assets/logos/${TSLA.toLowerCase()}.png`);
  assert.equal(robinhoodLogoUrl('nope'), null);
});

test('the icon is fetched once, only for listed tokens, and only if it really is an image', async () => {
  const calls = []; let body = png;
  const fetchImpl = async url => { calls.push(url); return { ok: true, status: 200, arrayBuffer: async () => body.buffer }; };
  let t = 0; const icons = createRobinhoodStockIcons({ fetchImpl, now: () => t, listed: a => a === TSLA.toLowerCase() });
  assert.equal(await icons.icon('0x' + '1'.repeat(40)), null, 'not on the list: nothing fetched');
  assert.equal(calls.length, 0);
  const img = await icons.icon(TSLA); assert.equal(img.type, 'image/png');
  await icons.icon(TSLA.toLowerCase()); assert.equal(calls.length, 1, 'cached');
  body = new Uint8Array(200); const other = createRobinhoodStockIcons({ fetchImpl, now: () => t, listed: () => true });
  assert.equal(await other.icon(TSLA), null, 'not an image: refused');
  assert.equal(await other.icon(TSLA), null); assert.equal(calls.length, 2, 'a failure waits before retrying');
  t += 3_600_001; await other.icon(TSLA); assert.equal(calls.length, 3);
  const down = createRobinhoodStockIcons({ fetchImpl: async () => ({ ok: false, status: 404 }), listed: () => true });
  assert.equal(await down.icon(TSLA), null);
});
