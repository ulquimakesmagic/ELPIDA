# Elpida Solana program

Anchor program `elpida_launchpad` (program ID `ANkA5pytoVkiKQbjzd5NdPWKgmwfsihNJvSfg3vtKLNz`), model 3: a virtual-reserve bonding curve, one config per trading pair (SOL, USDC or another approved token), that graduates into a PumpSwap pool. Test prototype, **not audited**.

## Trading pairs

Every chain offers the same four pair kinds (`packages/core/pairs.mjs`): native coin, USDC, xStock and paired token. On Solana each pair is a `CurveConfig` for its quote mint, with its own curve and creation fee in that asset.

- **SOL:** the wrapped-SOL mint. The client wraps exactly what an instruction spends and closes the wrapped account in the same transaction, so people pay and receive plain SOL.
- **USDC:** Circle USDC (Elpida tUSDC on test networks).
- **Paired token:** any approved classic SPL or Token-2022 mint (TEST-MEME on test networks).
- **xStock: not available.** xStocks are Token-2022 mints with an issuer **permanent delegate**, and PumpSwap refuses permanent-delegate quote mints (`UnsupportedQuoteMint`, verified against the real program), so such a curve could never graduate. `add_curve_config` therefore rejects them, together with transfer-fee, non-transferable, frozen-by-default and active-transfer-hook mints (error 6021). Adding xStocks needs a second graduation venue: Meteora DAMM v2 accepts the badged xStock mints.

On test networks the SOL pair is test sized (0.5 → 5 SOL FDV, 0.01 SOL creation fee) so a curve can be completed with faucet SOL; mainnet configs would be priced at $5k → $50k. `npm run solana:deploy` creates the SOL and TEST-MEME configs and records every pair in `local-data/solana-<cluster>.json`, which the web app reads.

## Lifecycle

1. **Curve.** Each token starts at a $5k FDV. It completes at $50k FDV, once 759.7M of the fixed 1B supply has sold.
   - The fee is 1.25%, split 50/50 between protocol and creator.
   - During the first 60 s, an anti-snipe fee decays from 90% to the base fee. The surplus above the base fee is locked as liquidity.
   - The creator's first buy pays only the base fee.
2. **Completion.** The buy that empties the curve is filled only up to the remaining supply. Trading then stops (`status = 1`).
3. **Migration.** Anyone can call `migrate_to_pumpswap`. It moves the remaining 240.3M tokens and all raised quote into a new PumpSwap pool (`status = 2`).
   - The quote moved includes the curve reserve and the anti-snipe bonus.
   - The pool opens at the final curve price, raised slightly by the bonus.
   - The pool is created by the data-less PDA `["pump-lp", mint]`, which keeps the LP tokens forever. Only PumpSwap's 100-unit minimum stays in the pool unowned.
4. **LP fees.** PumpSwap charges pools it did not create itself 0.25% to LPs and 0.05% to pump. It pays no coin-creator fee on these pools.
   - Anyone can call `harvest_lp_fees`. It withdraws only the LP tokens that represent fee growth, and splits the base and quote 50/50 between the treasury and the creator reward wallet.
   - Fee growth is measured in liquidity units (`lp / lp_supply × √(base × quote)`). The position never drops below its migrated units, and the program checks this after every harvest.
   - A harvest must be at least 0.01% of the locked LP.

## Instructions

| Instruction | Who | What it does |
| --- | --- | --- |
| `initialize_curve(params)` | Program upgrade authority, once | Quote mint (6–9 decimals), treasury, curve and fee parameters, including the creation fee in quote base units |
| `launch(name, symbol, first_buy, min_tokens_out, reward)` | Creator | Atomically does four things: charges the pair's creation fee to the treasury, mints a fixed 1B supply (6 decimals) to the curve, revokes mint authority (no freeze authority) and makes the mandatory first buy |
| `buy(gross_in, min_tokens_out)` / `sell(tokens_in, min_quote_out)` | Anyone | Curve trades at the current fee (anti-snipe schedule, then 1.25%) |
| `withdraw_fees` | Anyone | Pays accrued curve fees 50/50 to the treasury and the creator reward wallet; works before and after migration |
| `migrate_to_pumpswap` | Anyone, once the curve is complete | Creates the PumpSwap pool. The caller advances 0.05 SOL; about 0.017 SOL is used for rent and the rest is refunded in the same transaction |
| `add_curve_config(params)` | Program upgrade authority | A trading pair: an extra config for another quote mint (classic SPL or Token-2022) at `["curve-config", quote_mint]`; unsupported token extensions are rejected; pools always trade through the config they launched with |
| `create_test_usdc` / `test_usdc_faucet(amount)` | Upgrade authority / anyone | **Test networks only.** Elpida tUSDC, a valueless 6-decimal mint at `["test-usdc"]` that only the faucet can mint. The same faucet mints any test asset whose mint authority is its PDA (TEST-MEME), up to 10,000,000 whole units per call. It exists so curves can be completed and migrated on devnet. Never create it on mainnet |
| `harvest_lp_fees` | Anyone, after migration | Withdraws LP fee growth and splits it 50/50; destination token accounts must exist (the client adds idempotent creation) |

**Accounts:**
- `curve-config` PDA `["curve-config"]`.
- One `CurvePool` PDA `["curve", mint]` per token. Its associated token accounts hold the unsold supply and the quote.
- One `PumpMigration` PDA `["pump-migration", mint]` per migrated token. It records the PumpSwap pool, the locked LP and the principal.

There is no admin, rescue or reserve withdrawal. Error codes 6000+ are listed in `packages/solana/client.mjs`.

**PumpSwap.** PumpSwap is at `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` on mainnet and devnet. Pools use index 0 and are derived from `["pool", 0u16, lp_authority, mint, quote_mint]`, so nobody else can create them first. The CPI layouts follow pump's public IDL (`create_pool` with 9 args, `withdraw`).

## Build

The compiled program ships in `build/elpida_launchpad.so`, so deploying needs no Rust. To rebuild (Linux, macOS or WSL) with the Solana CLI 2.3.x:

```bash
cd contracts/solana
cargo-build-sbf --manifest-path programs/elpida_launchpad/Cargo.toml --sbf-out-dir build
rm -f build/elpida_launchpad-keypair.json   # the real program keypair lives in keys/
```

`Cargo.lock` pins dependencies compatible with the Solana toolchain's Rust 1.84 (for example `blake3` 1.5.5). The program ID is fixed by `declare_id!` and `keys/elpida_launchpad-keypair.json` (private, git-ignored).

## Deploy and test

- `npm run solana:deploy` deploys to Solana Devnet. It initializes the default curve with Circle devnet USDC, plus an Elpida tUSDC curve config (skip it with `--no-test-usdc`; see `docs/LOCALHOST_AND_TESTNET.md`). The web app launches new Solana tokens in tUSDC whenever that config exists, and its faucet button mints 25,000 tUSDC.
- `npm run solana:deploy -- --upgrade` (or double-click `solana-upgrade.cmd` in the ELPIDA folder) upgrades the deployed program to `build/elpida_launchpad.so`. Uploads resume if interrupted, and stale buffers from older builds are closed first.
- `npm run test:solana` runs the program against a throwaway `solana-test-validator`. The migration tests load the real PumpSwap program and its GlobalConfig from `fixtures/`. Refresh those with `solana-pumpswap-fixtures.cmd` or `node scripts/solana-pumpswap-fixtures.mjs`.

## Events

- `CurveLaunched`, `CurveBought` and `CurveSold` carry post-trade state:
  - `real_quote`;
  - `virtual_quote` (virtual + real);
  - `token_reserve` (virtual);
  - `sold`.

  Price is `virtual_quote ÷ token_reserve`.
- `CurveGraduated` marks completion.
- `CurveMigrated` records the PumpSwap pool and the locked LP.
- `LpFeesHarvested` records each harvest.

`decodeEvents` in `packages/solana/client.mjs` reads all of them. It also reads events from the first deployed version, which decode with `legacy: true`.

Not yet implemented:
- Metaplex token metadata.
- The branded vanity mint suffix. Base58 excludes 0, O, I and l; never log or persist mint secret keys.
- In-app PumpSwap trading after migration. Migrated tokens trade on PumpSwap or through aggregators.
