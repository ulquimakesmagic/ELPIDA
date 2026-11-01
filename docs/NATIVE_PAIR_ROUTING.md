# Native access to non-native pairs

Requested 1 November 2026: native coin funding and cash-out for every pair, while preserving the underlying curve
and graduated pool quote asset, Model 10 and separate chain wallets.

## This first implementation

Standard EVM non-native token pages expose a separate native/pair conversion panel. Supported V3 deployments use
the configured router, quoter, factory and wrapped-native token. Pool identity and nonzero liquidity are checked;
quotes choose the highest executable output among supported single-hop fee tiers. Amounts use raw integer units.
Conversions enforce a 1% minimum-output bound, quote expiry, exact pair-asset approvals and a five-minute on-chain
deadline. Native output unwraps to the connected account. Stock issuer preflight applies before execution.

The separate-conversion fallback is explicitly two steps: convert, then buy; or sell, then convert the proceeds. This fallback is not an atomic native
buy/sell, and cancellation of the later step does not reverse the earlier conversion. The UI discloses this.
Pair-asset trading is unchanged before and after graduation. Transfer-tax markets are excluded from this V3 path.
No treasury budget or launch pricing changes.

## Still required

- Solana native/pair route adapter and verified execution tests. UI states that routing is unavailable there.
- V2 transfer-tax routes and multi-hop routes, with their own verification.
- A deployed router alternative for wallets that do not support atomic batches.
- A funded ETH/tNVDAon test conversion pool; the existing faucet token alone provides no swap liquidity.
- Public-testnet evidence for the new conversion UI. Local tests are not deployment evidence.

Launch stock choices now show ticker emblems, ticker text, full asset names and test labels. Emblems are original
text badges, not issuer-certified logos. Live stock capabilities remain disabled.

Validation: 26 focused tests passed, including real local V3 conversion in both directions, existing USDC payment
lifecycle, signer/resume regressions, route rejection and flywheel policy. No public transactions for this patch.

## Atomic EVM native trading

Atomic-capable wallets now also have a dedicated native buy/sell panel. The wallet re-quotes both hops immediately
before submission. Native buys convert into at least the guaranteed pair-asset amount, approve exactly that amount,
and buy through the current curve or graduated V3 pool. Native sells sell tokens for a bounded pair-asset minimum,
then swap that guaranteed amount into native currency and unwrap it to the same account. Excess intermediate pair
assets stay in the wallet and are explicitly disclosed. Each hop has 1% protection; this is not 1% total slippage.
Approvals are reset to zero in the batch. All steps must execute atomically; unavailable atomic support fails
before submission, with no sequential fallback. Issuer preflight, quote expiry and router deadlines remain active.

Local tests exercise the actual wallet composition from a smart account against real V3 contracts, both before and
after graduation, plus a deliberately failing final call that rolls back every account balance. This is local
execution evidence, not a public wallet compatibility certification. No public funds were used for this extension.
