import assert from 'node:assert/strict';
import { Contract, JsonRpcSigner, keccak256, parseEther, toBeHex, id } from 'ethers';
import { erc1967Slot } from './ondo-controls.mjs';

// Source records retrieved from Sourcify v2 on 29 October 2026. Pin runtime, not ticker or guessed ABI.
export const ONDO_RESTRICTION_PROFILE = {
  token: '0x2d1f7226bd1f780af6b9a49dcc0ae00e8df4bdee',
  view: ['0x54a8757c2fef8649830b158a8c19d3a670e80318', '0x335f3aab208de166709d5e39c061921ccc78222f194833c79f27add6e323616a'],
  core: ['0x156f73fc73197555e950743cb2b23f411c751002', '0xe49e4e270adef3495807d4e1a8c3a6d05f6587c85a50a045d11fe3eaaa838b7a'],
  pause: ['0xfd48112e448417ca79305a518c4186df4b0a200a', '0xdf72b8f350fc2891169965c67cb8b2c376f698e1fceb7a17eca645a60fc7b59c'],
};

/** Actual issuer methods, impersonated on an in-process Hardhat fork ONLY. Not a public-chain signer. */
export async function ondoRestrictionChecks({ provider, stockAddress, onCheck = () => {} }) {
  assert.equal(Number((await provider.getNetwork()).chainId), 31337);
  const metadata = await provider.send('hardhat_metadata', []);
  assert.equal(metadata.forkedNetwork?.chainId, 1, 'requires a local Ethereum fork');
  assert.equal(stockAddress.toLowerCase(), ONDO_RESTRICTION_PROFILE.token);
  const erc = new Contract(stockAddress, ['function compliance() view returns(address)', 'function tokenPauseManager() view returns(address)'], provider);
  const same = (a, b) => assert.equal(a.toLowerCase(), b.toLowerCase());
  same(await erc.compliance(), ONDO_RESTRICTION_PROFILE.view[0]);
  same(await erc.tokenPauseManager(), ONDO_RESTRICTION_PROFILE.pause[0]);
  const beaconWord = await provider.getStorage(stockAddress, erc1967Slot('beacon'));
  const beaconAddress = '0x' + beaconWord.slice(-40);
  const beacon = new Contract(beaconAddress, ['function implementation() view returns(address)'], provider);
  assert.equal(keccak256(await provider.getCode(await beacon.implementation())), '0x7480293a8fad3f98f01f39aa59cd4e4c30d7fc4e7019e8f6e691eb5a9be53d11', 'review upgraded token before role impersonation');
  for (const [address, hash] of [ONDO_RESTRICTION_PROFILE.view, ONDO_RESTRICTION_PROFILE.core, ONDO_RESTRICTION_PROFILE.pause]) assert.equal(keccak256(await provider.getCode(address)), hash, 'review dependency source again if runtime changes');
  const view = new Contract(ONDO_RESTRICTION_PROFILE.view[0], ['function compliance() view returns(address)', 'function gmIdentifier() view returns(address)'], provider);
  same(await view.compliance(), ONDO_RESTRICTION_PROFILE.core[0]);
  const core = new Contract(ONDO_RESTRICTION_PROFILE.core[0], ['function rwaTokenToBlocklist(address) view returns(address)'], provider);
  const blocklist = new Contract(await core.rwaTokenToBlocklist(await view.gmIdentifier()), ['function owner() view returns(address)', 'function isBlocked(address) view returns(bool)', 'function addToBlocklist(address[])', 'function removeFromBlocklist(address[])'], provider);
  // Blocklist runtime pin filled from its verified source record.
  assert.equal(keccak256(await provider.getCode(blocklist.target)), BLOCKLIST_HASH);
  const pause = new Contract(ONDO_RESTRICTION_PROFILE.pause[0], ['function PAUSE_TOKEN_ROLE() view returns(bytes32)', 'function UNPAUSE_TOKEN_ROLE() view returns(bytes32)', 'function getRoleMember(bytes32,uint256) view returns(address)', 'function hasRole(bytes32,address) view returns(bool)', 'function pauseToken(address)', 'function unpauseToken(address)', 'function isTokenPaused(address) view returns(bool)'], provider);
  const pauser = await pause.getRoleMember(await pause.PAUSE_TOKEN_ROLE(), 0);
  const unpauser = await pause.getRoleMember(await pause.UNPAUSE_TOKEN_ROLE(), 0);
  assert.equal(await pause.hasRole(await pause.PAUSE_TOKEN_ROLE(), pauser), true);
  assert.equal(await pause.hasRole(await pause.UNPAUSE_TOKEN_ROLE(), unpauser), true);
  const owner = await blocklist.owner();
  const act = async (contract, caller, method, args) => {
    await provider.send('hardhat_impersonateAccount', [caller]);
    await provider.send('hardhat_setBalance', [caller, toBeHex(parseEther('10'))]);
    try { assert.equal((await (await contract.connect(new JsonRpcSigner(provider, caller))[method](...args, { gasLimit: 1000000 })).wait()).status, 1); }
    finally { await provider.send('hardhat_stopImpersonatingAccount', [caller]); }
  };
  assert.equal(await pause.isTokenPaused(stockAddress), false, 'do not clear an upstream restriction');
  const check = async ({ name, send, state, target, deferred = false }) => {
    assert.equal(await blocklist.isBlocked(target), false, 'do not unblock an upstream blocked account');
    for (const mode of ['paused', 'blocked']) {
      if (mode === 'paused') await act(pause, pauser, 'pauseToken', [stockAddress]);
      else await act(blocklist, owner, 'addToBlocklist', [[target]]);
      try {
        assert.equal(mode === 'paused' ? await pause.isTokenPaused(stockAddress) : await blocklist.isBlocked(target), true);
        const before = await state();
        if (deferred) {
          const receipt = await (await send()).wait();
          assert.equal(receipt.status, 1);
          assert.ok(receipt.logs.some(log => log.topics[0] === id('FeePayoutFailed(address,uint256)')), 'must explicitly report deferred payout');
        }
        else await assert.rejects(async () => { const tx = await send(); await tx.wait(); },
          error => error?.code === 'CALL_EXCEPTION' || /revert/i.test(error?.message ?? ''), `${name} must revert when ${mode}; transport failures are not evidence`);
        assert.deepEqual(await state(), before, `${name}: reserve, token balances and ledgers must roll back`);
        onCheck({ name: `${name}: ${mode} operation ${deferred ? 'defers payout' : 'reverts'} without ledger changes`, ok: true });
      } finally {
        if (mode === 'paused') await act(pause, unpauser, 'unpauseToken', [stockAddress]);
        else await act(blocklist, owner, 'removeFromBlocklist', [[target]]);
      }
    }
  };
  check.evidence = { token: stockAddress, dependencies: ONDO_RESTRICTION_PROFILE, blocklist: { address: blocklist.target, hash: BLOCKLIST_HASH, owner }, pauser, unpauser,
    scope: 'Existing authority accounts impersonated only on the local fork. No role grants, storage patches or public transactions.',
    issuerControlsVerified: false };
  return check;
}

const BLOCKLIST_HASH = '0xbea1ef7521335cb658b6d194c5e50482b9820ed9b6edd21ee0afbb9296941495';
