# Model 11 prototype: locked liquidity from launch on Uniswap v4 (phases 2 and 3)

Phase 2: 1 November 2026. Phase 3: 2 November 2026 (see below). This is phase 2 of `LOCKED_FROM_LAUNCH_V4_FEASIBILITY.md`, EVM only. **It is a prototype on a local
chain.** Nothing is deployed, nothing touches a testnet or mainnet, and the contracts are **not audited**. Model 10 stays
live everywhere unchanged.

## What was built

| File | What it is |
|---|---|
| `contracts/evm/v4/ElpidaV4Hook.sol` (311 lines after phase 3) | One hook for all launches. It owns every pool's positions, charges the fees, runs the partner burn and moves the liquidity at the milestone. |
| `contracts/evm/v4/ElpidaV4Factory.sol` (117 lines after phase 3) | Creates the token. The hook then creates the pool and both positions, and runs the optional creator first buy, all in one transaction. The factory also handles partner tiers, as in Model 10. Also contains a minimal CREATE2 deployer (prototype tooling). |
| `scripts/compile-v4.mjs` | Solidity 0.8.26 for the `cancun` EVM, via IR. It runs separately from the 0.8.24 / `shanghai` build used for everything deployed today. |
| `hardhat.config.js` | Adds a `localCancun` network (v4 needs transient storage). `localTest` stays on shanghai. |
| `tests/v4-locked-launch.test.mjs` | 12 tests that run against **Uniswap's own published PoolManager**, from the pinned `@uniswap/v4-core@1.0.2`. |
| `tests/helpers/model10-reference.mjs` | Model 10's formulas in exact rational arithmetic, plus a bit-for-bit port of Uniswap's `TickMath`. |

Pinned dependencies: `@uniswap/v4-core@1.0.2`, `@uniswap/v4-periphery@1.0.3` and `solc@0.8.26` (installed as
`solc-0.8.26`). Commands: `npm run compile:v4` and `npm run test:v4`.

## How it works

- **Currencies:**
  - currency0 is the quote (ETH, or USDC since phase 3) and currency1 is the token.
  - The pool's own LP fee is 0 and its tick spacing is 10.
- **Positions at launch.** Both are owned by the hook for ever:
  - **Sale range** `[lower, upper]` with liquidity `L`, holding only tokens.
  - **Upper range** `[min, lower]` with liquidity `L' = L (1 − 1/√r)`, holding the rest of the supply.
  - `upper` is the launch price, Model 10's `vT / vQ`, rounded to the tick spacing.
  - `lower` is 23,030 ticks away, which is **10.003×** the launch price.
- **Milestone.** When a buy takes the price to 10×:
  - The hook's after-swap step removes the sale position, which then holds only quote.
  - It adds that quote, plus the anti-snipe bonus, as `[lower, max]`.
  - The result is the same liquidity on both sides of 10×. That is one full-range position, in the same pool, at the same price, with no migration.
- **Fees.** The hook charges every swap in the quote through v4 custom accounting:
  - Before the milestone: 1.25%, with anti-snipe falling from 90% over 60 s.
  - After the milestone: 1%.
  - The split is Model 10's:
    - creator 50%;
    - partner burn from Elpida's half;
    - Elpida the rest;
    - anti-snipe surplus to the locked liquidity.
  - Fees are held as ERC-6909 claims in the PoolManager. They are paid in the quote to the treasury and the creator vault, and a recipient that cannot receive never blocks the other.
- **Lock:**
  - Third-party liquidity is refused, after the milestone too, unless the treasury opens the token (phase 3).
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
   - The hook charges 1% in the quote on both sides. The v3 pool today charges 1% in the input token.
   - The partner burn runs in each swap, not through the keeper with its TWAP guard. Sandwiching it costs the attacker two fees, as on the curve.
4. **No graduation step:**
   - There is no `graduate()`, grace period or `reopen()`.
   - Audit finding F-1 and review finding E-2 do not apply.

## Risks and open questions

- **Audit:** a hook with custom accounting is the highest-risk kind of v4 code. It adds about 350 lines to the audit scope.
- **Uniswap's protocol-fee switch:** Uniswap governance may set a protocol fee of up to 0.1% of input on any v4 pool, this one included. That would take a little from each trade before the curve sees it.
- **Quotes:** native and USDC are done (phase 3). Stock and tax tokens are excluded until each one has its own proof; the factory accepts only team-approved quotes.
- **Routers and aggregators:** the PoolSwapTest router handles the hook's deltas. Uniswap's Universal Router should too, but aggregator support must be checked on a testnet.
- **Indexer:** the PoolManager's `Swap` event does not include the hook's fee. The hook emits `Fee`, `BuybackBurned` and `Milestone` for the indexer.

## Decisions (Malik, 2 November 2026)

1. **Tick spacing: 10.** The sale range is 10.003×, and the launch price rounds by at most 0.1%, never cheaper.
2. **Fee after the milestone: 1%**, in the pair's quote.
3. **Third-party liquidity:** yes, but as a separate feature for selected tokens. So the hook refuses third-party liquidity by default, including after the milestone.
   - `openLiquidity(token)` lets the treasury open a token's pool:
     - only after that token's milestone;
     - once, and never closed again.
   - The switch had to be in the hook from the start: a deployed hook cannot be changed, so without it the feature could never be added.
   - The page where people add liquidity is the separate feature, still to build.

## Phase 3 (2 November 2026, local chain only)

- **Quote assets:**
  - The hook handles any approved quote: the native coin or an ERC-20 such as USDC.
  - The factory deploys each token with CREATE2 at an address above the quote's, so the quote is always the pool's `currency0` and the curve maths stays the same.
  - Fees and their payouts are in the pair's quote.
  - Claims are tracked per quote asset (`totalOwed(quote)`).
- **`ElpidaV4Factory` now has Model 10's commercial terms** (it inherits `ElpidaUsdPricing`):
  - **Pricing:** an oracle-priced $10 launch fee (or 10 USDC), and a `startFdvUsd` starting FDV for native pairs ($5,000 on mainnet, $50 on testnets).
  - **Quotes:** team-approved ERC-20 quote templates (USDC), set once.
  - **Token details:** an `ipfs://` URI published only in the launch transaction, and required where `requiresMetadata()`.
  - **Entry point:** Model 10's `launchWithPayment` shape, so the app can call both factories the same way.
- **Tests:** `tests/v4-factory.test.mjs` (6 tests) covers:
  - the oracle start and fee, refunds and a stale feed;
  - testnet terms;
  - a USDC pair, with trades against Model 10, a raise of about $12,000 at 10× and fees paid in USDC;
  - the fee paid in USDC;
  - token details;
  - quote approval.

  `tests/v4-locked-launch.test.mjs` (13 tests) adds the liquidity switch.
- **Gas:** about the same as phase 2. Launch is 946k, because of the CREATE2 token and the oracle read.

## Phase 4 (6 November 2026, test networks only)

1. **Router: `ElpidaV4Router`.** v4 has no per-token curve contract, so the site trades through a small router of
   its own rather than Uniswap's Universal Router:
   - exact-input `buy` and `sell`, with a minimum out and a deadline;
   - one plain approval of the router for an ERC-20 input (USDC, or the token when selling), no Permit2;
   - `quote(token, isBuy, amountIn)` runs the swap and undoes it, so a quote includes the hook's fee to the wei;
   - `Swapped(token, trader, recipient, …)` names the real trader, which the hook's `Fee` event cannot (it only sees
     the router);
   - it holds nothing between transactions. Not audited.
2. **Indexer: `packages/indexer/v4-indexer.mjs`.** It writes the same tables and rows as the curve indexer, so
   listings, trades, candles, holders and balances are served by the same code. It reads:
   - the factory's `Launched` and `MetadataPublished`;
   - the hook's `Launched`, `Fee`, `BuybackBurned`, `Milestone`, `LiquidityOpened` and fee payouts;
   - the PoolManager's `Swap`, filtered by each launch's pool id;
   - the router's `Swapped`.

   Each `Swap` is matched with the `Fee` that follows it, so a buy is recorded gross and a sell net of the fee. A swap
   the hook makes itself is the creator's first buy (followed by `Fee`) or a buyback (followed by `BuybackBurned`,
   not a trade). A trade through another router is attributed to the transaction's sender.
3. **Shared maths: `packages/core/v4-model.mjs`.** It replays Uniswap's TickMath and SqrtPriceMath and the hook's
   launch sizing, for the indexer's snapshot (price, quote in the locked positions, sale progress, quote left to the
   milestone) and the launch form's first-buy estimate. The tests check it against the hook's own views.
   - A v4 swap walks the tick bitmap one 256-tick word at a time and rounds each step's input up. So "buy the rest"
     adds one wei per word of the sale range.
4. **App.**
   - The operator panel's **Launchpads** tab has a **Deploy Model 11 test launchpad** button (operators only). The hook's salt is mined in the page, and the
     six steps resume where they stopped.
   - The launch form offers **Launch model: Model 11 test** where that launchpad exists (native or USDC pairs, no token
     tax).
   - Token pages trade Model 11 tokens through the router and label them as tests.
5. **Server.**
   - `networks.mjs` has a `v4` block on Base Sepolia and Ethereum Sepolia: Uniswap's PoolManager, and the launchpad
     once it is pinned.
   - The public index adds a Model 11 entry beside each curve launchpad, after checking the factory, hook and router
     point at each other.
   - `/api/v4-artifacts` serves the bytecode the browser deploys, from the same pinned build the tests run.
6. **Tests:**
   - `tests/v4-router.test.mjs` (4 tests);
   - `tests/v4-indexer.test.mjs` (4 tests, including the public index);
   - `tests/v4-browser.test.mjs` (3 tests: the owner's deploy, then launch, quote, buy, sell and fee payout, as the
     page calls them).

## Next (phase 5, still no mainnet)

1. ~~Malik deploys the test launchpad and it is pinned.~~ Done on 6 November 2026 on Ethereum Sepolia, Base Sepolia and
   BNB Chain testnet (on a test copy of Uniswap's PoolManager there).
2. Check the hook's swaps through Uniswap's Universal Router and an aggregator on a testnet.
3. Build the page for the opt-in third-party liquidity (`openLiquidity`).
4. An external audit of the hook and the router before any mainnet plan.

## Later phase: tokenized stocks as a Model 11 pair (Malik, 6 November 2026)

Model 11 pairs with the native coin and USDC only. Tokenized stocks stay on Model 10, which already checks the
issuer's controls. Malik asked to plan stock pairs for Model 11 as a later phase.

**Why they are left out today:**
- **One frozen stock freezes every pool.** In Model 11 the stock sits in Uniswap's PoolManager, which holds every v4
  pool's funds. If the issuer pauses the stock, or blocks the PoolManager's address, every Model 11 pool on that
  stock stops. Its liquidity is locked from the first trade, so it would be stuck for good. In Model 10 the stock sits
  in each token's own curve, behind the stock checks that run before trading and before graduation.
- **No market gate.** The hook does not check the stock's feed or its market status (open, closed, corporate action).
  It would trade through a closed market or a split at a price nobody can verify.
- **Balances that rescale.** A stock that rescales balances on a split (Solana's ScaledUiAmount, or an EVM
  equivalent) breaks the PoolManager's balance-delta accounting. Uniswap advises against such tokens in v4.
- **Scope.** The 2 November decisions limited Model 11 to the native coin and team-approved, fixed-behaviour ERC-20s
  (USDC) until the audit.

**What the phase needs, in order:**
1. **Ondo's answers.** Can they block the PoolManager or another shared contract? Will they turn on transfer hooks?
   Do the EVM stocks rescale balances? These are the questions already sent (docs/HUMAN_ACTIONS.md, Ondo and
   Chainlink). A stock that can rescale balances on EVM is not offered on Model 11 at all.
2. **A stock gate in the hook's `beforeSwap`,** for stock-paired launches only. It refuses swaps while:
   - the stock is paused;
   - the reference feed is stale;
   - the market is closed or in a corporate action.

   This is the same rule as Model 10's stock checks, at swap time.
3. **A frozen-stock plan for locked liquidity.** Decide what happens to a pool whose stock is frozen for good, for
   example a treasury-only switch that lets holders exit to the stock once it moves again. Today nothing can be
   withdrawn, by design.
4. **Approval in the operator panel,** one stock at a time, as for Model 10. Test it on testnets with the Ondo-style
   stand-ins (pause, blocklist and feed controls) before any real stock.
5. **An audit of the stock gate and the frozen-stock plan,** with the rest of the hook, before mainnet.

