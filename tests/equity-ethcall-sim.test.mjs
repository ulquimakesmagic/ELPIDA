import test from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { BrowserProvider, ContractFactory } from 'ethers';
import { compileContracts } from '../scripts/compile.mjs';
import { runSimulation } from '../scripts/equity-ethcall-sim.mjs';

// Offline check of the simulation logic against a local token. The multiplier interface is absent on a plain token,
// so that single check must fail; every transfer, approve and control check must behave as it would on a real token.
test('eth_call simulation passes its transfer checks and its negative controls on a well-behaved token', async t => {
  const connection = await network.create('localTest');
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 10;
  t.after(async () => { provider.destroy(); await connection.close(); });
  const mock = compileContracts({ includeMocks: true })['tests/fixtures/MockUSDC.sol'].MockUSDC;
  const signer = await provider.getSigner(0), holder = await signer.getAddress();
  const coin = await new ContractFactory(mock.abi, mock.evm.bytecode.object, signer).deploy(); await coin.waitForDeployment();
  await (await coin.mint(holder, 1_000_000n)).wait();
  const res = await runSimulation({ rpc: (m, p) => provider.send(m, p), tokenAddress: coin.target, holder, expect: { symbol: await coin.symbol(), decimals: 6 } });
  const failed = res.checks.filter(c => !c.ok).map(c => c.name);
  assert.deepEqual(failed, ['multiplier interface present']);
  assert.ok(res.checks.some(c => c.name.startsWith('control: transferring more')));
});

test('eth_call simulation fails the transfer checks when the token rejects transfers', async t => {
  const connection = await network.create('localTest');
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 10;
  t.after(async () => { provider.destroy(); await connection.close(); });
  const mock = compileContracts({ includeMocks: true })['tests/fixtures/MockUSDC.sol'].MockUSDC;
  const signer = await provider.getSigner(0), holder = await signer.getAddress();
  const coin = await new ContractFactory(mock.abi, mock.evm.bytecode.object, signer).deploy(); await coin.waitForDeployment();
  await (await coin.mint(holder, 1_000_000n)).wait(); await (await coin.setFailTransfers(true)).wait();
  const res = await runSimulation({ rpc: (m, p) => provider.send(m, p), tokenAddress: coin.target, holder });
  assert.ok(res.checks.find(c => c.name.startsWith('holder -> fresh EOA, one base unit')).ok === false);
  assert.equal(res.pass, false);
});
