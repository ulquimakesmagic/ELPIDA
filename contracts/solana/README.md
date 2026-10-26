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
4. **Escape hatch (D7).** If a completed curve has not migrated 24 hours after it completed (for example because PumpSwap changed or refused the pool), anyone can call `reopen_curve`. Trading resumes with the reserves unchanged, so holders can sell; completing the curve again restarts the grace period. The locked anti-snipe bonus stays in the vault for the eventual migration.
5. **Early-partner tiers** (`docs/DESIGN_PARTNER_TIERS.md`). The SOL pair's treasury registers a creator wallet with `set_partner`: 10% (Partner) or 20% (Elite) and an expiry at most 180 days ahead, or (0, 0) to end it.
   - A pool launched by that wallet before the expiry fixes the share at launch, in bytes appended after the pool's fixed layout (pools are 292 bytes from this version; older 260-byte pools read as standard). Changing or ending a tier never affects a launched pool.
   - On every trade the creator still gets the larger half of the base fee. The share comes out of the protocol half and buys tokens from the curve at its current price, with no fee, in the same instruction; those tokens are burned (SPL burn, so the supply falls). The quote joins the real reserve.
   - A buyback never completes the curve: if it would reach the curve supply, buys nothing, or follows the completing buy, its quote is locked as liquidity bonus instead.
   - After migration, `harvest_lp_fees` burns the share of the token side at once and keeps the share of the quote side with the LP authority, recorded as `pending_buyback` in the migration record. Spending it on a capped PumpSwap buyback is the next program step; until then it stays there, accounted for.
6. **LP fees.** PumpSwap charges pools it did not create itself 0.25% to LPs and 0.05% to pump. It pays no coin-creator fee on these pools.
   - Anyone can call `harvest_lp_fees`. It withdraws only the LP tokens that represent fee growth, and splits the base and quote 50/50 between the treasury and the creator reward wallet.
   - Fee growth is measured in liquidity units (`lp / lp_supply × √(base × quote)`). The position never drops below its migrated units, and the program checks this after every harvest.
   - A harvest must be at least 0.01% of the locked LP.

## Instructions

| Instruction | Who | What it does |
| --- | --- | --- |
| `initialize_curve(params)` | Program upgrade authority, once | Legacy default config at `["curve-config"]`; deployments now use `add_curve_config` for every pair |
| `launch(name, symbol, first_buy, min_tokens_out, reward, max_fee, fee_in_usdc, uri)` | Creator | Atomically: charges the creation fee to the treasury, mints a fixed 1B supply (6 decimals) to the curve, writes **immutable Metaplex metadata** (name, symbol, `ipfs://` URI, `is_mutable = false`, curve PDA as update authority), revokes mint authority (no freeze authority) and makes the mandatory first buy. An invalid URI reverts everything (6030) |
| `reopen_curve` | Anyone, 24 h after completion without migration | D7 escape hatch: sets a completed, unmigrated curve back to trading; reserves, bonus and owed fees unchanged; emits `CurveReopened`. Earlier: 6031 `GraceNotOver` |
| `buy(gross_in, min_tokens_out)` / `sell(tokens_in, min_quote_out)` | Anyone | Curve trades at the current fee (anti-snipe schedule, then 1.25%) |
| `withdraw_fees` | Anyone | Pays accrued curve fees 50/50 to the treasury and the creator reward wallet; works before and after migration |
| `migrate_to_pumpswap` | Anyone, once the curve is complete | Creates the PumpSwap pool. The caller advances 0.05 SOL; about 0.017 SOL is used for rent and the rest is refunded in the same transaction |
| `update_curve_config(params)` | Program upgrade authority | Reprices an existing config for future launches: curve sizing, creation fee and creator-buy cap. The fee schedule must stay the same (6024 `FeeScheduleFixed`), because live pools read it. Emits `CurveConfigUpdated` |
| `add_curve_config(params)` | Program upgrade authority | A trading pair: an extra config for another quote mint (classic SPL or Token-2022) at `["curve-config", quote_mint]`; unsupported token extensions are rejected; pools always trade through the config they launched with |
| `test_usdc_faucet(amount)` | Anyone | **Test networks only.** Mints any test asset whose mint authority is the faucet PDA (TEST-MEME), up to 10,000,000 whole units per call, so paired curves can be completed on devnet. (`create_test_usdc` remains in the program but deployments no longer create tUSDC.) |
| `set_beta_gate(authority, enabled)` | Program upgrade authority | Mainnet beta: while enabled, only allowlisted creators can launch. Trading is never gated. `authority` is the beta admin who manages the allowlist |
| `allow_beta_creator(creator)` / `revoke_beta_creator` | Beta admin | Adds or removes a creator (PDA `["beta-creator", creator]`) |
| `test_build_check` | Anyone | Succeeds only on the test build; lets scripts confirm a cluster runs the mainnet build |
| `harvest_lp_fees` | Anyone, after migration | Withdraws LP fee growth and splits it 50/50; destination token accounts must exist (the client adds idempotent creation). Partner pools: the share of the token side is burned (the mint must be passed writable) and the share of the quote side is queued |
| `set_partner(creator, buyback_bps, expires_at)` | Treasury of the SOL pair (`["curve-config", wSOL]`) | Early-partner tier for a creator wallet at PDA `["partner", creator]`: 1000 or 2000 with an expiry at most 180 days ahead, or (0, 0) to end it. Future launches only. Error 6032 `PartnerTerms`. `npm run solana:partner` sends it from the deploy key |
| `partner_tiers_version` | Anyone | Empty; lets clients detect this version (launch takes the creator's `partner` account in place of the rent sysvar, trades pass the mint writable) |

**Transaction size.** A launch is one legacy transaction, capped by Solana at 1,232 bytes. From the partner-tier version the launch passes the creator's `partner` record where it used to pass the rent sysvar (optional for Metaplex's `CreateMetadataAccountV3`), so the size is unchanged. The client sends only bare `ipfs://<CIDv1>` links (66 characters, `MAX_LAUNCH_URI`); the largest supported launch, a SOL pair paying the fee in SPL-Token USDC with a 32-byte name, is 1,227 bytes. A Token-2022 USDC fee on a SOL pair would be 1,259 bytes, so the wallet refuses it before signing and suggests paying in SOL; it needs a v0 transaction with a lookup table if such a USDC mint is ever configured. Mainnet and devnet USDC are SPL-Token mints.

**Accounts:**
- One `CurveConfig` PDA `["curve-config", quote_mint]` per pair (the SOL pair uses the wrapped-SOL mint).
- One `CurvePool` PDA `["curve", mint]` per token. Its associated token accounts hold the unsold supply and the quote.
- One `PumpMigration` PDA `["pump-migration", mint]` per migrated token. It records the PumpSwap pool, the locked LP and the principal (and, from this version, 48 appended bytes: the quote queued for buyback and the partner burns).
- One `PartnerConfig` PDA `["partner", creator]` per registered creator wallet: the share, the expiry and the bump.

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

Release builds (26 October 2026, early-partner tiers; Agave / Solana CLI **2.3.13**, platform-tools v1.48), each reproduced byte for byte from a clean `target`:

| File | Build | sha256 |
|---|---|---|
| `build/elpida_launchpad.so` | `--features testnet` (devnet, localnet) | `331765ca50908c188126cd167ec7b3a1f93c5c0dd046bc22dc0cf041c0471b4e` |
| `build/elpida_launchpad-mainnet.so` | mainnet (test instructions refused) | `f469dde710b5d1d6c303cf88af3cdbe4735b8e17471948f1b0325ca7ea5bca1e` |

The previous devnet build (`319e2ffe…`, before metadata and reopen) is kept as `fixtures/elpida_launchpad-pre-metadata.so` for the compatibility test. Browsers detect which build a cluster runs (`client.supportsMetadata`, a simulated `reopen_curve`) and use the earlier launch layout until the program is upgraded.

## Deploy and test

- `npm run solana:deploy` deploys to Solana Devnet and creates or reprices the SOL pair from `config/native-pricing.json`, plus the TEST-MEME pair (skip it with `--no-test-pairs`).
- `node scripts/native-pricing.mjs --chain solana-devnet --yes` reprices the pairs after editing the pricing file (`--export` prints the instructions for a multisig).
- `npm run solana:deploy -- --upgrade` (or double-click `solana-upgrade.cmd` in the ELPIDA folder) upgrades the deployed program to `build/elpida_launchpad.so`. Uploads resume if interrupted, and stale buffers from older builds are closed first.
- `npm run test:solana` runs the program against a throwaway `solana-test-validator`. Without the private program keypair the validator preloads the build at the program ID as an upgradeable program, so the suite runs anywhere the Solana CLI is installed. It also loads, from `fixtures/`:
  - the real PumpSwap program and its GlobalConfig (refresh with `solana-pumpswap-fixtures.cmd` or `node scripts/solana-pumpswap-fixtures.mjs`);
  - Metaplex Token Metadata, built from its mainnet source tag (see `fixtures/SOURCE.txt`).
- `npm run test:solana-host` runs `host-tests/`, a separate Cargo workspace: the 24 h reopen in LiteSVM (the clock moves) and property tests of the curve math (`PROPTEST_CASES=200000` for a deeper run): solvency through any trade sequence, k never decreasing, price direction, rounding in the pool's favour, round trips never profitable, the exact final fill (overcharge at most `floor(10000/(10000-fee))+1` base units, kept by the pool), fee split, the anti-snipe schedule, LP harvests never touching the principal, oracle rounding and `isqrt`.

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
- `CurveReopened` records a D7 reopen (graduated and reopened times, reserve and bonus).

`decodeEvents` in `packages/solana/client.mjs` reads all of them. It also reads events from the first deployed version, which decode with `legacy: true`.

## Vanity mint addresses (D9)

The mint is a fresh signer keypair, so the program needs nothing for vanity addresses. The server (`apps/api/vanity-mints.mjs`) keeps a small pool of keypairs whose address ends in `hope`, ground in a worker thread (about 9 minutes per key per core) and sealed with AES-256-GCM under `ELPIDA_VANITY_KEY`. A launch reserves one key for one wallet; the key leaves the pool at once, the server co-signs only an Elpida `launch` by that wallet with that mint, and the secret is destroyed after that one signature or on expiry. Without the key, with an empty pool or over the rate limit, launches use a random mint and say so. Secret keys are never logged or stored in plaintext.
- In-app PumpSwap trading after migration. Migrated tokens trade on PumpSwap or through aggregators.
