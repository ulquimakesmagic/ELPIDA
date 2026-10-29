// Versioned app code (apps/api/static-assets.mjs): every import of a served module carries the build id, those URLs are
// immutable, and index.html preloads the whole static import graph so the browser fetches it in one round trip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStaticAssets, versionImports, staticImports, resolveSpecifier, contentVersion } from '../apps/api/static-assets.mjs';

test('imports of served modules get the build id; other specifiers are left alone', () => {
  const known = new Set(['/ui.mjs', '/vendor/ethers.js', '/pairs.mjs']);
  const source = `import { h } from './ui.mjs';\nimport {Contract} from '/vendor/ethers.js';\nimport './missing.mjs';\nconst m = await import('/pairs.mjs');\nconst text = 'see ./ui.mjs';\nexport * from "./ui.mjs";`;
  assert.equal(versionImports(source, '/token-page.mjs', known, 'b1'),
    `import { h } from './ui.mjs?v=b1';\nimport {Contract} from '/vendor/ethers.js?v=b1';\nimport './missing.mjs';\nconst m = await import('/pairs.mjs?v=b1');\nconst text = 'see ./ui.mjs';\nexport * from "./ui.mjs?v=b1";`);
  assert.equal(resolveSpecifier('/vendor/pumpswap.mjs', '../ui.mjs'), '/ui.mjs');
  assert.deepEqual(staticImports(source, '/token-page.mjs'), ['/ui.mjs', '/vendor/ethers.js', '/missing.mjs', '/ui.mjs'], 'dynamic import() is not preloaded');
});

test('index.html preloads the import graph and versions its scripts and stylesheets; development serves files as they are', () => {
  const dir = mkdtempSync(join(tmpdir(), 'elpida-static-'));
  try {
    const write = (name, text) => { writeFileSync(join(dir, name), text); return join(dir, name); };
    const files = new Map([['/app.mjs', write('app.mjs', "import './a.mjs';\nconst lazy = () => import('./lazy.mjs');")], ['/a.mjs', write('a.mjs', "import { x } from './b.mjs';")],
      ['/b.mjs', write('b.mjs', 'export const x = 1;')], ['/lazy.mjs', write('lazy.mjs', 'export default 1;')], ['/styles.css', write('styles.css', 'body{}')]]);
    const version = contentVersion(files);
    assert.match(version, /^[0-9a-f]{12}$/);
    const assets = createStaticAssets({ files, version });
    const html = assets.html('<head>\n  <link rel="stylesheet" href="/styles.css">\n  <script type="module" src="/app.mjs"></script>\n  <link rel="icon" href="/assets/x.svg?v=1">\n</head>');
    assert.deepEqual([...html.matchAll(/modulepreload" href="([^"]+)"/g)].map(m => m[1]), ['/app.mjs', '/a.mjs', '/b.mjs'].map(p => `${p}?v=${version}`), 'static graph only, entry first');
    assert.ok(html.includes(`href="/styles.css?v=${version}"`) && html.includes(`src="/app.mjs?v=${version}"`) && html.includes('href="/assets/x.svg?v=1"'));
    assert.ok(html.indexOf('modulepreload') < html.indexOf('<script type="module"'), 'preloads come before the entry script');
    assert.equal(assets.serve('/app.mjs', version).immutable, true);
    assert.equal(assets.serve('/app.mjs', null).immutable, false, 'an unversioned request is revalidated');
    assert.equal(assets.serve('/app.mjs', 'old').immutable, false, 'an old build id is not trusted');
    assert.ok(assets.serve('/app.mjs', version).body.includes(`import('./lazy.mjs?v=${version}')`));
    // Development: no build id, nothing rewritten or cached, files read fresh.
    const dev = createStaticAssets({ files, version: null });
    assert.equal(dev.html('<script type="module" src="/app.mjs"></script>'), '<script type="module" src="/app.mjs"></script>');
    writeFileSync(join(dir, 'b.mjs'), 'export const x = 2;');
    assert.equal(dev.serve('/b.mjs').body, 'export const x = 2;');
    assert.notEqual(contentVersion(files), version, 'any content change changes the build id');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
