import test from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { BrowserProvider, ContractFactory } from 'ethers';
import { compileContracts } from '../scripts/compile.mjs';
import { runTokenChecks } from '../scripts/equity-fork-check.mjs';

// Offline check that the fork-check logic itself works, using a local ERC-20. The real run needs a forked RPC.
test('fork-check steps pass for a well-behaved token and fail for a token that refuses transfers', async () => {
  const compiled = compileContracts({ includeMocks: true });
  const probeArtifact = compiled['tests/fixtures/EquityHolderProbe.sol'].EquityHolderProbe, usdc = compiled['tests/fixtures/MockUSDC.sol'].MockUSDC;
  const connection = await network.create('localTest');
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 10;
  try {
    const signer = await provider.getSigner(0), holder = await (await provider.getSigner(3)).getAddress();
    const token = await new ContractFactory(usdc.abi, usdc.evm.bytecode.object, signer).deploy(); await token.waitForDeployment();
    await (await token.mint(holder, 10n ** 12n)).wait();
    const good = await runTokenChecks({ provider, tokenAddress: await token.getAddress(), holder, probeArtifact, expect: { symbol: 'USDC', decimals: 6 } });
    assert.equal(good.pass === false, good.checks.some(c => !c.ok));
    const byName = Object.fromEntries(good.checks.map(c => [c.name, c.ok]));
    assert.equal(byName['holder -> EOA transfer conserves the raw amount'], true);
    assert.equal(byName['holder -> contract (curve/pool/vault stand-in) conserves the raw amount'], true);
    assert.equal(byName['contract -> EOA sweep'], true);
    assert.equal(byName['approve + transferFrom pull by a contract (pool/router pattern)'], true);
    assert.equal(byName['multiplier interface present'], false, 'a plain token has no multiplier and the check says so');
    assert.equal(good.pass, false, 'missing multiplier interface keeps the overall result honest');
    await (await token.setFailTransfers(true)).wait();
    const bad = await runTokenChecks({ provider, tokenAddress: await token.getAddress(), holder, probeArtifact, expect: { symbol: 'USDC', decimals: 6 } });
    assert.equal(bad.checks.find(c => c.name === 'contract -> EOA sweep').ok, false);
  } finally { provider.destroy(); await connection.close(); }
});
