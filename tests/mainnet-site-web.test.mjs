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

test('the site hides a switched-off Solana, labels mainnet networks and offers holder strategies on mainnet (since 20 Nov)', () => {
  const app = read('apps/web/app.mjs'), flow = read('apps/web/launch-flow.mjs');
  assert.match(app, /const networks = \(\) => \[\.\.\.config\.testnets, \.\.\.\(config\.solana && !config\.solana\.disabled \? \[config\.solana\] : \[\]\)\];/);
  assert.match(app, /saved === config\.solana\.key && !config\.solana\.disabled/);
  assert.match(app, /if \(mainnetSite\(\)\) \{\s*const names/);
  assert.match(app, /item\.mainnet \? 'Mainnet beta · real funds'/);
  assert.match(flow, /const v2Strategies = \(\) => v2Splits\(\) && \(solana\(\)/);
  assert.match(flow, /net\(\)\?\.mainnet \? 'Mainnet beta; not audited\.'/);
  assert.match(app, /config\.v2Keeper\?\.distributions \?/);
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

// 20 November 2026: the first Base mainnet launch was blocked ("Base is not set up for launches yet") because the
// launch page checked for a curve launchpad, which mainnet never has, and the server served no Base USD oracle.
test('a mainnet V2 launch needs only the V2 launchpad; the server serves mainnet USD oracles', async () => {
  const flow = readFileSync(new URL('../apps/web/launch-flow.mjs', import.meta.url), 'utf8');
  assert.match(flow, /draft\.chain !== 'local' && v2Chosen\(\) \? connected\(\)/);
  assert.match(flow, /!ctx\.wallet\.deployment && !\(n\.kind !== 'solana' && v2Offered\(\)\)/);
  assert.match(flow, /ctx\.wallet\.price\?\?ctx\.config\.prices\?\.\[draft\.chain\]/);
  assert.match(flow, /ELPIDA V2\$\{net\(\)\?\.mainnet \? '' : ' test'\}/);
  assert.match(readFileSync(new URL('../apps/api/curve-runtime.mjs', import.meta.url), 'utf8'), /oracles:usdOracles\(process\.env,evmNetworks\)/);
  const { usdOracles } = await import('../packages/core/usd-oracles.mjs');
  const o = usdOracles({}, [{ key: 'base-mainnet', mainnet: true, usd: { feed: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70', usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', maxAge: 1500 } }]);
  assert.equal(o['base-mainnet'].available, true);
});

test('holder strategies on mainnet: Base pins Uniswap v3 for reward swaps; the vault deploy uses it when no test DEX exists', async () => {
  const { EVM_MAINNETS } = await import('../packages/core/mainnets.mjs');
  const base = EVM_MAINNETS.find(n => n.key === 'base-mainnet');
  assert.deepEqual({ ...base.rewardDex }, { factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', router: '0x2626664c2603336E57B271c5C0b26F421741e481', weth: '0x4200000000000000000000000000000000000006', routerVersion: 2 });
  const v2 = read('apps/web/v2-launchpad.mjs');
  assert.match(v2, /const dex = w\.dex \?\? w\.net\.rewardDex \?\? null;/);
  assert.match(v2, /deploy\(keeper\.address, d\.hook, d\.router, dex\?\.router \?\? ZeroAddress, dex\?\.weth \?\? ZeroAddress/);
});
