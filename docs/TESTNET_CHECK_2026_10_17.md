# Core lifecycle check — 17 October 2026

The public Base Sepolia inspection was read-only. No keys, signatures, deployments
or transactions were submitted. Model 10 and separate chain wallets are unchanged.

At 19:52 UTC, the current factory was
`0xD64119914DDA7b206d01Fb2B334A630Ca94fD6d2`, model 10, metadata version 1.
Storage reported durable; the current factory indexer had no error and lagged two
blocks, matching its two-confirmation setting. These are observations at that time.

VASTOLORDE (`0x824932198c224e52a5b73e8c412e2987ef9b03a4`) had verified current-factory
origin and resolvable metadata. Its graduated pool was
`0xcC83Eb4dF38708EcD228ac094C16F1d9bEBbCa72`.
Uniswap position 82996 was owned by locker
`0xf06aE71B427b4Ad2C25D320a78D087Fe91332256`; the locker reported locked and the same
position ID. Its manager and migration adapter manager matched the configured Base
Sepolia manager, and the position had nonzero liquidity. These custody checks are
not a contract audit or a substitute for verifying fee-only collection.

The recent VASTOLORDE trade response contained two records with a buy but no sell
or DEX trade. This bounded window does not prove there has never been such a trade.
ELTEST, JUICEWRLD and JOSH verified against the configured legacy factory; ELTEST's
metadata resolved. JUICEWRLD and JOSH had empty on-chain metadata references.

The readiness command now verifies each curve's factory against the configured
current/legacy allowlist, reads metadata from that factory, and directly checks
graduated position custody. Previously it queried every token against the current
factory, producing misleading origin and metadata results for legacy tokens.

## Local contract validation

All 32 tests passed with zero failures or skips:

```text
node --test --test-concurrency=1 tests/usdc-payments.test.mjs tests/metadata-store.test.mjs tests/dex-migration.test.mjs tests/post-migration-fees.test.mjs tests/holder-epochs-evm.test.mjs tests/holder-snapshot.test.mjs tests/reward-epoch-security.test.mjs tests/reward-runtime.test.mjs
```

Coverage includes metadata/first-buy atomicity, native and USDC trading, actual
local Uniswap graduation and swaps, fee collection without moving principal,
rejecting-recipient claim isolation, funded holder epochs, historical snapshot
agreement, payout replay prevention, local reward allocation, conversion and vesting.
The revised readiness script also completed successfully against the public
read-only endpoints and Base Sepolia RPC. No production code was deployed in this pass.

## Next public testnet exercise

Use the existing graduated VASTOLORDE token, avoiding an unnecessary new launch:

1. With a test-only Base Sepolia wallet and sufficient test ETH for gas, make a
   small post-graduation buy. Record the successful transaction receipt, actual
   token balance increase, and indexed DEX trade.
2. Sell part of that purchase. Record the successful receipt, actual token balance
   decrease and indexed DEX sell. Check the All/Buys/Sells views.
3. Collect the position's earned fees, then claim the creator's split with the
   creator wallet. Record receipts and actual asset deltas accounting for gas.
   A previous curve fee claim does not prove post-graduation fee collection.
4. Re-run `npm run testnet:check` and confirm position 82996 is still owned by its
   locker with unchanged principal liquidity. Fee collection must not move principal.

These public steps remain pending in this check. Historical snapshots and automatic
holder-epoch funding remain local candidates; passing their tests does not enable
them on public chains or authorize a mainnet deployment.
