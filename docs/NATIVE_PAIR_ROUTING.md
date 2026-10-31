# Native access to non-native pairs

Requested 1 November 2026: native coin funding and cash-out for every pair, while preserving the underlying curve
and graduated pool quote asset, Model 10 and separate chain wallets.

## This first implementation

Standard EVM non-native token pages expose a separate native/pair conversion panel. Supported V3 deployments use
the configured router, quoter, factory and wrapped-native token. Pool identity and nonzero liquidity are checked;
quotes choose the highest executable output among supported single-hop fee tiers. Amounts use raw integer units.
Conversions enforce a 1% minimum-output bound, quote expiry, exact pair-asset approvals and a five-minute on-chain
deadline. Native output unwraps to the connected account. Stock issuer preflight applies before execution.

This is explicitly two steps: convert, then buy; or sell, then convert the proceeds. It is not an atomic native
buy/sell, and cancellation of the later step does not reverse the earlier conversion. The UI discloses this.
Pair-asset trading is unchanged before and after graduation. Transfer-tax markets are excluded from this V3 path.
No treasury budget or launch pricing changes.

## Still required

- Solana native/pair route adapter and verified execution tests. UI states that routing is unavailable there.
- V2 transfer-tax routes and multi-hop routes, with their own verification.
- Atomic composition if a single native buy/sell confirmation is required.
- A funded ETH/tNVDAon test conversion pool; the existing faucet token alone provides no swap liquidity.
- Public-testnet evidence for the new conversion UI. Local tests are not deployment evidence.

Launch stock choices now show ticker emblems, ticker text, full asset names and test labels. Emblems are original
text badges, not issuer-certified logos. Live stock capabilities remain disabled.

Validation: 26 focused tests passed, including real local V3 conversion in both directions, existing USDC payment
lifecycle, signer/resume regressions, route rejection and flywheel policy. No public transactions for this patch.
