import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, toBeHex, zeroPadValue } from 'ethers';
import { inspectOndoControls, erc1967Slot } from '../scripts/lib/ondo-controls.mjs';

const token = '0x' + 'ab'.repeat(20), implementation = '0x' + 'cd'.repeat(20);
const beaconAddress = '0x' + 'ef'.repeat(20);
const asset = { provider: 'ondo', network: 'ethereum', address: token, symbol: 'TESTon', decimals: 18 };
const snapshot = { chainId: 1, number: 100, hash: '0x' + '12'.repeat(32) };
const iface = new Interface(['function symbol() view returns(string)', 'function decimals() view returns(uint8)', 'function paused() view returns(bool)', 'function DEFAULT_ADMIN_ROLE() view returns(bytes32)', 'function getRoleMemberCount(bytes32) view returns(uint256)', 'function getRoleMember(bytes32,uint256) view returns(address)', 'function owner() view returns(address)', 'function implementation() view returns(address)']);

test('read-only inspection records proxy pointers and bounded roles without approving issuer controls', async () => {
  const methods = [];
  const request = async (method, params) => {
    methods.push(method); assert.equal(params.at(-1), '0x64');
    if (method === 'eth_getCode') return '0x6000';
    if (method === 'eth_getStorageAt') return params[1] === erc1967Slot('implementation') ? zeroPadValue(implementation, 32) : params[1] === erc1967Slot('beacon') ? zeroPadValue(beaconAddress, 32) : toBeHex(0, 32);
    const parsed = iface.parseTransaction({ data: params[0].data });
    if (!parsed) throw new Error('unknown getter');
    if (parsed.name === 'owner' && params[0].to === token) throw new Error('owner unavailable');
    if (parsed.name === 'owner') return iface.encodeFunctionResult(parsed.fragment, [token]);
    if (parsed.name === 'implementation') return iface.encodeFunctionResult(parsed.fragment, [implementation]);
    const values = { symbol: 'TESTon', decimals: 18, paused: false, DEFAULT_ADMIN_ROLE: toBeHex(0, 32), getRoleMemberCount: 100, getRoleMember: token };
    return iface.encodeFunctionResult(parsed.fragment, [values[parsed.name]]);
  };
  const report = await inspectOndoControls({ asset, snapshot, request });
  assert.equal(report.identityMatches, true); assert.equal(report.issuerControlsVerified, false);
  assert.equal(report.proxySlots.implementation.value.address, implementation);
  assert.equal(report.proxySlots.admin.value.address, null);
  assert.equal(report.observations.owner.status, 'unverified');
  assert.equal(report.beacon.implementation.value, implementation);
  assert.equal(report.beacon.implementationCode.value.present, true);
  assert.equal(report.roles.DEFAULT_ADMIN_ROLE.members.length, 16);
  assert.equal(report.roles.DEFAULT_ADMIN_ROLE.truncated, true);
  assert.ok(methods.every(x => ['eth_call', 'eth_getCode', 'eth_getStorageAt'].includes(x)));
});

test('failed ABI probes do not imply absent roles, and mismatched identity is reported', async () => {
  const request = async (method, params) => {
    if (method === 'eth_getCode') return '0x';
    if (method === 'eth_getStorageAt') return '0x';
    if (params[0].data === iface.encodeFunctionData('symbol')) return iface.encodeFunctionResult('symbol', ['OTHERon']);
    throw new Error('unavailable');
  };
  const report = await inspectOndoControls({ asset, snapshot, request });
  assert.equal(report.identityMatches, false); assert.equal(report.codePresent, false); assert.equal(report.issuerControlsVerified, false);
  assert.equal(report.observations.paused.status, 'unverified');
  assert.equal(report.proxySlots.implementation.status, 'unverified');
  for (const role of Object.values(report.roles)) assert.equal(role.role.status, 'unverified');
});

test('confirmed GMToken getters reveal dependencies, pause status and role administrators without approving them', async () => {
  const api = new Interface(['function symbol() view returns(string)', 'function decimals() view returns(uint8)',
    'function compliance() view returns(address)', 'function tokenPauseManager() view returns(address)',
    'function isTokenPaused(address) view returns(bool)', 'function CONFIGURER_ROLE() view returns(bytes32)',
    'function getRoleAdmin(bytes32) view returns(bytes32)', 'function getRoleMemberCount(bytes32) view returns(uint256)']);
  const request = async (method, params) => {
    if (method === 'eth_getCode') return '0x6000';
    if (method === 'eth_getStorageAt') return toBeHex(0, 32);
    const call = api.parseTransaction({ data: params[0].data });
    if (!call) throw new Error();
    if (call.name === 'isTokenPaused') { assert.equal(params[0].to, beaconAddress); assert.equal(call.args[0].toLowerCase(), token); }
    const values = { symbol: 'TESTon', decimals: 18, compliance: implementation, tokenPauseManager: beaconAddress,
      isTokenPaused: true, CONFIGURER_ROLE: toBeHex(1, 32), getRoleAdmin: toBeHex(0, 32), getRoleMemberCount: 0 };
    return api.encodeFunctionResult(call.fragment, [values[call.name]]);
  };
  const report = await inspectOndoControls({ asset, snapshot, request });
  assert.equal(report.dependencies.compliance.address, implementation);
  assert.equal(report.dependencies.tokenPauseManager.tokenPaused.value, true);
  assert.equal(report.roles.CONFIGURER_ROLE.admin.value, toBeHex(0, 32));
  assert.equal(report.sourceProfile.implementationHashMatches, false);
  assert.equal(report.sourceProfile.dependencyControlsVerified, false);
  assert.equal(report.issuerControlsVerified, false);
});
