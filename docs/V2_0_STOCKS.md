# ELPIDA V2 — 100+ stocks, priced at launch (10 November 2026)

Malik, 10 November: mainnet will list over 100 tokenized stocks, so each stock must not need hand-set numbers, and a
launch on any stock must start at the same dollar market cap whatever the stock has done since it was approved.

## Contract (`contracts/evm/v2/ElpidaV2Factory.sol`, `STOCK_FEEDS_VERSION` 1)
- `approvePricedQuote(asset, feed, maxAge)` (treasury only, once per asset, never alongside a fixed `approveQuote`):
  the stock is priced at every launch by its USD feed (Chainlink's Ondo GM feed on mainnet). `maxAge` is at most
  4 days (`MAX_STOCK_FEED_AGE`: a weekend plus a market holiday).
- `quoteVirtual(asset)`: the virtual quote a launch gets now: the native coin and fixed approvals as before; a
  feed-priced stock at `startMcapUsd × 5/4 ÷ price`. It reverts (`stock price stale` / `stock price`) while the answer is
  invalid or too old, so no launch can use a frozen or broken price; the site says "launches open again when the price
  updates". `launch` uses it. Nothing else changes; `MODEL_VERSION` stays 20.
- Launchpads already on test networks keep their fixed approvals. A V2 deployment made after this change has the
  feature (mainnet will be a fresh deployment). The site reads either kind.

## The verified stock list (`config/stocks/<network>.json`)
- Built by `STOCK_LIST_RPC_URL=<rpc> node scripts/stock-list.mjs <network> <candidates.json>` from the issuer's and the
  oracle's published lists (never typed by hand). Each candidate is checked on chain (`packages/core/stock-list.mjs`):
  token and feed are contracts, the token's symbol matches, decimals 6–18, the feed's description names the stock
  (e.g. `TSLA / USD`), its latest answer is valid; duplicates (by address or symbol) are refused. Rejects are printed
  with the reason and left out. Reads only.
- Served at `/api/public/stock-list?network=` for the operator panel.

## Approving them (operator panel → Launchpads → V2 card → Verified stock list)
Shows how many listed stocks are approved and offers the rest: signed directly when the connected wallet is the
treasury (test networks), otherwise downloaded as Safe Transaction Builder files of up to 25 approvals each (a mainnet
treasury is a Safe). Already-approved stocks are skipped, so the same list can be re-run as stocks are added.

## Launch form
The stock dropdown already searches by ticker or company and scales to hundreds (`apps/web/stock-picker.mjs`). A
launch on a feed-priced stock whose price is too old stops before anything is sent, with "the stock's price is older
than its limit: its market is closed or its price feed is paused".

## Tests
`tests/v2-stock-feeds.test.mjs`: pricing at launch (price doubles → half the shares), stale/zero/unanswered prices
blocking launches, approval rules; the list checker's rejections and batching (62 stocks → 25/25/10); the panel's
direct approvals and Safe batches on a local V2 launchpad.

## Still open
- Ondo: whether contracts may hold the stocks (EVM) and whether Solana's Token-2022 transfer hook allows our program's
  accounts (the 3 November email). Chainlink: exact GM feed proxies per chain and whether to read the SVR proxy.
- The feed's `paused` flag during corporate actions is not read on chain (its interface is not confirmed); the price
  is frozen at the last good value while paused.
