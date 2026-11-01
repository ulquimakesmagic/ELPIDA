# Locked liquidity from launch on Uniswap v4: feasibility (phase 1)

1 November 2026. Phase 1 of `LOCKED_FROM_LAUNCH_DESIGN.md`, EVM only. Design and maths; no contract, deployment or
fund movement. Decisions so far (Malik, 1 November): **Uniswap v4 with a hook** on EVM; Solana stays as it is
(SOL pairs to Raydium, no new PumpSwap pools); the creator milestone reward is dropped.

## Result in one paragraph

Model 10 can be reproduced **exactly** inside one Uniswap v4 pool, from the first trade, with no seed money. The
1,000,000,000 tokens go into two positions owned for ever by an Elpida hook: the 759.7M sale tokens in a range from
the launch price to 10× it, and the remaining 240.3M tokens in a range from 10× to the top. Within a range, Uniswap's
maths is a constant-product curve, and with the right liquidity it is *the same* curve as Model 10. When the price
first reaches 10×, the hook moves the raised quote from the sale range to a range below 10× with the same liquidity
as the upper range. The result is exactly the full-range pool Model 10 graduates into today, in the same pool, with no
migration, no price jump and no pre-created-pool griefing (audit F-1 and review finding E-2 disappear). Fees and
anti-snipe are charged by the hook in the quote asset, so every trade on the pool pays them.

## 1. The maths

Model 10 is a virtual constant-product curve: virtual quote `vQ` and virtual tokens `vT = 1,111,111,111`, with
`vQ · vT = k`, and the sale ends when 759,746,926.65 tokens are sold, at 10× the starting price.

A Uniswap v3/v4 position with liquidity `L` between prices `pa` and `pb` trades as `x · y = L²` on virtual reserves
inside that range. Choose `L = √k`, `pa = vQ0 / vT0` (the launch price) and `pb = 10 · pa`. Then:

| | Uniswap range position | Model 10 |
|---|---|---|
| Tokens in the range at `pa` | `L (1/√pa − 1/√pb) = vT0 (1 − 1/√10)` | `SALE_CAP = vT0 (1 − 1/√10)` |
| Quote in the range at `pb` | `L (√pb − √pa) = vQ0 (√10 − 1)` | the raise, `vQ0 (√10 − 1)` |
| Tokens for a buy of net quote `n` | `L (1/√p − 1/√(p'))`, `√p' = √p + n/L` | `vT · n / (vQ + n)` |

They are the same functions. Numerically, at mainnet terms ($5,000 starting FDV, ETH at $2,500, 18-decimal tokens):

| Quantity | v4 positions | Model 10 |
|---|---|---|
| Launch price | 2.00000e-9 ETH (tick −200,311, rounded: +0.002%) | 2.00000e-9 ETH |
| End price | 9.999998× launch (tick −177,284) | 10× |
| Sale tokens | 759,739,236 (rounding the ticks) | 759,746,927 |
| Raise at the end | 4.805109 ETH | 4.805061 ETH |
| A 1 ETH (net) first buy | 344,827,586 tokens | 344,827,586 tokens |

Ticks round to whole numbers, so the launch price and the sale size move by about 0.002%. That is the only
difference, and it can be removed entirely by choosing the launch price as a tick price rather than an exact dollar
figure. **This is still Model 10's curve; the version number changes only because the contracts do (Model 11).**

### The milestone ("graduation" without migration)

At 10×, Model 10 today pairs the raise `q` with the 240.25M remaining tokens in a new full-range pool, with liquidity
`L' = q / √pb = 0.6838 · L`. The v4 design reaches the same pool:

1. **At launch:** the sale range `[pa, pb]` with `L`, and an upper range `[pb, max]` holding the 240.25M remaining
   tokens. Its liquidity is `240.25M · √pb = 0.6838 · L = L'`.
2. **When the price first reaches `pb`:** the sale range now holds only quote, exactly `q`. The hook removes it and
   adds `q` as a range `[min, pb]`. That range's liquidity is `q / √pb = L'`.
3. **Result:** `[min, pb]` and `[pb, max]` with the same `L'`, which is one full-range position with `L'`: the pool
   Model 10 graduates into, at the same price, in the same pool.

A buy that crosses 10× simply continues into the upper range at a continuous price, so there is no partial fill and
no refund step. The milestone runs inside that buy (the hook's after-swap step), paid for by that buyer, like today's
atomic graduation.

## 2. Fees and anti-snipe (the hook)

- The pool's own LP fee is **0**. The hook charges the fee itself, through v4's custom accounting:
  - **Buys:** before the swap, from the quote paid in.
  - **Sells:** after the swap, from the quote paid out.
  - This is exactly where Model 10 takes it. Plain v4 LP fees would charge sells in the launched token.
- **Rate:** 1.25% base. In the first 60 seconds, the anti-snipe rate falls from 90% to 1.25%, as today.
- **Split:**
  - The base fee goes 50/50 to the creator and the protocol. Partner tiers take their burn share from the protocol half.
  - The anti-snipe surplus is added to the locked liquidity at the milestone, as Model 10 does.
- **No way around it:** every swap on this pool goes through the hook, so no router can skip the fee. A different pool
  for the same token, created by someone else, cannot be prevented, as today. But it no longer matters for graduation.
- **Liquidity is locked:**
  - The hook allows only its own liquidity changes before the milestone, so a third party cannot change the curve's
    shape or the milestone amounts.
  - It has no function that withdraws principal.
  - Whether third parties may add liquidity after the milestone is a product choice; the default proposal is to
    allow it.
- **Hook permissions:**
  - v4 hooks declare their permissions in their address, so the hook is deployed at a mined CREATE2 address.
  - Flags needed: `beforeInitialize`, `beforeAddLiquidity`, `beforeRemoveLiquidity`, `beforeSwap`, `afterSwap`,
    `beforeSwapReturnDelta`, `afterSwapReturnDelta`.

## 3. Where Uniswap v4 exists

Checked against Uniswap's deployments page on 1 November 2026:

| Network | Uniswap v4 | Note |
|---|---|---|
| Ethereum (1), Base (8453), BNB Chain (56), Robinhood Chain (4663) | Yes (official) | BNB uses Uniswap v4 itself; no PancakeSwap needed |
| Ethereum Sepolia, Base Sepolia | Yes (official) | Rehearsal networks |
| BNB Testnet, Robinhood Testnet | **No** | Either deploy v4 ourselves, labelled as an Elpida test deployment (as with Robinhood's v3 today), or rehearse only on the two Sepolias |

Model 10 stays live everywhere it is today; Model 11 would be added beside it, network by network.

## 4. Risks and open questions

- **New code to audit:** a v4 hook with custom accounting. That is the highest-risk kind of v4 code. Expect roughly
  400–600 lines, plus a factory change. It joins the audit scope; it does not replace it.
- **Compiler:** v4 needs Solidity 0.8.26 with the `cancun` EVM (transient storage). Our build is 0.8.24 / `shanghai`.
  The hook needs its own compile settings and a local chain on `cancun`.
- **Price-limit edge cases:** swaps with a caller's price limit inside the sale range, and very large single swaps
  across 10×, need tests at the tick boundaries.
- **Tokens with transfer restrictions** (stock pairs, tax tokens): excluded from Model 11 at first. Each needs its own
  compatibility proof.
- **Indexers and charts:** v4 swaps emit the PoolManager's `Swap` event. The hook's fee deltas are not part of it, so
  our indexer must add them from the hook's own events.
- **The milestone's gas:** it lands on the buyer who crosses 10×, as atomic graduation does today; it needs measuring
  on the local chain.

## 5. Proposed next phase (2: prototype, no deployment)

1. Add `@uniswap/v4-core` and `@uniswap/v4-periphery` (pinned) and a 0.8.26 / `cancun` compile target.
2. `ElpidaV4Hook` (fees, anti-snipe, locked positions, milestone) and `ElpidaV4Factory` (launch: token, pool
   initialised at `pa`, both positions, optional creator buy in the same transaction).
3. Local tests on a real v4 `PoolManager`:
   - each buy and sell matches Model 10's quote functions to the wei, across random sequences;
   - zero creator buy;
   - the milestone mid-swap;
   - the anti-snipe window;
   - fee split and partner burn;
   - a third-party liquidity add before the milestone is refused;
   - no principal path;
   - gas.
4. Then: indexer and UI support, and a Sepolia rehearsal on a labelled test launchpad.

Sources: [Uniswap v4 deployments](https://developers.uniswap.org/contracts/v4/deployments), `LOCKED_FROM_LAUNCH_DESIGN.md`.
