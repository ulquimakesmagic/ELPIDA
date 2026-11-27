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
  assert.ok((page.match(/Live on Base mainnet\./g) ?? []).length >= 2, 'Open Graph and Twitter previews');
  assert.match(page, /<span id="footer-note" hidden><\/span>/);
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
  assert.match(flow, /\(net\(\)\?\.mainnet \? '' : ' Test networks only; not audited\.'\)/, 'mainnet: no audit warning (Malik, 25 Nov); test networks keep it');
  assert.match(app, /50% to traders \(a monthly airdrop in USDC\), 30% to the token's creator and 20% to Elpida/);
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
  assert.equal((out.match(/Yes, on Base mainnet\. The contracts are open source/g) ?? []).length >= 2, true);
  const arbitrum = pages.map(page => seoText(page, { mode: 'mainnet', names: ['Arbitrum One'] })).join('\n');
  assert.match(arbitrum, /Yes, on Arbitrum One mainnet\./);
  assert.match(out, /Approved tokenized stocks can be a trading pair/);
  // 24 November 2026: the V2.3 split, no Solana, and no five-way split on the mainnet site.
  assert.deepEqual([...out.matchAll(/.{0,40}(Solana|flywheel|five ways|Raydium).{0,40}/gi)].map(m => m[0]), []);
  assert.match(out, /50% to a monthly USDC airdrop for traders, 30% to the creator and 20% to the Elpida treasury/);
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

// 24 November 2026: the docs page listed no mainnet contracts, offered Elpida tokens as a pair and showed the V2.0 split.
test('the docs page lists each mainnet launchpad contract and no token-to-token pairs', () => {
  const docs = readFileSync(new URL('../apps/web/docs-view.mjs', import.meta.url), 'utf8');
  for (const role of ['Factory', 'Hook', 'Router', 'Trader airdrop', 'Treasury']) assert.match(docs, new RegExp(`contractCard\\(net, '${role}'`));
  assert.match(docs, /const v2 = net\.v2\?\.shared/);
  assert.match(docs, /mainnets\.map\(network => network\.name\)/);
  assert.doesNotMatch(docs, /Elpida tokens|graduated Elpida token can be the pair|five ways/);
  const page = readFileSync(new URL('../apps/web/token-page.mjs', import.meta.url), 'utf8');
  assert.match(page, /model === 'v2\.3-hook' \? "50% traders' monthly airdrop, 30% creator, 20% Elpida"/);
});

// 24 November 2026: the chain menu offered "Simulation · Test funds" on the mainnet site.
test('the mainnet site offers no simulation in the chain menu, the first-visit chooser or a saved choice', () => {
  const app = read('apps/web/app.mjs'), ui = read('apps/web/chain-ui.mjs');
  assert.match(app, /simulation:\(\)=>!mainnetSite\(\)/);
  assert.match(ui, /\.\.\.\(simulation\(\)\?\[\{key:'local',name:'Simulation'\}\]:\[\]\)/);
  assert.match(app, /\.\.\.\(mainnetSite\(\) \? \[\] : \[\{ key: 'local', name: 'Local simulation'/);
  assert.match(app, /if \(mainnetSite\(\) && saved === 'local'\) saved = null;/);
});

test('the review step and the wallet prompt show the V2.3 split and no test-launchpad label on mainnet (26 Nov 2026)', () => {
  const flow = readFileSync(new URL('../apps/web/launch-flow.mjs', import.meta.url), 'utf8');
  const v2 = readFileSync(new URL('../apps/web/v2-launchpad.mjs', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../apps/web/app.mjs', import.meta.url), 'utf8');
  assert.match(flow, /row\('Fee split', v2Deployment\(net\(\)\)\?\.model === 'v2\.3-hook' \? '50% traders · 30% you · 20% Elpida'/);
  assert.match(flow, /'v2\.3-hook' \? 'three-way' : 'five-way'/);
  assert.match(v2, /w\.net\.mainnet \? `Confirm the launch on \$\{w\.net\.name\}/);
  assert.doesNotMatch(app, /'mainnet beta' : 'testnet'/);
});
