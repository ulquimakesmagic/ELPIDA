import test from 'node:test';
import assert from 'node:assert/strict';
import { compareOndoControls } from '../scripts/lib/ondo-control-drift.mjs';

const address = '0x' + 'ab'.repeat(20), hash = '0x' + '12'.repeat(32);
const observed = value => ({ status: 'observed', value });
const baseline = () => ({ kind: 'ondo-readonly-control-observations', network: 'ethereum', chainId: 1,
  token: address, symbol: 'TESTon', number: 100, hash, identityMatches: true, codePresent: true, codeHash: hash,
  observations: { symbol: observed('TESTon'), decimals: observed('18'), paused: observed(false) },
  proxySlots: { beacon: observed({ address, raw: hash, codeHash: hash }) },
  beacon: { address, owner: observed(address), implementation: observed(address), implementationCode: observed({ present: true, hash }) },
  roles: { DEFAULT_ADMIN_ROLE: { role: observed(hash), memberCount: observed('2'), truncated: false,
    members: [observed(address), observed('0x' + 'cd'.repeat(20))] } } });

test('unchanged observations retain unknown controls and never approve live use', () => {
  const a = baseline(), b = structuredClone(a); b.number++;
  b.roles.DEFAULT_ADMIN_ROLE.members.reverse();
  const result = compareOndoControls(a, b);
  assert.equal(result.status, 'NO_OBSERVED_CHANGE'); assert.deepEqual(result.changes, []);
  assert.ok(result.unverified.includes('token.blocklist'));
  assert.equal(result.issuerControlsVerified, false); assert.equal(result.liveCapabilitiesApproved, false);
});

test('upgrades, owner rotation, pauses and lost reads require review', () => {
  const a = baseline(), b = structuredClone(a); b.number++;
  b.beacon.implementation.value = '0x' + '34'.repeat(20);
  b.beacon.owner.value = '0x' + '56'.repeat(20);
  b.observations.paused.value = true;
  b.roles.DEFAULT_ADMIN_ROLE.memberCount = { status: 'unverified' };
  const result = compareOndoControls(a, b);
  assert.equal(result.status, 'CHANGED');
  assert.deepEqual(result.changes.map(x => x.field).sort(), ['beacon.implementation', 'beacon.owner', 'role.DEFAULT_ADMIN_ROLE.count', 'token.paused'].sort());
  assert.ok(result.unverified.includes('role.DEFAULT_ADMIN_ROLE.count'));
});

test('incomplete role enumeration is unknown rather than a complete member list', () => {
  const a = baseline(), b = structuredClone(a); b.roles.DEFAULT_ADMIN_ROLE.truncated = true;
  const result = compareOndoControls(a, b);
  assert.equal(result.status, 'CHANGED'); assert.ok(result.unverified.includes('role.DEFAULT_ADMIN_ROLE.members'));
});

test('rejects asset substitution, wrong chain, stale or reorged comparisons and malformed reports', () => {
  for (const change of [{ token: '0x' + 'cd'.repeat(20) }, { chainId: 56 }, { number: 99 },
    { hash: '0x' + '34'.repeat(32) }, { hash: 'invalid' }, { observations: null }]) {
    assert.throws(() => compareOndoControls(baseline(), { ...baseline(), ...change }));
  }
});
