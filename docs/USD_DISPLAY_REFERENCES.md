# USD display reference recovery

The display keeper refreshes web prices before their 180-second expiry instead of waiting for a failed freshness check. Original provider timestamps are retained; neither polling nor a failed refresh renews an old observation.

When web prices fail:

- EVM native pairs use their verified on-chain USD feed. If an ETH chain's feed is unavailable, another fresh configured ETH/USD feed can supply a display-only reference. Its actual feed, source chain, timestamp and heartbeat are retained. BNB and SOL are never substituted for ETH.
- Solana devnet additionally reads the existing sponsored Pyth SOL/USD account (`SOLANA_ORACLES.devnet`) at confirmed commitment. The Pyth receiver owner, PriceUpdateV2 discriminator, Full verification, exact feed ID, exponent, positive price, confidence and publication age must pass. This fallback is only assigned to devnet, never to mainnet. It needs no new API key or wallet transaction.
- A genuinely unavailable or expired source still produces `USD unavailable`. Paused/stale stock feeds are not relabelled fresh. USDC retains its explicitly labelled parity assumption.

All these references are for display. Factories and programs continue to enforce their own launch/trading oracle rules. Model 10 pricing, fees and separate chain wallets are unchanged.

Read-only live check on 1 November 2026: with the web source deliberately unavailable in a local keeper, the devnet Pyth account supplied a fresh, fully verified SOL/USD observation. The deployed Explore page had four Solana tokens; that matches the reported size of the affected group, but the earlier outage itself was not captured.

Focused regression coverage checks early renewal, same-asset fallback isolation, expiry without timestamp fabrication, invalid owner/feed/verification/confidence/age/exponent rejection, and no promotion of devnet data to mainnet.

Validation: full-suite checkpoint **680 total / 647 passed / 33 skipped / 0 failed**. After the final SOL fallback and its regression were added, the price, discovery, clock, API, operations and web-shell integration run passed **32/32**, with no skips or failures. No wallet transaction was sent by these checks.
