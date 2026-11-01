# Sepolia test stock conversion rehearsal

This phase uses only Ethereum Sepolia and the simulated `ondo-test` stock, never real Ondo assets. It preserves Model 10 and the launched token's underlying pair.

## Display reference

A fresh indexed simulated stock feed supplies the USD reference on the explicit public test-network allowlist. Paused, corporate-action, unknown-status, nonpositive, future-dated beyond five minutes, and older-than-two-days prices are unavailable. Live networks and real issuer providers are not promoted through this test rule. The source explicitly says simulated/no monetary value. This repairs STKTEST showing `USD unavailable` while its $180 test feed was fresh.

## Refresh safety

The background token-page refresh now restores side and settlement currency before the entered amount. Restoration checks the wallet/chain/token context. Native-route slippage stays fixed at 1% per hop. Changing accounts or chains does not restore an old amount into a different settlement currency.

## Operator workflow after deployment

1. Select Ethereum Sepolia and connect the simulated stock controller wallet.
2. Open Network and funds, then **ETH/test-stock conversion liquidity (Sepolia only)**.
3. Select tNVDAon and preview the budget (default **0.05 test ETH**, hard maximum **0.1 test ETH**). The stock amount is calculated from the current on-chain native USD oracle and simulated stock USD feed. No signing occurs at preview.
4. Confirm only after reviewing both amounts. Exact stock approval precedes a single manager multicall that initializes the 0.3% V3 pool if needed, mints a full-range position, and refunds unused ETH. Both amounts have 99% lower consumption bounds. The LP NFT belongs to the connected controller wallet and is **not permanently locked**; it is rehearsal conversion liquidity, separate from the launched token's permanently locked graduation LP.
5. Remaining stock approval is cleared. If a submitted mint is pending, its saved hash prevents another mint until its receipt is known. A funded pool prevents another setup mint. A previously initialized pool outside the test-reference price tolerance is refused.
6. On STKTEST choose ETH and request a small quote, then buy/sell using test funds. Native trading currently requires a wallet with atomic execution support. An ordinary-wallet router remains separate work if the chosen wallet lacks that capability.

The helper verifies the manager's factory and wrapped-native identity, test issuer/controller, 18-decimal stock, eight-decimal valid feed round, market state, pause/blocklist, balances and network. Existing pool identity and price are rechecked. The actual Ethereum Sepolia factory had no ETH/tNVDAon pools at supported tiers when checked on 1 November 2026. No public liquidity funding was performed for this PR.

Local tests create a real V3 pool with the simulated issuer asset, verify native quoting, budget bounds, repeat-funding detection, manager/network/controller mismatches and paused/blocked/corporate-action/stale issuer states. Display and draft tests cover fresh/stale USD references and currency restoration order/context.

Validation results: full suite 670 tests, 637 passed, zero failures, 33 environment skips. Focused liquidity, native routing, USD/draft, analytics and web-shell checks passed 18/18 after the final approval-resume changes. No public funding transaction was sent.
