# USD pricing and interface verification — 11 October 2026

## Implemented

Models 8 (basic EVM) and 9 (DEX EVM) replace manually priced native creation fees. The factory reads its configured on-chain USD feed during execution and charges `ceil(10 × 10^18 × 10^feedDecimals / answer)` wei. Launches are unavailable before configuration. The owner selects a feed, freshness limit and optional six-decimal USDC address once; these settings cannot subsequently be changed. Browser deployment verifies them against the server's chain registry. This trusts the deployment operator and the selected oracle proxy/administrator; it does not make an arbitrary owner-selected feed trustworthy.

Positive prices, completed nonzero rounds, timestamps and freshness are enforced on-chain. Missing, invalid, future and stale prices fail closed. Source failures cannot silently revert to a manually configured native fee. USDC payment transfers exactly 10,000,000 units to the treasury, checks the received amount and remains atomic with token creation and the first purchase. USDC launches also require a fresh native oracle to initialize the curve. Pool payment assets remain independent of fee payment.

The browser sends a 1% allowance above its quoted native fee; the factory charges its current calculated fee and refunds excess. If the required amount exceeds what was submitted, the launch reverts. Approval transactions can persist after a rejected launch signature; approvals are limited to the required amount. Signature rejection, stale feed and price movement errors allow retry without losing the launch draft. Network gas is estimated before signing and is separate from the creation fee and first purchase.

“Exactly $10” means $10 using the accepted oracle answer at execution, rounded upward by less than one native smallest unit. Oracle heartbeat, market volatility, transaction inclusion time and source deviation prevent guaranteeing $10 at an exchange's instantaneous price. Ten USDC is a nominal amount and may not equal ten dollars during a depeg. Gas and trading fees are additional.

The native curve snapshots its starting FDV at creation, before the mandatory first purchase: $5,000 on mainnet and $50 on test-sized testnet deployments (model 10). Model 10 uses the Solana curve shape (virtual tokens 1B × 10/9, sale cap ≈ 759.75M) and graduates at 10× its start; legacy models 8 and 9 used an 800M sale cap and 16×. See [MODEL_10.md](MODEL_10.md). Existing curves are never repriced when the feed changes. Later USD FDV changes with both the token price and native USD reference. The whole 1B supply is minted at launch, so circulating supply is constant at 1B and market cap equals FDV (price × 1B). Tokens still held by the curve or pool count toward that supply. Approved custom quote templates retain their quote-unit economics; custom quote USD feeds are not yet available and their figures stay in quote units.

The keeper supplies timestamped prices for ETH, BNB and SOL, covering every configured chain's native asset. Fee-enabled EVM chains prefer their on-chain feed. Optional authenticated Pyth and timestamped CoinGecko fallback support display references. Browser/off-chain prices never authorize fees. Cached data keeps its original timestamp and becomes visibly stale/unavailable. Feed freshness follows verified heartbeat plus tolerance (Base Sepolia 1,500s; Ethereum Sepolia and BNB testnet 3,900s); display fallback freshness is 180s. The simulation uses a clearly labelled mock oracle, initially $2,500/ETH, refreshed from available references. Mock values are not real market guarantees.

## Chain readiness

| Environment | USD fee | USDC fee | Graduation |
|---|---|---|---|
| Local/hosted simulation | Working with mock oracle | Working with mock USDC | Actual local Uniswap v3 contracts and permanent position locker |
| Base Sepolia | Implemented; wallet deployment/signatures required | Official test USDC configured | Uniswap v3 adapter deployment prepared |
| Ethereum Sepolia | Implemented; wallet deployment/signatures required | Official test USDC configured | Locked test pool, not an external production DEX |
| BNB testnet | Implemented with official test feed; wallet/RPC test still required | Disabled unless a reviewed USDC address is configured | Locked test pool |
| Robinhood testnet | Disabled pending verified native USD feed | Disabled pending reviewed addresses | Existing basic preview only |
| Solana | Program reads Pyth SOL/USD on-chain at launch (built and validator-tested); devnet upgrade must be run from your computer | 10 USDC transfer_checked to the treasury (built and tested) | Existing PumpSwap integration unchanged |

Existing public advanced creator rewards, xStocks, identity attestations and public DEX historical indexing are not made production-ready by this change. Local reward simulations and their tests remain available. Existing permanent liquidity lockers and fee allocation were preserved.

## Interface

Black surfaces and restrained neon green establish hierarchy without excessive glow. Discovery separates bonding-curve and graduated tokens, shows price/circulating cap/FDV and groups incompatible reserve units. The guided launch flow retains metadata, chain selection before wallet connection, reward configuration, first purchase and final review. Fee currency is independent of the trading pair. Conversion source/time, execution-price limitations and separate gas are visible. Metadata accepts the existing 5MB PNG/JPEG/WebP/GIF/AVIF/BMP policy.

Token pages show indexed quote-unit history with honest empty/error states. One recorded trade is a point, not fabricated history. Public history explicitly explains the missing public indexer. Trade amounts exceeding the curve are rejected with an exact remaining-amount action. Background refresh preserves trade amount/slippage and obtains a fresh quote. Buy/Sell support arrow keys/Home/End and proper tab focus. Controls meet 44px touch height where applicable, addresses wrap, focus is visible, and reduced-motion styling suppresses decorative movement.

## Research applied

Patterns were evaluated through accessible official documentation and visible interfaces, without importing branding or assuming fees are identical:

- [Pump.fun curve documentation](https://pump.fun/docs/bonding-curve) and [fees](https://pump.fun/docs/fees?include-nsfw=true): explicit curve lifecycle and fee disclosure.
- [BONK.fun](https://www.bonk.fun/) / [LetsBONK](https://www.letsbonk.fun/): visible discovery filters, search, graduated-stage separation and rewards navigation.
- [Four.meme creation guide](https://four-meme.gitbook.io/four.meme/guide/how-it-works): metadata, trading-pair choice and lifecycle clarity. Tax-token features were not added to Elpida.
- [Flap documentation](https://docs.flap.sh/flap): reward-vault configuration and launch review patterns.
- [Pons Family v2](https://docs.ponsfamily.com/v2): graduation and locked-pool/reward explanation. Elpida does not claim its Uniswap v4 integration.
- [Raydium LaunchLab](https://docs.raydium.io/products/launchlab): distinct curve, migration and post-migration phases.
- Stonkfun's canonical current interface/documentation could not be verified; no implementation or capability claims rely on it.

Oracle references: [Chainlink feed directory](https://docs.chain.link/data-feeds/price-feeds/addresses), [round API](https://docs.chain.link/data-feeds/api-reference), [Circle USDC addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses), [Pyth authenticated updates](https://docs.pyth.network/price-feeds/core/fetch-price-updates), [CoinGecko timestamped prices](https://docs.coingecko.com/reference/simple-price). `PYTH_API_KEY` is optional and belongs only in server/Railway variables. Pyth live authenticated access needs your key; mock tests verify parsing/identity/confidence behavior.

## Verification and user actions

Full suite: 93 tests, 74 passed, zero failures, 19 skipped Solana validator tests. After final backend changes, the API/oracle/keeper regression run passed all 10 tests. An additional keeper test covers invalid identities, missing/excessive confidence and stale Pyth data falling back; all four keeper tests pass. Application modules pass syntax checks. Coverage includes oracle freshness and execution-time movement, upward rounding, exact USDC transfers, refunds, atomic rollback, trading/curve invariants, DEX migration and locked principal, post-migration fees, holder rewards, paired rewards, buybacks/vesting, identity checks and request protection. These checks are not an independent security audit or a public-chain deployment test.

Browser verification uses isolated localhost simulation and simulated funds: metadata validation/upload, chain/reward/fee selection, a USDC-paid launch, native buying, exact curve completion, locked Uniswap graduation, a post-migration sell and a creator ETH claim. Discovery, trading and rewards have no horizontal overflow at 320, 390, 768, 1280 or 1440px. The launch indicator's 320px overflow was repaired and its controls measure at least 44px high. Buy/Sell keyboard navigation was verified. Public deployment requires your browser wallet: choose Base Sepolia in Create token, connect the desired extension, fund it with test ETH, then complete the prepared adapter/factory/oracle activation signatures (three transactions). If paying USDC, obtain official Base Sepolia test USDC and approve exactly ten USDC when prompted. Review the final launch transaction and sign it yourself. Old factory versions need a new deployment; old deployments remain recorded and cannot acquire this pricing through a frontend update.

Changes were pushed to `main` and Railway's `/health`, `/api/config` and pricing endpoint confirm model 9 running in shared simulation. Public-chain wallet transactions still require the user's signatures. Latest isolated local runtime is available on port 3002; the user's original port-3000 process was left running. Screenshot evidence is saved locally under `backups/ui-audit-20261011/` (excluded from Git).

For public metadata, set `PINATA_JWT` in Railway, never Git. Configure X application credentials and the registered callback before attempting real X verification. Robinhood needs a verified feed with reviewed heartbeat/asset/administrator. Solana needs the devnet program upgrade below before new launches are enabled there. Public chart/indexer and advanced reward contracts require separate completion and review.

The hosted simulation journals every state-changing action (launch, trade, withdraw, graduate, reward actions, and the seeded demo launches) to `local-data/simulation-journal-v2.jsonl` on the Railway volume and replays it at start, so tokens and balances survive restarts and redeploys. `/api/public/status` reports `storage.simulation` (`durable`, `replayed`, `skipped`). The new indexer filename separates model 9 from older deployment databases; the previous database is preserved. Ports other than 3000 use separate data files so browser QA does not overwrite the user's running preview.

## Solana USD pricing (added 12 October 2026)

The Solana program has a `PricingConfig` account per pair config (PDA `["pricing", config]`), set once by the upgrade authority with `set_pricing`. It binds the Pyth SOL/USD feed id (`ef0d8b6f…b56d`), the sponsored price account (`7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE`, owned by the Pyth receiver), a maximum age, a maximum confidence width, the $10 fee and the $5,000 start FDV.

At `launch` the program reads the `PriceUpdateV2` account itself. It requires the bound account, Pyth ownership, full verification, the right feed, a positive price, a fresh publish time and a confidence width under the limit. It then computes the fee as `ceil(10 USD / price)` lamports and the starting virtual SOL reserve from $5,000 / 1B. The creator passes `max_fee` (the browser sends its quote + 1%); a higher on-chain fee fails with `FeeAboveMax` (6028) instead of overcharging. Other errors: `PriceUnavailable` 6025, `PriceStale` 6026, `PriceUncertain` 6027, `UsdcFeeUnavailable` 6029. Paying in USDC transfers exactly 10 USDC (6 decimals, `transfer_checked`) to the treasury's associated token account. Pairs without pricing keep their configured fixed fee.

Limits per cluster are in `packages/core/usd-oracles.mjs` (`SOLANA_ORACLES`): mainnet 120 s / 2%, devnet 300 s / 3% with a test-sized $50 start FDV, localnet 3,600 s. The validator tests cover fresh, stale, wide-confidence, wrong-feed and non-Pyth accounts, max-fee protection and USDC payment.

**To enable it on devnet** (devnet RPC is unreachable from Claude's environments): on Windows, double-click `solana-upgrade.cmd` (or run `npm run solana:deploy -- --upgrade`) with devnet SOL in `local-data/solana-deployer.json`. It upgrades the program, runs `ensurePricing` for each pair and writes `deployments/solana-devnet.json`; commit and push that file so the hosted site sees the pricing accounts.

## Public indexers

- **Base Sepolia:** `PublicIndexer`, SQLite on the volume, see `PUBLIC_MARKETS.md`.
- **Solana:** `packages/indexer/solana-indexer.mjs` reads every pool account (`getProgramAccounts`), then each pool's transaction history (`getSignaturesForAddress` → `getTransaction` → program events) into SQLite on the volume (`public-solana-<cluster>-<programId>.sqlite`). The server polls every 20 s and serves `/api/public/tokens[/<mint>[/trades|candles|holders]]?network=solana-devnet`. The browser lists Solana tokens from this index first and falls back to direct RPC reads. Holders come from `getTokenLargestAccounts`, so only the top 20 accounts are shown. Prices after PumpSwap graduation still come from the last curve state. Set `SOLANA_RPC_URL` in Railway for a dedicated RPC; `ELPIDA_SOLANA_INDEXER=off` disables it.
