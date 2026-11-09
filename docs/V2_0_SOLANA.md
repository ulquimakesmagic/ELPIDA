# ELPIDA V2 on Solana

Solana has no Uniswap v4 hooks, so V2 lives in the existing `elpida_launchpad` program (same program ID, an in-place
upgrade). Existing Solana tokens keep trading exactly as before. Malik chose the curve-then-Raydium design on 9
November 2026: the bonding curve graduates into a locked Raydium CPMM pool (other pairs: PumpSwap), and the fees the
locked position earns there are harvested and split the same five ways.

Not audited. Test networks first; mainnet only with Malik's explicit approval.

## Phases

| Phase | What | Status |
|---|---|---|
| S1 | V2 pairs, `launch_v2`, the token's own fee, anti-snipe to liquidity, the five-way fee ledger, `withdraw_v2_fees` | This PR |
| S2 | Five-way harvest of graduated-pool (Raydium / PumpSwap) fees for V2 pools | Next |
| S3 | Trader airdrop and holder reward rounds (Merkle claims) and the flywheel buy-and-burn, from the vault PDAs | Later |
| S4 | Server keeper (Solana key), indexers, launch flow, token pages, unified rewards on the analytics page | Later |
| S5 | Malik upgrades devnet; the site pins the V2 pairs | Later |

## S1: what the program does

- **Pairs.** `add_v2_config(params)` (upgrade authority) creates a V2 pair at PDA `["curve-config-v2", quote_mint]` with
  `model_version = 4`. In a V2 config `base_fee_bps` is the **minimum** fee a creator may choose: 1 to 125 bps on test
  builds; exactly 100 bps (1.00%, approved by Malik) on the mainnet build. The anti-snipe schedule must be 90% over
  60 s and the first-buy cap 3%. Quotes that would need the locked pool (no DEX venue) are refused.
- **Curve.** The same virtual-reserve curve, sized ×5 like EVM V2: virtual token reserve 1.25B, sale supply
  vT(1 − 1/√5) ≈ 690.98M. Test pairs start at $50 (graduate at $250); mainnet pairs at $20,000 ($100,000).
- **`launch_v2(name, symbol, fee_bps, first_buy, min_tokens_out, reward, max_fee, fee_in_usdc, uri)`.** Like `launch`
  (creation fee, fixed 1B supply, immutable Metaplex metadata, mint authority revoked), plus:
  - `fee_bps` is the token's own fee, from the pair's minimum to 4%, fixed for good;
  - tickers are 1 to 10 letters or digits, any case (not unique);
  - the first buy pays the token's own fee and is capped at 3% of supply;
  - there are no partner tiers.
- **Trading.** `buy` and `sell` are unchanged for older pools. For V2 pools the fee starts at 90% and falls linearly
  to the token's own fee over 60 seconds. The part at the token's rate joins the pool's ledger (`accrued`); anything
  above it is locked as liquidity (`liquidity_bonus`) and goes into the DEX pool at migration.
- **Ledger.** 64 bytes after the pool extension (pool accounts are 356 bytes): version, `fee_bps`, `accrued`, `paid[5]`.
  Recipient i is owed floor(accrued × split[i] / 10,000) − paid[i], with the split 30% creator, 30% trader airdrop,
  10% flywheel, 10% holder rewards, 20% treasury (the EVM hook's order). At most 4 base units of rounding stay behind.
- **`withdraw_v2_fees` (anyone).** Pays every owed share to fixed destinations: the pool's creator reward wallet, the
  three reward vaults (data-less PDAs `["v2-vault", "airdrop" | "flywheel" | "holder"]`, one associated account per
  asset) and the pair's treasury. Works before and after migration; liquidity is never touched.
- **Migration.** Unchanged: `migrate_to_raydium` (SOL pair) or `migrate_to_pumpswap` moves the reserve and the locked
  surplus; owed shares stay in the curve vault for `withdraw_v2_fees`.
- **Harvests.** Until S2, `harvest_raydium_fees` and `harvest_lp_fees` refuse V2 pools (error 6040). Fees keep
  accumulating in the locked position, so nothing is lost; S2 harvests them five ways.

## Errors added

| Code | Name | Meaning |
|---|---|---|
| 6037 | `NotV2` | The instruction needs a V2 pool or pair |
| 6038 | `V2FeeRange` | Fee below the pair's minimum or above 4% |
| 6039 | `NothingToWithdraw` | Nothing owed yet |
| 6040 | `V2HarvestPending` | Five-way harvest arrives in S2 |

## Tests

- `contracts/solana/host-tests/tests/v2_ledger.rs`: the split, the fee schedule, tickers, the ledger round trip, and
  property tests that shares never exceed the total, are paid once, and that the vault always covers the reserve, the
  locked surplus and every unpaid share.
- `tests/solana.test.mjs` (V2 tests at the end, against `solana-test-validator`): pair creation rules, the legacy
  launch refusing V2 pairs, fee range, first-buy cap and ticker checks, the anti-snipe surplus going to liquidity, the
  five-way withdrawal (once), graduation, migration, withdrawal after migration, and the harvest guard.
