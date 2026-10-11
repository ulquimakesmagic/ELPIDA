# Elpida Solana program

Anchor program `elpida_launchpad` (program ID `ANkA5pytoVkiKQbjzd5NdPWKgmwfsihNJvSfg3vtKLNz`), model 3: a virtual-reserve bonding curve, one config per trading pair (SOL or another approved token), that graduates into a PumpSwap pool. Pricing is native: every launch pays its creation fee in SOL (see `docs/NATIVE_PRICING.md`). Test prototype, **not audited**.

## Trading pairs

Every chain offers the same three pair kinds (`packages/core/pairs.mjs`): native coin, xStock and paired token. On Solana each pair is a `CurveConfig` for its quote mint, with its own curve in that asset and a creation fee in lamports (SOL).

- **SOL:** the wrapped-SOL mint. The client wraps exactly what an instruction spends and closes the wrapped account in the same transaction, so people pay and receive plain SOL.
- **Paired token:** any approved classic SPL or Token-2022 mint (TEST-MEME on test networks).
- **xStock: not available.** xStocks are Token-2022 mints with an issuer **permanent delegate**, and PumpSwap refuses permanent-delegate quote mints (`UnsupportedQuoteMint`, verified against the real program), so such a curve could never graduate. `add_curve_config` therefore rejects them, together with transfer-fee, non-transferable, frozen-by-default and active-transfer-hook mints (error 6021). Adding xStocks needs a second graduation venue: Meteora DAMM v2 accepts the badged xStock mints.

The SOL pair's fee and curve come from `config/native-pricing.json`. On test networks it is test sized (0.5 → 5 SOL FDV, 0.01 SOL creation fee) so a curve can be completed with faucet SOL. `npm run solana:deploy` creates or reprices the SOL pair (and TEST-MEME on test networks) and records every pair in `local-data/solana-<cluster>.json` and `deployments/solana-<cluster>.json`, which the web app reads.

## Lifecycle

1. **Curve.** Each token starts at the pair's starting FDV and completes at 10× that by default (`startFdv` → `endFdv` in the pricing file), once the curve supply has sold (759.7M of the fixed 1B supply for a 10× curve).
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
| `initialize_curve(params)` | Program upgrade authority, once | Legacy default config at `["curve-config"]`; deployments now use `add_curve_config` for every pair |
| `launch(name, symbol, first_buy, min_tokens_out, reward)` | Creator | Atomically does four things: transfers the creation fee in SOL (lamports) to the treasury wallet, mints a fixed 1B supply (6 decimals) to the curve, revokes mint authority (no freeze authority) and makes the mandatory first buy |
| `buy(gross_in, min_tokens_out)` / `sell(tokens_in, min_quote_out)` | Anyone | Curve trades at the current fee (anti-snipe schedule, then 1.25%) |
| `withdraw_fees` | Anyone | Pays accrued curve fees 50/50 to the treasury and the creator reward wallet; works before and after migration |
| `migrate_to_pumpswap` | Anyone, once the curve is complete | Creates the PumpSwap pool. The caller advances 0.05 SOL; about 0.017 SOL is used for rent and the rest is refunded in the same transaction |
| `update_curve_config(params)` | Program upgrade authority | Reprices an existing config for future launches: curve sizing, creation fee and creator-buy cap. The fee schedule must stay the same (6024 `FeeScheduleFixed`), because live pools read it. Emits `CurveConfigUpdated` |
| `add_curve_config(params)` | Program upgrade authority | A trading pair: an extra config for another quote mint (classic SPL or Token-2022) at `["curve-config", quote_mint]`; unsupported token extensions are rejected; pools always trade through the config they launched with |
| `test_usdc_faucet(amount)` | Anyone | **Test networks only.** Mints any test asset whose mint authority is the faucet PDA (TEST-MEME), up to 10,000,000 whole units per call, so paired curves can be completed on devnet. (`create_test_usdc` remains in the program but deployments no longer create tUSDC.) |
| `set_beta_gate(authority, enabled)` | Program upgrade authority | Mainnet beta: while enabled, only allowlisted creators can launch. Trading is never gated. `authority` is the beta admin who manages the allowlist |
| `allow_beta_creator(creator)` / `revoke_beta_creator` | Beta admin | Adds or removes a creator (PDA `["beta-creator", creator]`) |
| `test_build_check` | Anyone | Succeeds only on the test build; lets scripts confirm a cluster runs the mainnet build |
| `harvest_lp_fees` | Anyone, after migration | Withdraws LP fee growth and splits it 50/50; destination token accounts must exist (the client adds idempotent creation) |

**Accounts:**
- One `CurveConfig` PDA `["curve-config", quote_mint]` per pair (the SOL pair uses the wrapped-SOL mint).
- One `CurvePool` PDA `["curve", mint]` per token. Its associated token accounts hold the unsold supply and the quote.
- One `PumpMigration` PDA `["pump-migration", mint]` per migrated token. It records the PumpSwap pool, the locked LP and the principal.

There is no admin, rescue or reserve withdrawal. Error codes 6000+ are listed in `packages/solana/client.mjs`.

**PumpSwap.** PumpSwap is at `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` on mainnet and devnet. Pools use index 0 and are derived from `["pool", 0u16, lp_authority, mint, quote_mint]`, so nobody else can create them first. The CPI layouts follow pump's public IDL (`create_pool` with 9 args, `withdraw`).

## Build

Two builds ship in `build/`, so deploying needs no Rust:

- `elpida_launchpad.so`, the **test build** (`--features testnet`). It is used for devnet and localnet, and its test-asset faucet works.
- `elpida_launchpad-mainnet.so`, the **mainnet build**. Test-only instructions fail with `TestNetworksOnly` (6022), so it can never mint test assets. The mainnet deploy script confirms this on-chain (`test_build_check`) before configuring anything.

To rebuild (Linux, macOS or WSL) with the Solana CLI 2.3.x:

```bash
cd contracts/solana
cargo-build-sbf --manifest-path programs/elpida_launchpad/Cargo.toml --features testnet --sbf-out-dir /tmp/sbf-test
cp /tmp/sbf-test/elpida_launchpad.so build/elpida_launchpad.so
cargo-build-sbf --manifest-path programs/elpida_launchpad/Cargo.toml --sbf-out-dir /tmp/sbf-main
cp /tmp/sbf-main/elpida_launchpad.so build/elpida_launchpad-mainnet.so
```

`Cargo.lock` pins dependencies compatible with the Solana toolchain's Rust 1.84 (for example `blake3` 1.5.5). The program ID is fixed by `declare_id!` and `keys/elpida_launchpad-keypair.json` (private, git-ignored).

## Deploy and test

- `npm run solana:deploy` deploys to Solana Devnet and creates or reprices the SOL pair from `config/native-pricing.json`, plus the TEST-MEME pair (skip it with `--no-test-pairs`).
- `node scripts/native-pricing.mjs --chain solana-devnet --yes` reprices the pairs after editing the pricing file (`--export` prints the instructions for a multisig).
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
