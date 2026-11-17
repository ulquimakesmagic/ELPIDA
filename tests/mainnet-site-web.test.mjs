// The mainnet site's wording and launch options (17 November 2026): no "testnet" in the served page, Solana hidden
// until it is on mainnet, and V2 launches without holder strategies or X/website allocations in the first release.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { siteHtml, seoText } from '../apps/api/site-copy.mjs';
import { PAGES, renderPage, renderLlms } from '../packages/core/seo.mjs';

const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('the mainnet site serves index.html without testnet wording; the testnet site is unchanged', () => {
  const html = read('apps/web/index.html');
  assert.equal(siteHtml(html, { mode: 'testnet', names: [] }), html);
  const page = siteHtml(html, { mode: 'mainnet', names: ['Base'] });
  assert.deepEqual([...page.matchAll(/.{0,40}test ?net.{0,40}/gi)].map(m => m[0]), [], 'no testnet wording left');
  assert.match(page, /<meta name="description" content="[^"]*Elpida is live on Base mainnet\."/);
  assert.equal((page.match(/Live on Base mainnet\./g) ?? []).length, 2, 'Open Graph and Twitter previews');
  assert.match(page, /<span id="footer-note">Base mainnet: real funds\. The contracts are not independently audited\.<\/span>/);
  assert.match(page, /graduates in that same pool/);
  assert.match(siteHtml(html, { mode: 'mainnet', names: ['Base', 'BNB Chain'] }), /Live on Base, BNB Chain mainnet\./);
});

test('the site hides a switched-off Solana, labels mainnet networks and keeps holder strategies off on mainnet', () => {
  const app = read('apps/web/app.mjs'), flow = read('apps/web/launch-flow.mjs');
  assert.match(app, /const networks = \(\) => \[\.\.\.config\.testnets, \.\.\.\(config\.solana && !config\.solana\.disabled \? \[config\.solana\] : \[\]\)\];/);
  assert.match(app, /saved === config\.solana\.key && !config\.solana\.disabled/);
  assert.match(app, /if \(mainnetSite\(\)\) \{\s*const names/);
  assert.match(app, /item\.mainnet \? 'Mainnet beta · real funds'/);
  assert.match(flow, /const v2Strategies = \(\) => v2Splits\(\) && !net\(\)\?\.mainnet &&/);
  assert.match(flow, /net\(\)\?\.mainnet \? 'Holder strategies and X or website allocations are not on mainnet yet/);
  assert.match(read('apps/web/analytics-view.mjs'), /mainnetSite \? '' : ' Testnet tokens have no monetary value\.'/);
});

test('the server exposes the site mode to the browser and serves the page through siteHtml', () => {
  assert.match(read('apps/api/curve-runtime.mjs'), /testnets:evmNetworks,siteMode:evm\.mode,/);
  assert.match(read('apps/api/server.mjs'), /siteHtml\(staticAssets\.html\(.*\), \{ mode: evm\.mode, names: evmNetworks\.map\(n => n\.name\) \}\)/);
});

test('the /learn guides, the FAQ and llms.txt carry no testnet wording on the mainnet site', () => {
  const pages = [...PAGES.map(p => renderPage(p)), renderLlms()];
  for (const page of pages) assert.equal(seoText(page, { mode: 'testnet', names: [] }), page, 'the testnet site is unchanged');
  const out = pages.map(p => seoText(p, { mode: 'mainnet', names: ['Base'] })).join('\n');
  assert.deepEqual([...out.matchAll(/.{0,40}(test ?net|Sepolia|Devnet).{0,40}/gi)].map(m => m[0]), []);
  // The real-money answer reaches both the visible FAQ and its JSON-LD copy.
  assert.equal((out.match(/Yes, on Base mainnet\. Its contracts have not had an independent audit/g) ?? []).length >= 2, true);
  assert.match(out, /Not yet: tokenized stocks are switched off for the first mainnet release\./);
});
