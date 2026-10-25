# F-1: a griefed graduation pool, and what each option costs

**Status:** decision record. Nothing here changes a contract. Measured on 25 October 2026 against the current
`ElpidaV3MigrationAdapter` on a scratch branch, using the existing griefing harness.

The audit brief carries this finding as **F-1 (Medium, design)** and the 23 October decision was option (a), the app-side
unblock. This note records what the other options actually cost, so the decision can be re-taken with numbers.

## The finding, in one paragraph

Anyone can create the token's Uniswap v3 pool before graduation. A thin pool at the wrong price is corrected during
graduation, and so is deep full-range liquidity at a wrong price. But a **narrow band of the token's own supply placed
at 80–97% of the graduation price** absorbs the adapter's 2% correction budget, so the completing buy reverts with
`pool price mismatch`. The curve keeps trading, nothing is lost, and anyone can clear the band by buying it on the pool
at or below the curve's price, after which completion graduates normally.

## The options

| | What it does | Where the fix lives |
|---|---|---|
| **(a)** app-side unblock | when the completing buy would fail this way, the app first buys the band with a v3 price limit at the graduation price, then completes | `apps/web/graduation-unblock.mjs` — shipped, tested |
| **(b)** widen the adapter's budget | let the corrective swap spend more than 2%, relying on the swap's price limit to guarantee no trade is worse than the target | `ElpidaV3MigrationAdapter._rebalance` — needs a redeploy on every testnet |
| **(c)** complete without graduating | accept completion, leave the pool to a retry, use `reopen` after 24 h as the backstop | curve + factory semantics — changes what "complete" means |

## What (b) actually does, measured

One line changed: `budget = (zeroForOne ? x : y) * MAX_REBALANCE_BPS / 10000` with the constant replaced by a larger
percentage. Then the existing harness (`tests/graduation-griefing.test.mjs`) run against bands of increasing size:

| Band placed by the griefer | Quote the adapter spent clearing it | Share of the 4.805 ETH raise | Position tokens minted | Smallest cap that cleared it |
|---|---|---|---|---|
| 10,000,000 | 0.177 ETH | 3.7% | 221.4M | 10% |
| 40,000,000 | 0.708 ETH | 14.7% | 164.8M | 25% |
| 80,000,000 | 1.417 ETH | 29.5% | 89.4M | 60% |

Three things fall out of this:

1. **It works mechanically.** Every band above graduated, at the right price, with no dust left over. Normal graduation
   is unaffected: `dex-migration` and `atomic-graduation` stay 7/7, and the 2M band is still absorbed silently.
2. **The griefer gets paid, out of the raise.** The adapter has to buy the band, and the band holder is the seller. The
   larger the band, the more of the graduation quote ends up in the griefer's hands instead of the pool.
3. **The pool opens thinner.** The minted position shrinks from 221M tokens (10M band) to 89M (80M band) for the same
   quote, because the quote went to the seller rather than into liquidity.

## Why (a) is still the better answer

Both (a) and (b) pay the band holder; the difference is **who pays and who captures the discount**.

- Under **(a)**, whoever clears the band buys tokens at 80–97% of the graduation price and keeps the difference. That is
  a self-interested, permissionless action: it does not depend on the app, and the pool keeps the raise. The clearer
  profits; the protocol does not pay.
- Under **(b)**, the raise buys the band, so the protocol pays the discount and the liquidity is thinner by exactly what
  the griefer took. The incentive to grief is *stronger*, because the protocol now guarantees the exit.

Put differently: (b) automates the unblock at the issuer's expense, while (a) turns it into an opportunity someone takes.

**(c)** is worse than both for holders: a completed curve stops trading, so a 24-hour wait with no ability to sell is a
worse outcome than a discount that anyone can clear in one transaction.

## Recommendation

**Keep (a). Do not widen the adapter.** Concretely:

- The unblock is already implemented and covered by four tests, including "the target price the app computes is the
  price graduation opens the pool at".
- Keep the 24-hour `reopen` escape hatch as the backstop for a band nobody chooses to clear.
- If the app-side unblock is ever removed, do not replace it with a bigger fixed percentage. If a protocol-side fix is
  ever required, cap the spend by **value at risk** (a fraction of the raise) rather than by a percentage of inventory,
  and account for it publicly as a cost of graduation.

## What would change this recommendation

- **A product promise that graduation is unconditional.** Then (b) becomes necessary, with a value-based cap and the
  cost documented, and the two F-1 tests that currently pin the block would be rewritten (measured: the "10M band
  blocks" test and the app-unblock test both fail under (b), by design).
- **Evidence that clearing does not happen in practice.** If a real launch is blocked for 24 hours because nobody
  clears the band, the app-side flow needs a stronger prompt; the contract would not be the problem.

## Reproducing

The prototype was a one-line change in `_rebalance` on a throwaway branch, discarded afterwards. To re-measure, change

```solidity
uint256 budget=(zeroForOne?x:y)*MAX_REBALANCE_BPS/10000;
```

to a larger fixed percentage and run `tests/graduation-griefing.test.mjs`. The numbers above come from bands of 10M,
40M and 80M tokens at the current $5,000 start, a 4.805 ETH raise, and a 2% default.
