// One confirmation per action. Fee claims go through Multicall3 as one transaction on any wallet; the launched token
// is approved once for selling, so later sells are one confirmation; payment assets keep exact approvals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Contract, Interface } from 'ethers';
import './helpers/browser-modules.mjs';
import { MULTICALL3, MULTICALL3_ABI, MAX_UINT256, multicallData, approvalFor } from '../apps/web/one-confirmation.mjs';
import { swapCalldata } from '../packages/core/dex-router.mjs';
import { dexFixture, launch, complete, mined, art, fixtureArt } from './helpers/dex-fixture.mjs';
const { TestnetWallet } = await import('../apps/web/wallet.mjs');

test('approval rule: the launched token once (unlimited) for selling; payment assets exactly; nothing when covered', () => {
  assert.equal(approvalFor({ allowance: 10n, input: 5n, sellingLaunchedToken: true }), null);
  const sell = approvalFor({ allowance: 0n, input: 5n, sellingLaunchedToken: true, symbol: 'VEGETA' });
  assert.equal(sell.amount, MAX_UINT256); assert.match(sell.label, /VEGETA.*once/);
  assert.deepEqual(approvalFor({ allowance: 4n, input: 5n, sellingLaunchedToken: false }), { amount: 5n, label: 'Approve exactly this trade amount…' });
  assert.throws(() => multicallData(Interface, []), /Nothing/);
  assert.throws(() => multicallData(Interface, [{ to: '0x1', data: '0x', value: 1n }]), /value/);
});

function stub({ multicall }) {
  const log = { sent: [], batches: 0 };
  const w = Object.create(TestnetWallet.prototype);
  Object.assign(w, {
    address: '0x00000000000000000000000000000000000000aa', net: { chainId: 11155111, key: 'ethereum-sepolia' }, onProgress: () => {}, checkNetwork: async () => {},
    provider: { getCode: async a => (multicall && a === MULTICALL3 ? '0x6080' : '0x'), getTransactionReceipt: async () => ({ status: 1 }) },
    _eth: { request: async ({ method }) => { if (method === 'wallet_getCapabilities') return {}; throw new Error(method); } },
    signer: { sendTransaction: async tx => { log.sent.push(tx); return { hash: '0xtx' + log.sent.length, wait: async () => ({ status: 1 }) }; } },
  });
  return { w, log };
}
const claimSteps = [{ to: '0x' + '1'.repeat(40), data: '0xaa' }, { to: '0x' + '2'.repeat(40), data: '0xbb' }, { to: '0x' + '3'.repeat(40), data: '0xcc' }];

test('claims: one transaction to Multicall3 on a wallet that cannot batch; the previous path when the chain lacks it', async () => {
  let { w, log } = stub({ multicall: true });
  await w.sendPermissionless(claimSteps, 'Claim fees.');
  assert.equal(log.sent.length, 1); assert.equal(log.sent[0].to, MULTICALL3);
  const [calls] = new Interface(MULTICALL3_ABI).decodeFunctionData('aggregate3', log.sent[0].data);
  assert.deepEqual(calls.map(c => [c.target.toLowerCase(), c.allowFailure, c.callData]), claimSteps.map(s => [s.to, false, s.data]));
  ({ w, log } = stub({ multicall: false }));
  await w.sendPermissionless(claimSteps, 'Claim fees.');
  assert.deepEqual(log.sent.map(t => t.to), claimSteps.map(s => s.to), 'without Multicall3 the steps go in order, as before');
});

test('on-chain: every fee step through Multicall3 in one transaction pays the fixed recipients, from any caller', async t => {
  const f = await dexFixture(t), l = await launch(f), anyone = f.signers[3];
  await f.provider.send('hardhat_setCode', [MULTICALL3, '0x' + fixtureArt('Multicall3').evm.deployedBytecode.object]);
  await complete(f, l); await mined(l.curve.graduate());
  // Trade on the pool so the locked position has fees to collect.
  const token = new Contract(await l.curve.token(), art('ElpidaToken').abi, f.signers[1]), router = f.dex.router.target, me = f.addresses[1];
  const deadline = BigInt(await f.now() + 600);
  await mined(f.signers[1].sendTransaction({ to: router, value: 10n ** 16n, data: swapCalldata(Interface, 2, router, { tokenIn: f.dex.weth.target, tokenOut: token.target, fee: 10000, recipient: me, amountIn: 10n ** 16n, amountOutMinimum: 0n }, { deadline }) }));
  const locker = new Contract(await l.curve.locker(), art('ElpidaV3FeeLocker').abi, anyone), splitter = new Contract(await l.curve.feeSplitter(), art('ElpidaFeeSplitter').abi, anyone);
  const curve = new Contract(l.curve.target, l.curve.interface, anyone), recipients = [...new Set([f.addresses[2], await l.curve.creatorRewardVault()])];
  assert.ok(await l.curve.protocolFees() + await l.curve.creatorFees() > 0n, 'curve fees are owed');
  const steps = [{ to: curve.target, data: curve.interface.encodeFunctionData('withdrawFees') }, { to: locker.target, data: locker.interface.encodeFunctionData('collectFees') }];
  for (const asset of [token.target, f.dex.weth.target]) for (const r of recipients) steps.push({ to: splitter.target, data: splitter.interface.encodeFunctionData('claim', [asset, r]) });
  const receipt = await mined(anyone.sendTransaction({ to: MULTICALL3, data: multicallData(Interface, steps) }));
  assert.equal(receipt.status, 1);
  assert.equal(await l.curve.protocolFees() + await l.curve.creatorFees(), 0n, 'curve fees paid');
  for (const asset of [token.target, f.dex.weth.target]) for (const r of recipients) assert.equal(await splitter.claimable(asset, r), 0n, 'pool fees paid out');
  const weth = new Contract(f.dex.weth.target, ['function balanceOf(address) view returns(uint256)'], f.provider);
  assert.ok(await weth.balanceOf(f.addresses[2]) > 0n, 'the treasury received its share of the pool fees');
  assert.equal(await weth.balanceOf(MULTICALL3), 0n, 'nothing is left on the multicall contract');
  // The same batch again: every step is zero-safe, so it still succeeds.
  assert.equal((await mined(anyone.sendTransaction({ to: MULTICALL3, data: multicallData(Interface, steps) }))).status, 1);
});

test('on-chain: a standing approval of the launched token cannot be used by anyone but the seller', async t => {
  const f = await dexFixture(t), l = await launch(f), seller = f.signers[0], other = f.signers[1];
  const token = new Contract(await l.curve.token(), art('ElpidaToken').abi, seller);
  await f.advance(61);
  await mined(token.approve(l.curve.target, MAX_UINT256));
  const before = await token.balanceOf(f.addresses[0]);
  assert.ok(before > 0n, 'the creator holds tokens from the first buy');
  // Someone else selling cannot pull the seller's tokens; the curve only takes from msg.sender.
  await assert.rejects(l.curve.connect(other).sell(1000n, 0n));
  assert.equal(await token.balanceOf(f.addresses[0]), before);
  // The seller's next sells need no further approval.
  await mined(l.curve.connect(seller).sell(before / 4n, 0n)); await mined(l.curve.connect(seller).sell(before / 4n, 0n));
  assert.equal(await token.balanceOf(f.addresses[0]), before - before / 2n);
});
