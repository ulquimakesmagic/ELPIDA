# Holder epochs Phase 3 (local candidate)

No deployment, mainnet transaction, key loading, or real funds are part of this change.
Model 10 pricing and the existing separate chain wallets are unchanged. This bridge
is a same-chain ERC20 transfer, not a cross-chain bridge.

## Funding

For a new local deployment, initialize the reward vault as before. Deploy a new
ElpidaHolderEpochs with publisher = reward vault address and a deliberate
publication delay, then have the vault executor call configureHolderDistributor.
The binding is permanent and checks the distributor's publication authority.
An existing Phase 2 distributor with an EOA publisher cannot be rebound.

The executor calls fundHolderEpoch with the immutable manifest commitments.
The launch token is always the initialized mainToken. Only synced strategyBalance
can fund an epoch; identity claims, direct claims and vested grants cannot.
Funding decrements accounted and strategyBalance, checks exact ERC20 debit and
credit, then publishes and reserves the budget in the same transaction. A transfer
or publication failure rolls everything back. Native funds must first use an
existing approved conversion path; native payouts are not supported here.
The executor and configured distributor remain trusted. Use only reviewed standard
ERC20 assets; rebasing, transfer-tax and malicious tokens are unsupported.
Each payout asset and snapshot can fund at most one holder epoch, even under a new
epoch ID. The old trusted distribute path remains available for existing local
workflows, but a snapshot used there cannot subsequently fund a holder epoch and
a funded holder snapshot cannot use the old path. Failed transactions roll back
these replay markers. Separate snapshots still require a trusted allocation policy.

## Historical snapshots and keeper

verifiedHolderSnapshot takes exactly two independently operated archive providers,
a chain ID, token, explicit snapshotBlock and confirmation depth (default 64).
It enumerates Transfer participants from genesis in bounded log ranges, queries
historical balances and totalSupply on each provider, reconciles the discovered
supply, compares both complete reports, and checks the block hash for reorgs.
This supports standard ERC20 Transfer semantics; incomplete RPC history fails closed.
Confirmation depth is chain-specific and is not a claim of consensus finality.
RPC agreement is not a cryptographic state proof and cannot protect against two
colluding endpoints. Full history scans may be expensive; no server timer is enabled.

Build a manifest with buildHolderEpoch from eligible snapshot rows and the existing
reward policy's exact integer allocation. publishFundedHolderEpoch accepts the vault,
distributor, manifest and {manifestPath, snapshotOptions}. It independently rebuilds
the eligible set, verifies holdings and commitments, excludes the vault, distributor,
launch token and main curve plus explicit excluded addresses, persists the immutable
manifest and a .snapshot.json audit sidecar, rechecks the canonical hash, and submits
atomic funding. Both vault and distributor client chains are validated. Persist
manifests redundantly before using any non-local environment. Identical journal
files allow retry; different files are refused. Publication retries and uncertain
receipts reconcile all immutable epoch fields against the audited manifest before
considering publication successful. The result is {alreadyPublished, receipt}, with
a null receipt when an existing matching epoch is recovered. A mismatched existing
epoch fails closed. Resume payouts with executeHolderEpoch, whose paid-state checks
handle restarts and lost payout receipts. Publication delay must elapse first.

The snapshot block is committed on chain; its canonical hash is checked off chain.
A reorg after submission requires operator review; immutable epochs have no automatic
cancellation/recovery. This candidate is not production-audited and leaves economic
allocation policy and scheduling to the existing explicit caller.

## Validation

Local Hardhat EVM tests cover atomic funding and rollback, authority and binding,
claim isolation, keeper payouts and a historical snapshot whose current balances
have changed. Adversarial cases cover taxed funding and payouts, reentrant sync,
snapshot replay across epoch IDs and legacy paths, lost publication receipts,
publication restarts, omitted eligible holders, false historical holdings, wrong
chains and reorgs immediately before sending. Snapshot unit tests cover missing
holders, RPC balance/hash disagreement, shared providers, mid-read reorgs and
insufficient confirmations. Existing Phase 2 proof, replay, failed-transfer, reward
and wallet tests are run alongside the new coverage.

Validation on 2026-10-17:

- `node --test --test-concurrency=4 tests/*.test.mjs`: 212 tests, 187 passed,
  0 failed, 25 skipped because solana-test-validator is not installed.
- `node --test tests/holder-epochs-evm.test.mjs tests/holder-snapshot.test.mjs tests/holder-epochs.test.mjs`:
  17 passed, 0 failed (including the final hardening changes).
- `git diff --cached --check`: passed. The unrelated package-lock.json is excluded.
