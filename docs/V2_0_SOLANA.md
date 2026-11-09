# ELPIDA V2 on Solana

Solana has no Uniswap v4 hooks, so V2 lives in the existing `elpida_launchpad` program (same program ID, an in-place
upgrade). Existing Solana tokens keep trading exactly as before. Malik chose the curve-then-Raydium design on 9
November 2026: the bonding curve graduates into a locked Raydium CPMM pool (other pairs: PumpSwap), and the fees the
locked position earns there are harvested and split the same five ways.

Not audited. Test networks first; mainnet only with Malik's explicit approval.

## Phases

| Phase | What | Status |
|---|---|---|
| S1 | V2 pairs, `launch_v2`, the token's own fee, anti-snipe to liquidity, the five-way fee ledger, `withdraw_v2_fees` | Done |
| S2 | Five-way harvest of graduated-pool (Raydium / PumpSwap) fees for V2 pools | Done |
| S3 | Trader airdrop and holder reward rounds (Merkle claims) and the flywheel buy-and-burn, from the vault PDAs | Done |
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
- **Harvests (S2).** `harvest_raydium_fees` (SOL pair) and `harvest_lp_fees` (PumpSwap) stay permissionless and
  still withdraw only the LP growth earned from fees; the principal liquidity never falls. For V2 pools, instead of the
  older 50/50 payout:
  - the **token side** of the harvest is **burned** (supply falls);
  - the **quote side** returns to the curve's quote vault and joins the pool's ledger, so the next `withdraw_v2_fees`
    splits it 30 / 30 / 10 / 10 / 20 like every curve fee.
  The caller passes the pool writable and the curve's quote vault as the first remaining account (`v2: true` in the
  client). Event `V2Harvested { pool, base_burned, quote_accrued, accrued }`.
- **Fee after graduation.** On Raydium the pool's own 1% tier applies (84% of it to the locked position); the token's
  chosen fee applies on the curve. Matching Raydium tiers to the chosen fee, and Raydium's separate creator fee, are
  open questions for later.

## S3: reward rounds and the flywheel

- **Distributors.** `init_v2_distributor(kind, operator, period, genesis)` (upgrade authority, once per kind; immutable):
  kind 0 trader airdrop, kind 1 holder rewards. `period` 0 means calendar months from `genesis` (the first of a month,
  00:00 UTC, Howard Hinnant's date algorithm as on EVM); otherwise rounds of `period` seconds (at least a day) from a UTC
  midnight. The operator is the server keeper's Solana key. State at `["v2-dist", kind]`; funds stay with the vault PDA
  `["v2-vault", "airdrop" | "holder"]`.
- **Rounds.** `post_v2_root(kind, round, root, total, recipients, manifest_uri)` (operator, after the round has ended):
  creates `["v2-round", kind, asset, round]` with a claim bitmap of `recipients` bits (at most 80,000), and only if the
  vault holds `total` beyond what earlier posted rounds still owe (`["v2-reserved", kind, asset]`). Posting the same
  round and asset twice fails.
- **Leaves.** keccak(keccak("elpida-v2" | program id | kind | round u32 | asset | index u32 | account | amount u64)),
  sorted-pair keccak Merkle tree (`packages/solana/v2-rounds.mjs` builds lists and proofs). A proof works for one
  program, distributor, round, asset and position only.
- **Claims.** `claim_v2` (anyone) pays one leaf once: wrapped-SOL rounds in **plain SOL** from the vault PDA (after
  `sweep_v2_sol` closes the vault's wrapped-SOL account into it), other assets to the payee's associated token account
  (created by the payer when missing).
- **Expiry.** `expire_v2` (anyone) once 12 further rounds have started: what the round left unclaimed is no longer
  reserved and pays later rounds.
- **Holder conversion.** Not on Solana: SOL pairs already pay in SOL; other pairs pay in their own asset.
- **Flywheel.** `v2_flywheel_curve` and `v2_flywheel_raydium` (the airdrop distributor's operator): buy a V2 token with
  the flywheel vault's quote and burn every token bought. The token must be at least a day old, an order at most 10% of
  the vault, one order per token every 6 hours (`["v2-fly", mint]`), and a curve order may not complete the curve. Curve
  orders pay the token's fee like any buy; Raydium orders swap through the locked pool with `min_out`. Event
  `V2BoughtAndBurned`. PumpSwap pairs (non-SOL) have no flywheel route yet.

## Errors added

| Code | Name | Meaning |
|---|---|---|
| 6037 | `NotV2` | The instruction needs a V2 pool or pair |
| 6038 | `V2FeeRange` | Fee below the pair's minimum or above 4% |
| 6039 | `NothingToWithdraw` | Nothing owed yet |
| 6040 | `V2HarvestPending` | Unused since S2 (kept so codes do not shift) |
| 6041 | `V2Terms` | Invalid distributor or round terms |
| 6042 | `RoundNotOver` | The round has not ended (posting) or its claim window is open (expiry) |
| 6043 | `NotFunded` | The vault does not hold the round's total beyond what earlier rounds owe |
| 6044 | `BadProof` | Invalid proof, index or amount |
| 6045 | `AlreadyPaid` | The leaf was already paid |
| 6046 | `RoundClosed` | The round expired |
| 6047 | `FlywheelLimit` | Token under a day old, order above 10% of the vault, or within 6 hours of the last |
| 6048 | `FlywheelWouldComplete` | A flywheel order may not complete a curve |

## Tests

- `contracts/solana/host-tests/tests/v2_ledger.rs`: the split, the fee schedule, tickers, the ledger round trip, and
  property tests that shares never exceed the total, are paid once, and that the vault always covers the reserve, the
  locked surplus and every unpaid share.
- Host tests also check the calendar-month schedule against EVM, date round trips, and that proofs bind every field.
- `tests/solana.test.mjs` (V2 tests at the end, against `solana-test-validator`): pair creation rules, the legacy
  launch refusing V2 pairs, fee range, first-buy cap and ticker checks, the anti-snipe surplus going to liquidity, the
  five-way withdrawal (once), graduation, migration, withdrawal after migration, five-way harvests on PumpSwap and
  Raydium, and reward rounds (operator only, ended rounds only, funded only, each leaf once, wrong amounts refused, expiry,
  native SOL payouts) and the flywheel's guards. The flywheel's buy-and-burn itself needs a token a day old, which a local
  validator cannot reach; it is exercised on devnet before mainnet.
