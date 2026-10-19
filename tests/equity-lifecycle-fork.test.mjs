import test from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { BrowserProvider, ContractFactory } from 'ethers';
import { compileContracts } from '../scripts/compile.mjs';
import { runLifecycle } from '../scripts/equity-lifecycle-fork.mjs';

// Offline check of the lifecycle script's own logic, with a local ERC-20 standing in for a tokenized stock.
test('lifecycle check passes for a well-behaved quote token (factory, curve, graduation, fees, router)', async t => {
  const connection = await network.create('localTest');
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 10;
  t.after(async () => { provider.destroy(); await connection.close(); });
  const compiled = compileContracts({ includeMocks: true });
  const mock = compiled['tests/fixtures/MockUSDC.sol'].MockUSDC;
  const signer0 = await provider.getSigner(0);
  const coin = await new ContractFactory(mock.abi, mock.evm.bytecode.object, signer0).deploy(); await coin.waitForDeployment();
  const unit = 10n ** 6n;
  const fund = async signers => { for (const s of signers.slice(0, 2)) await (await coin.mint(await s.getAddress(), 1000n * unit)).wait(); };
  const res = await runLifecycle({ provider, stockAddress: coin.target, fund, virtualQuote: 20n * unit, firstBuy: unit, tradeBuy: unit });
  assert.ok(res.checks.length >= 10);
  assert.ok(res.checks.every(c => c.ok));
});
