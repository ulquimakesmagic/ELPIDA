# Model 10 — current EVM launch model

Status: implemented and tested locally on 15 October 2026 (Phase 1 of the fix-and-finish plan). **Not audited, not deployed to any public chain yet.** Base Sepolia's pinned team launchpad is still the model 9 factory `0xe605…4f91` until the model 10 factory is deployed (see [HUMAN_ACTIONS.md](HUMAN_ACTIONS.md)). Model 9 stays fully readable and tradable in the app as a legacy model.

This page supersedes the curve numbers in older guides (VIRTUAL_CURVE_AND_PAIRS, INDEXER_AND_POST_MIGRATION_FEES, CURVE_MIGRATION_INDEXER_PLAN), which describe models 3–9.

## Product rules

| Rule | Model 10 (EVM) | Solana program |
|---|---|---|
| Launch fee | $10 at the on-chain oracle price at execution, or 10 USDC | Same (Pyth SOL/USD, or USDC) |
| Curve | Start $5,000 FDV, graduate at $50,000 (10x) | Same |
| Curve shape | `virtualToken = 1B x 10/9`, `SALE_CAP = 1B x sqrt(10)/(sqrt(10)+1) ≈ 759,746,926.647958` | Identical values (6 decimals; EVM scales them to 18) |
| Testnet size | $50 → $500 (same shape) | $50 → $500 on devnet |
| Trade fee | 1.25%, split 50/50 protocol / creator | Same |
| Anti-snipe | Fee starts at 90% and decays linearly to 1.25% over 60 s. The surplus above 1.25% is locked into graduation liquidity | Same |
| Creator first buy | Atomic with the launch, base fee only, **no cap** | Same (`max_creator_buy_bps = 0`) |
| Final buy | Partially filled: takes exactly the remaining supply, charges only what it needs, refunds the rest | Same |
| Graduation | Uniswap v3 full-range position, locked forever; LP fees split 50/50 | PumpSwap, LP locked in a program PDA |
| Escape hatch | If a completed curve has not graduated 24 h after completion, anyone can `reopen()` it for trading | Phase 2 (pending) |
| Metadata | Set once in the launch transaction; no setter | Phase 2: Metaplex, `is_mutable = false` |

All shared numbers live in `packages/core/curve-model.mjs` (served to the browser as `/curve-model.mjs`). Nothing else should hard-code them.

## Contracts

- `ElpidaDexFactory` (model 10). Constructor: `(treasury, nativeAdapter, startFdvUsd, graduationGrace)`. `startFdvUsd` is in whole dollars (1–1,000,000) and `graduationGrace` in seconds (60 s – 7 days); both are immutable. Deploy tooling (`assertDeploymentTerms` in `curve-model.mjs`) refuses anything other than $5,000 and 24 h on a mainnet network. The browser deploys $50 / 24 h on testnets. `nativeVirtualQuote()` = oracle value of `startFdvUsd x 10/9`, rounded up. Runtime size: 11.4 KB.
- `ElpidaDexCurveDeployer`. Created by the factory's constructor; holds the token and curve creation code so the factory stays far below the EIP-170 limit. Only its factory can call `create`.
- `ElpidaDexCurve`. Adds `currentFeeBps()`, `launchedAt`, `liquidityBonus`, `previewBuy()`, `remainingAtBaseFee()`, `claimFees(recipient)`, `reopen()`, `completedAt`, `graduationGrace`, and the events `AntiSnipeFee`, `FeePayoutFailed` and `CurveReopened`. Existing events (`Bought`, `Sold`, `FeesWithdrawn`, `CurveCompleted`, `Graduated`) keep their signatures, so model 9 history still decodes.
- `ElpidaV3MigrationAdapter`. If the graduation pool already exists at a wrong price, it swaps it back to the curve's terminal price using at most `MAX_REBALANCE_BPS` (2%) of the migrating token or quote amount. What the swap spends stays in the pool. If the price is still wrong, migration reverts and the curve's escape hatch applies. The swap callback pays only the pool being rebalanced, only during a migration and only up to the budget. Emits `PoolRebalanced`.

### Fee payouts (failure isolation)

`claimFees(recipient)` pays one fixed recipient (treasury or creator reward address). `withdrawFees()` attempts both and never reverts because one side cannot receive: the failing side keeps its balance owed and emits `FeePayoutFailed`. A reward address that rejects ETH, or a blacklisted USDC recipient, can no longer block protocol fees. If a hostile recipient burns all forwarded gas, call `claimFees(treasury)` on its own.

Legacy contracts: `ElpidaLaunchCurve` (models 3–5) has the same isolation. `ElpidaBetaCurve` and `ElpidaLockedPool` (model 8) still pay both sides together; adding the fix pushes `ElpidaBetaFactory` over the 24,576-byte limit. Model 8 is only offered on testnets without a Uniswap adapter and will be replaced by model 10 on those chains in Phase 3. Do not deploy model 8 to mainnet.

### Graduation and price continuity

At completion, `lpTokens = realReserve x (virtualToken - sold) / (virtualQuote + realReserve)` matches the terminal price, and with this curve shape equals the unsold 240,253,073.352042 tokens (bounded at 1 ppm for rounding; anything left is sent to `0x…dEaD`). The quote side is `realReserve + liquidityBonus`, so a launch with anti-snipe activity opens its pool slightly **above** the final curve price. A launch with no first-minute trading opens exactly at it (tested within 1 ppm).

### Griefing and the escape hatch

A griefer who creates the Uniswap pool early with a sliver of liquidity at a wrong price used to freeze a completed curve forever. Curve trading stops at completion, and graduation reverted on `pool price mismatch`. Now:

1. Small or medium griefs (tested: 1 USDC; ~1% of the reserve at 2x the price) are corrected by the bounded rebalance, and graduation succeeds.
2. Larger griefs (tested: half the reserve at 3x) still block graduation. 24 hours after completion, anyone can call `reopen()`. Trading resumes with unchanged invariants, so every holder can sell. Completing the curve again restarts the timer.

## Interface and indexer

- Trade panel: a live "Launch fee window: 47.1% → 1.25% in 31 s" line on both chains, the fee rate in quotes, and a "Reopen curve trading" button once a stuck curve passes its grace time.
- Creator transparency: the indexer records the creator's first buy and live holding. The token page shows "Dev 4.73% → 4.73%" (bought at launch → holds now), and discovery cards show the same chip. Solana data arrives in Phase 2.
- `remainingBuy` shows the cost to finish the curve at the base fee. During the first minute a larger buy is partially filled rather than reverting.
- Legacy model 9 records keep their old behaviour: no fee window, no partial fill, no escape hatch.

## Tests

`tests/graduation-safety.test.mjs` (12 tests), `tests/dex-migration.test.mjs`, `tests/dev-transparency.test.mjs`, `tests/contract-size.test.mjs`, plus the updated runtime suites. Shared fixture: `tests/helpers/dex-fixture.mjs` (real local Uniswap v3, mock USD feed, mock USDC).
