// The multi-chain fork check's lifecycle, run in the suite against a local Uniswap v3 with both router layouts:
// SwapRouter02 (version 2: Base, Ethereum) and Uniswap's original SwapRouter (version 1: the layout PancakeSwap v3 uses
// on BNB Chain). On a real chain the same function runs on a fork via `npm run test:chain-fork -- <network>`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ContractFactory } from 'ethers';
import { runChainLifecycle } from '../scripts/chain-fork-lifecycle.mjs';
import { dexFixture, art } from './helpers/dex-fixture.mjs';

const originalRouter = JSON.parse(readFileSync(new URL('../node_modules/@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json', import.meta.url), 'utf8'));

for (const version of [2, 1]) {
  test(`fork-check lifecycle passes end to end with router version ${version}`, async t => {
    const f = await dexFixture(t);
    let dex = { ...f.dex.config, name: 'Uniswap v3 (local)' };
    if (version === 1) {
      const router = await new ContractFactory(originalRouter.abi, originalRouter.bytecode, f.signers[0]).deploy(f.dex.factory.target, f.dex.weth.target);
      await router.waitForDeployment();
      dex = { ...dex, router: router.target, routerVersion: 1 };
    }
    const lines = [];
    const result = await runChainLifecycle({ provider: f.provider, signer: f.signers[0], attacker: f.signers[1], dex, feed: f.feed.target, maxAge: 86400, art, log: l => lines.push(l) });
    t.diagnostic(lines.join('\n'));
    assert.ok(result.checks.length === 11 && result.checks.every(c => c.ok));
    assert.ok(result.gas.some(g => g.step === 'DEX sell (native out)'));
    assert.ok(result.gas.some(g => /pre-created pool/.test(g.step)), 'the rebalance path ran');
  });
}
