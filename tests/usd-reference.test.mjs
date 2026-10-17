import test from 'node:test';
import assert from 'node:assert/strict';
import { usdReferenceFor, USDC_PARITY_SOURCE } from '../packages/core/pairs.mjs';

const native = { status: 'fresh', usd: 104.8, updatedAt: 1_000, maxAge: 180, source: 'Pyth SOL/USD' };

test('USD references: native uses the oracle, USDC is $1 by stated parity, other pairs stay as they are', () => {
  assert.equal(usdReferenceFor({ pair: 'native' }, native), native);
  assert.equal(usdReferenceFor({ pair: 'native' }, null), null, 'no oracle, no dollars');
  const usdc = usdReferenceFor({ pair: 'usdc' }, native, 5_000);
  assert.deepEqual({ status: usdc.status, usd: usdc.usd, updatedAt: usdc.updatedAt, source: usdc.source }, { status: 'fresh', usd: 1, updatedAt: 5_000, source: USDC_PARITY_SOURCE });
  assert.ok(5_000 + 10 * 365 * 86_400 - usdc.updatedAt <= usdc.maxAge, 'never goes stale');
  assert.equal(JSON.parse(JSON.stringify(usdc)).maxAge, usdc.maxAge, 'survives JSON (no Infinity)');
  assert.equal(usdReferenceFor({ pair: 'token' }, native), null);
  const own = { status: 'fresh', usd: 3 };
  assert.equal(usdReferenceFor({ pair: 'xstock', usdReference: own }, native), own);
});
