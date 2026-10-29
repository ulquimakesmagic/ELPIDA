import test from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { BrowserProvider, ContractFactory } from 'ethers';
import { compileContracts } from '../scripts/compile.mjs';
import { runLifecycle } from '../scripts/equity-lifecycle-fork.mjs';

// Offline check of the lifecycle script's own logic, with a local ERC-20 standing in for a tokenized stock.
for (const [atomic, decimals] of [[false, 6], [true, 6], [true, 18]]) test(`local stock quote lifecycle (${decimals} decimals): ${atomic ? 'atomic graduation, zero creator buy' : 'legacy graduation'}`, async t => {
  const connection = await network.create('localTest');
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 10;
  t.after(async () => { provider.destroy(); await connection.close(); });
  const compiled = compileContracts({ includeMocks: true });
  const mock = decimals === 18 ? compiled['tests/fixtures/MockIssuerStock.sol'].MockIssuerStock : compiled['tests/fixtures/MockUSDC.sol'].MockUSDC;
  const signer0 = await provider.getSigner(0);
  const coin = await new ContractFactory(mock.abi, mock.evm.bytecode.object, signer0).deploy(); await coin.waitForDeployment();
  const unit = 10n ** BigInt(decimals);
  const fund = async signers => { for (const s of signers.slice(0, 2)) await (await coin.mint(await s.getAddress(), 1000n * unit)).wait(); };
  const progress = [];
  const stages = [];
  const beforeOperation = async context => {
    stages.push(context.name);
    assert.equal(typeof context.send, 'function');
    assert.match(context.target, /^0x[0-9a-f]{40}$/i);
    const snapshot = await context.state();
    assert.equal(typeof snapshot.curve.reserve, 'bigint');
    if (context.name === 'curve fees') assert.equal(context.deferred, true);
    if (context.name.startsWith('pool fee claim')) assert.ok(snapshot.extra.owed > 0n);
  };
  const res = await runLifecycle({ provider, stockAddress: coin.target, fund, virtualQuote: 20n * unit, firstBuy: atomic ? 0n : unit, tradeBuy: unit, atomic, beforeOperation, onCheck: check => progress.push(check) });
  assert.equal(stages.length, 8, 'restriction hooks cover curve buy/sell/fees, completion, pool buy/sell and both quote claims');
  assert.ok(res.checks.length >= 10);
  assert.ok(res.checks.every(c => c.ok));
  assert.deepEqual(progress, res.checks, 'each completed assertion is available to the partial report writer');
  assert.ok(res.checks.some(c => c.name.startsWith('post-graduation creator and treasury claims')));
  if (atomic) assert.ok(res.checks.some(c => c.name === 'final stock purchase graduates in the same transaction'));
});
