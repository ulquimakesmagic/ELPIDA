# Holder distribution Phase 2 — EVM candidate (not yet wired into production)

This additive implementation does **not** change Elpida's chain-specific wallets, $10 launch fee, Model 10 market-cap parameters, fee split, or Solana programs. No new shared USDC balance is introduced.

## Components

- `contracts/evm/src/ElpidaHolderEpochs.sol`: pre-funded ERC20 rewards, immutable per-epoch root and snapshot metadata, on-chain budget reservation, eligible-holder proof checks, and permissionless atomic **push** payments of at most 16 recipients per transaction.
- `packages/core/holder-epochs.mjs`: chain-ID and distributor-domain-separated, deterministic sorted-address, double-keccak Merkle manifests and proofs. All amounts are token base units. JSON contains no private keys.
- `apps/api/holder-epoch-keeper.mjs`: idempotent execution of **unpaid** recipients, including mixed paid/unpaid batches and lost transaction confirmations, from a durable manifest. `persistEpochManifest` uses create-if-absent storage to avoid overwriting an already-published snapshot.
- `auditHolderEpoch` re-checks the published balances with a historical RPC callback and refuses excluded contract addresses before publication. This is a sanity check, not cryptographic proof of full snapshot correctness.
- `tests/holder-epochs.test.mjs` / `tests/holder-epochs-evm.test.mjs`: manifest, retry, on-chain accounting, authorization, delay, and reverted transfers.

## Required production work (do not bypass)

1. **Snapshot validity:** Publishing a Merkle root proves a recipient matches the signed-off list, **not** their balance at the historical block. The existing ERC20 token does not expose checkpointed historical balances on-chain. The designated `publisher` must be a governed, independently supervised multisig/attestation process. Audit all holder and excluded-contract balances against an archive RPC at `snapshotBlock`, and publish the complete manifest for independent review. Investigate checkpointed tokens, challenge protocols or cryptographic historical-state proofs before describing this as trustless.
2. **Funding:** `publishEpoch` reserves funds **already transferred to the distributor**. A holder reward vault must only transfer its strategy funds through an audited, allowlisted adapter. No ad-hoc transfer from unrelated wallets, no using the $10 launch fee or graduation reserves. The current `ElpidaRewardVault` remains local/trusted; this prototype intentionally does **not** attach to or redeploy it.
3. **Asset eligibility:** This candidate supports only ordinary ERC20 transfers. Native SOL/ETH payments, the Solana branch, restricted tokenized stocks, bridging and rebasing/fee-on-transfer tokens require additional implementations. A failed ERC20 batch reverts atomically. Only permit asset addresses verified by governance and issuer compliance where necessary.
4. **Automation:** Run a funded keeper as a scheduled service. Store the manifest in persistent replicated storage before publication; pass its hash on-chain. Any address can execute batches, so the keeper may restart and filter already-paid holders using `epochPaid`. Publication has a configurable review delay (recommend 24h). Include timeouts, RPC finality/reorg handling, backoff, gas caps, failure alerts, and independent reconciliation of `reserved` to contract balances.
5. **Completeness:** Validate that `sum(amount) == budget`, holders are unique, and `recipientCount` matches the manifest. A publisher who commits an incorrect or incomplete root can strand funds; this prototype deliberately has no arbitrary funds withdrawal or root mutation. Introduce a timelocked, independently authorized recovery design before production.
6. **Security:** External audit, adversarial testing, fork simulations, actual chain-specific quote asset allowlists, and regulator/issuer review for xStocks remain mandatory. Never deploy with a hot wallet as `publisher` or real customer funds in this form.

## Testing

```sh
npm run compile
node --test tests/holder-epochs.test.mjs
node --test tests/holder-epochs-evm.test.mjs
```

## Example publication workflow

1. At a **finalized past block**, obtain recipient addresses from token Transfer logs and check each token balance using `balanceOf(address, {blockTag: snapshotBlock})`. Exclude the curve, LP pools, treasury, burn wallets, vaults and ineligible/blocked addresses. Do not rely solely on token transfers if holder state is maintained differently.
2. Compute proportional/equal payout amounts as **integers**, resolving any dust deterministically, then call `buildHolderEpoch` using the actual `chainId`, deployed `distributor` address and historical balances. Save with `persistEpochManifest` and independently verify its root/recipient count/budget.
3. Fund the distributor with exactly enough already-earned, eligible reward assets. After an audit/review of the manifest and balances, call `publishEpoch(epochId, launchToken, payoutAsset, snapshotBlock, minimumHolding, root, manifestHash, budget, recipientCount)` from the publisher multisig.
4. After `readyAt`, run `executeHolderEpoch(distributor, manifest)` from a gas-funded keeper. The contract enforces proof, replay and reserve invariants. Publish the manifest URL alongside the epoch event for public inspection.

**Version scope:** EVM candidate only; no on-chain swap executor/verified stock issuer routes yet. The reward asset purchase stays in the existing simulated/local engine until real DEX quotes, slippage, route allowlists and transfer restrictions have been independently validated.

## Test status from the build environment

- Solidity compilation (`npm run compile`): **passed**.
- Pure economic, epoch manifest, retry and existing batch tests: **16/16 passed**.
- `tests/holder-epochs-evm.test.mjs`: **not executable here**, because the ZIP's Hardhat optional native binding targets Windows, not this Linux container. Run it on the developer's Windows machine after `npm ci`/installing the correct platform-native dependencies. No deployed or forked-chain test was completed.

## Production cutover

This prototype is intentionally **not connected to** `RewardEngine.process()`, `ElpidaRewardVault.sync()`, or an automated converter. Preserve the currently tested local reward path until the snapshot publisher, allowlisted vault funding adapter, external keeper and asset compliance validations pass testnet and external security review. The existing local/production reward flow will not spontaneously switch because these files are added.
