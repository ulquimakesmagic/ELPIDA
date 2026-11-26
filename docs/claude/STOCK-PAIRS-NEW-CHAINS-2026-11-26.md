# Tokenized stock pairs on the new chains — decided 26 Nov 2026

Public-repo copy of the Claude Project note. Companion to `HANDOFF-2026-11-26.md`.

**Decision (Malik, 26 Nov 2026):**
1. **HyperEVM (999, HYPE): Ondo stocks** as trading pairs, next to the native HYPE pair. Candidates: draft PR #402
   (35 issuer-published addresses verified against on-chain metadata and the shared compliance contract).
2. **Elysium (99901, HYPE): Backed xStocks**, not Ondo — Elysium has no Ondo stocks; its bridge provider Enso brings
   xStocks. Candidates: draft PR #403 (326 bridge mappings; five had supply at the checked block; prices unset).
3. Arbitrum One and Arc: no stock pairs in this phase.

## Availability (checked 26 Nov)

| Chain | Stocks | Notes |
|---|---|---|
| HyperEVM | Ondo, since 11 May 2026 | Bridged from Ethereum and BNB Chain via the Ondo Bridge (LayerZero OFT); 35 stocks/ETFs (SPYon, QQQon, NVDAon, TSLAon…); used by Felix and Melt; the bridge has an Ondo emergency pause. |
| Elysium | xStocks (Backed) via Enso | No Ondo or Ondo Bridge on Elysium. A competing Uniswap v4 launchpad (Volta) already operates there. |
| Arbitrum One | No Ondo | Other issuers exist (Robinhood's EU stock tokens). |
| Arc | None found | — |

## Order and gates

1. Deploy the chain's V2.3 launchpad with the native HYPE pair; pass a public launch, buy and sell.
2. HyperEVM stocks before Elysium stocks.
3. Per active list: stock-pair fork rehearsal proving contract custody and transfers (factory, hook, PoolManager,
   router can hold and move the tokens under the issuer's compliance rules); a usable HYPE → stock first-buy route
   (#402 found no HyperSwap quote for NVDAon/SPYon/TSLAon at the sampled routes — needs liquidity or another route);
   a USD price per stock (Chainlink → RedStone/Pyth → `ElpidaOndoStockFeed`-style adapter; otherwise list unpriced, as on
   Robinhood Chain #309 — never invent prices); issuer eligibility and the existing US-person region block; full suite;
   Malik's Safe approval (`approvedQuotes`).
4. `config/stocks/<chain>-mainnet.json` in a PR; Malik approves from the Safe.

## Reuse the existing stock-pair code

`packages/core/stock-list.mjs`, `stock-catalog.mjs`, `stock-prices.mjs`, `ondo-assets.mjs`, `ondo-market.mjs`,
`ondo-valuation.mjs`, `tokenized-equity.mjs`, `pairs.mjs`; `scripts/stock-list.mjs`; `config/stocks/` and
`config/stocks/candidates/`; `config/tokenized-equity-registry.json`. `docs/HUMAN_ACTIONS.md` sections: Ondo stocks
per EVM chain (18 Nov), Ondo on Ethereum (13 Nov), Ondo on BNB price adapters (13 Nov), Robinhood stock tokens (24 Nov),
stock-pair region block (19 Nov).

Outreach: Ondo stock pairs on HyperEVM are a concrete hook for the Ondo launch-support email; ask Ondo whether the
Ondo Bridge will reach Elysium.
