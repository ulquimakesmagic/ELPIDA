# Ondo market-input validation, 29 October 2026

This phase adds a pure market-input gate and a read-only Uniswap-v3-compatible QuoterV2 adapter. It does not configure a production oracle, select a live pool, expose a launch option or authorize transactions. Model 10 and separate chain wallets are unchanged.

## Valuation and executable observations

`validateOndoMarket` builds on `valueOndoReserve`: the reference must already be USD per raw token, representing total return, with fresh, explicit asset and corporate-action status. Ordinary share prices and display-adjusted unit prices cannot substitute. No multiplier is applied again. [Ondo's pricing documentation](https://docs.ondo.finance/ondo-stocks/token-and-quote-pricing) distinguishes total return and display scaling from raw onchain balances.

A trusted server policy must additionally specify the quote token, its decimals and USD feed ID, maximum timestamp skew, maximum execution loss, minimum sell-probe size, exact buy-probe size and minimum USD probe depth. Both direction samples must belong to the reviewed token/pool/quote pair. The sell input must exactly equal the reserve balance being valued; a small quote is not evidence for liquidation of a larger reserve. Buy size must match policy. All amounts use exact integers and cross-product threshold checks.

The TWAP, quote-USD observation and execution simulations must use the same numbered, hashed block. All price/status/sample timestamps must be fresh and within the reviewed skew bound. The quote asset needs its own fresh USD price; USDC or another quote is not assumed to stay at one dollar. Both sell proceeds and buy output must meet the policy's loss and depth thresholds against the total-return reference. The returned reserve valuation is capped by the simulated sell proceeds as well as the existing conservative reference/TWAP valuation.

These functions accept trusted normalized observations. Caller-supplied feed IDs, code hashes, status labels and policy IDs are not authorization. Server adapters must authenticate their sources, validate provenance and retain the observation block. A `usable` result never changes registry capability flags.

## Read-only QuoterV2 adapter

`readOndoV3Execution` verifies upstream chain ID, block header, reviewed runtime hashes for pool/factory/quoter, token pair, fee tier, pool/quoter factory references and factory getPool wiring. Every state/code read uses EIP-1898 blockHash plus requireCanonical. It uses eth_call to simulate exact-input quotes in both directions; it never sends a transaction or discovers an approved venue automatically. Missing observation history, wrong code, unsupported quoter interfaces and failed simulations must remain failures, not zero/slippage defaults.

[Uniswap's v3 documentation](https://developers.uniswap.org/docs/protocols/v3/concepts/architecture) separates pools, factories and periphery. A quoter address or pool ticker alone is insufficient identification. QuoterV2 simulation is not proof of a future fill, available public liquidity at another block, or eligibility of the eventual sender/router/recipient. Restricted stock transfers need the separately documented issuer-control checks. QuoterV2 does not establish a production USD reference or collect a TWAP in this phase.

## Validation and remaining work

New tests cover exact 6-decimal quote/18-decimal token accounting, threshold rounding, full-reserve versus undersized/oversized sell probes, buy-probe identity, insufficient depth, losses, quote depegs, stale/future/skewed timestamps, mismatched blocks, unknown corporate actions, changed bytecode, substituted pools/assets and failed simulations. Reader tests use deterministic RPC fixtures; they are not observations of a real Ondo/USD pool or an end-to-end market rehearsal.

The prior restriction phase's full local suite completed with 579 passes, zero failures and 33 missing-Solana-validator skips. That result predates this phase and subsequent indexing changes. Production total-return/status feeds, independent pool selection, a real TWAP reader, participant-specific executable checks, and fresh evidence remain open. Do not activate live stock pairing until those and eligibility/issuer gates are resolved.
