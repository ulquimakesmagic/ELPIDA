
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

test('Phase 3 vault funding is atomic, authorized and excludes allocated claims', async t=>{
 const f=await fixture(t);
 const a=getArtifact('contracts/evm/src/ElpidaRewardVault.sol','ElpidaRewardVault');
 const deployVault=async(wallets=[],splits=[])=>{
  const v=await new ContractFactory(a.abi,a.evm.bytecode.object,f.publisher).deploy(f.publisher.address,f.publisher.address,wallets.map(()=> '0x'+'00'.repeat(32)),wallets,splits);
  await v.waitForDeployment();
  await mined(v.initialize(f.launchToken,f.launchToken,f.payoutAsset));return v;
 };
 const v=await deployVault();
 const d=getArtifact('contracts/evm/src/ElpidaHolderEpochs.sol','ElpidaHolderEpochs');
 const dist=await new ContractFactory(d.abi,d.evm.bytecode.object,f.publisher).deploy(await v.getAddress(),0);await dist.waitForDeployment();
 await assert.rejects(v.configureHolderDistributor.staticCall(f.distributor),/distributor publisher/);
 await assert.rejects(v.connect(f.other).configureHolderDistributor.staticCall(await dist.getAddress()),/distributor config/);
 await mined(v.configureHolderDistributor(await dist.getAddress()));
 await assert.rejects(v.configureHolderDistributor.staticCall(await dist.getAddress()),/distributor config/);
 await mined(f.quote.transfer(await v.getAddress(),100_000_000n));await mined(v.sync(f.payoutAsset));
 const m=plan({...f,distributor:await dist.getAddress()});
 const args=[m.epochId,m.payoutAsset,m.snapshotBlock,m.minimumHolding,m.root,m.manifestHash,m.budget,m.recipientCount];
 await assert.rejects(v.connect(f.other).fundHolderEpoch.staticCall(...args),/holder funding authority/);
 const bad=[...args];bad[0]=2;
 await assert.rejects(mined(v.fundHolderEpoch(...bad,{gasLimit:2_000_000})));
 assert.equal(await v.strategyBalance(f.payoutAsset),100_000_000n);
 assert.equal(await f.quote.balanceOf(await dist.getAddress()),0n);
 await mined(v.fundHolderEpoch(...args));
 assert.equal(await v.strategyBalance(f.payoutAsset),40_000_000n);
 assert.equal(await v.accounted(f.payoutAsset),40_000_000n);
 assert.equal(await dist.reserved(f.payoutAsset),60_000_000n);
 await assert.rejects(v.fundHolderEpoch.staticCall(...args));
 await executeHolderEpoch(dist.connect(f.other),m);
 assert.equal(await dist.reserved(f.payoutAsset),0n);
 const allocated=await deployVault([f.other.address],[10000]);
 const ad=await new ContractFactory(d.abi,d.evm.bytecode.object,f.publisher).deploy(await allocated.getAddress(),0);await ad.waitForDeployment();
 await mined(allocated.configureHolderDistributor(await ad.getAddress()));
 await mined(f.quote.transfer(await allocated.getAddress(),100_000_000n));await mined(allocated.sync(f.payoutAsset));
 await assert.rejects(allocated.fundHolderEpoch.staticCall(...args),/holder budget/);
 assert.equal(await allocated.claimable(f.other.address,f.payoutAsset),100_000_000n);
});

test('Phase 3 historical snapshot publishes through keeper after balances change',async t=>{
 const f=await fixture(t);
 const ta=getArtifact('contracts/evm/src/ElpidaToken.sol','ElpidaToken');
 const token=await new ContractFactory(ta.abi,ta.evm.bytecode.object,f.publisher).deploy('Historical','HIST',1000n,f.holders[0].address);await token.waitForDeployment();
 const va=getArtifact('contracts/evm/src/ElpidaRewardVault.sol','ElpidaRewardVault');
 const vault=await new ContractFactory(va.abi,va.evm.bytecode.object,f.publisher).deploy(f.publisher.address,f.publisher.address,[],[],[]);await vault.waitForDeployment();
 await mined(vault.initialize(await token.getAddress(),f.launchToken,f.payoutAsset));
 const da=getArtifact('contracts/evm/src/ElpidaHolderEpochs.sol','ElpidaHolderEpochs');
 const dist=await new ContractFactory(da.abi,da.evm.bytecode.object,f.publisher).deploy(await vault.getAddress(),0);await dist.waitForDeployment();
 await mined(vault.configureHolderDistributor(await dist.getAddress()));
 await mined(f.quote.transfer(await vault.getAddress(),100n));await mined(vault.sync(f.payoutAsset));
 await mined(token.connect(f.holders[0]).transfer(f.holders[1].address,400n));
 const snapshotBlock=await f.provider.getBlockNumber();
 await mined(token.connect(f.holders[0]).transfer(f.holders[1].address,500n));
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=await mkdtemp(join(tmpdir(),'elpida-phase3-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 // Two adapters to one local chain exercise the dual-reader path; production needs independent RPC operators.
 const adapter=()=>({getNetwork:()=>f.provider.getNetwork(),getBlockNumber:()=>f.provider.getBlockNumber(),getBlock:n=>f.provider.getBlock(n),getLogs:q=>f.provider.getLogs(q),call:q=>f.provider.call(q)});
 const m=buildHolderEpoch({chainId:f.chainId,distributor:await dist.getAddress(),epochId:1,launchToken:await token.getAddress(),payoutAsset:f.payoutAsset,snapshotBlock,minimumHolding:1,rows:[{address:f.holders[0].address,holding:600,amount:60},{address:f.holders[1].address,holding:400,amount:40}]});
 const {publishFundedHolderEpoch}=await import('../apps/api/holder-epoch-keeper.mjs');
 const options={manifestPath:join(dir,'epoch.json'),snapshotOptions:{providers:[adapter(),adapter()],confirmations:1}};
 const incomplete=buildHolderEpoch({...m,rows:[{address:f.holders[0].address,holding:600,amount:60}]});
 await assert.rejects(publishFundedHolderEpoch(vault,dist,incomplete,options),/Incomplete eligible recipient set/);
 const untrue=buildHolderEpoch({...m,rows:m.entries.map(row=>({...row,holding:500}))});
 await assert.rejects(publishFundedHolderEpoch(vault,dist,untrue,options),/Historical token balance mismatch/);
 const wrongChain={runner:{provider:{getNetwork:async()=>({chainId:1n})}}};
 await assert.rejects(publishFundedHolderEpoch(wrongChain,dist,m,options),/Wrong vault chain/);
 // Change the hash only on the final pre-send check, after both RPC audits finish.
 const reorgReader=adapter();let hashReads=0;const getBlock=reorgReader.getBlock;
 reorgReader.getBlock=async n=>{const b=await getBlock(n);return ++hashReads===3?{...b,hash:'0x'+'11'.repeat(32)}:b;};
 await assert.rejects(publishFundedHolderEpoch(vault,dist,m,{...options,manifestPath:join(dir,'reorg.json'),snapshotOptions:{providers:[reorgReader,adapter()],confirmations:1}}),/Snapshot reorg/);
 assert.equal(await dist.nextEpochId(),0n);
 assert.equal(await vault.strategyBalance(f.payoutAsset),100n);
 const lostReceiptVault={runner:vault.runner,getAddress:()=>vault.getAddress(),holderDistributor:()=>vault.holderDistributor(),mainToken:()=>vault.mainToken(),mainCurve:()=>vault.mainCurve(),fundHolderEpoch:async(...args)=>{
  const tx=await vault.fundHolderEpoch(...args);return {wait:async()=>{await tx.wait();throw new Error('lost publication receipt');}};
 }};
 assert.equal((await publishFundedHolderEpoch(lostReceiptVault,dist,m,options)).alreadyPublished,true);
 // A restart reads the same journal and matching immutable epoch, without sending again.
 assert.equal((await publishFundedHolderEpoch(vault,dist,m,options)).alreadyPublished,true);
 assert.equal(await dist.nextEpochId(),1n);
 await executeHolderEpoch(dist.connect(f.other),m);
 assert.equal(await f.quote.balanceOf(f.holders[0].address),60n);
 assert.equal(await f.quote.balanceOf(f.holders[1].address),40n);
 assert.equal(await vault.accounted(f.payoutAsset),0n);
});

test('Phase 3 rejects taxed funding and blocks reentrant sync without corrupting reserves',async t=>{
 const f=await fixture(t);
 const deploy=async(file,name,args=[])=>{const a=getArtifact(file,name);const c=await new ContractFactory(a.abi,a.evm.bytecode.object,f.publisher).deploy(...args);await c.waitForDeployment();return c;};
 const asset=await deploy('tests/fixtures/AdversarialRewardToken.sol','AdversarialRewardToken');
 const vault=await deploy('contracts/evm/src/ElpidaRewardVault.sol','ElpidaRewardVault',[f.publisher.address,f.publisher.address,[],[],[]]);
 await mined(vault.initialize(f.launchToken,f.launchToken,await asset.getAddress()));
 const dist=await deploy('contracts/evm/src/ElpidaHolderEpochs.sol','ElpidaHolderEpochs',[await vault.getAddress(),0]);
 await mined(vault.configureHolderDistributor(await dist.getAddress()));
 await mined(asset.mint(await vault.getAddress(),100_000_000n));await mined(vault.sync(await asset.getAddress()));
 const m=plan({...f,distributor:await dist.getAddress(),payoutAsset:await asset.getAddress()});
 const args=[m.epochId,m.payoutAsset,m.snapshotBlock,m.minimumHolding,m.root,m.manifestHash,m.budget,m.recipientCount];
 await mined(asset.configure(true,'0x0000000000000000000000000000000000000000'));
 await assert.rejects(mined(vault.fundHolderEpoch(...args,{gasLimit:2_000_000})));
 assert.equal(await asset.balanceOf(await vault.getAddress()),100_000_000n);
 assert.equal(await asset.balanceOf(await dist.getAddress()),0n);
 assert.equal(await vault.accounted(m.payoutAsset),100_000_000n);
 assert.equal(await vault.strategyBalance(m.payoutAsset),100_000_000n);
 assert.equal(await vault.holderSnapshotFunded(m.payoutAsset,m.snapshotBlock),false);
 assert.equal(await dist.nextEpochId(),0n);
 await mined(asset.configure(false,await vault.getAddress()));
 await mined(vault.fundHolderEpoch(...args));
 assert.equal(await asset.callbackAttempted(),true);
 assert.equal(await asset.callbackSucceeded(),false);
 assert.equal(await vault.accounted(m.payoutAsset),40_000_000n);
 assert.equal(await vault.strategyBalance(m.payoutAsset),40_000_000n);
 assert.equal(await dist.reserved(m.payoutAsset),60_000_000n);
 const replay=[...args];replay[0]=2;replay[6]=10n;
 await assert.rejects(vault.fundHolderEpoch.staticCall(...replay),/snapshot already funded/);
 await assert.rejects(vault.distribute.staticCall(m.payoutAsset,[f.holders[0].address],[1n],0,m.snapshotBlock),/snapshot already funded/);
 // Taxed payouts also roll back all recipient, reservation and token changes.
 await mined(asset.configure(true,'0x0000000000000000000000000000000000000000'));
 await assert.rejects(executeHolderEpoch(dist,m));
 assert.equal(await dist.epochPaid(m.epochId,m.entries[0].address),false);
 assert.equal(await dist.reserved(m.payoutAsset),60_000_000n);
 await mined(asset.configure(false,'0x0000000000000000000000000000000000000000'));
 await executeHolderEpoch(dist,m);
 const snapshot=await f.provider.getBlockNumber();
 await mined(vault.distribute(m.payoutAsset,[f.holders[0].address],[1n],0,snapshot));
 const legacyReplay=[...replay];legacyReplay[2]=snapshot;
 await assert.rejects(vault.fundHolderEpoch.staticCall(...legacyReplay),/snapshot already funded/);
 // Vesting reserves remain accounted but are no longer strategy funds.
 await mined(vault.distribute(m.payoutAsset,[f.holders[1].address],[39_999_999n],3600,snapshot));
 assert.equal(await vault.strategyBalance(m.payoutAsset),0n);
 assert.equal(await vault.accounted(m.payoutAsset),39_999_999n);
 assert.equal(await vault.grantCount(),1n);
 const encumbered=[...replay];encumbered[2]=await f.provider.getBlockNumber();encumbered[6]=1n;
 await assert.rejects(vault.fundHolderEpoch.staticCall(...encumbered),/holder budget/);
});
