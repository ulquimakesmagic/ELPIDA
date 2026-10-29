import test from 'node:test';
import assert from 'node:assert/strict';
import { ondoRestrictionChecks } from '../scripts/lib/ondo-restrictions.mjs';

test('issuer impersonation refuses public chains and non-Ethereum local forks before mutating anything', async () => {
  for (const [chainId, upstream] of [[1, 1], [31337, 56], [31337, undefined]]) {
    const methods = [];
    const provider = { getNetwork: async () => ({ chainId }), send: async method => { methods.push(method); return { forkedNetwork: { chainId: upstream } }; } };
    await assert.rejects(ondoRestrictionChecks({ provider, stockAddress: '0x' + '12'.repeat(20) }));
    assert.ok(methods.every(method => method === 'hardhat_metadata'));
  }
});

test('issuer impersonation refuses a substituted asset before reading or invoking its ABI', async () => {
  const provider = { getNetwork: async () => ({ chainId: 31337 }), send: async () => ({ forkedNetwork: { chainId: 1 } }) };
  await assert.rejects(ondoRestrictionChecks({ provider, stockAddress: '0x' + '12'.repeat(20) }));
});
