# Model 11 prototype: locked liquidity from launch on Uniswap v4 (phase 2)

1 November 2026. This is phase 2 of `LOCKED_FROM_LAUNCH_V4_FEASIBILITY.md`, EVM only. **It is a prototype on a local
chain.** Nothing is deployed, nothing touches a testnet or mainnet, and the contracts are **not audited**. Model 10 stays
live everywhere unchanged.

## What was built

| File | What it is |
|---|---|
| `contracts/evm/v4/ElpidaV4Hook.sol` (291 lines) | One hook for all launches. It owns every pool's positions, charges the fees, runs the partner burn and moves the liquidity at the milestone. |
| `contracts/evm/v4/ElpidaV4Factory.sol` (62 lines) | Creates the token. The hook then creates the pool and both positions, and runs the optional creator first buy, all in one transaction. The factory also handles partner tiers, as in Model 10. Also contains a minimal CREATE2 deployer (prototype tooling). |
| `scripts/compile-v4.mjs` | Solidity 0.8.26 for the `cancun` EVM, via IR. It runs separately from the 0.8.24 / `shanghai` build used for everything deployed today. |
| `hardhat.config.js` | Adds a `localCancun` network (v4 needs transient storage). `localTest` stays on shanghai. |
| `tests/v4-locked-launch.test.mjs` | 12 tests that run against **Uniswap's own published PoolManager**, from the pinned `@uniswap/v4-core@1.0.2`. |
| `tests/helpers/model10-reference.mjs` | Model 10's formulas in exact rational arithmetic, plus a bit-for-bit port of Uniswap's `TickMath`. |

Pinned dependencies: `@uniswap/v4-core@1.0.2`, `@uniswap/v4-periphery@1.0.3` and `solc@0.8.26` (installed as
`solc-0.8.26`). Commands: `npm run compile:v4` and `npm run test:v4`.

## How it works

- **Currencies:**
  - currency0 is ETH and currency1 is the token.
  - The pool's own LP fee is 0 and its tick spacing is 10.
- **Positions at launch.** Both are owned by the hook for ever:
  - **Sale range** `[lower, upper]` with liquidity `L`, holding only tokens.
  - **Upper range** `[min, lower]` with liquidity `L' = L (1 − 1/√r)`, holding the rest of the supply.
  - `upper` is the launch price, Model 10's `vT / vQ`, rounded to the tick spacing.
  - `lower` is 23,030 ticks away, which is **10.003×** the launch price.
- **Milestone.** When a buy takes the price to 10×:
  - The hook's after-swap step removes the sale position, which then holds only ETH.
  - It adds that ETH, plus the anti-snipe bonus, as `[lower, max]`.
  - The result is the same liquidity on both sides of 10×. That is one full-range position, in the same pool, at the same price, with no migration.
- **Fees.** The hook charges every swap in ETH through v4 custom accounting:
  - Before the milestone: 1.25%, with anti-snipe falling from 90% over 60 s.
  - After the milestone: 1%.
  - The split is Model 10's:
    - creator 50%;
    - partner burn from Elpida's half;
    - Elpida the rest;
    - anti-snipe surplus to the locked liquidity.
  - Fees are held as ERC-6909 claims in the PoolManager. They are paid in ETH to the treasury and the creator vault, and a recipient that cannot receive never blocks the other.
- **Lock:**
  - Third-party liquidity adds are refused before the milestone (they are allowed after it).
  - Only the hook can create pools that use it.
  - The hook has no function that removes principal; a test checks its whole external surface.

## Results (local chain, mainnet terms: $5,000 starting FDV at $2,500 per ETH)

| Check | Result |
|---|---|
| Launch price vs Model 10 | Within 0.1%, never cheaper (tick spacing 10) |
| Sale tokens | 759,774,284 vs Model 10's 759,746,927 (+0.0036%, from the 10.003× range) |
| Raise at 10× | 4.8065 ETH |
| 30 random buys and sells vs Model 10, exact rational | Largest difference **1 wei of ETH**. The pool never pays more than Model 10 |
| Anti-snipe at 1, 15, 30, 45, 59 and 60 s | Exact Model 10 rates; the surplus goes to the liquidity bonus |
| Exact-output buys and sells | Same 1.25% of gross, rounded in the pool's favour |
| Milestone mid-swap | Tokens equal the whole sale plus the upper range at a continuous price. The new position's liquidity equals `L'` to 1 part per billion |
| Partner tier (20%) | Burn bought at Model 10 prices in the same swap and sent to the dead address |
| Mixed 40-step sequence through the milestone | The hook's ETH claims equal its ledgers after every step |

Gas (local chain):

| Action | Gas |
|---|---|
| Launch, including the token | 889k |
| First buy after launch | 265k |
| 1 ETH buy | 164k |
| Sell | 150k |
| Buy that crosses 10× | 340k–462k |
| Buy after the milestone | 144k |

With tick spacing 1, a swap across the whole curve would walk about ninety bitmap words instead of nine.

### Found and fixed while building

**Donation griefing.**
- Anyone can `donate` to a v4 pool. Donated tokens become fees on the hook's sale position, and come out when the milestone removes it.
- The first version did not settle them, so a 1-wei token donation would have made every crossing buy revert, blocking the milestone for ever.
- Fix: the milestone now burns donated tokens and keeps donated ETH in the locked liquidity.
- A test shows the attack fails with the fix and succeeds without it.

## Differences from Model 10 (all deliberate, for review)

1. **Ticks:** the launch price rounds by up to 0.1%, and the sale ends at 10.003× instead of 10×. Tick spacing 1 would make both exact but costs about ten times more gas on large swaps.
2. **The buy that crosses 10×** pays the 1.25% curve fee on its whole amount. Model 10 instead fills it partially, refunds the rest, and the buyer then pays 1% in the v3 pool.
3. **After the milestone:**
   - The hook charges 1% in ETH on both sides. The v3 pool today charges 1% in the input token.
   - The partner burn runs in each swap, not through the keeper with its TWAP guard. Sandwiching it costs the attacker two fees, as on the curve.
4. **No graduation step:**
   - There is no `graduate()`, grace period or `reopen()`.
   - Audit finding F-1 and review finding E-2 do not apply.

## Risks and open questions

- **Audit:** a hook with custom accounting is the highest-risk kind of v4 code. It adds about 350 lines to the audit scope.
- **Uniswap's protocol-fee switch:** Uniswap governance may set a protocol fee of up to 0.1% of input on any v4 pool, this one included. That would take a little from each trade before the curve sees it.
- **Native pairs only.** USDC and other ERC-20 quotes need the currency order handled. Stock and tax tokens are excluded until each one has its own proof.
- **Routers and aggregators:** the PoolSwapTest router handles the hook's deltas. Uniswap's Universal Router should too, but aggregator support must be checked on a testnet.
- **Indexer:** the PoolManager's `Swap` event does not include the hook's fee. The hook emits `Fee`, `BuybackBurned` and `Milestone` for the indexer.

## Decisions needed (Malik)

1. **Tick spacing:** 10 (10.003×, cheaper gas; the prototype's choice) or 1 (exact 10×, about ten times the gas on full-curve swaps).
2. **Fee after the milestone:** 1% in ETH (prototype), or another rate.
3. **Third-party liquidity after the milestone:** allowed (prototype) or refused.

## Next (phase 3, still no mainnet)

1. Starting FDV from the USD oracle (`ElpidaUsdPricing`), as in Model 10.
2. USDC pairs.
3. Indexer and UI support.
4. A labelled test launchpad on Base Sepolia and Ethereum Sepolia, the two testnets with official Uniswap v4.
