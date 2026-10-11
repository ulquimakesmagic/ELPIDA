# Virtual curve, pair selection and graduation

**Model 3 historical guide:** the default UI now uses model 4 beta economics and durable indexing. See [current implementation](INDEXER_AND_POST_MIGRATION_FEES.md). Existing model 3 source remains unchanged.

Current design: 11 October 2026. This supersedes the direct-pool/deposit design recorded on 10 October. Work lives in `C:\Users\user\Desktop\OneForAll\ELPIDA\elpida-v1`; synced ChatGPT sources remain untouched.

## Creation fee and trading pair

Every launch pays 10 USDC to the protocol. The creator chooses native-asset or USDC pairing, immutable for that launch. There is no separate liquidity deposit. The mandatory first buy uses the pair asset:

| Launch | Creation fee | First buy and trading | Production graduation pair |
| --- | --- | --- | --- |
| Ethereum / Base / Robinhood native pair | 10 USDC | ETH | Token / wrapped ETH |
| BNB native pair | 10 USDC | BNB | Token / wrapped BNB |
| Solana native pair, pending program update | 10 USDC | SOL | Token / wrapped SOL |
| USDC pair | 10 USDC | USDC | Token / USDC |

Verify the accepted USDC variant per chain. Testnets without Circle USDC use explicitly labelled tUSDC. Selecting a native pair does not convert USDC automatically: a native launch needs the fee token and native funds for its buy and gas. A future router may swap with explicit price, slippage and authorization.

The 1.25% trading fee splits 50/50 protocol/creator and accrues in the pair asset. Native fees are not USD amounts. Optional USDC reward conversion is a separate future integration. Recipients are fixed at launch; claims cannot take trading reserves.

## Implemented prototype

Localhost and new EVM browser deployments use `ElpidaLaunchFactory` (model 3) and `ElpidaLaunchCurve`. Both native and USDC launches/trades execute on contracts. USDC fee collection, token creation and first buy are atomic. Earlier direct-pool and curve sources are preserved.

Virtual reserves set prices, while purchases accumulate real funds and sells draw only from those real funds. At the sale cap, curve trades stop. Anyone may call `graduate()`, deploying a **custom locked test pool** and moving real reserves and the price-matched token allocation into it. Existing token holders can sell into it immediately. Pre-migration fees remain claimable on the curve; post-migration fees accrue on the pool.

This is not a PumpSwap, Raydium, Uniswap or Meteora integration. Production needs an established DEX adapter and reviewed locker. Native funds would normally be wrapped for that DEX; the custom test pool handles native currency directly. Neither creators nor administrators have a principal-withdrawal, rescue or upgrade function.

New browser records use `elpida:curve-pairs-v3:deployment:<chainId>`, leaving old records intact. Shared deployment entries need `model: 'curve-pairs-v3'`; the factory is checked for version 3.

The existing Solana program implements the preceding direct-pool model. Its code and connection support are preserved. New-model Solana launches are blocked until its program/client supports virtual trading, pair selection and graduation. Tests against a Solana validator are skipped when the validator executable is unavailable.

## Test economics

These are test parameters, not calibrated production economics:

- Supply and virtual token reserve: 1 billion tokens, EVM decimals 18.
- Sale cap: 800 million; 200 million withheld from curve buyers.
- Initial virtual quote: 30,000 USDC or 30 native units, independently configured with no assumed exchange rate.
- With no sells, real reserves approach 120,000 USDC or 120 native units at completion. Fees are separate.

Curve marginal price is `(virtualQuote + realReserve) / (virtualToken - sold)`. Migration deposits all real quote Q and calculates:

`poolTokens = floor(Q * (virtualToken - sold) / (virtualQuote + Q))`

At the sale cap, approximately 160 million tokens seed the pool; approximately 40 million remaining tokens go to the dead address. This price-matching rule avoids depositing virtual money or creating a migration price jump. TotalSupply stays 1 billion: the dead-address transfer does not decrement it. Gas costs are paid separately, not deducted from liquidity. Production parameters and costs must be solved together.

The terminal buy is bounded by `completionQuote()`. Oversized requests revert rather than donating excess. After completion, the UI offers a separate graduation transaction before pool trading resumes.

Accounted quote balance equals reserve plus accrued fees on each market. After migration the curve has zero trading reserve and retains backed old fees. Fee claims do not remove principal. Incoming transfer-tax quote amounts are rejected. Forced/donated funds are not admin-recoverable.

## Testing and remaining work

Run `npm run dev`; open http://localhost:3000 and select a pair in Create a token. A 25 USDC buy costs 35 test USDC plus gas. A 0.01 native buy costs 10 test USDC plus 0.01 native plus gas. Prices, reserves and fees display in the selected asset; different assets are not added as dollars.

Tests cover both pairs, rollback, redemption backing, completion limits, terminal-price matching, permissionless migration, claims and sales by pre-graduation holders. Production DEX integration, public-chain transaction verification, the updated Solana model, automatic swaps, unified funding, reward conversion, durable indexing and security review remain pending.

Lifecycle references: [Pump program](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_PROGRAM_README.md), [Meteora DBC](https://docs.meteora.ag/core-products/dbc/what-is-dbc). Elpida's test parameters and fee split are its own.
