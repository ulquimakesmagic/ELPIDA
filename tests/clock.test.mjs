import test from 'node:test';
import assert from 'node:assert/strict';
import { syncClock, nowSeconds } from '../apps/web/clock.mjs';
import { freshUsd } from '../apps/web/discovery.mjs';

test('price freshness follows the server clock, not a wrong PC clock or time zone', () => {
  const server = Date.now() / 1000 - 8 * 3600; // this device runs 8 hours fast
  syncClock(server);
  assert.ok(Math.abs(nowSeconds() - server) < 2);
  const token = { usdReference: { status: 'fresh', usd: 2418, updatedAt: server - 884, maxAge: 1500 } };
  assert.equal(freshUsd(token), 2418, 'a 15-minute-old oracle price stays fresh');
  assert.equal(freshUsd({ usdReference: { ...token.usdReference, updatedAt: server - 1600 } }), 2418, 'a missed refresh within the hour still shows dollars');
  // 6 November 2026: values are only ever shown in dollars, so an old reference still values them (the page says when it
  // was set); only a pair asset that never had a dollar reference shows a dash.
  assert.equal(freshUsd({ usdReference: { ...token.usdReference, status: 'stale', updatedAt: server - 86400 } }), 2418, 'an old reference still shows dollars');
  assert.equal(freshUsd({ usdReference: { status: 'unavailable', usd: null } }), null);
  assert.equal(freshUsd({}), null);
  syncClock(Number.NaN);
  assert.ok(Math.abs(nowSeconds() - server) < 2, 'invalid server time keeps the last offset');
  syncClock(Date.now() / 1000);
  assert.ok(Math.abs(nowSeconds() - Date.now() / 1000) < 1);
});
