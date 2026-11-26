# Elpida public API, version 1

Read-only JSON for builders: bots, terminals, trackers, scanners and aggregators. Served by the site at
`https://elpida.fun/api/v1`. The same reference is on the site at `#/docs/developers` (Docs → Developers).

- **Stable.** New fields and endpoints may be added. Nothing under `/api/v1` is renamed or removed. Other `/api`
  paths are the site's own and can change without notice.
- **Open.** Any origin may call it (`Access-Control-Allow-Origin: *`). GET only.
- **Limited.** 120 requests a minute per client. Over that: `429` with `Retry-After` (seconds).
- **Mainnets only.** Base, BNB Chain, Robinhood Chain and Ethereum launches of the Elpida V2 launchpad. Test networks
  never appear.
- **Cached** for 15 s (chains 5 min, ABIs 1 h). Token answers carry `indexedAt` and `stale` (true when the chain's
  index has not synced for 3 minutes).

| Endpoint | Returns |
|---|---|
| `GET /api/v1` | The endpoint list and rate limit. |
| `GET /api/v1/chains` | Each chain: `chainId`, `chain`, `name`, `explorer`, `nativeSymbol`, `payoutToken`, `contracts` (`factory`, `hook`, `router`, `traderAirdrop`, `treasury`, `poolManager`), `feeSplitBps` (`traders`, `creator`, `elpida`). |
| `GET /api/v1/tokens?chain=&since=&limit=` | Launches, newest first. `since`: unix seconds. `limit`: 1 to 500 (default 100). Each token: `chainId`, `chain`, `address`, `name`, `symbol`, `decimals`, `totalSupply`, `image`, `description`, `links`, `creator`, `createdAt`, `launchBlock`, `launchTx`, `metadataURI`, `pool` (`poolManager`, `poolId`, `hook`, `quote`, `quoteSymbol`, `pairKind`), `feeBps`, `graduated`, `launchpad` (`url`, `factory`), `explorer`. |
| `GET /api/v1/tokens/{chain}/{address}` | One launch, the same fields, plus `indexedAt` and `stale`. `404` when the address is not an Elpida launch on that chain. |
| `GET /api/v1/tokens/{chain}/{address}/trades?limit=` | `trades`: the latest trades, newest first (limit 1 to 500). |
| `GET /api/v1/tokens/{chain}/{address}/candles?interval=&limit=` | `candles`: OHLC buckets. `interval` in seconds: 60, 300, 900, 3600, 14400 or 86400. |
| `GET /api/v1/tokens/{chain}/{address}/holders` | `holders`: the largest holders. |
| `GET /api/v1/rewards?wallet=` | The monthly trader airdrop (EWPR): rules, the month so far, and the wallet's standing when given. |
| `GET /api/v1/abi` · `GET /api/v1/abi/{name}` | JSON ABIs: `factory`, `router`, `hook`, `token` (packages/core/public-abi.mjs). |

## On chain

- Every token trades in its own Uniswap v4 pool with the Elpida hook from the first trade. The hook holds the
  liquidity: there are no LP tokens, and nobody can remove it. There is no migration at graduation.
- Index `Factory.Launched` and `Factory.MetadataPublished` (the metadata `ipfs://` link; also
  `factory.tokenMetadataURI(token)`), `Router.Swapped` (the real trader for trades through the Elpida router) and the
  PoolManager's `Swap` for trades through any other router. `Hook.Fee` records each trade's fee.
- Trading through the router: `quote(token, isBuy, amountIn)` (call it statically), then `buy(token, quoteIn,
  minTokensOut, recipient, deadline)` with `value` for native pairs, or `sell(...)` after approving the router.

Code: `apps/api/public-api-v1.mjs`, tests in `tests/public-api-v1.test.mjs`.
