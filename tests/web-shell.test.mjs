import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startServer } from '../apps/api/server.mjs';

const web = path => readFileSync(new URL(`../apps/web/${path}`, import.meta.url), 'utf8');
const html = web('index.html');

test('every shell element the scripts look up by id exists in the page', () => {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  for (const file of ['app.mjs', 'shell.mjs']) {
    const wanted = [...web(file).matchAll(/\$\('#([a-z0-9-]+)'\)/gi)].map(m => m[1]);
    assert.ok(wanted.length > 0, `${file} looks up shell elements`);
    for (const id of wanted) assert.ok(ids.has(id), `${file} needs #${id} in index.html`);
  }
  for (const id of ['env-button', 'env-button-mobile', 'dock', 'app-shell', 'last-sale', 'wallet-dialog', 'search-dialog']) assert.ok(ids.has(id), `#${id}`);
});

test('the shell ships its own fonts, theme and scripts, served same-origin under the CSP', async t => {
  const app = await startServer({ port: 0, seed: false });
  t.after(() => app.close());
  const local = [...html.matchAll(/(?:href|src)="(\/[^"?#]*)/g)].map(m => m[1]).filter(path => !path.startsWith('/#'));
  const required = ['/theme.css', '/explore.css', '/token.css', '/launch.css', '/docs.css', '/theme-boot.js', '/app.mjs', '/assets/fonts/geist-variable.woff2', '/assets/fonts/geist-mono-variable.woff2', '/assets/icons.svg'];
  for (const path of required) assert.ok(local.includes(path), `${path} is referenced by index.html`);
  for (const path of new Set([...local, '/shell.mjs', '/explore-view.mjs', '/odometer.mjs'])) {
    const response = await fetch(`${app.url}${path}`);
    assert.equal(response.status, 200, `${path} is served`);
    await response.arrayBuffer();
  }
  // The theme is applied by a same-origin classic script before first paint; no inline script is needed.
  assert.doesNotMatch(html, /<script>(?!\s*<\/script>)/, 'no inline scripts');
  assert.match(html, /<script src="\/theme-boot\.js"><\/script>/);
  const csp = (await fetch(`${app.url}/`)).headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  // Icons the shell uses are in the sprite.
  const sprite = web('assets/icons.svg');
  for (const name of [...html.matchAll(/icons\.svg#i-([a-z0-9-]+)/g)].map(m => m[1])) assert.match(sprite, new RegExp(`id="i-${name}"`), `icon ${name}`);
});

test('the recent-trades endpoint returns a list for the Last sale strip', async t => {
  const app = await startServer({ port: 0, seed: false });
  t.after(() => app.close());
  const response = await fetch(`${app.url}/api/public/recent-trades?limit=5`);
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(await response.json()));
});
