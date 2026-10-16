# Curve economics, DEX migration and indexing

> **Superseded for current economics by [MODEL_10.md](MODEL_10.md)** (15 October 2026): every chain now uses a $5,000 → $50,000 (10x) curve with anti-snipe fees and a graduation escape hatch. The figures below describe older models and are kept for history.

Implementation update: model 4 beta economics, local SQLite indexing and separate fee splitter/v3 locker prototypes are now implemented. See [current implementation and limitations](INDEXER_AND_POST_MIGRATION_FEES.md). The recommendations below predate the fee-preserving route refinement.

Research date: 11 October 2026. Recommendations for Elpida (assuming the user's reference to Helm means Elpida). This is a design proposal; it does not change deployed contracts, select production addresses or implement a production indexer.

## Starting valuation: a price parameter, not deposited cash

A launch has a positive initial marginal price determined by its curve. Multiplying that price by total supply gives an initial fully diluted valuation (FDV). That is not the creator's deposit, money raised, pool liquidity or a minimum buyer contribution. With zero circulating supply, circulating market cap can initially be zero even though FDV is positive. A creator first buy changes the displayed opening valuation. Elpida's current factory requires a positive first buy, separately from its USDC creation fee.

There is no common minimum dollar valuation enforced across launchpads:

| Protocol | Documented mechanism | Relevant evidence |
| --- | --- | --- |
| Pump | Virtual constant product, no upfront liquidity; completes when real sale tokens are exhausted, then permissionless PumpSwap migration | The published example has 30 virtual SOL, 1.073B virtual tokens and 1B supply. Implied starting FDV is 30 / 1.073B * 1B = approximately 27.96 SOL. This is an example configuration, not a verified current on-chain default or a fixed USD number. |
| Meteora DBC | Partner-defined virtual curve templates and quote-reserve graduation into DAMM v2 | SDK supports initialMarketCap and migrationMarketCap in quote units. These are configurable parameters, not one universal minimum. |
| Raydium LaunchLab | Configured curve with quote-funding threshold; graduates into CPMM | Launch configuration and LP lock/burn policy govern the transition; starting valuation is configuration dependent. |
| Flap | Virtual constant-product reserves with per-quote curve parameters, then DEX migration | Its docs explicitly warn against hardcoding the example parameter table: read each token's parameters from the contract. |

Sources: [Pump program](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_PROGRAM_README.md), [Meteora configuration examples](https://github.com/MeteoraAg/meteora-invent/blob/main/studio/config/dbc_config.jsonc), [Meteora DBC](https://docs.meteora.ag/core-products/dbc/what-is-dbc), [Raydium LaunchLab](https://github.com/raydium-io/raydium-docs-v1/blob/main/products/launchlab/overview.mdx), [Flap curve](https://docs.flap.sh/flap/developers/basic-and-mechanism/bonding-curve).

## Recommended beta curve

Use a single fixed virtual constant-product curve per token, with deterministic buy/sell math, immutable quote asset and immutable launch parameters. Keep the USDC creation fee independent. Avoid arbitrary creator-controlled curve settings in the first beta. No permanent price floor is promised: sells can take valuation below any quoted launch or graduation figure after graduation.

Proposed USDC beta template, before migration costs and integer rounding:

| Parameter | Proposed | Current prototype |
| --- | ---: | ---: |
| Actual fixed token supply S | 1B | 1B |
| Curve sale allocation A | 800M | 800M |
| Tokens reserved for pool | 200M | 200M |
| Initial virtual token reserve T | 1.066666667B | 1B |
| Initial virtual USDC reserve V | 5,333.333333 | 30,000 |
| Initial FDV | $5,000 | $30,000 |
| Final curve FDV | $80,000 | $750,000 |
| Real USDC at completion Q | 16,000 | 120,000 |
| Tokens deposited at matched price | 200M | 160M |
| Leftover tokens | approximately 0 | approximately 40M transferred to dead address |

This is a simulation starting point, not a demonstrated optimum. Under the proposal, a pool opens with approximately $32,000 total marked liquidity: 16,000 USDC plus tokens valued at 16,000 USDC. Before DEX fees, a 1,000-USDC constant-product buy has about 5.88% average execution price impact relative to the opening spot price. Raising a larger graduation reserve reduces trade impact but makes graduation harder. Compare trader-size distributions and completion rates in testnet experiments before production.

Derivation, using whole-token and whole-quote units:

```
(T - s) * (V + q) = T * V
q(s) = V * s / (T - s)
p(s) = T * V / (T - s)^2
FDV(s) = S * p(s)
Q = V * A / (T - A)
poolTokens = Q / p(A) = A * (T - A) / T
```

To deposit all R = S - A = 200M reserved tokens without a price jump and with no migration deduction, solve T = A^2 / (A - R) = 1.066666667B. This gives a 16x initial-to-final price multiple. Set V = initialFDV * T / S. Virtual tokens above actual supply are mathematical parameters; do not mint them.

At 1.25% curve fee, no sells, and fees taken from gross input as in the current prototype, collecting 16,000 net USDC requires approximately 16,202.53 gross USDC across buys; rounding is per transaction. Fees are accounted separately, never counted as migration reserve.

If migration costs C are paid from quote reserves, deposit (Q-C) quote and (Q-C)/p(A) tokens. That creates leftover tokens, or requires a recalibrated curve/allocation. Prefer a separately funded migration budget where practical. Solve with actual DEX creation costs, minimum-liquidity rounding, wrapped-native costs and lock costs before implementation.

Native pairs need their own quote-unit configuration. For a launch-time native/USD reference E, the analogous template is V = 5,333.333333/E native units and Q = 16,000/E native units. Freeze the approved template for each launch; do not change it as the native USD rate moves. Dollar FDV will subsequently move with the native asset. Do not copy 30 units across ETH, BNB and SOL or assume equal economic value. Index the template/version and launch-time reference timestamp. USDC/USD conversion should also be labelled as an assumption or supplied by a feed, rather than guaranteed forever at $1.

Implementation required: make virtual token reserve a constructor parameter; separate actual supply from virtual reserve in graduation accounting; add bounded, versioned templates; update clients; validate terminal rounding, migration deductions and price continuity. Existing markets must retain their original parameters. Contract tests must cover this change before switching defaults.

## Chain-specific migration recommendations

Migration creates a pool on the token's current chain. It is not cross-chain bridging. Each network needs verified factory/program, router, quote mint, wrapped native address, fee tier, pool type and principal-lock implementation. Store this adapter choice immutably at launch; do not route a completed launch to an arbitrary admin-selected address.

| Chain | First integration candidate | Alternative / reason |
| --- | --- | --- |
| Ethereum | Uniswap v2 constant-product pool | Simple full-range liquidity and fungible LP ownership. Uniswap v3 is possible with reviewed position locking and range policy. |
| Base | Aerodrome basic volatile pool | Its x*y=k pool fits the curve and needs no range manager. Uniswap is an alternative for shared EVM infrastructure; choose after comparing integration and fee economics. |
| BNB Chain | PancakeSwap v2 | Simple constant-product migration; v3 requires NFT/range lock design. |
| Solana | Raydium CPMM for the existing custom curve | Burn & Earn supports permanently locked principal with fee rights. Meteora DBC -> DAMM v2 is a strong alternative if we adopt its curve infrastructure rather than maintain our own Solana curve. |
| Robinhood Chain | Pending verified AMM and lock support for the exact network | Do not infer an LP pool deployment from UniswapX support: an order-routing reactor is not an AMM factory. Testnet and mainnet are separate deployment configurations. |

These are recommendations based on compatibility and operation, not verified rankings by live volume or an assertion of universally best execution. A new pool creates its own token liquidity; the DEX's total TVL is not liquidity automatically available to that new token. Check quote routing, aggregator discovery, current deployment code, fee behavior and lock integration on a fork/testnet before choosing production adapters.

Sources: [Uniswap deployment registry](https://developers.uniswap.org/deployments), [Aerodrome pool types](https://github.com/aerodrome-finance/docs/blob/main/content/liquidity.mdx), [PancakeSwap routing](https://docs.pancakeswap.finance/trade/pancakeswap-exchange/fees-and-routes), [Raydium lock/fee rights](https://github.com/raydium-io/raydium-docs-v1/blob/main/getting-started/faq.mdx), [Meteora permanent locking](https://docs.meteora.ag/user-guides/creating-a-liquidity-pool).

Locking means no withdrawal of the migrated principal, including via upgrades or administrative rescue. Burning fungible LP ownership generally forfeits its future fee rights; a reviewed permanent locker or fee-key mechanism can preserve permitted fee claims. A concentrated position can stay locked but leave its active range. Use full-range/basic pools initially to avoid that operational issue.

IMPORTANT: our custom pool's 1.25%, 50/50 fee split does not carry over automatically to an external DEX. Traders using other interfaces bypass any Elpida router surcharge. Production post-migration revenue must come from the DEX's available LP fee rights and an explicit distribution design. Aerodrome, Uniswap, PancakeSwap, Raydium and Meteora differ here. Confirm permissionless fee claims and principal protection independently.

Migrate atomically or revert on failure; handle pre-existing pools and manipulated initial prices, exact spend limits, token ordering/decimals, leftover refunds, repeat calls and permissionless retry. Emit a canonical graduation record with destination pool, assets deposited, DEX adapter, lock address/position ID and actual supply changes.

## Indexer scope and architecture

Build our own durable indexer for Elpida-origin tokens first, including their curve and graduated pools. Indexing every token/pool on every DEX is a much larger separate product. The current browser/local API reads contracts directly; a production durable indexer is not present.

Pipeline: chain workers -> raw event/transaction store -> normalized trades and reserve snapshots -> prices/candles/supply projections -> API -> browser. Start with PostgreSQL for both durable records and candle aggregates; add caching only as load requires it. No trading private keys are needed by indexing workers. A migration keeper, if used, is a separate service and cannot redirect funds.

EVM worker:

1. Backfill factory Launched events from its deployment block with bounded eth_getLogs requests. Discover token and curve addresses and read immutable parameters at a fixed block.
2. Index Bought, Sold, CurveCompleted, Graduated and fee claims, plus token Transfer events. Include every successful transaction and order events by block, transaction index and log index. Initial buys occur before Launched in the same transaction: the discovered curve must be backfilled from that creation block, not the next block.
3. Register each graduation pool, starting from its creation block. Add a decoder per DEX for creation, swaps, liquidity and state updates; v2 Sync/Swap is not interchangeable with v3 ticks/sqrtPriceX96 or Solana accounts. Reconcile event projections with reserve/account reads at the same block or slot.
4. Persist checkpoints and raw events transactionally. Unique event key: chain ID + transaction hash + log index. Store block hash/parent hash, support rollback and replay for reorganizations, and expose provisional versus finalized state. Websocket notification is an acceleration, not the only durable ingestion path.

Solana worker: paginate signatures, fetch successful transactions, decode program instructions/events and inner instructions, and reconcile relevant pool accounts. Use slot/signature/instruction/event indices as identifiers and process finalized history durably. A live confirmed stream may feed provisional UI updates, then reconcile with finalized records. Account for historical RPC retention, missed websocket events and failed transactions. [Solana pagination](https://solana.com/docs/rpc/http/getsignaturesforaddress), [EVM RPC](https://ethereum.org/developers/docs/apis/json-rpc/).

Minimum stored entities: chains/deployments, blocks/checkpoints, raw events, tokens/metadata and parameter versions, curves, pools, migrations/locks, trades, reserve snapshots, native/USD observations, supply/balance projections and OHLCV candles. Use chain + address as token/pool identity; symbols are not unique. Store raw integer amounts as arbitrary precision decimal strings/numeric integers, never floating-point token balances.

## Price and market-cap display rules

- Curve spot: use virtual reserves and current curve state, never realReserve divided by actual remaining supply. Show virtual launch FDV even before buyers exist, alongside actual funds raised.
- Graduated spot: derive from authoritative pool state using the pool's pricing model and token decimals. Trade execution price is a separate field; normalize gross input, net output and fees explicitly. Do not label the last tiny trade as a reliable valuation.
- USD price: quote-asset spot * timestamped quote/USD feed. Display original quote units when USD is missing/stale, with freshness and source. USDC assumption/peg deviation needs an explicit policy.
- FDV = spot * total minted supply. Circulating market cap = spot * policy-defined circulating supply. Exclude provably dead tokens and agreed locked/vesting inventories; label policy/version. Do not assume curve sold count remains circulation after DEX migration and subsequent trades.
- Dead-address transfer is not an on-chain supply burn. Current prototype totalSupply remains 1B even after its approximately 40M transfer. Display total minted, provably inaccessible allocation and circulating estimate separately.
- TVL uses actual reserves and observed prices, never virtual reserves. Fee liabilities must not be double-counted as tradeable reserve. OHLCV uses normalized executed trades, time buckets, exact quote units and explicit gaps; price change requires a valid historical reference.
- The graduation pool is the initial canonical pool. Additional pools cannot replace its price merely because someone created them. Later aggregation needs allowlisted quote assets, minimum depth, freshness and manipulation checks. Keep venue-specific price and consolidated price distinct.
- Expose timestamp, block/slot, finality, source pool and indexing lag with price data. TWAP can supplement spot for less manipulable reference values; it is not automatically secure for a tiny/inactive pool. [Uniswap oracle design](https://developers.uniswap.org/docs/protocols/v2/concepts/oracles).

Proposed API: GET /tokens, /tokens/:chain/:address, /tokens/:chain/:address/trades, /tokens/:chain/:address/candles, /tokens/:chain/:address/pools and /indexer/status; SSE or WebSocket for updates. Keep transaction quotes on live contract/router simulation rather than treating an indexed display price as a guaranteed executable quote.

## Delivery sequence and acceptance checks

1. Implement durable EVM curve + custom-test-pool indexing locally, with replay from the factory deployment and UI/API reads. Keep existing transactions working.
2. Simulate the beta curve; implement it as a new model/template only after tests. Do not silently modify existing launches.
3. Add one chain's production DEX adapter, lock integration and decoder, then exercise graduation on a fork/testnet. Expand per chain after verifying the same invariants.
4. Add Solana curve/program or select Meteora DBC integration; add its account/transaction decoder. Expand cross-pool discovery later.

Acceptance: full replay equals incremental ingestion; restart resumes without duplicate trades; a simulated reorg corrects trades/candles; initial buys are indexed; pool prices match block/slot state; graduation preserves price within integer/tick rounding; principal remains locked; fees and supply projections reconcile; missing/stale FX never displays a fabricated USD price; API explicitly reports lag.
