import test from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { BrowserProvider, ContractFactory } from 'ethers';
import { compileContracts } from '../scripts/compile.mjs';
import { buildIssuerOps, runIssuerPowers } from '../scripts/equity-issuer-powers-fork.mjs';

// Offline check of the issuer-power scenarios against a local token that has the same powers (block, pause, burn, multiplier).
test('issuer-power scenarios run end to end and record what blocking, pausing and burning do to the launchpad', async t => {
  const connection = await network.create('localTest');
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 10;
  t.after(async () => { provider.destroy(); await connection.close(); });
  const mock = compileContracts({ includeMocks: true })['tests/fixtures/MockIssuerStock.sol'].MockIssuerStock;
  const signer = await provider.getSigner(0), issuer = await signer.getAddress();
  const stock = await new ContractFactory(mock.abi, mock.evm.bytecode.object, signer).deploy(); await stock.waitForDeployment();
  const unit = 10n ** 18n;
  const fund = async signers => { for (const s of signers.slice(0, 2)) await (await stock.mint(await s.getAddress(), 200n * unit)).wait(); };
  const ops = await buildIssuerOps({ provider, sources: [{ address: stock.target, abi: mock.abi }], candidates: ['0x00000000000000000000000000000000000bad01', issuer] });
  for (const k of ['block', 'unblock', 'pause', 'unpause', 'burn', 'multiplier']) assert.ok(ops[k].run, `${k}: ${ops[k].missing}`);
  assert.equal(ops.block.caller.toLowerCase(), issuer.toLowerCase()); // the non-issuer candidate is skipped
  const res = await runIssuerPowers({ provider, stockAddress: stock.target, fund, ops, virtualQuote: 20n * unit, firstBuy: unit, tradeBuy: unit });
  const names = res.checks.map(c => c.name);
  for (const letter of ['A.', 'B.', 'C.', 'D.', 'E.']) assert.ok(names.some(n => n.startsWith(letter)), `scenario ${letter} did not run`);
  const noteA = res.observations.find(o => o.name.startsWith('A. issuer blocks the curve'));
  assert.match(noteA.detail, /sell reverted, buy reverted/);
  const noteC = res.observations.find(o => o.name.startsWith('C. issuer burns half of the curve reserve: shortfall'));
  assert.match(noteC.detail, /raw units/);
});

test('missing issuer powers are reported, not invented', async t => {
  const connection = await network.create('localTest');
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 10;
  t.after(async () => { provider.destroy(); await connection.close(); });
  const mock = compileContracts({ includeMocks: true })['tests/fixtures/MockIssuerStock.sol'].MockIssuerStock;
  const signer = await provider.getSigner(0);
  const stock = await new ContractFactory(mock.abi, mock.evm.bytecode.object, signer).deploy(); await stock.waitForDeployment();
  const ops = await buildIssuerOps({ provider, sources: [{ address: stock.target, abi: mock.abi }], candidates: ['0x00000000000000000000000000000000000bad01'] });
  assert.match(ops.burn.missing, /no candidate account may call adminBurn/);
  const none = await buildIssuerOps({ provider, sources: [{ address: stock.target, abi: [] }], candidates: [] });
  assert.match(none.pause.missing, /no function named pause/);
});
