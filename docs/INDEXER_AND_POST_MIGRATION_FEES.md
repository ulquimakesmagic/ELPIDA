# Beta curve, durable indexing and post-migration fee rights

> **Superseded for current economics by [MODEL_10.md](MODEL_10.md)** (15 October 2026): every chain now uses a $5,000 → $50,000 (10x) curve with anti-snipe fees and a graduation escape hatch. The figures below describe older models and are kept for history.

This page describes the preserved model 4 implementation. Localhost and Base Sepolia now use model 5 with actual Uniswap v3 migration, permanent NFT custody, DEX indexing and fee claims. See [current DEX testing guide](BASE_SEPOLIA_DEX_TESTING.md) for the active behavior and limitations.

Implemented locally on 11 October 2026. Development prototypes; no production DEX transaction or mainnet deployment has been made.

## Current implementation

- New `ElpidaBetaFactory` / `ElpidaBetaCurve`, model 4 (`curve-beta-v4`). Existing model 3 and older source contracts remain unchanged. Browser deployment records use a new key, leaving old records intact.
- USDC template: approximately $5,000 initial FDV, $80,000 terminal FDV, 800M tokens sold, approximately 16,000 net USDC and 200M tokens deposited into the custom permanently locked test pool. Total supply remains 1B.
- Virtual token reserve is independent of actual token supply. Graduation uses actual remaining token inventory. Final-buy quote rounding can produce an allocation infinitesimally above inventory; a one-part-per-billion bound permits capping this excess. Larger discrepancies revert. Any smaller unmatched leftover is sent to the known dead address and indexed separately.
- Native template is immutable per factory. Local/ETH testnets use 2.133333333333333333 virtual ETH; BNB testnet uses 8.888888888888888888 virtual BNB. These are illustrative test parameters based on hypothetical ETH=$2,500 and BNB=$600, NOT live prices or a dollar valuation guarantee. The indexer does not fabricate USD prices for native pairs.
- SQLite WAL indexer stores deployment identity, blocks/hashes, launches, decoded events, trades and historical market snapshots. It discovers first buys in the creation block, backfills graduated test pools in their creation block, rolls back orphaned blocks and resumes from stored history. Raw balances and decimal prices use integer arithmetic/string storage.
- Local listings now come from indexed snapshots; wallet balances and transaction quotes still read live contracts. The browser labels total-supply valuation as FDV and shows market-data indexing status. The API exposes circulating supply/market-cap estimates separately.

SQLite is the local/single-worker implementation. PostgreSQL, high-volume batching and production RPC retention/availability are deployment work, not implemented here. External DEX and Solana decoding are also pending. Stored history is durable; the embedded Hardhat chain still resets when the dev server restarts. The worker detects that replaced history and rebuilds instead of preserving trades from a chain that no longer exists.

## Local API

The dev server indexes automatically. Start `npm run dev`, then use:

- `GET /api/indexer/status`: indexed/head blocks, lag, confirmation policy, errors and supported adapters.
- `GET /api/tokens`: indexed markets and parameter records.
- `GET /api/tokens/<address>`: market snapshot, quote price, FDV, circulating estimate and price timestamp.
- `GET /api/tokens/<address>/trades`: up to 100 recent trades.
- `GET /api/tokens/<address>/candles?interval=60`: execution-price OHLCV. Supported intervals: 60, 300, 3600, 86400 seconds.

Candles use quote paid/received per token, including trader fees, not marginal spot. Candle volumes are exact raw integers; interpret them using quote/token decimals in the token record. Gaps are not filled with invented trades. USDC dollar price is explicitly marked as a $1 assumption, not an oracle feed. Native USD price is null without a feed. Circulating estimate excludes current curve/pool inventory and the known dead address; it is a stated policy, not an externally certified circulating supply.

## Read-only public EVM worker

This worker can index existing Elpida model 3 or 4 curves/test pools over a configured RPC. It does not submit transactions or need a private key. It does not yet decode Uniswap, PancakeSwap or other production pools.

PowerShell example; fill in an existing deployment and its actual deployment block:

```powershell
$env:ELPIDA_RPC_URL = 'https://YOUR_RPC'
$env:ELPIDA_FACTORY = '0xYOUR_FACTORY'
$env:ELPIDA_FROM_BLOCK = 'ACTUAL_DEPLOYMENT_BLOCK'
$env:ELPIDA_CONFIRMATIONS = '12'
$env:ELPIDA_NATIVE_SYMBOL = 'ETH'
npm.cmd run indexer
```

Read endpoints are at `http://localhost:3901`. Optional `ELPIDA_INDEX_DB` and `ELPIDA_INDEX_PORT` choose database path and port. `npm run indexer -- --once` performs one sync and exits. Confirmation depth is chain-specific and is not a guarantee of finality. Public-testnet browser mode still uses its existing direct-contract reader; connecting that UI to a separately hosted production indexer is pending.

## Post-migration fees

Recommended flow:

```
DEX swaps -> LP position's claimable fees
         -> permanent principal locker collects fees only
         -> ElpidaFeeSplitter credits each asset
         -> 50% protocol / 50% creator, to fixed wallets
```

Anyone may trigger collection or payout, but cannot change the recipients. Fees are paid in the assets the DEX position actually earns (often both the launched token and quote token). ETH pairs usually earn WETH, not native ETH. Automatic conversion into USDC is a separate swap integration with quotes/slippage, and is not implemented.

Implemented reusable prototypes:

- `ElpidaFeeSplitter`: ERC20 or native deposits, exact incoming-balance checks, immutable 50/50 beneficiaries, fee-only accounting and individual permissionless claims. Odd smallest-unit rounding goes to creator. Identical beneficiary addresses accumulate both shares correctly. A rejecting native recipient does not block another recipient's claim.
- `ElpidaV3FeeLocker`: custody of one full-range position NFT from an immutable trusted migration adapter and verified manager. Validates pair, fee, range, positive liquidity, cleared approval and zero pre-existing owed amounts. Only exposes fee collection; it has no position transfer, approval, liquidity decrease, arbitrary rescue or upgrade path. Collected fees fund its dedicated splitter.

The locker and splitter are NOT yet connected to the curve's `graduate()` method. Local graduation still creates the existing custom locked test pool, which already accrues 1.25% fees split 50/50. A real DEX migration adapter, its deployed-address/code validation and fork/testnet verification must be implemented before changing that path. The trusted adapter must supply a freshly minted position; the locker cannot distinguish previously withdrawn principal from fees if a malicious adapter/manager supplies it. These trust assumptions need independent review.

### Example revenue

Suppose a pool charges 0.30%, receives $100,000 volume and our migrated locked position earns $300 of claimable fees after any DEX protocol allocation. Splitter credits $150 protocol and $150 creator. If other LPs subsequently provide liquidity, our position earns only its share of fees for liquidity active on the swaps. A 50/50 split applies to OUR collected fees; it does not claim all DEX revenue. A DEX protocol deduction can reduce the $300 example.

External interfaces trading the same pool still generate its LP fees. An Elpida-only router surcharge can be bypassed through another router. Do not promise the old 1.25% fee for every external trade or introduce transfer-tax tokens to enforce it.

### Revised DEX choices when fee income matters

| Chain | Fee-preserving route |
| --- | --- |
| Ethereum | Uniswap v3 full-range NFT held in a reviewed permanent fee-only locker. Standard v2 fees compound into reserves and have no equivalent separate fee claim. |
| BNB Chain | PancakeSwap v3 position with its exact position-manager ABI/deployment and permanent locker checked. Do not assume this Uniswap-compatible prototype has been verified against PancakeSwap. |
| Base | Aerodrome basic volatile pool has separate `claimFees()` in its pool code; a corresponding permanent fungible-LP locker could preserve these rights. Uniswap v3 is an alternative. Gauges/staking introduce a separate fee ownership policy. |
| Solana | Raydium Burn & Earn Fee Key or Meteora DAMM v2 permanently locked position with claimable fees. The Solana fee-split/distribution program remains to be built. |

Sources: [Uniswap v3 fee collection](https://developers.uniswap.org/docs/protocols/v3/guides/managing-liquidity/collect-fees), [Aerodrome fee accounting](https://github.com/aerodrome-finance/contracts/blob/main/contracts/Pool.sol), [Raydium fee-preserving lock](https://github.com/raydium-io/raydium-docs-v1/blob/main/getting-started/faq.mdx), [Meteora DAMM v2 locks and fees](https://docs.meteora.ag/core-products/damm-v2/what-is-damm-v2).

## Validation

Focused tests cover beta native/USDC buys and sells, 6/18-decimal quote amounts, rollback, terminal allocation/price continuity, old-holder pool sales, fee backing, index replay/restart/reorg, first-buy inclusion, post-graduation indexing, NFT configuration/source rejection, repeat locking rejection, permissionless fee collection, fixed payout destinations, failed-claim rollback and principal custody. Production managers, real swap fee accrual, public-chain graduation, external DEX decoding and Solana integration have not been validated by these mock/local tests.
