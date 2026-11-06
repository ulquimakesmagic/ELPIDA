// Launchpad deployments are operator work (Malik, 6 November 2026: "limited to admin panel only and not everyone").
// Every deploy and setup action lives in the operator panel's Launchpads tab; the public account panel and the launch
// form only say whether a network is ready.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../apps/web/${path}`, import.meta.url), 'utf8');
const SETUP = ['deploy', 'deploy-test-dex', 'deploy-v4', 'apply-pricing'];

test('launchpad deployments and the price feed activation are only in the operator panel', () => {
  const app = read('app.mjs'), flow = read('launch-flow.mjs'), admin = read('admin-launchpads.mjs'), panel = read('admin-view.mjs');
  for (const action of SETUP) {
    assert.ok(!new RegExp(`run\\('${action}'`).test(app), `${action} is not a button in the public account panel`);
    assert.ok(!new RegExp(`run\\('${action}'`).test(flow) && !flow.includes(`'${action}'`), `${action} is not in the launch flow`);
    assert.ok(admin.includes(`'${action}'`), `${action} is in the Launchpads tab`);
  }
  for (const label of ['Set up launchpad', 'Deploy Model 11 test launchpad', 'Activate price feed', 'Set up test DEX']) {
    assert.ok(!app.includes(label) && !flow.includes(label), `"${label}" is not shown to visitors`);
  }
  assert.match(panel, /tab=launchpads/); assert.match(panel, /renderLaunchpads\(ctx/);
  // The tab is reached only after the server-checked operator sign-in, like Pairs and Partners.
  assert.ok(panel.indexOf("if (!session.signedIn)") < panel.indexOf("if (tab === 'launchpads')"));
});
