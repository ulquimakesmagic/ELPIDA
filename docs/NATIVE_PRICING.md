# Native pricing

> **Legacy.** Current launches are priced in US dollars by on-chain oracles ($10 fee, $5,000 → $50,000 curve); see [MODEL_10.md](MODEL_10.md) and [USD_PRICING_AND_UX.md](USD_PRICING_AND_UX.md). This file only applies to legacy model 8 EVM factories and to Solana configs without USD pricing.

Elpida charges and prices every launch in each chain's own coin: SOL on Solana, ETH on Base, Ethereum and Robinhood Chain, BNB on BNB Chain. There are no dollar (USDC) pairs and no dollar fees. The team sets the numbers in one file, and nothing moves with the dollar price unless the team changes it.

## The file

`config/native-pricing.json` has one entry per network. Amounts are whole coins, written as strings.

| Field | Meaning |
|---|---|
| `launchFee` | Creation fee the creator pays to the treasury on every launch, whatever the trading pair. |
| `startFdv` | Fully diluted value of a new token at launch (price × 1B supply). |
| `endFdv` | Solana only. The FDV at which the curve completes and migrates to PumpSwap. Legacy model 8 EVM curves have a fixed shape and complete at 16 × `startFdv`; model 10 completes at 10 × its USD start. |

The mainnet values in the file are examples. Set them from the current coin price before deploying. For instance, at SOL = $150, a $5k → $50k curve is about 33 → 333 SOL, and a $7.50 fee is 0.05 SOL.

New values apply to launches made after the change. Tokens already launched keep the values they launched with, because each curve stores its own.

## Applying a change

**Solana**

```
node scripts/native-pricing.mjs                              # show every network's configured values
node scripts/native-pricing.mjs --chain solana-devnet        # compare with what is on-chain (no change)
node scripts/native-pricing.mjs --chain solana-devnet --yes  # apply, signed by the upgrade authority
node scripts/native-pricing.mjs --chain solana-mainnet --export  # print instructions for a Squads multisig
```

The script updates the SOL pair (curve and fee) and the SOL fee on every other pair config. It uses the program's `update_curve_config` instruction, which only the upgrade authority can call. The fee schedule (the 1.25% base fee and the anti-snipe decay) cannot change on an existing pair, because live pools read it on every trade. A normal deploy run (`npm run solana:deploy`) also applies the file.

**EVM**

Each factory is owned by its treasury wallet. As that wallet, open the site, pick the network, open **Network and funds**, and press **Apply native pricing**. It appears whenever the live factory differs from the file. A newly deployed launchpad starts with the file's values.

## What changed on-chain

- **Solana program:** `launch` transfers `launch_fee` lamports to the treasury wallet with a system transfer. Trading fees stay in the pair asset. New instruction `update_curve_config(params)`, upgrade authority only; error 6024 `FeeScheduleFixed`; event `CurveConfigUpdated`. Deployments create the SOL pair at `["curve-config", wSOL]` and no USDC or tUSDC configs.
- **EVM factories:** `ElpidaBetaFactory` (model 6) and `ElpidaDexFactory` (model 7) take `(treasury, launchFee, nativeVirtualQuote[, adapter])`. Launches send `msg.value` = fee + first buy for native pairs, or fee only for paired tokens. The value must be exact, so a price change between signing and mining reverts instead of overcharging. `setPricing(launchFee, nativeVirtualQuote)` is treasury only and emits `PricingSet`.
- Launchpads deployed from the browser before this change (priced in USDC) are not reused. Set up the launchpad again from **Network and funds**.

## Upgrading the live devnet program

1. Double-click `solana-upgrade.cmd` (or run `npm run solana:deploy -- --upgrade`). This upgrades the program and creates or reprices the SOL pair from the file.
2. Commit and push `deployments/solana-devnet.json` so the hosted site sees the SOL pair.

Older devnet tokens paired with USDC or tUSDC still exist on-chain, but the app no longer lists them.
