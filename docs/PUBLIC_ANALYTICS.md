# Public protocol analytics

Open `/#/analytics` or `/analytics`. No wallet is needed. The homepage no longer shows the protocol stats strip.

The endpoint `/api/public/analytics?period=7d&network=all` accepts 24h, 7d, 30d and all, plus registered public chain keys. It reads complete confirmed SQLite trade histories, not the capped token detail feed. Simulation trades are excluded. Reorganizations follow the underlying indexer's rollback behavior.

Volume is the sum of quoted buy and sell amounts, including trader fees where the event includes them. USD figures revalue that volume using the current fresh price keeper reference; they are not historical dollar volume. Unpriced quote assets remain visible in native units and are excluded from USD totals. No browser supplied exchange rates are accepted.

Reserve and outstanding creator/protocol fee balances are current snapshots across all time. They are not lifetime fees or protocol revenue. Launch payments and uncollected DEX position fees are not counted. Trading addresses may include pool recipients and routers; they do not represent unique people. Networks with no configured public deployment are displayed as not indexed. Solana coverage currently includes Elpida curve events, not PumpSwap trades.

The time filters, protocol chart, pair breakdown and token ranking draw interaction inspiration from https://ponsfamily.com/analytics while retaining Elpida's own theme. No unsupported buyback, burn or cumulative revenue figures are invented.

Tests: `node --test tests/protocol-analytics.test.mjs tests/api.test.mjs`. The focused aggregation tests cover more than 500 trades, stale prices, case-sensitive mints, chain/time isolation and empty/unavailable networks.
