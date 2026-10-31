# Testnet Ondo-style stock pair (tNVDAon), 29 October 2026

Live Ondo stock pairing stays off. The mainnet blockers are a confirmed total-return feed, the issuer-privilege
review and eligibility; see [ONDO_PAIRING.md](ONDO_PAIRING.md) and [ONDO_PROVIDER_QUESTIONS.md](ONDO_PROVIDER_QUESTIONS.md).

This adds a **testnet stand-in** so the product side can be built and tried end to end now: launching a token paired
with a stock, trading it, and seeing how the site behaves when the issuer restricts the stock or its price can't be
trusted. **tNVDAon has no value and is not issued by Ondo.** Nothing in the contracts themselves stops a mainnet
deployment, so they live in `contracts/evm/testnet/` and are only deployed from the testnet tools panel.

## What it imitates

These are the controls the mainnet-fork rehearsal exercised on real NVDAon
([ONDO_RESTRICTION_REHEARSAL.md](ONDO_RESTRICTION_REHEARSAL.md)):

- **`ElpidaTestOndoStock`**: an ERC-20 (18 decimals) with a faucet.
  - It has a token-wide **pause** and a per-account **blocklist**, held by its controller (the launchpad treasury
    that deployed it).
  - Every transfer checks the sender, the recipient and the spender, as the real token's transfer hook does, so a
    pause or a block makes curve trades, pool swaps and fee claims revert. Nothing is lost.
  - It exposes `stockProvider() = "ondo-test"` and `referenceFeed()`. Real Ondo tokens do not; that is how the
    site recognises the stand-in.
- **`ElpidaTestStockFeed`**: a Chainlink-compatible **total-return** feed (USD per whole raw token, 8 decimals,
  never scaled again).
  - The controller posts prices and sets a **market status**: open, closed or corporate action.
  - Rounds are timestamped when posted.

## The gate (`apps/web/test-stock.mjs`)

It uses the same rules as `referencePriceStatus` and `checkGraduation` (`on-completion`) in
`packages/core/tokenized-equity.mjs`:

| Stock state | Curve buys and sells | The buy that completes and graduates the curve | Claims |
|---|---|---|---|
| Fresh price (two days on testnet; Chainlink's Ondo heartbeat is one day) | yes | yes | yes |
| Corporate action | yes | **waits** | yes |
| Stale price, or market closed with a stale price | yes | **waits** | yes |
| Issuer pause | **waits** | **waits** | **waits** |
| Your wallet blocked | **waits** | **waits** | **waits** |

- The wallet checks the issuer's pause, the blocklist for your wallet and the feed **before signing**, and explains
  why instead of letting the transaction revert.
- Block clocks up to 5 minutes ahead of the browser's clock are tolerated.
- **Testnet only checks the reference price.** There is no independent tNVDAon/USD pool to cross-check, so the gate
  is the reference alone. Mainnet adds the independent pool TWAP and the executable-liquidity checks already built
  in `packages/core/ondo-market.mjs`.
- The indexer publishes `stock: { provider, paused, price, updatedAt, marketStatus }` on every tNVDAon-paired
  token. The token page shows a status tag and a safety line.

## Setup (launchpad treasury, Ethereum Sepolia or BNB Testnet)

1. Open **Network and funds**, connect the treasury wallet, and press **Add test pairs: tNVDAon**. It deploys the
   feed (at $180), the stock and its Uniswap or PancakeSwap v3 migration adapter, then approves tNVDAon as a pair.
   This costs test gas only.
2. Anyone can get 25 tNVDAon per faucet call and launch under **Tokenized stock → tNVDAon**.
3. To rehearse, use **Test stock issuer controls** in the same panel: post a price, set the market status, pause or
   unpause, block or unblock a wallet. Token pages update within about a minute.

## Tests

`tests/test-ondo-stock.test.mjs` covers:

- the status and hold rules;
- a stock-paired curve on a local Uniswap v3 deployment:
  - the pause and the blocklist halt buys, transfers and the faucet with nothing moved;
  - trading resumes afterwards;
  - only the controller can act;
- the indexer read;
- the wallet preflight against the real contracts (an ordinary buy proceeds during a corporate action; the
  graduating buy waits);
- graduation into the pool once the price is fresh again.

## Not covered

- Solana: Ondo stocks there are Token-2022 with issuer extensions. Raydium and PumpSwap graduation is unverified.
- A server-side heartbeat for the test feed. The treasury posts prices by hand; after two days without a post,
  graduation waits.
- Corporate-action multipliers. The feed is already total-return, so nothing needs scaling.

## Interrupted setup recovery

Setup deployment stages now save their transaction hash and address in this browser, scoped to chain, factory,
wallet, pair and stage. Receipt checks poll the public RPC directly, stop after two minutes, and preserve the
record for the next attempt. A failed receipt or missing contract code never triggers an automatic redeployment.
Keep browser storage until setup finishes.

For a TEST-STOCK deployment submitted before this recovery support, enter its transaction hash in the optional
recovery field before resuming setup. The wallet verifies the sender and exact constructor bytecode against the
current TEST-STOCK artifact and requires a successful creation receipt. It reuses that asset, then requests the
remaining adapter and approval transactions. This does not recover an unknown historical adapter or approval.

Focused validation: public RPC signer and test Ondo stock suites, 9 passed, no skips or failures.
