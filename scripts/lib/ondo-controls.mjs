import { Interface, keccak256, toUtf8Bytes, toBeHex } from 'ethers';

export const erc1967Slot = name => toBeHex(BigInt(keccak256(toUtf8Bytes(`eip1967.proxy.${name}`))) - 1n, 32);
const addressWord = value => /^0x[0-9a-f]{64}$/i.test(value ?? '') && /^0{24}/.test(value.slice(2)) && !/^0x0+$/.test(value) ? '0x' + value.slice(-40).toLowerCase() : null;

/** Read-only observations. Guessed ABI probes and empty slots never establish absence of issuer controls. */
export async function inspectOndoControls({ asset, snapshot, request }) {
  if (asset?.provider !== 'ondo' || !['ethereum', 'bnb'].includes(asset.network) || !/^0x[0-9a-f]{40}$/i.test(asset.address)) throw new Error('Select a canonical EVM Ondo asset.');
  const block = '0x' + snapshot.number.toString(16);
  const observe = async fn => { try { return { status: 'observed', value: await fn() }; } catch { return { status: 'unverified', reason: 'Read failed, reverted or returned incompatible data; ABI/source confirmation is still required.' }; } };
  const getter = async (signature, args = [], target = asset.address) => observe(async () => {
    const iface = new Interface([signature]), fragment = iface.fragments[0];
    const raw = await request('eth_call', [{ to: target, data: iface.encodeFunctionData(fragment, args) }, block]);
    const value = iface.decodeFunctionResult(fragment, raw)[0];
    if (fragment.outputs[0]?.type === 'address') return value.toLowerCase();
    return typeof value === 'bigint' ? value.toString() : value;
  });
  const code = await request('eth_getCode', [asset.address, block]);
  const observations = {};
  for (const [name, signature] of Object.entries({ symbol: 'function symbol() view returns(string)', decimals: 'function decimals() view returns(uint8)', owner: 'function owner() view returns(address)', paused: 'function paused() view returns(bool)', blocklist: 'function blocklist() view returns(address)', sanctionsList: 'function sanctionsList() view returns(address)', sharesMultiplier: 'function sharesMultiplier() view returns(uint256)', compliance: 'function compliance() view returns(address)', tokenPauseManager: 'function tokenPauseManager() view returns(address)' })) observations[name] = await getter(signature);
  const proxySlots = {};
  for (const kind of ['implementation', 'admin', 'beacon']) {
    const slot = erc1967Slot(kind);
    proxySlots[kind] = await observe(async () => {
      const raw = await request('eth_getStorageAt', [asset.address, slot, block]);
      if (!/^0x[0-9a-f]{64}$/i.test(raw ?? '')) throw new Error();
      const address = addressWord(raw);
      const targetCode = address ? await request('eth_getCode', [address, block]) : '0x';
      return { slot, raw, address, codePresent: targetCode !== '0x', codeHash: targetCode !== '0x' ? keccak256(targetCode) : null };
    });
  }
  let beacon = null;
  const beaconAddress = proxySlots.beacon.status === 'observed' ? proxySlots.beacon.value.address : null;
  if (beaconAddress) {
    beacon = { address: beaconAddress, owner: await getter('function owner() view returns(address)', [], beaconAddress), implementation: await getter('function implementation() view returns(address)', [], beaconAddress) };
    if (beacon.implementation.status === 'observed') beacon.implementationCode = await observe(async () => {
      const code = await request('eth_getCode', [beacon.implementation.value, block]);
      return { present: code !== '0x', hash: code !== '0x' ? keccak256(code) : null };
    });
  }
  const roles = {};
  for (const name of ['DEFAULT_ADMIN_ROLE', 'PAUSER_ROLE', 'UPGRADER_ROLE', 'BURNER_ROLE', 'BLOCKLIST_ROLE', 'CONFIGURER_ROLE', 'MINTER_ROLE']) {
    const role = await getter(`function ${name}() view returns(bytes32)`);
    roles[name] = { role };
    if (role.status !== 'observed') continue;
    roles[name].admin = await getter('function getRoleAdmin(bytes32) view returns(bytes32)', [role.value]);
    const count = await getter('function getRoleMemberCount(bytes32) view returns(uint256)', [role.value]);
    roles[name].memberCount = count;
    if (count.status === 'observed') {
      roles[name].members = [];
      const length = BigInt(count.value);
      roles[name].truncated = length > 16n;
      for (let index = 0n; index < length && index < 16n; index++) roles[name].members.push(await getter('function getRoleMember(bytes32,uint256) view returns(address)', [role.value, index]));
    }
  }
  const dependencies = {};
  for (const name of ['compliance', 'tokenPauseManager']) {
    const pointer = observations[name];
    if (pointer.status !== 'observed') continue;
    dependencies[name] = { address: pointer.value, code: await observe(async () => {
      const code = await request('eth_getCode', [pointer.value, block]);
      return { present: code !== '0x', hash: code !== '0x' ? keccak256(code) : null };
    }) };
    if (name === 'tokenPauseManager') dependencies[name].tokenPaused = await getter('function isTokenPaused(address) view returns(bool)', [asset.address], pointer.value);
  }
  const sourceProfile = { implementationHashMatches: beacon?.implementationCode?.value?.hash === '0x7480293a8fad3f98f01f39aa59cd4e4c30d7fc4e7019e8f6e691eb5a9be53d11',
    source: 'https://sourcify.dev/server/v2/contract/1/0xebbcb2cee51c2fee4062c9c1270dcb98b0b22250?fields=all',
    contract: 'contracts/globalMarkets/GMToken.sol:GMToken', dependencyControlsVerified: false };
  return { dependencies, sourceProfile, kind: 'ondo-readonly-control-observations', network: asset.network, token: asset.address, symbol: asset.symbol, source: asset.source, ...snapshot, codePresent: code !== '0x', codeHash: code !== '0x' ? keccak256(code) : null, identityMatches: observations.symbol.status === 'observed' && observations.symbol.value === asset.symbol && observations.decimals.status === 'observed' && Number(observations.decimals.value) === asset.decimals, observations, proxySlots, beacon, roles, issuerControlsVerified: false, note: 'Read-only ABI probes and ERC-1967 slot observations only. Missing getters and zero slots are not evidence of absent privileges. No account impersonation, role changes, source audit or live capability approval.' };
}
