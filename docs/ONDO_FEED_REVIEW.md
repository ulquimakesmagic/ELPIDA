# Ondo feed review and quote-USD observations, 29 October 2026

This phase builds on PR133 (pool history). It adds a pinned Chainlink-style quote-asset USD reader and a diagnostic pairing of that observation with real NVDAon pool history. No production policy, stock reference feed, corporate-action clearance or live capability is installed.

## Source suitability

| Source | Finding | ELPIDA treatment |
|---|---|---|
| [Current Ondo OpenAPI specification](https://docs.ondo.finance/openapi.json), latest-price endpoints | Describes stock-token and underlying prices, but explicitly warns against using these display feeds as asset oracles | Not a reserve/risk reference; do not infer corporate-action clearance from a recent price |
| [Ondo API overview](https://docs.ondo.finance/api-reference/overview) | Primary mint/redeem attestations are a separate surface; access is obtained through onboarding | An attestation or API account is not universal secondary trading/contract eligibility |
| [Chainlink Ondo feed documentation](https://docs.chain.link/data-feeds/tokenized-equity-feeds/ondo) | Describes total-return prices including sValue and corporate-action freezes; lists the Base network | Candidate research only. No Base feed is aliased into Ethereum, and no canonical Base Ondo token is invented |
| [Ethereum reference-data directory](https://reference-data-directory.vercel.app/feeds-mainnet.json), exact usdc-usd proxy | USDC/USD proxy `0x8fffffd4afb6115b954bd326cbe7b4ba576818f6`, 8 decimals, directory heartbeat 82800 seconds, marked stablecoin-capped | Quote-asset diagnostic only; heartbeat is not an automatic risk-policy approval |

The deprecated ReadMe API pages are not used as current integration instructions. Current Ondo OpenAPI was inspected directly. Neither an ordinary NVDA equity feed nor a display token-price endpoint is substituted for an Ethereum NVDAon total-return/status reference. Chainlink's documented corporate-action freeze means a last-good price must not be treated as status clearance. No contact or onboarding message was sent to either provider.

## Quote reader

`readChainlinkQuoteUsd` requires the exact network/token/feed identity, proxy and aggregator runtime pins, description, decimals and a reviewed source-age limit. It checks chain ID and the canonical header, pins all state/code reads by block hash, verifies the active aggregator, and rejects nonpositive answers, incomplete rounds, invalid times and stale/future rounds. WAD conversion uses exact integers. It preserves the round's updatedAt separately from the block's observedAt; reading an old answer now does not make the answer fresh.

This reader is specific to quote-USD normalization. It does not approve a provider, resolve capped-feed suitability or produce stock trading/corporate-action status. Aggregator/address or code changes require another review. Freshness at a historical block does not establish current wall-clock freshness; downstream gates retain that check.

## Real read-only diagnostic

Run `node --env-file=.env.ondo.local scripts/ondo-market-observe.mjs`. An explicit ELPIDA_EQUITY_FORK_BLOCK reproduces a historical read. The tool fetches the exact directory record, records observed code hashes, and reads the feed round plus the candidate pool TWAP. Those observed pins, heartbeat-based source age and minimal raw liquidity threshold are diagnostic inputs, not reviewed production policy. No registered launch, feed or venue configuration is changed.

[ondo-ethereum-quote-usd-twap-2026-10-29.json](evidence/ondo-ethereum-quote-usd-twap-2026-10-29.json) records Ethereum block 26294021. The feed answer was 0.99971556 USD/USDC with updatedAt 1793213279, observed at block timestamp 1793224091: age 10812 seconds. The 600-second NVDAon/USDC tick-window conversion produced 214.058606837512021139 USD per raw token denomination. These are historical diagnostic values, not current quotes or an approved stock reference.

The directory marks this feed as capped. Its reported heartbeat is 23 hours. Neither property establishes suitability for ELPIDA's execution-risk policy. In particular, a three-hour-old USD source does not satisfy a 60-second composite gate; this phase does not loosen global freshness/skew limits to force a passing result. A separate review must reconcile source heartbeat, depeg sensitivity, caps and acceptable source ages without weakening stock/status freshness implicitly.

`marketUsable` and `liveCapabilitiesApproved` are false. Still missing: a same-chain, semantically verified total-return reference and corporate-action/status source; reviewed source-age/venue/depth policies; participant-specific bidirectional execution checks; complete issuer and jurisdiction approval. Available Base feeds may inform that review but cannot be used as if they were native Ethereum feeds.

## Validation

The quote reader tests cover exact depeg values, original timestamps, nonpositive/stale/future/incomplete rounds, changed aggregator/code, incorrect chain/description/decimals and conflicting headers. A real archive read paired quote-USD and pool history at the same block, with no transactions. The prior PR133 full suite completed 591 passes, zero failures and 33 missing-Solana-validator skips (624 total); it predates this phase.
