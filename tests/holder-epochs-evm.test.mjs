
import test from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import {
  BrowserProvider,
  ContractFactory,
  parseUnits
} from 'ethers';

import { compileContracts } from '../scripts/compile.mjs';
import { buildHolderEpoch } from '../packages/core/holder-epochs.mjs';
import { executeHolderEpoch } from '../apps/api/holder-epoch-keeper.mjs';

// ====================================================
// ELPIDA — HOLDER EPOCH EVM INTEGRATION TESTS
// ====================================================

const artifacts = compileContracts({ includeMocks: true });

const getArtifact = (file, name) => artifacts[file][name];

const mined = async tx => (await tx).wait();

// ====================================================
// TEST FIXTURE
// ====================================================

async function fixture(t, delay = 0) {
  const networkConnection = await network.create('localTest');

  const provider = new BrowserProvider(
    networkConnection.provider,
    undefined,
    { cacheTimeout: -1 }
  );

  provider.pollingInterval = 10;

  t.after(async () => {
    provider.destroy();
    await networkConnection.close();
  });

  const [
    publisher,
    other,
    holderA,
    holderB,
    holderC
  ] = await Promise.all(
    [0, 1, 2, 3, 4].map(i => provider.getSigner(i))
  );

  // Deploy mock USDC.
  const tokenArtifact = getArtifact(
    'tests/fixtures/MockUSDC.sol',
    'MockUSDC'
  );

  const quote = await new ContractFactory(
    tokenArtifact.abi,
    tokenArtifact.evm.bytecode.object,
    publisher
  ).deploy();

  await quote.waitForDeployment();

  // Deploy the holder distribution contract.
  const distArtifact = getArtifact(
    'contracts/evm/src/ElpidaHolderEpochs.sol',
    'ElpidaHolderEpochs'
  );

  const dist = await new ContractFactory(
    distArtifact.abi,
    distArtifact.evm.bytecode.object,
    publisher
  ).deploy(
    await publisher.getAddress(),
    delay
  );

  await dist.waitForDeployment();

  const launchToken = await quote.getAddress();
  const payoutAsset = launchToken;

  const holders = [
    holderA,
    holderB,
    holderC
  ];

  // Mint 1,000 mock USDC.
  await mined(
    quote.mint(
      await publisher.getAddress(),
      parseUnits('1000', 6)
    )
  );

  // Fund the distributor with 100 USDC.
  await mined(
    quote.transfer(
      await dist.getAddress(),
      parseUnits('100', 6)
    )
  );

  return {
    provider,
    publisher,
    other,
    holders,
    quote,
    dist,
    launchToken,
    payoutAsset,
    chainId: (await provider.getNetwork()).chainId,
    distributor: await dist.getAddress()
  };
}

// ====================================================
// EPOCH PLAN BUILDER
// ====================================================

function plan(
  f,
  {
    epochId = 1,
    min = 10,
    amounts = [10n, 20n, 30n]
  } = {}
) {
  return buildHolderEpoch({
    chainId: f.chainId,
    distributor: f.distributor,
    epochId,
    launchToken: f.launchToken,
    payoutAsset: f.payoutAsset,
    snapshotBlock: 1,
    minimumHolding: min,

    rows: amounts.map((value, i) => ({
      address: f.holders[i].address,
      holding: 100 + i,
      amount: value * 1_000_000n
    }))
  });
}

// ====================================================
// EPOCH PUBLISHER
// ====================================================

async function publish(f, m) {
  await mined(
    f.dist.publishEpoch(
      m.epochId,
      m.launchToken,
      m.payoutAsset,
      m.snapshotBlock,
      m.minimumHolding,
      m.root,
      m.manifestHash,
      m.budget,
      m.recipientCount
    )
  );
}

// ====================================================
// TEST 1
// FULL DISTRIBUTION AND REPLAY PREVENTION
// ====================================================

test(
  'EVM epoch: funded immutable root, permissionless payouts and replay prevention',
  async t => {
    const f = await fixture(t);
    const m = plan(f);

    await publish(f, m);

    // 60 USDC allocated to the epoch.
    assert.equal(
      await f.dist.reserved(f.payoutAsset),
      60_000_000n
    );

    // Any account can execute valid distributions.
    const c = f.dist.connect(f.other);

    const result = await executeHolderEpoch(
      c,
      m,
      { batchSize: 2 }
    );

    assert.equal(result.newlyPaid, 3);

    // All reserved rewards have been distributed.
    assert.equal(
      await f.dist.reserved(f.payoutAsset),
      0n
    );

    // Running the keeper again must not replay payouts.
    const replayResult = await executeHolderEpoch(c, m);

    assert.equal(replayResult.alreadyPaid, 3);
    assert.equal(replayResult.newlyPaid, 0);

    // Verify each wallet's expected payout.
    assert.equal(
      await f.quote.balanceOf(f.holders[0].address),
      10_000_000n
    );

    assert.equal(
      await f.quote.balanceOf(f.holders[1].address),
      20_000_000n
    );

    assert.equal(
      await f.quote.balanceOf(f.holders[2].address),
      30_000_000n
    );

    const first = m.entries[0];

    // The epoch is complete.
    // Recipient-count validation rejects new payouts.
    await assert.rejects(
      c.distributeBatch.staticCall(
        m.epochId,
        [first.address],
        [first.holding],
        [first.amount],
        [first.proof]
      ),
      /too many recipients/
    );
  }
);

// ====================================================
// TEST 2
// DUPLICATE PAYOUT BEFORE EPOCH COMPLETION
// ====================================================

test(
  'EVM rejects duplicate payments before an epoch is complete',
  async t => {
    const f = await fixture(t);
    const m = plan(f);

    await publish(f, m);

    // Merkle entries may be sorted by address.
    // Never assume entries[0] is the 10 USDC holder.
    const first = m.entries[0];

    const expectedAmount = BigInt(first.amount);
    const originalBudget = BigInt(m.budget);

    const initialBalance = await f.quote.balanceOf(
      first.address
    );

    // Pay only the selected first entry.
    await mined(
      f.dist.distributeBatch(
        m.epochId,
        [first.address],
        [first.holding],
        [first.amount],
        [first.proof]
      )
    );

    // Confirm payment status.
    assert.equal(
      await f.dist.epochPaid(
        m.epochId,
        first.address
      ),
      true
    );

    // Verify actual transferred amount.
    assert.equal(
      await f.quote.balanceOf(first.address),
      initialBalance + expectedAmount
    );

    // Attempt duplicate payout before epoch completion.
    await assert.rejects(
      f.dist.distributeBatch.staticCall(
        m.epochId,
        [first.address],
        [first.holding],
        [first.amount],
        [first.proof]
      ),
      /already paid/
    );

    // Confirm the wallet received no additional tokens.
    assert.equal(
      await f.quote.balanceOf(first.address),
      initialBalance + expectedAmount
    );

    // Verify reserved funds decreased exactly once.
    assert.equal(
      await f.dist.reserved(f.payoutAsset),
      originalBudget - expectedAmount
    );

    // All other holders must remain unpaid.
    for (const entry of m.entries.slice(1)) {
      assert.equal(
        await f.dist.epochPaid(
          m.epochId,
          entry.address
        ),
        false
      );
    }

    // Finish the epoch with the unpaid recipients.
    const remaining = m.entries.slice(1);

    await mined(
      f.dist.distributeBatch(
        m.epochId,
        remaining.map(entry => entry.address),
        remaining.map(entry => entry.holding),
        remaining.map(entry => entry.amount),
        remaining.map(entry => entry.proof)
      )
    );

    // Every holder should now be paid.
    for (const entry of m.entries) {
      assert.equal(
        await f.dist.epochPaid(
          m.epochId,
          entry.address
        ),
        true
      );

      assert.equal(
        await f.quote.balanceOf(entry.address),
        BigInt(entry.amount)
      );
    }

    // Nothing remains reserved.
    assert.equal(
      await f.dist.reserved(f.payoutAsset),
      0n
    );
  }
);

// ====================================================
// TEST 3
// AUTHORIZATION, MERKLE PROOFS AND RESERVE ACCOUNTING
// ====================================================

test(
  'EVM rejects incorrect proofs, unauthorized publication and overlapping reserved budget',
  async t => {
    const f = await fixture(t);
    const m = plan(f);

    // Unauthorized publishers cannot create epochs.
    await assert.rejects(
      f.dist.connect(f.other).publishEpoch.staticCall(
        m.epochId,
        m.launchToken,
        m.payoutAsset,
        m.snapshotBlock,
        m.minimumHolding,
        m.root,
        m.manifestHash,
        m.budget,
        m.recipientCount
      ),
      /publisher only/
    );

    await publish(f, m);

    const row = m.entries[0];

    // Changing a committed payout amount invalidates
    // its Merkle proof.
    await assert.rejects(
      f.dist.distributeBatch.staticCall(
        m.epochId,
        [row.address],
        [row.holding],
        [BigInt(row.amount) + 1n],
        [row.proof]
      ),
      /invalid proof/
    );

    // 60 USDC is already reserved out of 100 USDC.
    // Reserving another 60 USDC would overcommit funds.
    await assert.rejects(
      f.dist.publishEpoch.staticCall(
        2,
        m.launchToken,
        m.payoutAsset,
        m.snapshotBlock,
        m.minimumHolding,
        m.root,
        m.manifestHash,
        60_000_000n,
        m.recipientCount
      ),
      /unfunded epoch/
    );

    // The remaining 40 USDC can be reserved.
    const second = plan(f, {
      epochId: 2,
      amounts: [10n, 10n, 20n]
    });

    await publish(f, second);

    assert.equal(
      await f.dist.reserved(f.payoutAsset),
      100_000_000n
    );

    // No payout has occurred in either epoch.
    for (const entry of m.entries) {
      assert.equal(
        await f.dist.epochPaid(
          m.epochId,
          entry.address
        ),
        false
      );
    }
  }
);

// ====================================================
// TEST 4
// PUBLICATION DELAY AND FAILED TRANSFER ROLLBACK
// ====================================================

test(
  'EVM rejects payout before publication delay and rolls back failed transfers',
  async t => {
    const f = await fixture(t, 3600);
    const m = plan(f);

    await publish(f, m);

    const row = m.entries[0];

    // Epoch payouts cannot execute before the delay.
    await assert.rejects(
      f.dist.distributeBatch.staticCall(
        m.epochId,
        [row.address],
        [row.holding],
        [row.amount],
        [row.proof]
      ),
      /epoch not ready/
    );

    // Advance the local blockchain clock.
    await f.provider.send(
      'evm_increaseTime',
      [3601]
    );

    await f.provider.send(
      'evm_mine',
      []
    );

    // Simulate failed ERC20 transfers.
    await mined(
      f.quote.setFailTransfers(true)
    );

    await assert.rejects(
      f.dist.distributeBatch.staticCall(
        m.epochId,
        [row.address],
        [row.holding],
        [row.amount],
        [row.proof]
      ),
      /SafeERC20FailedOperation|revert/
    );

    // Failed transfers must not mark the wallet as paid.
    assert.equal(
      await f.dist.epochPaid(
        m.epochId,
        row.address
      ),
      false
    );

    // Failed transfers must not consume reserved funds.
    assert.equal(
      await f.dist.reserved(f.payoutAsset),
      60_000_000n
    );

    // Restore normal ERC20 transfers.
    await mined(
      f.quote.setFailTransfers(false)
    );

    // Complete the payout.
    await mined(
      f.dist.distributeBatch(
        m.epochId,
        [row.address],
        [row.holding],
        [row.amount],
        [row.proof]
      )
    );

    assert.equal(
      await f.dist.epochPaid(
        m.epochId,
        row.address
      ),
      true
    );

    // Confirm that the selected amount was transferred.
    assert.equal(
      await f.quote.balanceOf(row.address),
      BigInt(row.amount)
    );

    // Confirm that exactly the selected amount
    // was deducted from the reserved budget.
    assert.equal(
      await f.dist.reserved(f.payoutAsset),
      BigInt(m.budget) - BigInt(row.amount)
    );
  }
);
