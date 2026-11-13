//! Elpida launchpad for Solana, model 3: virtual-reserve bonding curve. NOT AUDITED.
//!
//! - Trading pairs: one `CurveConfig` per quote mint (wrapped SOL for native SOL, USDC, an xStock or
//!   another approved token), each with its own curve parameters. The creation fee is always charged
//!   in SOL (lamports) to the treasury wallet, whatever the pair, and the upgrade authority can reprice
//!   a config for future launches with `update_curve_config` (existing pools keep their own values).
//!   Quote mints may be classic SPL or Token-2022. Mints with transfer fees, an active transfer hook,
//!   non-transferability, frozen-by-default accounts or a permanent delegate are rejected at config
//!   time: PumpSwap will not create a pool for permanent-delegate quotes (which includes xStocks), so
//!   such a curve could never graduate.
//!
//! - `launch` atomically charges the creation fee, mints a fixed 1B supply into the pool vault
//!   (mint authority revoked in the same instruction, no freeze authority) and executes the creator's
//!   mandatory first buy at the base fee.
//! - Price follows a constant-product curve over virtual reserves:
//!   price = (virtual_quote + real_quote) / (virtual_token - sold). Parameters live in `CurveConfig`
//!   (default: $5k starting FDV, graduation at $50k FDV once `curve_supply` tokens are sold).
//! - Anti-sniping: during the first `snipe_window_secs` the fee decays linearly from
//!   `snipe_start_bps` to `base_fee_bps`, on buys and sells. The base fee splits 50/50 protocol /
//!   creator; anything above it goes to `liquidity_bonus`, which stays locked and joins the DEX pool
//!   at migration.
//! - Liquidity is never withdrawable: no instruction moves `real_quote` or `liquidity_bonus` out of
//!   the vault except `migrate_to_pumpswap`. Once the curve completes, anyone can migrate it: the
//!   remaining supply plus all raised quote seed a PumpSwap pool whose LP tokens are held forever by
//!   a program PDA. `harvest_lp_fees` withdraws only the LP growth earned from trading fees (the
//!   pool's liquidity never falls below the migrated amount) and splits it 50/50 protocol / creator.
//!   Only accrued fees can be paid out, to fixed destinations.
//! - Escape hatch (D7): if a completed curve has not migrated `GRADUATION_GRACE_SECS` (24 h) after it
//!   completed (for example because PumpSwap changed or refused the pool), anyone can `reopen_curve`, and
//!   trading resumes with unchanged reserves. The locked anti-snipe bonus stays for the eventual migration.
//! - Token metadata (D11): `launch` creates Metaplex metadata (name, symbol, IPFS URI) in the same
//!   transaction with `is_mutable = false` and the curve PDA as update authority, so nobody can change it.
//! - Early-partner tiers (docs/DESIGN_PARTNER_TIERS.md): the SOL pair's treasury registers a creator wallet with
//!   a 10% (Partner) or 20% (Elite) share and an expiry (`set_partner`). A pool launched by that wallet before the
//!   expiry fixes the share at launch. On every trade the creator still gets half of the base fee; the share comes
//!   out of the protocol half and buys tokens from the curve at its current price in the same instruction, and
//!   those tokens are burned. After migration, the share of each LP-fee harvest is burned (token side) or queued
//!   for buyback (quote side). Tier changes never affect pools already launched.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::keccak::hashv;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::pubkey;
use anchor_lang::system_program;
use anchor_spl::associated_token::{get_associated_token_address_with_program_id, AssociatedToken};
use anchor_spl::token_2022::Token2022;
use anchor_spl::token::spl_token::instruction::AuthorityType;
use anchor_spl::token::{self, Burn, Mint, MintTo, SetAuthority, Token, TokenAccount, Transfer};
use anchor_spl::token_interface::{self as ti, Mint as QuoteMint, TokenAccount as QuoteAccount, TokenInterface};

declare_id!("ANkA5pytoVkiKQbjzd5NdPWKgmwfsihNJvSfg3vtKLNz");

pub const BPS: u128 = 10_000;
pub const TOKEN_DECIMALS: u8 = 6;
pub const TOKEN_SUPPLY: u64 = 1_000_000_000 * 1_000_000;
pub const MODEL_VERSION: u8 = 3;
pub const MAX_NAME: usize = 32;
pub const MAX_SYMBOL: usize = 10;
pub const STATUS_TRADING: u8 = 0;
pub const STATUS_GRADUATED: u8 = 1; // curve complete, waiting for migration
pub const STATUS_MIGRATED: u8 = 2;
/// Curve complete for an issuer-controlled quote (Ondo's tokenized stocks): no outside pool accepts the mint, so
/// trading continues in a constant-product pool inside this program. Its reserves are the vaults themselves
/// (`real_quote` and `TOKEN_SUPPLY - sold`); nothing can withdraw them, so the liquidity is locked forever.
pub const STATUS_LOCKED: u8 = 3;

pub const PUMP_AMM: Pubkey = pubkey!("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
pub const PUMP_GLOBAL_CONFIG: Pubkey = pubkey!("ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw");
pub const PUMP_EVENT_AUTHORITY: Pubkey = pubkey!("GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR");
const PUMP_CREATE_POOL: [u8; 8] = [233, 146, 209, 142, 207, 104, 64, 188];
const PUMP_WITHDRAW: [u8; 8] = [183, 18, 70, 156, 148, 109, 161, 34];
/// SOL lent to the LP-authority PDA so it can pay PumpSwap's account rent; the rest is refunded.
pub const MIGRATION_RENT_LAMPORTS: u64 = 50_000_000;

// Raydium CPMM (constant product, no OpenBook). SOL pairs graduate here; other pairs keep PumpSwap. The test build
// (devnet, localnet) points at Raydium's devnet deployment, the mainnet build at mainnet. Both use the 1% fee tier.
#[cfg(feature = "testnet")]
pub mod raydium {
    use super::*;
    pub const PROGRAM: Pubkey = pubkey!("DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb");
    /// AmmConfig index 3: 1% trade fee, 0.15 SOL pool-creation fee.
    pub const AMM_CONFIG: Pubkey = pubkey!("EsTevfacYXpuho5VBuzBjDZi8dtWidGnXoSYAr8krTvz");
    pub const CREATE_POOL_FEE: Pubkey = pubkey!("3oE58BKVt8KuYkGxx8zBojugnymWmBiyafWgMrnb6eYy");
    /// PDA ["vault_and_lp_mint_auth_seed"] of the program.
    pub const AUTHORITY: Pubkey = pubkey!("CXniRufdq5xL8t8jZAPxsPZDpuudwuJSPWnbcD5Y5Nxq");
}
#[cfg(not(feature = "testnet"))]
pub mod raydium {
    use super::*;
    pub const PROGRAM: Pubkey = pubkey!("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
    /// AmmConfig index 1: 1% trade fee, 0.15 SOL pool-creation fee.
    pub const AMM_CONFIG: Pubkey = pubkey!("G95xxie3XbkCqtE39GgQ9Ggc7xBC8Uceve7HFDEFApkc");
    pub const CREATE_POOL_FEE: Pubkey = pubkey!("DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8");
    pub const AUTHORITY: Pubkey = pubkey!("GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL");
}
pub const MEMO_PROGRAM: Pubkey = pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const RAY_INITIALIZE: [u8; 8] = [175, 175, 109, 31, 13, 152, 155, 237];
const RAY_WITHDRAW: [u8; 8] = [183, 18, 70, 156, 148, 109, 161, 34];
const RAY_SWAP_BASE_INPUT: [u8; 8] = [143, 190, 90, 218, 196, 30, 51, 222];
const RAY_AMM_CONFIG_DISC: [u8; 8] = [218, 244, 33, 104, 203, 203, 43, 111];
const RAY_POOL_DISC: [u8; 8] = [247, 237, 227, 245, 215, 195, 222, 70];
/// The 1% tier, in Raydium's millionths.
pub const RAYDIUM_TRADE_FEE_RATE: u64 = 10_000;
/// Account sizes Raydium's `initialize` pays rent for: PoolState, ObservationState, the LP mint, and three token
/// accounts (two vaults, the creator's LP account). Their rent plus the pool-creation fee is paid from the raised SOL.
pub const RAY_POOL_LEN: usize = 637;
pub const RAY_OBSERVATION_LEN: usize = 4075;
const RAY_MINT_LEN: usize = 82;
const RAY_TOKEN_ACCOUNT_LEN: usize = 165;
// Raydium `PoolState` offsets (zero-copy, packed; 8-byte discriminator included).
const RAY_POOL_VAULT_0: usize = 72;
const RAY_POOL_VAULT_1: usize = 104;
const RAY_POOL_MINT_0: usize = 168;
const RAY_POOL_LP_SUPPLY: usize = 333;
const RAY_POOL_PROTOCOL_FEES_0: usize = 341;
const RAY_POOL_FUND_FEES_0: usize = 357;
const RAY_POOL_CREATOR_FEES_0: usize = 397;
/// A partner buyback spends at most this fraction of the pool's SOL depth per call (1 / 200 = 0.5%), which moves the
/// price by about 1%, inside the band below.
pub const BUYBACK_DEPTH_DIVISOR: u64 = 200;
/// Sandwich guard for `raydium_buyback` (review finding S-1): at most one buyback every BUYBACK_SLOT_GAP slots (about a
/// minute), so a front-run, many buybacks and a back-run cannot share a transaction or a bundle. One buyback of at most
/// 0.5% of depth moves the price about 1%, less than the 2% of fees an attacker pays to buy in front and sell after.
pub const BUYBACK_SLOT_GAP: u64 = 150;
/// Migration venues, stored in the migration record's extension.
pub const VENUE_PUMPSWAP: u8 = 0;
pub const VENUE_RAYDIUM: u8 = 1;
/// Pyth Solana Receiver: owner of verified `PriceUpdateV2` accounts (same ID on mainnet and devnet).
pub const PYTH_RECEIVER: Pubkey = pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
/// sha256("account:PriceUpdateV2")[0..8]
const PRICE_UPDATE_V2: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];
pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
/// Metaplex Token Metadata (same ID on mainnet and devnet).
pub const MPL_TOKEN_METADATA: Pubkey = pubkey!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
/// Metaplex `CreateMetadataAccountV3` instruction index.
const MPL_CREATE_METADATA_V3: u8 = 33;
/// Metaplex limit for the metadata URI.
pub const MAX_URI: usize = 200;
/// D7: a completed curve that has not migrated this long after completion can be reopened for trading.
pub const GRADUATION_GRACE_SECS: i64 = 86_400;
pub const USD_DECIMALS: u32 = 6;
/// Largest single test-faucet mint, in whole units of the test asset (10,000,000).
pub const TEST_FAUCET_MAX_WHOLE: u64 = 10_000_000;
/// Early-partner burn shares of the base fee: Partner 10%, Elite 20%.
pub const PARTNER_BPS: [u16; 2] = [1_000, 2_000];
/// Furthest expiry the treasury can give a partner tier.
pub const MAX_PARTNER_WINDOW_SECS: i64 = 180 * 86_400;
/// Bytes appended after `CurvePool`'s fixed layout in pools launched by this version (older pools have none and
/// read as standard): version u8, buyback_bps u16, tokens burned u64, quote spent u64; the rest is reserved.
pub const POOL_EXT_LEN: usize = 32;
/// Bytes appended after `PumpMigration` in migrations made by this version: version u8, quote queued for buyback
/// u64, base burned u64, quote spent on buybacks u64, base bought back and burned u64, venue u8 (0 PumpSwap,
/// 1 Raydium CPMM); the rest is reserved.
pub const MIGRATION_EXT_LEN: usize = 48;
const EXT_VERSION: u8 = 1;

// ---------- ELPIDA V2 (docs/V2_0_SOLANA.md) ----------
/// `CurveConfig.model_version` of V2 configs (PDA ["curve-config-v2", quote_mint]). In a V2 config `base_fee_bps` is
/// the minimum fee a creator may choose; each pool fixes its own fee at launch.
pub const V2_MODEL_VERSION: u8 = 4;
pub const V2_MAX_FEE_BPS: u16 = 400;
/// The mainnet minimum fee Malik approved (1.00%); test builds accept any minimum from 0.01% up to the default.
pub const V2_MAINNET_MIN_FEE_BPS: u16 = 100;
pub const V2_DEFAULT_FEE_BPS: u16 = 125;
pub const V2_FIRST_BUY_CAP_BPS: u16 = 300;
pub const V2_SNIPE_START_BPS: u16 = 9_000;
pub const V2_SNIPE_WINDOW_SECS: u32 = 60;
/// The five-way split of every fee at the token's own rate, in the EVM hook's order: creator, trader airdrop,
/// flywheel, holder rewards, treasury.
pub const V2_SPLIT: [u16; 5] = [3_000, 3_000, 1_000, 1_000, 2_000];
pub const V2_CREATOR: usize = 0;
pub const V2_AIRDROP: usize = 1;
pub const V2_FLYWHEEL: usize = 2;
pub const V2_HOLDER: usize = 3;
pub const V2_TREASURY: usize = 4;
/// Seeds of the three reward vaults (PDAs ["v2-vault", kind]); each holds one associated account per asset.
pub const V2_VAULT_AIRDROP: &[u8] = b"airdrop";
pub const V2_VAULT_FLYWHEEL: &[u8] = b"flywheel";
pub const V2_VAULT_HOLDER: &[u8] = b"holder";
/// Bytes appended after the pool extension in V2 pools: version u8, fee_bps u16, accrued u64, paid [u64; 5]; the rest
/// is reserved.
pub const V2_EXT_LEN: usize = 64;
const V2_EXT_VERSION: u8 = 1;
/// Reward distributors (S3): 0 trader airdrop (calendar months), 1 holder rewards (weekly). The vault PDAs
/// ["v2-vault", kind] hold the funds; state lives at ["v2-dist", kind].
pub const V2_DIST_AIRDROP: u8 = 0;
pub const V2_DIST_HOLDER: u8 = 1;
/// Unclaimed payouts return to the pool after this many further rounds (as on EVM).
pub const V2_CLAIM_WINDOW_ROUNDS: u32 = 12;
/// Most recipients one round can list (its claim bitmap must fit one account creation).
pub const V2_MAX_RECIPIENTS: u32 = 80_000;
/// The flywheel: one order per token at most every 6 hours, at most 10% of the vault, tokens at least a day old.
pub const V2_FLYWHEEL_COOLDOWN_SECS: i64 = 6 * 3_600;
pub const V2_FLYWHEEL_MIN_AGE_SECS: i64 = 86_400;
pub const V2_FLYWHEEL_MAX_SHARE_BPS: u128 = 1_000;
/// A data-less account keeps this many lamports to stay alive (rent-exempt minimum for 0 bytes).
pub const EMPTY_ACCOUNT_RENT: u64 = 890_880;
pub fn v2_vault_seed(kind: u8) -> &'static [u8] { if kind == V2_DIST_AIRDROP { V2_VAULT_AIRDROP } else { V2_VAULT_HOLDER } }
// PumpSwap `Pool` layout offsets (8-byte discriminator included).
const PUMP_POOL_LP_SUPPLY: usize = 203;
const PUMP_POOL_PROTOCOL_FEES: usize = 271;
const PUMP_POOL_CREATOR_FEES: usize = 279;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct CurveParams {
    pub virtual_quote: u64,
    pub virtual_token: u64,
    pub curve_supply: u64,
    pub base_fee_bps: u16,
    pub snipe_start_bps: u16,
    pub snipe_window_secs: u32,
    pub max_creator_buy_bps: u16,
    /// Creation fee in lamports (SOL), charged on every launch whatever the trading pair.
    pub launch_fee: u64,
}

/// USD pricing for one curve config, verified on-chain from a Pyth price account.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct PricingParams {
    /// Pyth feed ID of the quote's USD price (SOL/USD for the SOL pair).
    pub feed_id: [u8; 32],
    /// Oldest accepted publish time, in seconds before the launch.
    pub max_age_secs: u32,
    /// Largest accepted confidence interval, as basis points of the price.
    pub max_conf_bps: u16,
    /// Creation fee in USD with 6 decimals (10_000_000 = $10), charged in SOL or USDC.
    pub fee_usd_e6: u64,
    /// SOL pairs only: starting FDV in USD (6 decimals); the curve's virtual SOL reserve is sized from
    /// the oracle at each launch. Zero keeps the config's fixed virtual reserve.
    pub start_fdv_usd_e6: u64,
    /// Six-decimal USDC mint accepted for the fee, or the default key to accept SOL only.
    pub usdc_mint: Pubkey,
}

#[program]
pub mod elpida_launchpad {
    use super::*;
    /// Kept on every build: the site probes it before a launch with no creator buy.
    pub fn optional_buy_version(_ctx: Context<OptionalBuyVersion>) -> Result<()> { Ok(()) }
    #[cfg(feature = "testnet")]
    /// Lets clients detect this version (partner tiers, the extra `partner` launch account, writable mint on trades).
    pub fn partner_tiers_version(_ctx: Context<OptionalBuyVersion>) -> Result<()> { Ok(()) }

    #[cfg(feature = "testnet")]
    /// The SOL pair's treasury registers `creator` for an early-partner tier: `buyback_bps` 1000 or 2000 with an
    /// expiry at most 180 days ahead, or (0, 0) to end it early. Only future launches by that wallet are affected.
    pub fn set_partner(ctx: Context<SetPartner>, creator: Pubkey, buyback_bps: u16, expires_at: i64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(creator != Pubkey::default(), ElpidaError::InvalidParams);
        if buyback_bps == 0 {
            require!(expires_at == 0, ElpidaError::PartnerTerms);
        } else {
            let latest = now.checked_add(MAX_PARTNER_WINDOW_SECS).ok_or(ElpidaError::MathOverflow)?;
            require!(PARTNER_BPS.contains(&buyback_bps) && expires_at > now && expires_at <= latest, ElpidaError::PartnerTerms);
        }
        let partner = &mut ctx.accounts.partner;
        partner.creator = creator;
        partner.buyback_bps = buyback_bps;
        partner.expires_at = expires_at;
        partner.bump = ctx.bumps.partner;
        emit!(PartnerSet { creator, buyback_bps, expires_at });
        Ok(())
    }

    #[cfg(feature = "testnet")]
    /// One-time setup by the program's upgrade authority: quote mint, treasury and curve parameters.
    pub fn initialize_curve(ctx: Context<InitializeCurve>, params: CurveParams) -> Result<()> {
        let bump = ctx.bumps.curve_config;
        let (quote_mint, treasury) = (ctx.accounts.quote_mint.key(), ctx.accounts.treasury.key());
        check_quote_mint(&ctx.accounts.quote_mint.to_account_info())?;
        write_config(&mut ctx.accounts.curve_config, quote_mint, ctx.accounts.quote_mint.decimals, treasury, &params, bump)
    }

    #[cfg(feature = "testnet")]
    /// Upgrade authority: an additional curve config for another quote mint, PDA ["curve-config", quote_mint].
    /// Every config is created only here or by `initialize_curve`; pools record the config they use.
    pub fn add_curve_config(ctx: Context<AddCurveConfig>, params: CurveParams) -> Result<()> {
        let bump = ctx.bumps.curve_config;
        let (quote_mint, treasury) = (ctx.accounts.quote_mint.key(), ctx.accounts.treasury.key());
        check_quote_mint(&ctx.accounts.quote_mint.to_account_info())?;
        write_config(&mut ctx.accounts.curve_config, quote_mint, ctx.accounts.quote_mint.decimals, treasury, &params, bump)
    }

    #[cfg(feature = "testnet")]
    /// Upgrade authority: reprices an existing config for future launches (native SOL pricing set by the
    /// team). Pools copy the curve values at launch, so live pools are unaffected. The fee schedule
    /// (base fee and anti-snipe decay) is read by live pools on every trade and therefore cannot change.
    pub fn update_curve_config(ctx: Context<UpdateCurveConfig>, params: CurveParams) -> Result<()> {
        let config = &mut ctx.accounts.curve_config;
        require!(
            params.base_fee_bps == config.base_fee_bps && params.snipe_start_bps == config.snipe_start_bps && params.snipe_window_secs == config.snipe_window_secs,
            ElpidaError::FeeScheduleFixed
        );
        let (quote_mint, decimals, treasury, bump, version) = (config.quote_mint, config.quote_decimals, config.treasury, config.bump, config.model_version);
        if version == V2_MODEL_VERSION { check_v2_config(&params)?; }
        write_config(config, quote_mint, decimals, treasury, &params, bump)?;
        config.model_version = version;
        emit!(CurveConfigUpdated {
            config: config.key(), quote_mint, virtual_quote: params.virtual_quote, virtual_token: params.virtual_token,
            curve_supply: params.curve_supply, launch_fee: params.launch_fee, max_creator_buy_bps: params.max_creator_buy_bps,
        });
        Ok(())
    }

    #[cfg(feature = "testnet")]
    /// TEST NETWORKS ONLY (devnet / localnet): creates "Elpida tUSDC", a valueless 6-decimal stand-in
    /// for USDC at PDA ["test-usdc"] whose only minter is `test_usdc_faucet`. Never create on mainnet.
    pub fn create_test_usdc(_ctx: Context<CreateTestUsdc>) -> Result<()> {
        test_networks_only()
    }

    #[cfg(feature = "testnet")]
    /// TEST NETWORKS ONLY: mints a test asset to the caller. Works only for mints whose mint authority
    /// is the faucet PDA (Elpida tUSDC and the labelled test assets created by the deploy script).
    pub fn test_usdc_faucet(ctx: Context<TestUsdcFaucet>, amount: u64) -> Result<()> {
        test_networks_only()?;
        let max = TEST_FAUCET_MAX_WHOLE.checked_mul(10u64.pow(ctx.accounts.test_mint.decimals as u32)).ok_or(ElpidaError::MathOverflow)?;
        require!(amount > 0 && amount <= max, ElpidaError::InvalidParams);
        let seeds: &[&[u8]] = &[b"test-usdc-authority", &[ctx.bumps.faucet_authority]];
        ti::mint_to(
            CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), ti::MintTo { mint: ctx.accounts.test_mint.to_account_info(), to: ctx.accounts.user_token.to_account_info(), authority: ctx.accounts.faucet_authority.to_account_info() }, &[seeds]),
            amount,
        )
    }

    /// Succeeds only on the test build. Lets deploy scripts confirm, without any state, that the program
    /// on a cluster is the mainnet build (it fails with TestNetworksOnly).
    pub fn test_build_check(_ctx: Context<TestBuildCheck>) -> Result<()> {
        test_networks_only()
    }

    #[cfg(feature = "testnet")]
    /// TEST NETWORKS ONLY: adds SOL and a test asset to the SOL/asset conversion pool at PDA
    /// ["test-conversion", asset mint]. On mainnet, paying in SOL for a stock pair routes through Jupiter; devnet has
    /// no Jupiter and no DEX that accepts Ondo-shaped mints, so this constant-product pool stands in for it. Only the
    /// upgrade authority seeds it (it sets the test price); nobody can withdraw from it.
    pub fn seed_test_conversion(ctx: Context<SeedTestConversion>, sol_amount: u64, quote_amount: u64) -> Result<()> {
        test_networks_only()?;
        require!(sol_amount > 0 && quote_amount > 0, ElpidaError::InvalidParams);
        let a = &ctx.accounts;
        system_program::transfer(CpiContext::new(a.system_program.to_account_info(), system_program::Transfer { from: a.authority.to_account_info(), to: a.pool.to_account_info() }), sol_amount)?;
        quote_transfer(&a.quote_token_program, &a.quote_mint, a.authority_quote.to_account_info(), a.pool_quote.to_account_info(), a.authority.to_account_info(), quote_amount, a.quote_mint.decimals, &[])?;
        let pool = &mut ctx.accounts.pool;
        pool.quote_mint = ctx.accounts.quote_mint.key();
        pool.bump = ctx.bumps.pool;
        pool.sol_reserve = pool.sol_reserve.checked_add(sol_amount).ok_or(ElpidaError::MathOverflow)?;
        pool.quote_reserve = pool.quote_reserve.checked_add(quote_amount).ok_or(ElpidaError::MathOverflow)?;
        emit!(TestConversionSeeded { quote_mint: pool.quote_mint, sol_reserve: pool.sol_reserve, quote_reserve: pool.quote_reserve });
        Ok(())
    }

    #[cfg(feature = "testnet")]
    /// TEST NETWORKS ONLY: swaps SOL for the test asset (`sol_in`) or back, x·y = k with a 0.3% fee that stays in
    /// the pool. The caller's asset account is created if needed, so SOL can buy a stock in one step.
    pub fn test_conversion_swap(ctx: Context<TestConversionSwap>, amount_in: u64, min_out: u64, sol_in: bool) -> Result<()> {
        test_networks_only()?;
        let (reserve_in, reserve_out) = if sol_in { (ctx.accounts.pool.sol_reserve, ctx.accounts.pool.quote_reserve) } else { (ctx.accounts.pool.quote_reserve, ctx.accounts.pool.sol_reserve) };
        let out = test_conversion_out(reserve_in, reserve_out, amount_in)?;
        require!(out >= min_out, ElpidaError::Slippage);
        let a = &ctx.accounts;
        let seeds: &[&[u8]] = &[b"test-conversion", a.pool.quote_mint.as_ref(), &[a.pool.bump]];
        if sol_in {
            system_program::transfer(CpiContext::new(a.system_program.to_account_info(), system_program::Transfer { from: a.user.to_account_info(), to: a.pool.to_account_info() }), amount_in)?;
            quote_transfer(&a.quote_token_program, &a.quote_mint, a.pool_quote.to_account_info(), a.user_quote.to_account_info(), a.pool.to_account_info(), out, a.quote_mint.decimals, &[seeds])?;
        } else {
            quote_transfer(&a.quote_token_program, &a.quote_mint, a.user_quote.to_account_info(), a.pool_quote.to_account_info(), a.user.to_account_info(), amount_in, a.quote_mint.decimals, &[])?;
            a.pool.to_account_info().sub_lamports(out)?;
            a.user.to_account_info().add_lamports(out)?;
        }
        let pool = &mut ctx.accounts.pool;
        if sol_in { pool.sol_reserve += amount_in; pool.quote_reserve -= out; } else { pool.quote_reserve += amount_in; pool.sol_reserve -= out; }
        emit!(TestConversionSwapped { quote_mint: pool.quote_mint, sol_in, amount_in, amount_out: out, sol_reserve: pool.sol_reserve, quote_reserve: pool.quote_reserve });
        Ok(())
    }

    /// Upgrade authority: creates or updates the beta launch gate. While `enabled`, only creators on the
    /// allowlist can launch; `authority` (for example a beta admin key) manages that allowlist.
    pub fn set_beta_gate(ctx: Context<SetBetaGate>, authority: Pubkey, enabled: bool) -> Result<()> {
        require!(authority != Pubkey::default(), ElpidaError::InvalidParams);
        let gate = &mut ctx.accounts.beta_gate;
        gate.authority = authority;
        gate.enabled = enabled;
        gate.bump = ctx.bumps.beta_gate;
        emit!(BetaGateSet { authority, enabled });
        Ok(())
    }

    /// Beta gate authority: lets `creator` launch while the gate is enabled.
    pub fn allow_beta_creator(ctx: Context<AllowBetaCreator>, creator: Pubkey) -> Result<()> {
        let entry = &mut ctx.accounts.beta_creator;
        entry.creator = creator;
        entry.bump = ctx.bumps.beta_creator;
        emit!(BetaCreatorSet { creator, allowed: true });
        Ok(())
    }

    /// Beta gate authority: removes `creator` from the allowlist (rent returns to the authority).
    pub fn revoke_beta_creator(ctx: Context<RevokeBetaCreator>) -> Result<()> {
        emit!(BetaCreatorSet { creator: ctx.accounts.beta_creator.creator, allowed: false });
        Ok(())
    }

    /// Upgrade authority: turns on oracle pricing for a config (or updates it). The price account is
    /// checked now and bound, so launches must present exactly this Pyth account.
    pub fn set_pricing(ctx: Context<SetPricing>, params: PricingParams) -> Result<()> {
        require!(params.max_age_secs > 0 && params.max_age_secs <= 3_600, ElpidaError::InvalidParams);
        require!(params.max_conf_bps > 0 && params.max_conf_bps <= 1_000, ElpidaError::InvalidParams);
        require!(params.fee_usd_e6 <= 1_000 * 1_000_000, ElpidaError::InvalidParams);
        require!(params.start_fdv_usd_e6 == 0 || ctx.accounts.curve_config.quote_mint == WSOL_MINT, ElpidaError::InvalidParams);
        require!(params.start_fdv_usd_e6 <= 100_000_000 * 1_000_000, ElpidaError::InvalidParams);
        let p = &mut ctx.accounts.pricing;
        p.config = ctx.accounts.curve_config.key();
        p.price_feed = ctx.accounts.price_update.key();
        p.feed_id = params.feed_id;
        p.max_age_secs = params.max_age_secs;
        p.max_conf_bps = params.max_conf_bps;
        p.fee_usd_e6 = params.fee_usd_e6;
        p.start_fdv_usd_e6 = params.start_fdv_usd_e6;
        p.usdc_mint = params.usdc_mint;
        p.bump = ctx.bumps.pricing;
        let price = read_price(&ctx.accounts.price_update.to_account_info(), p, Clock::get()?.unix_timestamp)?;
        emit!(PricingConfigSet { config: p.config, price_feed: p.price_feed, fee_usd_e6: p.fee_usd_e6, start_fdv_usd_e6: p.start_fdv_usd_e6, usdc_mint: p.usdc_mint, price: price.price, exponent: price.exponent, publish_time: price.publish_time });
        Ok(())
    }

    #[cfg(feature = "testnet")]
    /// `max_fee`: the most lamports the creator accepts for the SOL creation fee (price movement guard).
    /// `fee_in_usdc`: pay the USD fee in USDC instead; the four USDC accounts follow in remaining accounts.
    /// `uri`: the token's IPFS metadata document (`ipfs://…`), written once into immutable Metaplex metadata.
    #[allow(clippy::too_many_arguments)]
    pub fn launch<'info>(ctx: Context<'_, '_, 'info, 'info, Launch<'info>>, name: String, symbol: String, first_buy: u64, min_tokens_out: u64, reward: Pubkey, max_fee: u64, fee_in_usdc: bool, uri: String) -> Result<()> {
        require!(ctx.accounts.curve_config.model_version != V2_MODEL_VERSION, ElpidaError::WrongConfig);
        check_beta(&ctx.accounts.beta_gate.to_account_info(), &ctx.accounts.beta_creator.to_account_info())?;
        let name = name.trim().to_string();
        require!(!name.is_empty() && name.len() <= MAX_NAME, ElpidaError::InvalidName);
        require!(
            !symbol.is_empty() && symbol.len() <= MAX_SYMBOL && symbol.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()),
            ElpidaError::InvalidSymbol
        );
        require!(reward != Pubkey::default(), ElpidaError::RewardRequired);
        require!(valid_metadata_uri(&uri), ElpidaError::InvalidUri);

        let now = Clock::get()?.unix_timestamp;
        let a = &ctx.accounts;
        let tp = a.token_program.to_account_info();
        let decimals = a.quote_mint.decimals;
        let start_quote = pay_creation_fee(&CreationFee {
            creator: a.creator.to_account_info(), treasury: a.treasury.to_account_info(), system_program: a.system_program.to_account_info(),
            pricing: a.pricing.to_account_info(), price_update: a.price_update.to_account_info(), config: a.curve_config.key(), launch_fee: a.curve_config.launch_fee, mint: a.mint.key(),
        }, ctx.remaining_accounts, max_fee, fee_in_usdc, now)?;
        token::mint_to(
            CpiContext::new(tp.clone(), MintTo { mint: a.mint.to_account_info(), to: a.token_vault.to_account_info(), authority: a.creator.to_account_info() }),
            TOKEN_SUPPLY,
        )?;
        // Immutable Metaplex metadata, created while the creator is still the mint authority.
        create_metadata(&a.token_metadata_program, &a.metadata, &a.mint.to_account_info(), &a.creator.to_account_info(), &a.pool.to_account_info(), &a.system_program.to_account_info(), &name, &symbol, &uri)?;
        token::set_authority(
            CpiContext::new(tp.clone(), SetAuthority { current_authority: a.creator.to_account_info(), account_or_mint: a.mint.to_account_info() }),
            AuthorityType::MintTokens,
            None,
        )?;

        let mut name_bytes = [0u8; MAX_NAME];
        name_bytes[..name.len()].copy_from_slice(name.as_bytes());
        let mut symbol_bytes = [0u8; MAX_SYMBOL];
        symbol_bytes[..symbol.len()].copy_from_slice(symbol.as_bytes());
        let (mint_key, creator_key) = (a.mint.key(), a.creator.key());
        let cfg: CurveConfig = **ctx.accounts.curve_config;
        // Early-partner tier of the launching wallet, fixed for this pool's whole life.
        let buyback_bps = partner_share(&a.partner.to_account_info(), &creator_key, now)?;
        let locked_venue = locked_pool_venue(&ctx.accounts.quote_mint.to_account_info())?;

        let pool = &mut ctx.accounts.pool;
        pool.config = ctx.accounts.curve_config.key();
        pool.mint = mint_key;
        pool.creator = creator_key;
        pool.reward = reward;
        pool.name = name_bytes;
        pool.symbol = symbol_bytes;
        // Oracle-priced SOL pairs: the virtual reserve that puts the starting FDV at the configured USD
        // value at this launch's price (FDV = virtual_quote x supply / virtual_token).
        pool.virtual_quote = match start_quote {
            Some(fdv_lamports) => {
                let vq = (fdv_lamports as u128).checked_mul(cfg.virtual_token as u128).ok_or(ElpidaError::MathOverflow)?.div_ceil(TOKEN_SUPPLY as u128);
                require!(vq > 0 && vq <= u64::MAX as u128, ElpidaError::InvalidParams);
                vq as u64
            }
            None => cfg.virtual_quote,
        };
        pool.virtual_token = cfg.virtual_token;
        pool.curve_supply = cfg.curve_supply;
        pool.real_quote = 0;
        pool.sold = 0;
        pool.liquidity_bonus = 0;
        pool.protocol_fees = 0;
        pool.creator_fees = 0;
        pool.created_at = now;
        pool.graduated_at = 0;
        pool.status = STATUS_TRADING;
        pool.bump = ctx.bumps.pool;

        // Optional creator buy; zero creates an empty trading curve without a synthetic purchase.
        let trade = if first_buy == 0 {
            TradeQuote { gross: 0, net: 0, tokens: 0, fee: 0, base_fee: 0, surplus: 0, graduates: false }
        } else { quote_buy(pool, first_buy, cfg.base_fee_bps as u64, cfg.base_fee_bps as u64)? };
        require!(trade.tokens >= min_tokens_out, ElpidaError::Slippage);
        if cfg.max_creator_buy_bps > 0 {
            require!(trade.tokens as u128 * BPS <= TOKEN_SUPPLY as u128 * cfg.max_creator_buy_bps as u128, ElpidaError::CreatorBuyCap);
        }
        let burn_quote = apply_buy(pool, &trade, now, buyback_bps)?;
        let burned = partner_buyback(pool, burn_quote)?;
        let opened = pool.status == STATUS_GRADUATED && locked_venue;
        if opened { open_locked_pool(pool)?; }
        let bump = pool.bump;
        let pool_key = pool.key();
        let snapshot = Snapshot::of(pool);
        let mut ext = PoolExt { buyback_bps, ..PoolExt::default() };
        ext.record(burned, burn_quote)?;
        ext.write(&mut ctx.accounts.pool.to_account_info().try_borrow_mut_data()?)?;
        let a = &ctx.accounts;
        quote_transfer(&a.quote_token_program, &a.quote_mint, a.creator_quote.to_account_info(), a.quote_vault.to_account_info(), a.creator.to_account_info(), trade.gross, decimals, &[])?;
        let seeds: &[&[u8]] = &[b"curve", mint_key.as_ref(), &[bump]];
        token::transfer(
            CpiContext::new_with_signer(a.token_program.to_account_info(), Transfer { from: a.token_vault.to_account_info(), to: a.creator_token.to_account_info(), authority: a.pool.to_account_info() }, &[seeds]),
            trade.tokens,
        )?;
        burn_from_vault(&a.token_program, &a.mint.to_account_info(), &a.token_vault.to_account_info(), &a.pool.to_account_info(), seeds, burned)?;
        if buyback_bps > 0 { emit!(PartnerPoolLaunched { pool: pool_key, mint: mint_key, creator: creator_key, buyback_bps }); }
        if burned > 0 { emit!(PartnerBuyback { pool: pool_key, quote_in: burn_quote, tokens_burned: burned, total_burned: ext.burned }); }
        emit!(CurveLaunched {
            creator: creator_key, mint: mint_key, pool: pool_key, quote_in: trade.gross, tokens_out: trade.tokens, fee: trade.fee,
            real_quote: snapshot.real_quote, virtual_quote: snapshot.virtual_quote_total, token_reserve: snapshot.token_reserve, sold: snapshot.sold,
        });
        if snapshot.graduated { emit!(CurveGraduated { pool: pool_key, mint: mint_key, real_quote: snapshot.real_quote, liquidity_bonus: snapshot.liquidity_bonus, lp_tokens: TOKEN_SUPPLY - snapshot.sold }); }
        if opened { emit!(LockedPoolOpened { pool: pool_key, mint: mint_key, quote_reserve: snapshot.real_quote, token_reserve: snapshot.token_reserve }); }
        Ok(())
    }

    pub fn buy(ctx: Context<Trade>, gross_in: u64, min_tokens_out: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let cfg: CurveConfig = **ctx.accounts.curve_config;
        let mut ext = PoolExt::read(&ctx.accounts.pool.to_account_info().try_borrow_data()?);
        let mut v2 = v2_of(&cfg, &ctx.accounts.pool.to_account_info())?;
        let locked_venue = locked_pool_venue(&ctx.accounts.quote_mint.to_account_info())?;
        let pool = &mut ctx.accounts.pool;
        require!(pool.status == STATUS_TRADING || pool.status == STATUS_LOCKED, ElpidaError::CurveClosed);
        let (fee_bps, own_bps) = match &v2 { Some(x) => (v2_fee_bps(x.fee_bps, pool.created_at, now), x.fee_bps as u64), None => (trade_fee_bps(&cfg, pool, now), cfg.base_fee_bps as u64) };
        let trade = quote_buy(pool, gross_in, fee_bps, own_bps)?;
        require!(trade.tokens >= min_tokens_out, ElpidaError::Slippage);
        let burn_quote = match v2.as_mut() { Some(x) => { v2_apply_buy(pool, x, &trade, now)?; 0 } None => apply_buy(pool, &trade, now, ext.buyback_bps)? };
        let burned = partner_buyback(pool, burn_quote)?;
        let opened = pool.status == STATUS_GRADUATED && locked_venue;
        if opened { open_locked_pool(pool)?; }
        let (mint_key, bump, pool_key) = (pool.mint, pool.bump, pool.key());
        let snapshot = Snapshot::of(pool);
        if ext.record(burned, burn_quote)? { ext.write(&mut ctx.accounts.pool.to_account_info().try_borrow_mut_data()?)?; }
        if let Some(x) = v2 { x.write(&mut ctx.accounts.pool.to_account_info().try_borrow_mut_data()?)?; }
        let a = &ctx.accounts;
        quote_transfer(&a.quote_token_program, &a.quote_mint, a.trader_quote.to_account_info(), a.quote_vault.to_account_info(), a.trader.to_account_info(), trade.gross, a.quote_mint.decimals, &[])?;
        let seeds: &[&[u8]] = &[b"curve", mint_key.as_ref(), &[bump]];
        token::transfer(
            CpiContext::new_with_signer(a.token_program.to_account_info(), Transfer { from: a.token_vault.to_account_info(), to: a.trader_token.to_account_info(), authority: a.pool.to_account_info() }, &[seeds]),
            trade.tokens,
        )?;
        burn_from_vault(&a.token_program, &a.mint.to_account_info(), &a.token_vault.to_account_info(), &a.pool.to_account_info(), seeds, burned)?;
        if burned > 0 { emit!(PartnerBuyback { pool: pool_key, quote_in: burn_quote, tokens_burned: burned, total_burned: ext.burned }); }
        emit!(CurveBought {
            pool: pool_key, buyer: a.trader.key(), quote_in: trade.gross, tokens_out: trade.tokens, fee: trade.fee, anti_snipe_fee: trade.surplus,
            real_quote: snapshot.real_quote, virtual_quote: snapshot.virtual_quote_total, token_reserve: snapshot.token_reserve, sold: snapshot.sold,
        });
        if snapshot.graduated { emit!(CurveGraduated { pool: pool_key, mint: mint_key, real_quote: snapshot.real_quote, liquidity_bonus: snapshot.liquidity_bonus, lp_tokens: TOKEN_SUPPLY - snapshot.sold }); }
        if opened { emit!(LockedPoolOpened { pool: pool_key, mint: mint_key, quote_reserve: snapshot.real_quote, token_reserve: snapshot.token_reserve }); }
        Ok(())
    }

    pub fn sell(ctx: Context<Trade>, tokens_in: u64, min_quote_out: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let cfg: CurveConfig = **ctx.accounts.curve_config;
        let mut ext = PoolExt::read(&ctx.accounts.pool.to_account_info().try_borrow_data()?);
        let mut v2 = v2_of(&cfg, &ctx.accounts.pool.to_account_info())?;
        let pool = &mut ctx.accounts.pool;
        require!(pool.status == STATUS_TRADING || pool.status == STATUS_LOCKED, ElpidaError::CurveClosed);
        let (fee_bps, own_bps) = match &v2 { Some(x) => (v2_fee_bps(x.fee_bps, pool.created_at, now), x.fee_bps as u64), None => (trade_fee_bps(&cfg, pool, now), cfg.base_fee_bps as u64) };
        let trade = quote_sell(pool, tokens_in, fee_bps, own_bps)?;
        require!(trade.net >= min_quote_out, ElpidaError::Slippage);
        pool.real_quote = pool.real_quote.checked_sub(trade.gross).ok_or(ElpidaError::MathOverflow)?;
        pool.sold = pool.sold.checked_sub(tokens_in).ok_or(ElpidaError::MathOverflow)?;
        let burn_quote = match v2.as_mut() { Some(x) => { v2_book_fee(pool, x, &trade)?; 0 } None => split_fee(pool, &trade, ext.buyback_bps)? };
        let burned = partner_buyback(pool, burn_quote)?;
        let (mint_key, bump, pool_key) = (pool.mint, pool.bump, pool.key());
        let snapshot = Snapshot::of(pool);
        if ext.record(burned, burn_quote)? { ext.write(&mut ctx.accounts.pool.to_account_info().try_borrow_mut_data()?)?; }
        if let Some(x) = v2 { x.write(&mut ctx.accounts.pool.to_account_info().try_borrow_mut_data()?)?; }
        let a = &ctx.accounts;
        token::transfer(
            CpiContext::new(a.token_program.to_account_info(), Transfer { from: a.trader_token.to_account_info(), to: a.token_vault.to_account_info(), authority: a.trader.to_account_info() }),
            tokens_in,
        )?;
        let seeds: &[&[u8]] = &[b"curve", mint_key.as_ref(), &[bump]];
        burn_from_vault(&a.token_program, &a.mint.to_account_info(), &a.token_vault.to_account_info(), &a.pool.to_account_info(), seeds, burned)?;
        if burned > 0 { emit!(PartnerBuyback { pool: pool_key, quote_in: burn_quote, tokens_burned: burned, total_burned: ext.burned }); }
        quote_transfer(&a.quote_token_program, &a.quote_mint, a.quote_vault.to_account_info(), a.trader_quote.to_account_info(), a.pool.to_account_info(), trade.net, a.quote_mint.decimals, &[seeds])?;
        emit!(CurveSold {
            pool: pool_key, seller: a.trader.key(), tokens_in, quote_out: trade.net, fee: trade.fee, anti_snipe_fee: trade.surplus,
            real_quote: snapshot.real_quote, virtual_quote: snapshot.virtual_quote_total, token_reserve: snapshot.token_reserve, sold: snapshot.sold,
        });
        Ok(())
    }

    #[cfg(feature = "testnet")]
    /// Permissionless: pays accrued base fees to the fixed treasury and creator-reward accounts.
    /// `real_quote` and `liquidity_bonus` are never touched.
    pub fn withdraw_fees(ctx: Context<WithdrawFees>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let (protocol, creator) = (pool.protocol_fees, pool.creator_fees);
        pool.protocol_fees = 0;
        pool.creator_fees = 0;
        let (mint_key, bump, pool_key) = (pool.mint, pool.bump, pool.key());
        let a = &ctx.accounts;
        let seeds: &[&[u8]] = &[b"curve", mint_key.as_ref(), &[bump]];
        for (to, amount) in [(a.treasury_quote.to_account_info(), protocol), (a.reward_quote.to_account_info(), creator)] {
            if amount > 0 {
                quote_transfer(&a.quote_token_program, &a.quote_mint, a.quote_vault.to_account_info(), to.clone(), a.pool.to_account_info(), amount, a.quote_mint.decimals, &[seeds])?;
                emit!(FeesWithdrawn { pool: pool_key, recipient: to.key(), amount });
            }
        }
        Ok(())
    }

    /// ELPIDA V2, upgrade authority: a V2 trading pair for `quote_mint` (PDA ["curve-config-v2", quote_mint]). Pools
    /// fix their own fee at launch, from `base_fee_bps` (the minimum) to 4%, with the 90% anti-snipe start over 60 s and
    /// a 3% first-buy cap. Quotes that would need the locked pool (no DEX venue) are refused: V2 graduates to a DEX.
    pub fn add_v2_config(ctx: Context<AddV2Config>, params: CurveParams) -> Result<()> {
        check_v2_config(&params)?;
        let bump = ctx.bumps.curve_config;
        let (quote_mint, treasury) = (ctx.accounts.quote_mint.key(), ctx.accounts.treasury.key());
        let info = ctx.accounts.quote_mint.to_account_info();
        check_quote_mint(&info)?;
        require!(!locked_pool_venue(&info)?, ElpidaError::UnsupportedQuote);
        let config = &mut ctx.accounts.curve_config;
        write_config(config, quote_mint, ctx.accounts.quote_mint.decimals, treasury, &params, bump)?;
        config.model_version = V2_MODEL_VERSION;
        emit!(V2ConfigAdded { config: config.key(), quote_mint, min_fee_bps: params.base_fee_bps });
        Ok(())
    }

    /// ELPIDA V2 launch: like `launch`, but the creator chooses the token's fee (`fee_bps`, from the config's minimum to
    /// 4%, fixed for good), the first buy pays that fee and is capped at 3% of supply, tickers are 1 to 10 letters or
    /// digits, and every fee at the token's rate is split 30% creator / 30% trader airdrop / 10% flywheel / 10% holder
    /// rewards / 20% treasury (`withdraw_v2_fees`). There are no partner tiers.
    #[allow(clippy::too_many_arguments)]
    pub fn launch_v2<'info>(ctx: Context<'_, '_, 'info, 'info, LaunchV2<'info>>, name: String, symbol: String, fee_bps: u16, first_buy: u64, min_tokens_out: u64, reward: Pubkey, max_fee: u64, fee_in_usdc: bool, uri: String) -> Result<()> {
        check_beta(&ctx.accounts.beta_gate.to_account_info(), &ctx.accounts.beta_creator.to_account_info())?;
        let name = name.trim().to_string();
        require!(!name.is_empty() && name.len() <= MAX_NAME, ElpidaError::InvalidName);
        require!(valid_v2_symbol(&symbol), ElpidaError::InvalidSymbol);
        require!(reward != Pubkey::default(), ElpidaError::RewardRequired);
        require!(valid_metadata_uri(&uri), ElpidaError::InvalidUri);
        let cfg: CurveConfig = **ctx.accounts.curve_config;
        require!(fee_bps >= cfg.base_fee_bps && fee_bps <= V2_MAX_FEE_BPS, ElpidaError::V2FeeRange);

        let now = Clock::get()?.unix_timestamp;
        let a = &ctx.accounts;
        let tp = a.token_program.to_account_info();
        let decimals = a.quote_mint.decimals;
        let start_quote = pay_creation_fee(&CreationFee {
            creator: a.creator.to_account_info(), treasury: a.treasury.to_account_info(), system_program: a.system_program.to_account_info(),
            pricing: a.pricing.to_account_info(), price_update: a.price_update.to_account_info(), config: a.curve_config.key(), launch_fee: cfg.launch_fee, mint: a.mint.key(),
        }, ctx.remaining_accounts, max_fee, fee_in_usdc, now)?;
        token::mint_to(CpiContext::new(tp.clone(), MintTo { mint: a.mint.to_account_info(), to: a.token_vault.to_account_info(), authority: a.creator.to_account_info() }), TOKEN_SUPPLY)?;
        create_metadata(&a.token_metadata_program, &a.metadata, &a.mint.to_account_info(), &a.creator.to_account_info(), &a.pool.to_account_info(), &a.system_program.to_account_info(), &name, &symbol, &uri)?;
        token::set_authority(CpiContext::new(tp.clone(), SetAuthority { current_authority: a.creator.to_account_info(), account_or_mint: a.mint.to_account_info() }), AuthorityType::MintTokens, None)?;

        let mut name_bytes = [0u8; MAX_NAME];
        name_bytes[..name.len()].copy_from_slice(name.as_bytes());
        let mut symbol_bytes = [0u8; MAX_SYMBOL];
        symbol_bytes[..symbol.len()].copy_from_slice(symbol.as_bytes());
        let (mint_key, creator_key, config_key) = (a.mint.key(), a.creator.key(), a.curve_config.key());
        let pool = &mut ctx.accounts.pool;
        pool.config = config_key;
        pool.mint = mint_key;
        pool.creator = creator_key;
        pool.reward = reward;
        pool.name = name_bytes;
        pool.symbol = symbol_bytes;
        pool.virtual_quote = match start_quote {
            Some(fdv_lamports) => {
                let vq = (fdv_lamports as u128).checked_mul(cfg.virtual_token as u128).ok_or(ElpidaError::MathOverflow)?.div_ceil(TOKEN_SUPPLY as u128);
                require!(vq > 0 && vq <= u64::MAX as u128, ElpidaError::InvalidParams);
                vq as u64
            }
            None => cfg.virtual_quote,
        };
        pool.virtual_token = cfg.virtual_token;
        pool.curve_supply = cfg.curve_supply;
        pool.real_quote = 0;
        pool.sold = 0;
        pool.liquidity_bonus = 0;
        pool.protocol_fees = 0;
        pool.creator_fees = 0;
        pool.created_at = now;
        pool.graduated_at = 0;
        pool.status = STATUS_TRADING;
        pool.bump = ctx.bumps.pool;

        // Optional first buy at the token's own fee (no anti-snipe surplus), at most 3% of supply.
        let mut ext = V2Ext { fee_bps, ..V2Ext::default() };
        let trade = if first_buy == 0 {
            TradeQuote { gross: 0, net: 0, tokens: 0, fee: 0, base_fee: 0, surplus: 0, graduates: false }
        } else { quote_buy(pool, first_buy, fee_bps as u64, fee_bps as u64)? };
        require!(trade.tokens >= min_tokens_out, ElpidaError::Slippage);
        require!(trade.tokens as u128 * BPS <= TOKEN_SUPPLY as u128 * V2_FIRST_BUY_CAP_BPS as u128, ElpidaError::CreatorBuyCap);
        v2_apply_buy(pool, &mut ext, &trade, now)?;
        let (bump, pool_key) = (pool.bump, pool.key());
        let snapshot = Snapshot::of(pool);
        {
            let info = ctx.accounts.pool.to_account_info();
            let mut data = info.try_borrow_mut_data()?;
            PoolExt::default().write(&mut data)?;
            ext.write(&mut data)?;
        }
        let a = &ctx.accounts;
        quote_transfer(&a.quote_token_program, &a.quote_mint, a.creator_quote.to_account_info(), a.quote_vault.to_account_info(), a.creator.to_account_info(), trade.gross, decimals, &[])?;
        let seeds: &[&[u8]] = &[b"curve", mint_key.as_ref(), &[bump]];
        token::transfer(
            CpiContext::new_with_signer(a.token_program.to_account_info(), Transfer { from: a.token_vault.to_account_info(), to: a.creator_token.to_account_info(), authority: a.pool.to_account_info() }, &[seeds]),
            trade.tokens,
        )?;
        emit!(V2PoolLaunched { pool: pool_key, mint: mint_key, creator: creator_key, fee_bps });
        emit!(CurveLaunched {
            creator: creator_key, mint: mint_key, pool: pool_key, quote_in: trade.gross, tokens_out: trade.tokens, fee: trade.fee,
            real_quote: snapshot.real_quote, virtual_quote: snapshot.virtual_quote_total, token_reserve: snapshot.token_reserve, sold: snapshot.sold,
        });
        if snapshot.graduated { emit!(CurveGraduated { pool: pool_key, mint: mint_key, real_quote: snapshot.real_quote, liquidity_bonus: snapshot.liquidity_bonus, lp_tokens: TOKEN_SUPPLY - snapshot.sold }); }
        Ok(())
    }

    /// Permissionless: pays a V2 pool's owed fee shares to the creator reward account, the three reward vaults and the
    /// treasury, before or after migration. Destinations are fixed: the pool's reward wallet, the vault PDAs and the
    /// config's treasury. Liquidity (`real_quote`, `liquidity_bonus`) is never touched.
    pub fn withdraw_v2_fees(ctx: Context<WithdrawV2Fees>) -> Result<()> {
        let info = ctx.accounts.pool.to_account_info();
        let mut ext = V2Ext::read(&info.try_borrow_data()?).ok_or(ElpidaError::NotV2)?;
        let owed = ext.owed();
        require!(owed.iter().any(|v| *v > 0), ElpidaError::NothingToWithdraw);
        for (i, v) in owed.iter().enumerate() { ext.paid[i] = ext.paid[i].checked_add(*v).ok_or(ElpidaError::MathOverflow)?; }
        ext.write(&mut info.try_borrow_mut_data()?)?;
        let (mint_key, bump, pool_key) = (ctx.accounts.pool.mint, ctx.accounts.pool.bump, ctx.accounts.pool.key());
        let a = &ctx.accounts;
        let seeds: &[&[u8]] = &[b"curve", mint_key.as_ref(), &[bump]];
        let to = [a.reward_quote.to_account_info(), a.airdrop_quote.to_account_info(), a.flywheel_quote.to_account_info(), a.holder_quote.to_account_info(), a.treasury_quote.to_account_info()];
        for (i, amount) in owed.into_iter().enumerate() {
            if amount == 0 { continue; }
            quote_transfer(&a.quote_token_program, &a.quote_mint, a.quote_vault.to_account_info(), to[i].clone(), a.pool.to_account_info(), amount, a.quote_mint.decimals, &[seeds])?;
            emit!(V2FeesPaid { pool: pool_key, recipient: i as u8, to: to[i].key(), amount });
        }
        Ok(())
    }

    /// ELPIDA V2 rewards, upgrade authority, once per kind: the distributor's operator (the server keeper) and schedule.
    /// `period` 0 means calendar months from `genesis` (the first of a month, 00:00 UTC); otherwise rounds of `period`
    /// seconds (at least a day) from `genesis` (a UTC midnight). Immutable afterwards, as on EVM.
    pub fn init_v2_distributor(ctx: Context<InitV2Distributor>, kind: u8, operator: Pubkey, period: u32, genesis: i64) -> Result<()> {
        require!(kind <= V2_DIST_HOLDER && operator != Pubkey::default() && genesis > 0 && genesis % 86_400 == 0, ElpidaError::V2Terms);
        let genesis_month = if period == 0 {
            let (y, m, d) = civil(genesis / 86_400);
            require!(d == 1, ElpidaError::V2Terms);
            (y * 12 + m - 1) as u32
        } else { require!(period >= 86_400, ElpidaError::V2Terms); 0 };
        let d = &mut ctx.accounts.distributor;
        d.kind = kind; d.operator = operator; d.period = period; d.genesis = genesis; d.genesis_month = genesis_month; d.bump = ctx.bumps.distributor;
        emit!(V2DistributorSet { kind, operator, period, genesis });
        Ok(())
    }

    /// Operator, after `round` has ended: commits a Merkle root of payouts in `asset` (wrapped SOL means native SOL).
    /// The vault must hold `total` beyond what earlier posted rounds still owe. Leaves are
    /// keccak(keccak("elpida-v2" | program | kind | round | asset | index | account | amount)); pairs hash sorted.
    #[allow(clippy::too_many_arguments)]
    pub fn post_v2_root(ctx: Context<PostV2Root>, kind: u8, round: u32, root: [u8; 32], total: u64, recipients: u32, manifest_uri: String) -> Result<()> {
        let d = &ctx.accounts.distributor;
        require!(d.kind == kind, ElpidaError::V2Terms);
        let now = Clock::get()?.unix_timestamp;
        require!(now >= round_start(d, round.checked_add(1).ok_or(ElpidaError::MathOverflow)?), ElpidaError::RoundNotOver);
        require!(root != [0u8; 32] && total > 0 && recipients > 0 && recipients <= V2_MAX_RECIPIENTS && manifest_uri.len() <= MAX_URI, ElpidaError::V2Terms);
        let asset = ctx.accounts.asset_mint.key();
        let held = vault_holding(&asset, &ctx.accounts.vault.to_account_info(), &ctx.accounts.vault_token.to_account_info())?;
        let ledger = &mut ctx.accounts.ledger;
        if ledger.bump == 0 { ledger.bump = ctx.bumps.ledger; }
        require!(held.saturating_sub(ledger.reserved) >= total, ElpidaError::NotFunded);
        ledger.reserved = ledger.reserved.checked_add(total).ok_or(ElpidaError::MathOverflow)?;
        let r = &mut ctx.accounts.round;
        r.kind = kind; r.round = round; r.asset = asset; r.root = root; r.total = total; r.claimed = 0; r.recipients = recipients;
        r.posted_at = now; r.expired = false; r.bump = ctx.bumps.round;
        emit!(V2RootPosted { kind, round, asset, root, total, recipients, manifest_uri });
        Ok(())
    }

    /// Anyone: pays leaf `index` of a posted round to `account` (native SOL for wrapped SOL, otherwise the asset to the
    /// account's associated token account, created by the payer when missing). Each leaf pays once.
    pub fn claim_v2(ctx: Context<ClaimV2>, kind: u8, round: u32, index: u32, amount: u64, proof: Vec<[u8; 32]>) -> Result<()> {
        let r_info = ctx.accounts.round.to_account_info();
        let (asset, root, recipients, expired) = (ctx.accounts.round.asset, ctx.accounts.round.root, ctx.accounts.round.recipients, ctx.accounts.round.expired);
        require!(!expired, ElpidaError::RoundClosed);
        require!(index < recipients, ElpidaError::BadProof);
        let account = ctx.accounts.recipient.key();
        require!(verify_proof(&proof, root, v2_leaf(kind, round, &asset, index, &account, amount)), ElpidaError::BadProof);
        {
            let mut data = r_info.try_borrow_mut_data()?;
            let (byte, bit) = (8 + V2Round::INIT_SPACE + (index / 8) as usize, 1u8 << (index % 8));
            require!(data.len() > byte, ElpidaError::BadProof);
            require!(data[byte] & bit == 0, ElpidaError::AlreadyPaid);
            data[byte] |= bit;
        }
        let r = &mut ctx.accounts.round;
        r.claimed = r.claimed.checked_add(amount).ok_or(ElpidaError::MathOverflow)?;
        require!(r.claimed <= r.total, ElpidaError::BadProof);
        let ledger = &mut ctx.accounts.ledger;
        ledger.reserved = ledger.reserved.checked_sub(amount).ok_or(ElpidaError::MathOverflow)?;
        let a = &ctx.accounts;
        let seed = v2_vault_seed(kind);
        let vault_seeds: &[&[u8]] = &[b"v2-vault", seed, &[ctx.bumps.vault]];
        if asset == WSOL_MINT {
            invoke_signed(&anchor_lang::solana_program::system_instruction::transfer(&a.vault.key(), &account, amount), &[a.vault.to_account_info(), a.recipient.to_account_info(), a.system_program.to_account_info()], &[vault_seeds])?;
        } else {
            let to = a.recipient_token.as_ref().ok_or(ElpidaError::V2Terms)?;
            ti::transfer_checked(CpiContext::new_with_signer(a.token_program.to_account_info(), ti::TransferChecked { from: a.vault_token.to_account_info(), mint: a.asset_mint.to_account_info(), to: to.to_account_info(), authority: a.vault.to_account_info() }, &[vault_seeds]), amount, a.asset_mint.decimals)?;
        }
        emit!(V2Claimed { kind, round, asset, index, account, amount });
        Ok(())
    }

    /// Anyone, once `V2_CLAIM_WINDOW_ROUNDS` further rounds have started: what a round left unclaimed returns to the
    /// pool for later rounds (it stays in the vault, no longer reserved).
    pub fn expire_v2(ctx: Context<ExpireV2>, kind: u8, round: u32) -> Result<()> {
        let d = &ctx.accounts.distributor;
        let now = Clock::get()?.unix_timestamp;
        require!(now >= round_start(d, round.checked_add(V2_CLAIM_WINDOW_ROUNDS + 1).ok_or(ElpidaError::MathOverflow)?), ElpidaError::RoundNotOver);
        let r = &mut ctx.accounts.round;
        require!(!r.expired, ElpidaError::RoundClosed);
        r.expired = true;
        let left = r.total - r.claimed;
        let ledger = &mut ctx.accounts.ledger;
        ledger.reserved = ledger.reserved.checked_sub(left).ok_or(ElpidaError::MathOverflow)?;
        emit!(V2Expired { kind, round, asset: r.asset, returned_to_pool: left });
        Ok(())
    }

    /// Anyone: turns a distributor's wrapped SOL into native SOL held by its vault PDA (closes the vault's wrapped-SOL
    /// account into it), so SOL rounds pay plain SOL. `withdraw_v2_fees` recreates the account when needed.
    pub fn sweep_v2_sol(ctx: Context<SweepV2Sol>, kind: u8) -> Result<()> {
        let seeds: &[&[u8]] = &[b"v2-vault", v2_vault_seed(kind), &[ctx.bumps.vault]];
        let before = ctx.accounts.vault.lamports();
        token::close_account(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), token::CloseAccount { account: ctx.accounts.vault_wsol.to_account_info(), destination: ctx.accounts.vault.to_account_info(), authority: ctx.accounts.vault.to_account_info() }, &[seeds]))?;
        emit!(V2SolSwept { kind, lamports: ctx.accounts.vault.lamports() - before });
        Ok(())
    }

    /// Stablecoin payouts (Malik, 10 November: "distribution should be in usdc"), operator: converts `amount_in`
    /// lamports of a distributor's SOL that no posted round still owes into USDC through Raydium's WSOL/USDC CPMM pool
    /// (the same 1% fee tier the program graduates into), at least `min_out`. The USDC stays in the vault's USDC account
    /// for USDC rounds (`post_v2_root` with the USDC mint); nothing can go anywhere else. USDC is the pricing config's.
    pub fn v2_convert_usdc(ctx: Context<V2ConvertUsdc>, kind: u8, amount_in: u64, min_out: u64) -> Result<()> {
        let a = &ctx.accounts;
        require!(amount_in > 0 && min_out > 0, ElpidaError::V2Terms);
        require!(a.pricing.usdc_mint != Pubkey::default() && a.usdc_mint.key() == a.pricing.usdc_mint, ElpidaError::UsdcFeeUnavailable);
        // SOL not promised to a posted round: the vault's lamports above rent, less the SOL ledger's reserve.
        let reserved = {
            let info = a.sol_ledger.to_account_info();
            if info.data_len() == 0 { 0 } else {
                require_keys_eq!(*info.owner, crate::ID, ElpidaError::V2Terms);
                let data = info.try_borrow_data()?;
                V2AssetLedger::try_deserialize(&mut &data[..])?.reserved
            }
        };
        let free = a.vault.lamports().saturating_sub(EMPTY_ACCOUNT_RENT).saturating_sub(reserved);
        require!(amount_in <= free, ElpidaError::NotFunded);
        let (_, usdc_is_0) = read_raydium(&a.ray_pool.to_account_info(), &a.ray_vault_0.to_account_info(), &a.ray_vault_1.to_account_info(), &a.usdc_mint.key())?;
        {
            // The other side must be wrapped SOL.
            let data = a.ray_pool.try_borrow_data()?;
            let other = if usdc_is_0 { RAY_POOL_MINT_0 + 32 } else { RAY_POOL_MINT_0 };
            require!(data[other..other + 32] == WSOL_MINT.to_bytes(), ElpidaError::RaydiumAccount);
        }
        let seed = v2_vault_seed(kind);
        let vault_seeds: &[&[u8]] = &[b"v2-vault", seed, &[ctx.bumps.vault]];
        // Wrap: the vault PDA (system-owned, data-less) sends the lamports to its wrapped-SOL account.
        invoke_signed(&anchor_lang::solana_program::system_instruction::transfer(&a.vault.key(), &a.vault_wsol.key(), amount_in),
            &[a.vault.to_account_info(), a.vault_wsol.to_account_info(), a.system_program.to_account_info()], &[vault_seeds])?;
        token::sync_native(CpiContext::new(a.token_program.to_account_info(), token::SyncNative { account: a.vault_wsol.to_account_info() }))?;
        let before = token_amount(&a.vault_usdc.to_account_info())?;
        let mut data = Vec::with_capacity(24);
        data.extend_from_slice(&RAY_SWAP_BASE_INPUT);
        data.extend_from_slice(&amount_in.to_le_bytes());
        data.extend_from_slice(&min_out.to_le_bytes());
        let (input_vault, output_vault) = if usdc_is_0 { (a.ray_vault_1.to_account_info(), a.ray_vault_0.to_account_info()) } else { (a.ray_vault_0.to_account_info(), a.ray_vault_1.to_account_info()) };
        let infos = [
            a.vault.to_account_info(), a.ray_authority.to_account_info(), a.amm_config.to_account_info(), a.ray_pool.to_account_info(),
            a.vault_wsol.to_account_info(), a.vault_usdc.to_account_info(), input_vault, output_vault,
            a.token_program.to_account_info(), a.token_program.to_account_info(), a.wsol_mint.to_account_info(), a.usdc_mint.to_account_info(), a.observation.to_account_info(),
        ];
        const WRITABLE: [bool; 13] = [false, false, false, true, true, true, true, true, false, false, false, false, true];
        let accounts = infos.iter().enumerate().map(|(i, info)| AccountMeta { pubkey: *info.key, is_signer: i == 0, is_writable: WRITABLE[i] }).collect();
        invoke_signed(&Instruction { program_id: raydium::PROGRAM, accounts, data }, &infos, &[vault_seeds])?;
        let got = token_amount(&a.vault_usdc.to_account_info())?.checked_sub(before).ok_or(ElpidaError::MathOverflow)?;
        require!(got >= min_out, ElpidaError::Slippage);
        emit!(V2ConvertedToUsdc { kind, sol_in: amount_in, usdc_out: got });
        Ok(())
    }

    /// Flywheel, operator: buys a V2 token on its curve with the flywheel vault's `amount_in` of quote and burns what it
    /// buys. The token must be at least a day old, an order at most 10% of the vault, one order per token every 6 hours,
    /// and the order may not complete the curve (graduation stays with traders). It pays the token's fee like any buy.
    pub fn v2_flywheel_curve(ctx: Context<V2FlywheelCurve>, amount_in: u64, min_out: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let cfg: CurveConfig = **ctx.accounts.curve_config;
        let mut v2 = v2_of(&cfg, &ctx.accounts.pool.to_account_info())?.ok_or(ElpidaError::NotV2)?;
        let (created_at, vault_balance) = (ctx.accounts.pool.created_at, token_amount(&ctx.accounts.vault_quote.to_account_info())?);
        flywheel_checks(&mut ctx.accounts.order, ctx.bumps.order, created_at, now, amount_in, vault_balance)?;
        let pool = &mut ctx.accounts.pool;
        require!(pool.status == STATUS_TRADING, ElpidaError::CurveClosed);
        let trade = quote_buy(pool, amount_in, v2_fee_bps(v2.fee_bps, pool.created_at, now), v2.fee_bps as u64)?;
        require!(!trade.graduates, ElpidaError::FlywheelWouldComplete);
        require!(trade.tokens >= min_out, ElpidaError::Slippage);
        v2_apply_buy(pool, &mut v2, &trade, now)?;
        let (mint_key, bump, pool_key) = (pool.mint, pool.bump, pool.key());
        v2.write(&mut ctx.accounts.pool.to_account_info().try_borrow_mut_data()?)?;
        let a = &ctx.accounts;
        let vault_seeds: &[&[u8]] = &[b"v2-vault", V2_VAULT_FLYWHEEL, &[ctx.bumps.vault]];
        quote_transfer(&a.quote_token_program, &a.quote_mint, a.vault_quote.to_account_info(), a.quote_vault.to_account_info(), a.vault.to_account_info(), trade.gross, a.quote_mint.decimals, &[vault_seeds])?;
        // The bought tokens never leave the curve vault: they are burned there (the curve PDA signs).
        let curve_seeds: &[&[u8]] = &[b"curve", mint_key.as_ref(), &[bump]];
        burn_from_vault(&a.token_program, &a.mint.to_account_info(), &a.token_vault.to_account_info(), &a.pool.to_account_info(), curve_seeds, trade.tokens)?;
        // `mint.supply` is the value before this burn (the account is not reloaded).
        let (asset, supply_after) = (a.quote_mint.key(), a.mint.supply.checked_sub(trade.tokens).ok_or(ElpidaError::MathOverflow)?);
        let order = &mut ctx.accounts.order;
        order.spent = order.spent.checked_add(trade.gross).ok_or(ElpidaError::MathOverflow)?;
        order.burned = order.burned.checked_add(trade.tokens).ok_or(ElpidaError::MathOverflow)?;
        emit!(V2BoughtAndBurned { pool: pool_key, mint: mint_key, asset, spent: trade.gross, burned: trade.tokens, supply_after, venue: 0 });
        Ok(())
    }

    /// Flywheel after graduation to Raydium (SOL pairs), operator: swaps the flywheel vault's wrapped SOL for the token
    /// through the locked pool and burns everything it buys. Same limits as `v2_flywheel_curve`; `min_out` guards price.
    pub fn v2_flywheel_raydium(ctx: Context<V2FlywheelRaydium>, amount_in: u64, min_out: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(ctx.accounts.curve_config.model_version == V2_MODEL_VERSION, ElpidaError::NotV2);
        let (created_at, vault_balance) = (ctx.accounts.pool.created_at, token_amount(&ctx.accounts.vault_quote.to_account_info())?);
        flywheel_checks(&mut ctx.accounts.order, ctx.bumps.order, created_at, now, amount_in, vault_balance)?;
        let a = &ctx.accounts;
        let mint_key = a.mint.key();
        let (_, base_is_0) = read_raydium(&a.ray_pool.to_account_info(), &a.ray_vault_0.to_account_info(), &a.ray_vault_1.to_account_info(), &mint_key)?;
        let vault_seeds: &[&[u8]] = &[b"v2-vault", V2_VAULT_FLYWHEEL, &[ctx.bumps.vault]];
        let before = token_amount(&a.vault_base.to_account_info())?;
        let mut data = Vec::with_capacity(24);
        data.extend_from_slice(&RAY_SWAP_BASE_INPUT);
        data.extend_from_slice(&amount_in.to_le_bytes());
        data.extend_from_slice(&min_out.max(1).to_le_bytes());
        let (input_vault, output_vault) = if base_is_0 { (a.ray_vault_1.to_account_info(), a.ray_vault_0.to_account_info()) } else { (a.ray_vault_0.to_account_info(), a.ray_vault_1.to_account_info()) };
        let infos = [
            a.vault.to_account_info(), a.ray_authority.to_account_info(), a.amm_config.to_account_info(), a.ray_pool.to_account_info(),
            a.vault_quote.to_account_info(), a.vault_base.to_account_info(), input_vault, output_vault,
            a.token_program.to_account_info(), a.token_program.to_account_info(), a.quote_mint.to_account_info(), a.mint.to_account_info(), a.observation.to_account_info(),
        ];
        const WRITABLE: [bool; 13] = [false, false, false, true, true, true, true, true, false, false, false, false, true];
        let accounts = infos.iter().enumerate().map(|(i, info)| AccountMeta { pubkey: *info.key, is_signer: i == 0, is_writable: WRITABLE[i] }).collect();
        invoke_signed(&Instruction { program_id: raydium::PROGRAM, accounts, data }, &infos, &[vault_seeds])?;
        let bought = token_amount(&a.vault_base.to_account_info())?.checked_sub(before).ok_or(ElpidaError::MathOverflow)?;
        require!(bought >= min_out, ElpidaError::Slippage);
        token::burn(CpiContext::new_with_signer(a.token_program.to_account_info(), Burn { mint: a.mint.to_account_info(), from: a.vault_base.to_account_info(), authority: a.vault.to_account_info() }, &[vault_seeds]), bought)?;
        // SPL mint layout: supply is the u64 at bytes 36..44.
        let supply = { let data = a.mint.try_borrow_data()?; u64::from_le_bytes(data[36..44].try_into().map_err(|_| ElpidaError::MathOverflow)?) };
        let pool_key = a.pool.key();
        let order = &mut ctx.accounts.order;
        order.spent = order.spent.checked_add(amount_in).ok_or(ElpidaError::MathOverflow)?;
        order.burned = order.burned.checked_add(bought).ok_or(ElpidaError::MathOverflow)?;
        emit!(V2BoughtAndBurned { pool: pool_key, mint: mint_key, asset: WSOL_MINT, spent: amount_in, burned: bought, supply_after: supply, venue: 1 });
        Ok(())
    }

    /// Permissionless escape hatch (D7): a curve that completed but has not migrated within
    /// `GRADUATION_GRACE_SECS` returns to trading with its reserves unchanged, so holders can sell (or buy
    /// back what others sold). Completing it again restarts the grace period. The locked anti-snipe bonus
    /// stays in the vault for the eventual migration.
    pub fn reopen_curve(ctx: Context<ReopenCurve>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let pool = &mut ctx.accounts.pool;
        require!(pool.status == STATUS_GRADUATED, ElpidaError::NotComplete);
        let open_at = pool.graduated_at.checked_add(GRADUATION_GRACE_SECS).ok_or(ElpidaError::MathOverflow)?;
        require!(now >= open_at, ElpidaError::GraceNotOver);
        pool.status = STATUS_TRADING;
        emit!(CurveReopened { pool: pool.key(), mint: pool.mint, graduated_at: pool.graduated_at, reopened_at: now, real_quote: pool.real_quote, liquidity_bonus: pool.liquidity_bonus });
        Ok(())
    }

    #[cfg(feature = "testnet")]
    /// Permissionless once the curve is complete (pairs other than SOL): seeds a PumpSwap pool with the remaining supply and
    /// all raised quote (curve reserve + locked anti-snipe bonus). The LP tokens stay in a program PDA
    /// forever. The caller pays PumpSwap's account rent (refunded surplus) and the transaction fee.
    pub fn migrate_to_pumpswap(ctx: Context<MigrateToPumpswap>) -> Result<()> {
        require!(ctx.accounts.pool.status == STATUS_GRADUATED, ElpidaError::NotComplete);
        require_keys_neq!(ctx.accounts.quote_mint.key(), WSOL_MINT, ElpidaError::WrongVenue);
        require!(!locked_pool_venue(&ctx.accounts.quote_mint.to_account_info())?, ElpidaError::WrongVenue);
        let pool = &ctx.accounts.pool;
        let base_amount = TOKEN_SUPPLY - pool.sold;
        let quote_amount = pool.real_quote.checked_add(pool.liquidity_bonus).ok_or(ElpidaError::MathOverflow)?;
        let (mint_key, pool_bump) = (pool.mint, pool.bump);
        let a = &ctx.accounts;
        let curve_seeds: &[&[u8]] = &[b"curve", mint_key.as_ref(), &[pool_bump]];
        // Move the liquidity from the curve vaults to the LP authority, which deposits it.
        token::transfer(
            CpiContext::new_with_signer(a.token_program.to_account_info(), Transfer { from: a.token_vault.to_account_info(), to: a.authority_base.to_account_info(), authority: a.pool.to_account_info() }, &[curve_seeds]),
            base_amount,
        )?;
        quote_transfer(&a.quote_token_program, &a.quote_mint, a.quote_vault.to_account_info(), a.authority_quote.to_account_info(), a.pool.to_account_info(), quote_amount, a.quote_mint.decimals, &[curve_seeds])?;
        system_program::transfer(
            CpiContext::new(a.system_program.to_account_info(), system_program::Transfer { from: a.payer.to_account_info(), to: a.lp_authority.to_account_info() }),
            MIGRATION_RENT_LAMPORTS,
        )?;
        let authority_bump = ctx.bumps.lp_authority;
        let authority_seeds: &[&[u8]] = &[b"pump-lp", mint_key.as_ref(), &[authority_bump]];
        let mut data = Vec::with_capacity(8 + 2 + 8 + 8 + 32 + 2 + 8 + 2);
        data.extend_from_slice(&PUMP_CREATE_POOL);
        data.extend_from_slice(&0u16.to_le_bytes()); // index
        data.extend_from_slice(&base_amount.to_le_bytes());
        data.extend_from_slice(&quote_amount.to_le_bytes());
        data.extend_from_slice(Pubkey::default().as_ref()); // coin_creator (ignored for non-pump pools)
        data.extend_from_slice(&[0, 0]); // is_mayhem_mode, is_cashback_coin
        data.extend_from_slice(&0u64.to_le_bytes()); // creator_fee_bps
        data.extend_from_slice(&[0, 0]); // can_edit_creator_fee, is_holder_reward
        let accounts = vec![
            AccountMeta::new(a.pump_pool.key(), false),
            AccountMeta::new_readonly(a.pump_global_config.key(), false),
            AccountMeta::new(a.lp_authority.key(), true),
            AccountMeta::new_readonly(a.mint.key(), false),
            AccountMeta::new_readonly(a.quote_mint.key(), false),
            AccountMeta::new(a.lp_mint.key(), false),
            AccountMeta::new(a.authority_base.key(), false),
            AccountMeta::new(a.authority_quote.key(), false),
            AccountMeta::new(a.authority_lp.key(), false),
            AccountMeta::new(a.pump_pool_base.key(), false),
            AccountMeta::new(a.pump_pool_quote.key(), false),
            AccountMeta::new_readonly(a.system_program.key(), false),
            AccountMeta::new_readonly(a.token_2022_program.key(), false),
            AccountMeta::new_readonly(a.token_program.key(), false),
            AccountMeta::new_readonly(a.quote_token_program.key(), false),
            AccountMeta::new_readonly(a.associated_token_program.key(), false),
            AccountMeta::new_readonly(a.pump_event_authority.key(), false),
            AccountMeta::new_readonly(a.pump_amm_program.key(), false),
        ];
        invoke_signed(
            &Instruction { program_id: PUMP_AMM, accounts, data },
            &[
                a.pump_pool.to_account_info(), a.pump_global_config.to_account_info(), a.lp_authority.to_account_info(), a.mint.to_account_info(),
                a.quote_mint.to_account_info(), a.lp_mint.to_account_info(), a.authority_base.to_account_info(), a.authority_quote.to_account_info(),
                a.authority_lp.to_account_info(), a.pump_pool_base.to_account_info(), a.pump_pool_quote.to_account_info(), a.system_program.to_account_info(),
                a.token_2022_program.to_account_info(), a.token_program.to_account_info(), a.quote_token_program.to_account_info(), a.associated_token_program.to_account_info(),
                a.pump_event_authority.to_account_info(), a.pump_amm_program.to_account_info(),
            ],
            &[authority_seeds],
        )?;
        // Refund the unused rent advance.
        let leftover = a.lp_authority.lamports();
        if leftover > 0 {
            invoke_signed(
                &anchor_lang::solana_program::system_instruction::transfer(&a.lp_authority.key(), &a.payer.key(), leftover),
                &[a.lp_authority.to_account_info(), a.payer.to_account_info(), a.system_program.to_account_info()],
                &[authority_seeds],
            )?;
        }

        let lp_locked = token_amount(&a.authority_lp.to_account_info())?;
        let state = PumpState::read(&a.pump_pool.to_account_info(), &a.pump_pool_base.to_account_info(), &a.pump_pool_quote.to_account_info())?;
        require!(lp_locked > 0 && state.lp_supply > 0, ElpidaError::PumpAccount);
        let principal = liquidity_units(lp_locked, &state)?;
        let now = Clock::get()?.unix_timestamp;
        let (pump_pool, lp_mint, pool_key) = (a.pump_pool.key(), a.lp_mint.key(), a.pool.key());
        let migration = &mut ctx.accounts.migration;
        migration.curve_pool = pool_key;
        migration.mint = mint_key;
        migration.pump_pool = pump_pool;
        migration.lp_mint = lp_mint;
        migration.lp_locked = lp_locked;
        migration.principal = principal;
        migration.base_migrated = base_amount;
        migration.quote_migrated = quote_amount;
        migration.harvested_lp = 0;
        migration.harvested_base = 0;
        migration.harvested_quote = 0;
        migration.migrated_at = now;
        migration.bump = ctx.bumps.migration;
        migration.authority_bump = authority_bump;
        MigrationExt::default().write(&mut ctx.accounts.migration.to_account_info().try_borrow_mut_data()?)?;
        let pool = &mut ctx.accounts.pool;
        pool.status = STATUS_MIGRATED;
        pool.real_quote = 0;
        pool.liquidity_bonus = 0;
        emit!(CurveMigrated { pool: pool_key, mint: mint_key, pump_pool, lp_mint, base_amount, quote_amount, lp_locked });
        Ok(())
    }

    #[cfg(feature = "testnet")]
    /// Permissionless: withdraws only the LP tokens that represent trading-fee growth since migration
    /// (liquidity units above the migrated principal) and splits the proceeds 50/50 between the
    /// protocol treasury and the creator reward wallet. The principal liquidity stays locked.
    /// Partner pools: the burn share comes out of the protocol half. Its token side is burned now (the mint must be
    /// passed writable to burn). PumpSwap pools have no buyback, so the quote side of that share goes to the treasury
    /// with the rest of the protocol half instead of waiting forever (review finding S-2), and any quote an earlier
    /// build left queued here is released to the treasury too.
    pub fn harvest_lp_fees<'info>(ctx: Context<'_, '_, 'info, 'info, HarvestLpFees<'info>>) -> Result<()> {
        ctx.accounts.check_token_accounts()?;
        let v2 = ctx.accounts.curve_config.model_version == V2_MODEL_VERSION;
        let a = &ctx.accounts;
        let state = PumpState::read(&a.pump_pool.to_account_info(), &a.pump_pool_base.to_account_info(), &a.pump_pool_quote.to_account_info())?;
        let lp_locked = token_amount(&a.authority_lp.to_account_info())?;
        let harvest = harvestable_lp(lp_locked, a.migration.principal, &state)?;
        // Ignore rounding dust: a harvest must be at least 0.01% of the locked position.
        require!(harvest > 0 && harvest as u128 * MIN_HARVEST_DIVISOR >= lp_locked as u128, ElpidaError::NothingToHarvest);
        let mint_key = a.mint.key();
        let authority_seeds: &[&[u8]] = &[b"pump-lp", mint_key.as_ref(), &[a.migration.authority_bump]];
        let (base_before, quote_before) = (token_amount(&a.authority_base.to_account_info())?, token_amount(&a.authority_quote.to_account_info())?);
        let mut data = Vec::with_capacity(32);
        data.extend_from_slice(&PUMP_WITHDRAW);
        data.extend_from_slice(&harvest.to_le_bytes());
        data.extend_from_slice(&0u64.to_le_bytes());
        data.extend_from_slice(&0u64.to_le_bytes());
        let accounts = vec![
            AccountMeta::new(a.pump_pool.key(), false),
            AccountMeta::new_readonly(a.pump_global_config.key(), false),
            AccountMeta::new_readonly(a.lp_authority.key(), true),
            AccountMeta::new_readonly(a.mint.key(), false),
            AccountMeta::new_readonly(a.quote_mint.key(), false),
            AccountMeta::new(a.lp_mint.key(), false),
            AccountMeta::new(a.authority_base.key(), false),
            AccountMeta::new(a.authority_quote.key(), false),
            AccountMeta::new(a.authority_lp.key(), false),
            AccountMeta::new(a.pump_pool_base.key(), false),
            AccountMeta::new(a.pump_pool_quote.key(), false),
            AccountMeta::new_readonly(a.token_program.key(), false),
            AccountMeta::new_readonly(a.token_2022_program.key(), false),
            AccountMeta::new_readonly(a.pump_event_authority.key(), false),
            AccountMeta::new_readonly(a.pump_amm_program.key(), false),
        ];
        invoke_signed(
            &Instruction { program_id: PUMP_AMM, accounts, data },
            &[
                a.pump_pool.to_account_info(), a.pump_global_config.to_account_info(), a.lp_authority.to_account_info(), a.mint.to_account_info(),
                a.quote_mint.to_account_info(), a.lp_mint.to_account_info(), a.authority_base.to_account_info(), a.authority_quote.to_account_info(),
                a.authority_lp.to_account_info(), a.pump_pool_base.to_account_info(), a.pump_pool_quote.to_account_info(), a.token_program.to_account_info(),
                a.token_2022_program.to_account_info(), a.pump_event_authority.to_account_info(), a.pump_amm_program.to_account_info(),
            ],
            &[authority_seeds],
        )?;
        let base_out = token_amount(&a.authority_base.to_account_info())?.checked_sub(base_before).ok_or(ElpidaError::MathOverflow)?;
        let quote_out = token_amount(&a.authority_quote.to_account_info())?.checked_sub(quote_before).ok_or(ElpidaError::MathOverflow)?;
        if v2 {
            let lp_after = token_amount(&a.authority_lp.to_account_info())?;
            let after = PumpState::read(&a.pump_pool.to_account_info(), &a.pump_pool_base.to_account_info(), &a.pump_pool_quote.to_account_info())?;
            require!(liquidity_units(lp_after, &after)? >= a.migration.principal, ElpidaError::PrincipalBreached);
            V2Harvest {
                token_program: a.token_program.to_account_info(), quote_program: a.quote_program_info(), mint: a.mint.to_account_info(), quote_mint: a.quote_mint.to_account_info(),
                quote_decimals: a.curve_config.quote_decimals, lp_authority: a.lp_authority.to_account_info(), seeds: authority_seeds,
                authority_base: a.authority_base.to_account_info(), authority_quote: a.authority_quote.to_account_info(), pool: a.pool.to_account_info(),
            }.settle(ctx.remaining_accounts, base_out, quote_out)?;
            let (pool_key, pump_pool) = (a.pool.key(), a.pump_pool.key());
            let migration = &mut ctx.accounts.migration;
            migration.lp_locked = lp_after;
            migration.harvested_lp = migration.harvested_lp.checked_add(harvest).ok_or(ElpidaError::MathOverflow)?;
            migration.harvested_base = migration.harvested_base.checked_add(base_out).ok_or(ElpidaError::MathOverflow)?;
            migration.harvested_quote = migration.harvested_quote.checked_add(quote_out).ok_or(ElpidaError::MathOverflow)?;
            emit!(LpFeesHarvested { pool: pool_key, pump_pool, lp_burned: harvest, base_out, quote_out, protocol_base: 0, protocol_quote: 0, lp_locked: lp_after });
            return Ok(());
        }
        let buyback_bps = PoolExt::read(&a.pool.to_account_info().try_borrow_data()?).buyback_bps as u128;
        let payout = HarvestPayout {
            token_program: a.token_program.to_account_info(), quote_program: a.quote_program_info(), mint: a.mint.to_account_info(), quote_mint: a.quote_mint.to_account_info(),
            quote_decimals: a.curve_config.quote_decimals, lp_authority: a.lp_authority.to_account_info(), seeds: authority_seeds,
            authority_base: a.authority_base.to_account_info(), authority_quote: a.authority_quote.to_account_info(), treasury_base: a.treasury_base.to_account_info(),
            treasury_quote: a.treasury_quote.to_account_info(), reward_base: a.reward_base.to_account_info(), reward_quote: a.reward_quote.to_account_info(),
        };
        let split = payout.pay(base_out, quote_out, buyback_bps, 0)?;
        let (protocol_base, protocol_quote) = (split.protocol_base, split.protocol_quote);
        let after = PumpState::read(&a.pump_pool.to_account_info(), &a.pump_pool_base.to_account_info(), &a.pump_pool_quote.to_account_info())?;
        let lp_after = token_amount(&a.authority_lp.to_account_info())?;
        require!(liquidity_units(lp_after, &after)? >= a.migration.principal, ElpidaError::PrincipalBreached);
        let (pool_key, pump_pool) = (a.pool.key(), a.pump_pool.key());
        if buyback_bps > 0 { split.record(&ctx.accounts.migration.to_account_info(), pool_key)?; }
        payout.release_stranded(&ctx.accounts.migration.to_account_info(), pool_key)?;
        let migration = &mut ctx.accounts.migration;
        migration.lp_locked = lp_after;
        migration.harvested_lp = migration.harvested_lp.checked_add(harvest).ok_or(ElpidaError::MathOverflow)?;
        migration.harvested_base = migration.harvested_base.checked_add(base_out).ok_or(ElpidaError::MathOverflow)?;
        migration.harvested_quote = migration.harvested_quote.checked_add(quote_out).ok_or(ElpidaError::MathOverflow)?;
        emit!(LpFeesHarvested { pool: pool_key, pump_pool, lp_burned: harvest, base_out, quote_out, protocol_base, protocol_quote, lp_locked: lp_after });
        Ok(())
    }

    /// Permissionless once a SOL-pair curve is complete: seeds a Raydium CPMM pool (1% fee tier) with the remaining
    /// supply and all raised SOL (curve reserve + locked anti-snipe bonus), less Raydium's pool-creation fee and the
    /// rent of the accounts it opens, which the raised SOL pays. The pool lives at Elpida's own PDA ["ray-pool", mint]
    /// (Raydium accepts a signed non-canonical address), so nobody can create it first. The LP authority PDA creates the
    /// pool and holds its LP tokens forever. The caller lends the fee and rent in lamports for the duration of the
    /// instruction and is repaid in full from the raised SOL, so graduating costs the caller only the transaction fee.
    pub fn migrate_to_raydium(ctx: Context<MigrateToRaydium>) -> Result<()> {
        require!(ctx.accounts.pool.status == STATUS_GRADUATED, ElpidaError::NotComplete);
        let cost = raydium_creation_cost(raydium_create_fee(&ctx.accounts.amm_config.to_account_info())?, &Rent::get()?)?;
        let pool = &ctx.accounts.pool;
        let base_amount = TOKEN_SUPPLY - pool.sold;
        let raised = pool.real_quote.checked_add(pool.liquidity_bonus).ok_or(ElpidaError::MathOverflow)?;
        let quote_amount = raised.checked_sub(cost).filter(|q| *q > 0).ok_or(ElpidaError::MathOverflow)?;
        let (mint_key, pool_bump) = (pool.mint, pool.bump);
        let a = &ctx.accounts;
        let curve_seeds: &[&[u8]] = &[b"curve", mint_key.as_ref(), &[pool_bump]];
        // Move the liquidity from the curve vaults to the LP authority, which deposits it.
        token::transfer(
            CpiContext::new_with_signer(a.token_program.to_account_info(), Transfer { from: a.token_vault.to_account_info(), to: a.authority_base.to_account_info(), authority: a.pool.to_account_info() }, &[curve_seeds]),
            base_amount,
        )?;
        token::transfer(
            CpiContext::new_with_signer(a.token_program.to_account_info(), Transfer { from: a.quote_vault.to_account_info(), to: a.authority_quote.to_account_info(), authority: a.pool.to_account_info() }, &[curve_seeds]),
            raised,
        )?;
        system_program::transfer(
            CpiContext::new(a.system_program.to_account_info(), system_program::Transfer { from: a.payer.to_account_info(), to: a.lp_authority.to_account_info() }),
            cost,
        )?;
        let authority_bump = ctx.bumps.lp_authority;
        let authority_seeds: &[&[u8]] = &[b"pump-lp", mint_key.as_ref(), &[authority_bump]];
        let ray_pool_seeds: &[&[u8]] = &[b"ray-pool", mint_key.as_ref(), &[ctx.bumps.ray_pool]];
        let base_is_0 = mint_key.to_bytes() < WSOL_MINT.to_bytes();
        let (amount_0, amount_1) = if base_is_0 { (base_amount, quote_amount) } else { (quote_amount, base_amount) };
        let (mint_0, mint_1) = if base_is_0 { (a.mint.to_account_info(), a.quote_mint.to_account_info()) } else { (a.quote_mint.to_account_info(), a.mint.to_account_info()) };
        let (creator_0, creator_1) = if base_is_0 { (a.authority_base.to_account_info(), a.authority_quote.to_account_info()) } else { (a.authority_quote.to_account_info(), a.authority_base.to_account_info()) };
        let mut data = Vec::with_capacity(32);
        data.extend_from_slice(&RAY_INITIALIZE);
        data.extend_from_slice(&amount_0.to_le_bytes());
        data.extend_from_slice(&amount_1.to_le_bytes());
        data.extend_from_slice(&0u64.to_le_bytes()); // open_time: Raydium opens trading one second later
        let infos = [
            a.lp_authority.to_account_info(), a.amm_config.to_account_info(), a.ray_authority.to_account_info(), a.ray_pool.to_account_info(),
            mint_0, mint_1, a.lp_mint.to_account_info(), creator_0, creator_1, a.authority_lp.to_account_info(),
            a.ray_vault_0.to_account_info(), a.ray_vault_1.to_account_info(), a.create_pool_fee.to_account_info(), a.observation.to_account_info(),
            a.token_program.to_account_info(), a.token_program.to_account_info(), a.token_program.to_account_info(),
            a.associated_token_program.to_account_info(), a.system_program.to_account_info(), a.rent.to_account_info(),
        ];
        // creator, amm_config, authority, pool_state, token_0_mint, token_1_mint, lp_mint, creator_token_0, creator_token_1, creator_lp_token,
        // token_0_vault, token_1_vault, create_pool_fee, observation_state, token_program, token_0_program, token_1_program,
        // associated_token_program, system_program, rent
        const WRITABLE: [bool; 20] = [true, false, false, true, false, false, true, true, true, true, true, true, true, true, false, false, false, false, false, false];
        let accounts = infos.iter().enumerate().map(|(i, info)| AccountMeta { pubkey: *info.key, is_signer: i == 0 || i == 3, is_writable: WRITABLE[i] }).collect();
        invoke_signed(&Instruction { program_id: raydium::PROGRAM, accounts, data }, &infos, &[authority_seeds, ray_pool_seeds])?;
        // Repay the caller: the SOL left with the LP authority (raised minus deposited, = the fee and rent it paid)
        // unwraps into the LP authority, and everything it holds goes back to the caller.
        token::close_account(CpiContext::new_with_signer(
            a.token_program.to_account_info(),
            token::CloseAccount { account: a.authority_quote.to_account_info(), destination: a.lp_authority.to_account_info(), authority: a.lp_authority.to_account_info() },
            &[authority_seeds],
        ))?;
        let repaid = a.lp_authority.lamports();
        invoke_signed(
            &anchor_lang::solana_program::system_instruction::transfer(&a.lp_authority.key(), &a.payer.key(), repaid),
            &[a.lp_authority.to_account_info(), a.payer.to_account_info(), a.system_program.to_account_info()],
            &[authority_seeds],
        )?;

        let lp_locked = token_amount(&a.authority_lp.to_account_info())?;
        let (state, _) = read_raydium(&a.ray_pool.to_account_info(), &a.ray_vault_0.to_account_info(), &a.ray_vault_1.to_account_info(), &mint_key)?;
        require!(lp_locked > 0 && state.lp_supply > 0 && state.base == base_amount && state.quote == quote_amount, ElpidaError::RaydiumAccount);
        let principal = liquidity_units(lp_locked, &state)?;
        let now = Clock::get()?.unix_timestamp;
        let (ray_pool, lp_mint, pool_key) = (a.ray_pool.key(), a.lp_mint.key(), a.pool.key());
        let migration = &mut ctx.accounts.migration;
        migration.curve_pool = pool_key;
        migration.mint = mint_key;
        migration.pump_pool = ray_pool;
        migration.lp_mint = lp_mint;
        migration.lp_locked = lp_locked;
        migration.principal = principal;
        migration.base_migrated = base_amount;
        migration.quote_migrated = quote_amount;
        migration.harvested_lp = 0;
        migration.harvested_base = 0;
        migration.harvested_quote = 0;
        migration.migrated_at = now;
        migration.bump = ctx.bumps.migration;
        migration.authority_bump = authority_bump;
        MigrationExt { venue: VENUE_RAYDIUM, ..Default::default() }.write(&mut ctx.accounts.migration.to_account_info().try_borrow_mut_data()?)?;
        let pool = &mut ctx.accounts.pool;
        pool.status = STATUS_MIGRATED;
        pool.real_quote = 0;
        pool.liquidity_bonus = 0;
        emit!(CurveMigrated { pool: pool_key, mint: mint_key, pump_pool: ray_pool, lp_mint, base_amount, quote_amount, lp_locked });
        emit!(RaydiumMigrated { pool: pool_key, ray_pool, lp_mint, raised, creation_cost: cost, repaid });
        Ok(())
    }

    /// Permissionless: the Raydium counterpart of `harvest_lp_fees`. Withdraws only the LP tokens that represent
    /// trading-fee growth since migration and splits the proceeds the same way; the principal liquidity stays locked.
    pub fn harvest_raydium_fees<'info>(ctx: Context<'_, '_, 'info, 'info, HarvestRaydiumFees<'info>>) -> Result<()> {
        ctx.accounts.check_token_accounts()?;
        let v2 = ctx.accounts.curve_config.model_version == V2_MODEL_VERSION;
        let a = &ctx.accounts;
        let mint_key = a.mint.key();
        let (state, base_is_0) = read_raydium(&a.ray_pool.to_account_info(), &a.ray_vault_0.to_account_info(), &a.ray_vault_1.to_account_info(), &mint_key)?;
        let lp_locked = token_amount(&a.authority_lp.to_account_info())?;
        let harvest = harvestable_lp(lp_locked, a.migration.principal, &state)?;
        require!(harvest > 0 && harvest as u128 * MIN_HARVEST_DIVISOR >= lp_locked as u128, ElpidaError::NothingToHarvest);
        let authority_seeds: &[&[u8]] = &[b"pump-lp", mint_key.as_ref(), &[a.migration.authority_bump]];
        let (base_before, quote_before) = (token_amount(&a.authority_base.to_account_info())?, token_amount(&a.authority_quote.to_account_info())?);
        let mut data = Vec::with_capacity(32);
        data.extend_from_slice(&RAY_WITHDRAW);
        data.extend_from_slice(&harvest.to_le_bytes());
        data.extend_from_slice(&0u64.to_le_bytes());
        data.extend_from_slice(&0u64.to_le_bytes());
        let (account_0, account_1) = if base_is_0 { (a.authority_base.to_account_info(), a.authority_quote.to_account_info()) } else { (a.authority_quote.to_account_info(), a.authority_base.to_account_info()) };
        let (mint_0, mint_1) = if base_is_0 { (a.mint.to_account_info(), a.quote_mint.to_account_info()) } else { (a.quote_mint.to_account_info(), a.mint.to_account_info()) };
        let infos = [
            a.lp_authority.to_account_info(), a.ray_authority.to_account_info(), a.ray_pool.to_account_info(), a.authority_lp.to_account_info(),
            account_0, account_1, a.ray_vault_0.to_account_info(), a.ray_vault_1.to_account_info(),
            a.token_program.to_account_info(), a.token_2022_program.to_account_info(), mint_0, mint_1, a.lp_mint.to_account_info(), a.memo_program.to_account_info(),
        ];
        // owner, authority, pool_state, owner_lp_token, token_0_account, token_1_account, token_0_vault, token_1_vault,
        // token_program, token_program_2022, vault_0_mint, vault_1_mint, lp_mint, memo_program
        const WRITABLE: [bool; 14] = [false, false, true, true, true, true, true, true, false, false, false, false, true, false];
        let accounts = infos.iter().enumerate().map(|(i, info)| AccountMeta { pubkey: *info.key, is_signer: i == 0, is_writable: WRITABLE[i] }).collect();
        invoke_signed(&Instruction { program_id: raydium::PROGRAM, accounts, data }, &infos, &[authority_seeds])?;
        let base_out = token_amount(&a.authority_base.to_account_info())?.checked_sub(base_before).ok_or(ElpidaError::MathOverflow)?;
        let quote_out = token_amount(&a.authority_quote.to_account_info())?.checked_sub(quote_before).ok_or(ElpidaError::MathOverflow)?;
        if v2 {
            let (after, _) = read_raydium(&a.ray_pool.to_account_info(), &a.ray_vault_0.to_account_info(), &a.ray_vault_1.to_account_info(), &mint_key)?;
            let lp_after = token_amount(&a.authority_lp.to_account_info())?;
            require!(liquidity_units(lp_after, &after)? >= a.migration.principal, ElpidaError::PrincipalBreached);
            V2Harvest {
                token_program: a.token_program.to_account_info(), quote_program: a.token_program.to_account_info(), mint: a.mint.to_account_info(), quote_mint: a.quote_mint.to_account_info(),
                quote_decimals: a.curve_config.quote_decimals, lp_authority: a.lp_authority.to_account_info(), seeds: authority_seeds,
                authority_base: a.authority_base.to_account_info(), authority_quote: a.authority_quote.to_account_info(), pool: a.pool.to_account_info(),
            }.settle(ctx.remaining_accounts, base_out, quote_out)?;
            let (pool_key, ray_pool) = (a.pool.key(), a.ray_pool.key());
            let migration = &mut ctx.accounts.migration;
            migration.lp_locked = lp_after;
            migration.harvested_lp = migration.harvested_lp.checked_add(harvest).ok_or(ElpidaError::MathOverflow)?;
            migration.harvested_base = migration.harvested_base.checked_add(base_out).ok_or(ElpidaError::MathOverflow)?;
            migration.harvested_quote = migration.harvested_quote.checked_add(quote_out).ok_or(ElpidaError::MathOverflow)?;
            emit!(LpFeesHarvested { pool: pool_key, pump_pool: ray_pool, lp_burned: harvest, base_out, quote_out, protocol_base: 0, protocol_quote: 0, lp_locked: lp_after });
            return Ok(());
        }
        let buyback_bps = PoolExt::read(&a.pool.to_account_info().try_borrow_data()?).buyback_bps as u128;
        let split = HarvestPayout {
            token_program: a.token_program.to_account_info(), quote_program: a.token_program.to_account_info(), mint: a.mint.to_account_info(), quote_mint: a.quote_mint.to_account_info(),
            quote_decimals: a.curve_config.quote_decimals, lp_authority: a.lp_authority.to_account_info(), seeds: authority_seeds,
            authority_base: a.authority_base.to_account_info(), authority_quote: a.authority_quote.to_account_info(), treasury_base: a.treasury_base.to_account_info(),
            treasury_quote: a.treasury_quote.to_account_info(), reward_base: a.reward_base.to_account_info(), reward_quote: a.reward_quote.to_account_info(),
        }.pay(base_out, quote_out, buyback_bps, buyback_bps)?;
        let (after, _) = read_raydium(&a.ray_pool.to_account_info(), &a.ray_vault_0.to_account_info(), &a.ray_vault_1.to_account_info(), &mint_key)?;
        let lp_after = token_amount(&a.authority_lp.to_account_info())?;
        require!(liquidity_units(lp_after, &after)? >= a.migration.principal, ElpidaError::PrincipalBreached);
        let (pool_key, ray_pool) = (a.pool.key(), a.ray_pool.key());
        if buyback_bps > 0 { split.record(&ctx.accounts.migration.to_account_info(), pool_key)?; }
        let migration = &mut ctx.accounts.migration;
        migration.lp_locked = lp_after;
        migration.harvested_lp = migration.harvested_lp.checked_add(harvest).ok_or(ElpidaError::MathOverflow)?;
        migration.harvested_base = migration.harvested_base.checked_add(base_out).ok_or(ElpidaError::MathOverflow)?;
        migration.harvested_quote = migration.harvested_quote.checked_add(quote_out).ok_or(ElpidaError::MathOverflow)?;
        emit!(LpFeesHarvested { pool: pool_key, pump_pool: ray_pool, lp_burned: harvest, base_out, quote_out, protocol_base: split.protocol_base, protocol_quote: split.protocol_quote, lp_locked: lp_after });
        Ok(())
    }

    #[cfg(feature = "testnet")]
    /// Permissionless: spends a partner pool's queued SOL (the quote side of its harvests) on its own token through the
    /// Raydium pool and burns what it buys. One call spends at most 0.5% of the pool's SOL depth, at most once every
    /// BUYBACK_SLOT_GAP slots.
    pub fn raydium_buyback(ctx: Context<RaydiumBuyback>) -> Result<()> {
        let a = &ctx.accounts;
        let mint_key = a.mint.key();
        let mut ext = MigrationExt::read(&a.migration.to_account_info().try_borrow_data()?).ok_or(ElpidaError::NothingToBuyBack)?;
        require!(ext.venue == VENUE_RAYDIUM, ElpidaError::WrongVenue);
        // Nothing queued yet (the LP authority's wrapped-SOL account may not even exist again until a harvest).
        require!(ext.pending_buyback > 0, ElpidaError::NothingToBuyBack);
        let (state, base_is_0) = read_raydium(&a.ray_pool.to_account_info(), &a.ray_vault_0.to_account_info(), &a.ray_vault_1.to_account_info(), &mint_key)?;
        let amount_in = buyback_amount(ext.pending_buyback.min(token_amount(&a.authority_quote.to_account_info())?), state.quote);
        require!(amount_in > 0, ElpidaError::NothingToBuyBack);
        let slot = Clock::get()?.slot;
        require!(ext.last_buyback_slot == 0 || slot >= ext.last_buyback_slot.saturating_add(BUYBACK_SLOT_GAP), ElpidaError::BuybackTooSoon);
        let authority_seeds: &[&[u8]] = &[b"pump-lp", mint_key.as_ref(), &[a.migration.authority_bump]];
        let base_before = token_amount(&a.authority_base.to_account_info())?;
        let mut data = Vec::with_capacity(24);
        data.extend_from_slice(&RAY_SWAP_BASE_INPUT);
        data.extend_from_slice(&amount_in.to_le_bytes());
        data.extend_from_slice(&1u64.to_le_bytes());
        let (input_vault, output_vault) = if base_is_0 { (a.ray_vault_1.to_account_info(), a.ray_vault_0.to_account_info()) } else { (a.ray_vault_0.to_account_info(), a.ray_vault_1.to_account_info()) };
        let infos = [
            a.lp_authority.to_account_info(), a.ray_authority.to_account_info(), a.amm_config.to_account_info(), a.ray_pool.to_account_info(),
            a.authority_quote.to_account_info(), a.authority_base.to_account_info(), input_vault, output_vault,
            a.token_program.to_account_info(), a.token_program.to_account_info(), a.quote_mint.to_account_info(), a.mint.to_account_info(), a.observation.to_account_info(),
        ];
        // payer, authority, amm_config, pool_state, input_token_account, output_token_account, input_vault, output_vault,
        // input_token_program, output_token_program, input_token_mint, output_token_mint, observation_state
        const WRITABLE: [bool; 13] = [false, false, false, true, true, true, true, true, false, false, false, false, true];
        let accounts = infos.iter().enumerate().map(|(i, info)| AccountMeta { pubkey: *info.key, is_signer: i == 0, is_writable: WRITABLE[i] }).collect();
        invoke_signed(&Instruction { program_id: raydium::PROGRAM, accounts, data }, &infos, &[authority_seeds])?;
        let bought = token_amount(&a.authority_base.to_account_info())?.checked_sub(base_before).ok_or(ElpidaError::MathOverflow)?;
        token::burn(
            CpiContext::new_with_signer(a.token_program.to_account_info(), Burn { mint: a.mint.to_account_info(), from: a.authority_base.to_account_info(), authority: a.lp_authority.to_account_info() }, &[authority_seeds]),
            bought,
        )?;
        ext.pending_buyback -= amount_in;
        ext.last_buyback_slot = slot;
        ext.quote_spent = ext.quote_spent.checked_add(amount_in).ok_or(ElpidaError::MathOverflow)?;
        ext.bought_burned = ext.bought_burned.checked_add(bought).ok_or(ElpidaError::MathOverflow)?;
        ext.write(&mut ctx.accounts.migration.to_account_info().try_borrow_mut_data()?)?;
        emit!(PartnerLpBuyback { pool: ctx.accounts.pool.key(), quote_in: amount_in, tokens_burned: bought, pending_buyback: ext.pending_buyback, total_burned: ext.bought_burned });
        Ok(())
    }
}

/// PumpSwap pool state relevant to liquidity: LP supply and the reserves withdrawals pay from
/// (base vault balance; quote vault balance less the protocol / creator fees kept in the pool).
pub struct PumpState { pub lp_supply: u64, pub base: u64, pub quote: u64 }
impl PumpState {
    fn read(pool: &AccountInfo, base_vault: &AccountInfo, quote_vault: &AccountInfo) -> Result<Self> {
        require_keys_eq!(*pool.owner, PUMP_AMM, ElpidaError::PumpAccount);
        let data = pool.try_borrow_data()?;
        require!(data.len() >= PUMP_POOL_LP_SUPPLY + 8, ElpidaError::PumpAccount);
        let read = |offset: usize| if data.len() >= offset + 8 { u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap()) } else { 0 };
        require!(data[139..171] == base_vault.key.to_bytes() && data[171..203] == quote_vault.key.to_bytes(), ElpidaError::PumpAccount);
        let lp_supply = read(PUMP_POOL_LP_SUPPLY);
        let kept_fees = read(PUMP_POOL_PROTOCOL_FEES).checked_add(read(PUMP_POOL_CREATOR_FEES)).ok_or(ElpidaError::MathOverflow)?;
        let base = token_amount(base_vault)?;
        let quote = token_amount(quote_vault)?.checked_sub(kept_fees).ok_or(ElpidaError::MathOverflow)?;
        Ok(PumpState { lp_supply, base, quote })
    }
}

/// Raydium CPMM pool state, in the same terms as `PumpState`: LP supply and the reserves a withdrawal pays from (vault
/// balances less the protocol, fund and creator fees Raydium keeps in them), mapped to base (the curve's token) and
/// quote (SOL). Also returns whether the token is Raydium's token 0 (mints are ordered by address).
pub fn read_raydium(pool: &AccountInfo, vault_0: &AccountInfo, vault_1: &AccountInfo, mint: &Pubkey) -> Result<(PumpState, bool)> {
    require_keys_eq!(*pool.owner, raydium::PROGRAM, ElpidaError::RaydiumAccount);
    let data = pool.try_borrow_data()?;
    require!(data.len() >= RAY_POOL_LEN && data[..8] == RAY_POOL_DISC, ElpidaError::RaydiumAccount);
    require!(data[RAY_POOL_VAULT_0..RAY_POOL_VAULT_0 + 32] == vault_0.key.to_bytes() && data[RAY_POOL_VAULT_1..RAY_POOL_VAULT_1 + 32] == vault_1.key.to_bytes(), ElpidaError::RaydiumAccount);
    let base_is_0 = data[RAY_POOL_MINT_0..RAY_POOL_MINT_0 + 32] == mint.to_bytes();
    require!(base_is_0 || data[RAY_POOL_MINT_0 + 32..RAY_POOL_MINT_0 + 64] == mint.to_bytes(), ElpidaError::RaydiumAccount);
    let read = |offset: usize| u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap());
    let fees = |side: usize| -> Result<u64> {
        read(RAY_POOL_PROTOCOL_FEES_0 + 8 * side).checked_add(read(RAY_POOL_FUND_FEES_0 + 8 * side)).and_then(|f| f.checked_add(read(RAY_POOL_CREATOR_FEES_0 + 8 * side))).ok_or(error!(ElpidaError::MathOverflow))
    };
    let r0 = token_amount(vault_0)?.checked_sub(fees(0)?).ok_or(ElpidaError::MathOverflow)?;
    let r1 = token_amount(vault_1)?.checked_sub(fees(1)?).ok_or(ElpidaError::MathOverflow)?;
    let (base, quote) = if base_is_0 { (r0, r1) } else { (r1, r0) };
    Ok((PumpState { lp_supply: read(RAY_POOL_LP_SUPPLY), base, quote }, base_is_0))
}

/// Lamports Raydium's `initialize` takes from the pool creator: the pool-creation fee plus rent for the accounts it
/// opens (pool, observation, LP mint, two vaults, the creator's LP account).
pub fn raydium_creation_cost(create_pool_fee: u64, rent: &Rent) -> Result<u64> {
    let rent_total = [RAY_POOL_LEN, RAY_OBSERVATION_LEN, RAY_MINT_LEN, RAY_TOKEN_ACCOUNT_LEN, RAY_TOKEN_ACCOUNT_LEN, RAY_TOKEN_ACCOUNT_LEN]
        .iter().try_fold(0u64, |sum, len| sum.checked_add(rent.minimum_balance(*len)));
    rent_total.and_then(|r| r.checked_add(create_pool_fee)).ok_or(error!(ElpidaError::MathOverflow))
}

/// Reads the pinned 1% AmmConfig and returns its pool-creation fee.
fn raydium_create_fee(amm_config: &AccountInfo) -> Result<u64> {
    require_keys_eq!(*amm_config.owner, raydium::PROGRAM, ElpidaError::RaydiumAccount);
    let data = amm_config.try_borrow_data()?;
    require!(data.len() >= 44 && data[..8] == RAY_AMM_CONFIG_DISC && data[9] == 0, ElpidaError::RaydiumAccount);
    require!(u64::from_le_bytes(data[12..20].try_into().unwrap()) == RAYDIUM_TRADE_FEE_RATE, ElpidaError::RaydiumAccount);
    Ok(u64::from_le_bytes(data[36..44].try_into().unwrap()))
}

/// Pays out one LP-fee harvest that the LP authority has just received: the creator's half of each side goes to the
/// reward wallet; the protocol half goes to the treasury, less a partner pool's share, whose token side is burned and
/// whose quote side stays with the LP authority for buybacks.
/// V2 pools after graduation: the token side of each harvest is burned, and the quote side returns to the curve's quote
/// vault and joins the fee ledger, so `withdraw_v2_fees` splits it five ways like every curve fee. `remaining[0]` must
/// be the curve's quote vault (ATA(pool, quote_mint), writable) and the pool must be passed writable.
struct V2Harvest<'a, 'info> {
    token_program: AccountInfo<'info>, quote_program: AccountInfo<'info>, mint: AccountInfo<'info>, quote_mint: AccountInfo<'info>, quote_decimals: u8,
    lp_authority: AccountInfo<'info>, seeds: &'a [&'a [u8]], authority_base: AccountInfo<'info>, authority_quote: AccountInfo<'info>, pool: AccountInfo<'info>,
}
impl<'a, 'info> V2Harvest<'a, 'info> {
    #[inline(never)]
    fn settle(&self, remaining: &[AccountInfo<'info>], base_out: u64, quote_out: u64) -> Result<()> {
        let vault = remaining.first().ok_or(ElpidaError::NotV2)?;
        require_keys_eq!(vault.key(), get_associated_token_address_with_program_id(&self.pool.key(), &self.quote_mint.key(), self.quote_program.key), ElpidaError::NotV2);
        require!(vault.is_writable && self.pool.is_writable, ElpidaError::NotV2);
        let mut ext = V2Ext::read(&self.pool.try_borrow_data()?).ok_or(ElpidaError::NotV2)?;
        if base_out > 0 {
            token::burn(CpiContext::new_with_signer(self.token_program.clone(), Burn { mint: self.mint.clone(), from: self.authority_base.clone(), authority: self.lp_authority.clone() }, &[self.seeds]), base_out)?;
        }
        if quote_out > 0 {
            ti::transfer_checked(
                CpiContext::new_with_signer(self.quote_program.clone(), ti::TransferChecked { from: self.authority_quote.clone(), mint: self.quote_mint.clone(), to: vault.clone(), authority: self.lp_authority.clone() }, &[self.seeds]),
                quote_out, self.quote_decimals,
            )?;
        }
        ext.accrued = ext.accrued.checked_add(quote_out).ok_or(ElpidaError::MathOverflow)?;
        ext.write(&mut self.pool.try_borrow_mut_data()?)?;
        emit!(V2Harvested { pool: self.pool.key(), base_burned: base_out, quote_accrued: quote_out, accrued: ext.accrued });
        Ok(())
    }
}

struct HarvestPayout<'a, 'info> {
    token_program: AccountInfo<'info>, quote_program: AccountInfo<'info>, mint: AccountInfo<'info>, quote_mint: AccountInfo<'info>, quote_decimals: u8,
    lp_authority: AccountInfo<'info>, seeds: &'a [&'a [u8]],
    authority_base: AccountInfo<'info>, authority_quote: AccountInfo<'info>,
    treasury_base: AccountInfo<'info>, treasury_quote: AccountInfo<'info>, reward_base: AccountInfo<'info>, reward_quote: AccountInfo<'info>,
}
struct HarvestSplit { protocol_base: u64, protocol_quote: u64, burn_base: u64, queue_quote: u64 }
impl<'a, 'info> HarvestPayout<'a, 'info> {
    #[inline(never)]
    /// `burn_bps` of the token side is burned; `queue_bps` of the quote side waits for a buyback (0 where the venue
    /// has none, so that share stays in the protocol half).
    fn pay(&self, base_out: u64, quote_out: u64, burn_bps: u128, queue_bps: u128) -> Result<HarvestSplit> {
        let (half_base, half_quote) = (base_out / 2, quote_out / 2);
        let (burn_base, queue_quote) = ((base_out as u128 * burn_bps / BPS) as u64, (quote_out as u128 * queue_bps / BPS) as u64);
        let (protocol_base, protocol_quote) = (half_base - burn_base, half_quote - queue_quote);
        if burn_base > 0 {
            token::burn(
                CpiContext::new_with_signer(self.token_program.clone(), Burn { mint: self.mint.clone(), from: self.authority_base.clone(), authority: self.lp_authority.clone() }, &[self.seeds]),
                burn_base,
            )?;
        }
        for (to, amount) in [(self.treasury_base.clone(), protocol_base), (self.reward_base.clone(), base_out - half_base)] {
            if amount > 0 {
                token::transfer(
                    CpiContext::new_with_signer(self.token_program.clone(), Transfer { from: self.authority_base.clone(), to, authority: self.lp_authority.clone() }, &[self.seeds]),
                    amount,
                )?;
            }
        }
        for (to, amount) in [(self.treasury_quote.clone(), protocol_quote), (self.reward_quote.clone(), quote_out - half_quote)] {
            if amount > 0 {
                ti::transfer_checked(
                    CpiContext::new_with_signer(self.quote_program.clone(), ti::TransferChecked { from: self.authority_quote.clone(), mint: self.quote_mint.clone(), to, authority: self.lp_authority.clone() }, &[self.seeds]),
                    amount, self.quote_decimals,
                )?;
            }
        }
        Ok(HarvestSplit { protocol_base, protocol_quote, burn_base, queue_quote })
    }
}
impl<'a, 'info> HarvestPayout<'a, 'info> {
    /// PumpSwap pools: quote an earlier build queued for a buyback that this venue cannot run goes to the treasury.
    fn release_stranded(&self, migration: &AccountInfo<'info>, pool: Pubkey) -> Result<()> {
        let mut ext = match MigrationExt::read(&migration.try_borrow_data()?) { Some(ext) => ext, None => return Ok(()) };
        if ext.venue == VENUE_RAYDIUM || ext.pending_buyback == 0 { return Ok(()); }
        let amount = ext.pending_buyback.min(token_amount(&self.authority_quote)?);
        if amount > 0 {
            ti::transfer_checked(
                CpiContext::new_with_signer(self.quote_program.clone(), ti::TransferChecked { from: self.authority_quote.clone(), mint: self.quote_mint.clone(), to: self.treasury_quote.clone(), authority: self.lp_authority.clone() }, &[self.seeds]),
                amount, self.quote_decimals,
            )?;
        }
        ext.pending_buyback = 0;
        ext.write(&mut migration.try_borrow_mut_data()?)?;
        emit!(StrandedBuybackReleased { pool, amount });
        Ok(())
    }
}
impl HarvestSplit {
    /// Partner pools: adds the burned token side and the queued quote side to the migration record's extension.
    fn record(&self, migration: &AccountInfo, pool: Pubkey) -> Result<()> {
        let mut data = migration.try_borrow_mut_data()?;
        let mut ext = MigrationExt::read(&data).ok_or(ElpidaError::PartnerTerms)?;
        ext.pending_buyback = ext.pending_buyback.checked_add(self.queue_quote).ok_or(ElpidaError::MathOverflow)?;
        ext.base_burned = ext.base_burned.checked_add(self.burn_base).ok_or(ElpidaError::MathOverflow)?;
        ext.write(&mut data)?;
        emit!(PartnerHarvest { pool, base_burned: self.burn_base, quote_queued: self.queue_quote, pending_buyback: ext.pending_buyback });
        Ok(())
    }
}

/// Largest partner buyback one call may spend: the queued SOL, at most 0.5% of the pool's SOL depth.
pub fn buyback_amount(pending: u64, quote_reserve: u64) -> u64 { pending.min(quote_reserve / BUYBACK_DEPTH_DIVISOR) }

fn token_amount(account: &AccountInfo) -> Result<u64> {
    let data = account.try_borrow_data()?;
    require!(data.len() >= 72, ElpidaError::PumpAccount);
    Ok(u64::from_le_bytes(data[64..72].try_into().unwrap()))
}

pub fn isqrt(n: u128) -> u128 {
    if n < 2 { return n; }
    let mut x = 1u128 << ((128 - n.leading_zeros()).div_ceil(2));
    loop {
        let y = (x + n / x) / 2;
        if y >= x { return x; }
        x = y;
    }
}

/// Liquidity units owned by `lp` LP tokens: lp / lp_supply * sqrt(base * quote). Swaps never reduce
/// sqrt(base * quote); trading fees grow it.
pub fn liquidity_units(lp: u64, state: &PumpState) -> Result<u128> {
    require!(state.lp_supply > 0, ElpidaError::PumpAccount);
    let root = isqrt(state.base as u128 * state.quote as u128);
    Ok((lp as u128).checked_mul(root).ok_or(ElpidaError::MathOverflow)? / state.lp_supply as u128)
}

/// LP tokens kept beyond the exact principal so withdrawal rounding can never dip below it.
pub const HARVEST_MARGIN_LP: u128 = 2;
/// Smallest harvest: 1 / MIN_HARVEST_DIVISOR of the locked LP (0.01%).
pub const MIN_HARVEST_DIVISOR: u128 = 10_000;

/// LP tokens that can be withdrawn while the remaining position keeps at least `principal` units.
pub fn harvestable_lp(lp: u64, principal: u128, state: &PumpState) -> Result<u64> {
    let root = isqrt(state.base as u128 * state.quote as u128);
    require!(root > 0, ElpidaError::PumpAccount);
    let keep = (principal.checked_mul(state.lp_supply as u128).ok_or(ElpidaError::MathOverflow)? + root - 1) / root + HARVEST_MARGIN_LP;
    Ok((lp as u128).saturating_sub(keep).min(u64::MAX as u128) as u64)
}

/// Fee of the devnet SOL/asset conversion pool, in basis points of the input (kept in the pool).
pub const TEST_CONVERSION_FEE_BPS: u64 = 30;

/// Output of the test conversion pool for `amount_in`: x·y = k after the 0.3% fee, rounded down, never the whole
/// reserve.
pub fn test_conversion_out(reserve_in: u64, reserve_out: u64, amount_in: u64) -> Result<u64> {
    require!(amount_in > 0 && reserve_in > 0 && reserve_out > 0, ElpidaError::InvalidParams);
    let net = amount_in as u128 * (BPS as u128 - TEST_CONVERSION_FEE_BPS as u128) / BPS as u128;
    let out = reserve_out as u128 * net / (reserve_in as u128 + net);
    require!(out > 0 && out < reserve_out as u128, ElpidaError::SellTooSmall);
    Ok(out as u64)
}

/// Test-only instructions exist in every build but succeed only when compiled with `--features testnet`.
/// The mainnet build (`build/elpida_launchpad-mainnet.so`) rejects them, so it can never mint test assets.
fn test_networks_only() -> Result<()> {
    require!(cfg!(feature = "testnet"), ElpidaError::TestNetworksOnly);
    Ok(())
}

/// A token metadata URI: `ipfs://` followed by printable ASCII, at most Metaplex's 200 bytes.
pub fn valid_metadata_uri(uri: &str) -> bool {
    uri.len() > "ipfs://".len() && uri.len() <= MAX_URI && uri.starts_with("ipfs://") && uri.bytes().all(|b| b.is_ascii_graphic())
}

/// The accounts the creation fee touches (shared by `launch` and `launch_v2`).
pub struct CreationFee<'info> {
    pub creator: AccountInfo<'info>, pub treasury: AccountInfo<'info>, pub system_program: AccountInfo<'info>,
    pub pricing: AccountInfo<'info>, pub price_update: AccountInfo<'info>, pub config: Pubkey, pub launch_fee: u64, pub mint: Pubkey,
}

/// Charges the creation fee: fixed lamports from the config, or USD from the bound Pyth price when pricing is on (paid
/// in SOL, or in USDC with the four USDC accounts in `remaining`). Returns the oracle-sized starting FDV in lamports for
/// SOL pairs priced in USD, if any.
fn pay_creation_fee<'info>(f: &CreationFee<'info>, remaining: &[AccountInfo<'info>], max_fee: u64, fee_in_usdc: bool, now: i64) -> Result<Option<u64>> {
    let pricing = load_pricing(&f.pricing, &f.config)?;
    let (fee_lamports, usdc_fee, start_quote, price) = match &pricing {
        None => { require!(!fee_in_usdc, ElpidaError::UsdcFeeUnavailable); (f.launch_fee, 0u64, None, None) }
        Some(p) => {
            let px = read_price(&f.price_update, p, now)?;
            let start = if p.start_fdv_usd_e6 > 0 { Some(usd_to_quote(p.start_fdv_usd_e6, &px, 9)?) } else { None };
            if fee_in_usdc { (0, p.fee_usd_e6, start, Some(px)) } else { (usd_to_quote(p.fee_usd_e6, &px, 9)?, 0, start, Some(px)) }
        }
    };
    require!(fee_lamports <= max_fee, ElpidaError::FeeAboveMax);
    if fee_lamports > 0 {
        system_program::transfer(CpiContext::new(f.system_program.clone(), system_program::Transfer { from: f.creator.clone(), to: f.treasury.clone() }), fee_lamports)?;
    }
    if usdc_fee > 0 {
        let p = pricing.as_ref().ok_or(ElpidaError::UsdcFeeUnavailable)?;
        require!(p.usdc_mint != Pubkey::default() && remaining.len() >= 4, ElpidaError::UsdcFeeUnavailable);
        let (usdc_mint, creator_usdc, treasury_usdc, usdc_program) = (&remaining[0], &remaining[1], &remaining[2], &remaining[3]);
        require_keys_eq!(usdc_mint.key(), p.usdc_mint, ElpidaError::UsdcFeeUnavailable);
        require!(*usdc_program.key == anchor_spl::token::ID || *usdc_program.key == anchor_spl::token_2022::ID, ElpidaError::UsdcFeeUnavailable);
        require!(*usdc_mint.owner == *usdc_program.key, ElpidaError::UsdcFeeUnavailable);
        require_keys_eq!(treasury_usdc.key(), get_associated_token_address_with_program_id(&f.treasury.key(), &p.usdc_mint, usdc_program.key), ElpidaError::UsdcFeeUnavailable);
        let usdc_decimals = usdc_mint.try_borrow_data()?.get(44).copied().ok_or(ElpidaError::UsdcFeeUnavailable)?;
        require!(usdc_decimals as u32 == USD_DECIMALS, ElpidaError::UsdcFeeUnavailable);
        // The token program enforces that the creator owns and signs for `creator_usdc`.
        ti::transfer_checked(CpiContext::new(usdc_program.clone(), ti::TransferChecked { from: creator_usdc.clone(), mint: usdc_mint.clone(), to: treasury_usdc.clone(), authority: f.creator.clone() }), usdc_fee, usdc_decimals)?;
    }
    if let Some(px) = &price {
        emit!(LaunchFeePaid { mint: f.mint, payer: f.creator.key(), asset: if usdc_fee > 0 { pricing.as_ref().map(|p| p.usdc_mint).unwrap_or_default() } else { Pubkey::default() }, amount: if usdc_fee > 0 { usdc_fee } else { fee_lamports }, price: px.price, exponent: px.exponent, publish_time: px.publish_time });
    }
    Ok(start_quote)
}

/// Metaplex `CreateMetadataAccountV3` with `is_mutable = false`: name, symbol and URI can never change.
/// No creators, collection or uses; zero royalties. The curve PDA is recorded as update authority but has
/// no instruction that signs for it, and immutable metadata cannot be updated anyway.
#[inline(never)]
#[allow(clippy::too_many_arguments)]
fn create_metadata<'info>(program: &AccountInfo<'info>, metadata: &AccountInfo<'info>, mint: &AccountInfo<'info>, creator: &AccountInfo<'info>, update_authority: &AccountInfo<'info>, system: &AccountInfo<'info>, name: &str, symbol: &str, uri: &str) -> Result<()> {
    let mut data = Vec::with_capacity(1 + 12 + name.len() + symbol.len() + uri.len() + 7);
    data.push(MPL_CREATE_METADATA_V3);
    for field in [name, symbol, uri] {
        data.extend_from_slice(&(field.len() as u32).to_le_bytes());
        data.extend_from_slice(field.as_bytes());
    }
    data.extend_from_slice(&0u16.to_le_bytes()); // seller_fee_basis_points
    data.extend_from_slice(&[0, 0, 0]); // creators, collection, uses: None
    data.push(0); // is_mutable: false
    data.push(0); // collection_details: None
    let accounts = vec![
        AccountMeta::new(metadata.key(), false),
        AccountMeta::new_readonly(mint.key(), false),
        AccountMeta::new_readonly(creator.key(), true), // mint authority
        AccountMeta::new(creator.key(), true),          // payer
        AccountMeta::new_readonly(update_authority.key(), false),
        AccountMeta::new_readonly(system.key(), false),
        // The rent sysvar is optional for CreateMetadataAccountV3; leaving it out keeps the largest launch
        // transaction (SOL pair, USDC fee, 32-byte name) within Solana's 1,232 bytes with the `partner` account.
    ];
    anchor_lang::solana_program::program::invoke(
        &Instruction { program_id: MPL_TOKEN_METADATA, accounts, data },
        &[metadata.clone(), mint.clone(), creator.clone(), update_authority.clone(), system.clone(), program.clone()],
    )?;
    Ok(())
}

/// Launches are open unless the beta gate exists and is enabled; then the creator must be allowlisted.
/// Both accounts are seed-checked PDAs, so a caller cannot substitute others.
#[inline(never)]
fn check_beta(gate: &AccountInfo, creator: &AccountInfo) -> Result<()> {
    if *gate.owner != crate::ID || gate.data_is_empty() { return Ok(()); }
    let state = BetaGate::try_deserialize(&mut &gate.try_borrow_data()?[..])?;
    if !state.enabled { return Ok(()); }
    require!(*creator.owner == crate::ID && !creator.data_is_empty(), ElpidaError::BetaClosed);
    BetaCreator::try_deserialize(&mut &creator.try_borrow_data()?[..])?;
    Ok(())
}

/// Moves quote tokens with `transfer_checked`, which works for classic SPL and Token-2022 mints.
#[allow(clippy::too_many_arguments)]
fn quote_transfer<'info>(program: &Interface<'info, TokenInterface>, mint: &InterfaceAccount<'info, QuoteMint>, from: AccountInfo<'info>, to: AccountInfo<'info>, authority: AccountInfo<'info>, amount: u64, decimals: u8, seeds: &[&[&[u8]]]) -> Result<()> {
    if amount == 0 { return Ok(()); }
    ti::transfer_checked(CpiContext::new_with_signer(program.to_account_info(), ti::TransferChecked { from, mint: mint.to_account_info(), to, authority }, seeds), amount, decimals)
}

/// Token-2022 mint extensions that would break curve accounting or make the vault unusable.
/// Parsed from the raw TLV area (type and length are u16) so newer extension types never fail to load.
fn check_quote_mint(mint: &AccountInfo) -> Result<()> {
    if *mint.owner != anchor_spl::token_2022::ID { return Ok(()); }
    const BASE: usize = 165; // extensions start after the account-type byte that follows the padded base state
    let data = mint.try_borrow_data()?;
    if data.len() <= 82 { return Ok(()); }
    require!(data.len() > BASE && data[BASE] == 1, ElpidaError::UnsupportedQuote);
    let mut offset = BASE + 1;
    while offset + 4 <= data.len() {
        let kind = u16::from_le_bytes([data[offset], data[offset + 1]]);
        let len = u16::from_le_bytes([data[offset + 2], data[offset + 3]]) as usize;
        let value = data.get(offset + 4..offset + 4 + len).ok_or(ElpidaError::UnsupportedQuote)?;
        match kind {
            0 => break,
            // TransferFeeConfig, NonTransferable, ConfidentialTransferFeeConfig; PermanentDelegate (12):
            // PumpSwap refuses such quote mints, so the curve could never graduate (this includes xStocks).
            1 | 9 | 12 | 16 => return err!(ElpidaError::UnsupportedQuote),
            // DefaultAccountState: Frozen (2) would freeze every vault at creation.
            6 => require!(value.first() != Some(&2), ElpidaError::UnsupportedQuote),
            // TransferHook: allowed only while no hook program is set (authority 32 bytes, then program id).
            14 => require!(value.len() >= 64 && value[32..64].iter().all(|b| *b == 0), ElpidaError::UnsupportedQuote),
            _ => {}
        }
        offset += 4 + len;
    }
    Ok(())
}

/// True when the quote mint must graduate into the program's own locked pool: a Token-2022 mint carrying an issuer
/// control that PumpSwap, Raydium and Orca refuse or do not support (ConfidentialTransferMint 4, TransferHook 14,
/// ScaledUiAmount 25, Pausable 26). Ondo's tokenized stocks carry all four.
pub fn locked_pool_venue(mint: &AccountInfo) -> Result<bool> {
    if *mint.owner != anchor_spl::token_2022::ID { return Ok(false); }
    Ok(locked_pool_extensions(&mint.try_borrow_data()?))
}

/// The TLV scan behind `locked_pool_venue`, on raw mint data (split out for host tests).
pub fn locked_pool_extensions(data: &[u8]) -> bool {
    const BASE: usize = 165;
    if data.len() <= BASE || data[BASE] != 1 { return false; }
    let mut offset = BASE + 1;
    while offset + 4 <= data.len() {
        let kind = u16::from_le_bytes([data[offset], data[offset + 1]]);
        let len = u16::from_le_bytes([data[offset + 2], data[offset + 3]]) as usize;
        match kind {
            0 => return false,
            4 | 14 | 25 | 26 => return true,
            _ => {}
        }
        offset += 4 + len;
    }
    false
}

/// Turns a just-completed curve into its locked pool: the anti-snipe bonus joins the quote reserve and the virtual
/// reserves become the real ones, so the curve formulas in `quote_buy`/`quote_sell` price the pool as x·y = k with
/// x = `real_quote` (the quote vault less accrued fees) and y = `TOKEN_SUPPLY - sold` (the token vault).
pub fn open_locked_pool(pool: &mut CurvePool) -> Result<()> {
    require!(pool.status == STATUS_GRADUATED, ElpidaError::NotComplete);
    pool.real_quote = pool.real_quote.checked_add(pool.liquidity_bonus).ok_or(ElpidaError::MathOverflow)?;
    pool.liquidity_bonus = 0;
    pool.virtual_quote = 0;
    pool.virtual_token = TOKEN_SUPPLY;
    pool.status = STATUS_LOCKED;
    Ok(())
}

fn write_config(config: &mut CurveConfig, quote_mint: Pubkey, decimals: u8, treasury: Pubkey, params: &CurveParams, bump: u8) -> Result<()> {
    require!((6..=9).contains(&decimals), ElpidaError::QuoteDecimals);
    require!(params.virtual_quote > 0, ElpidaError::InvalidParams);
    require!(params.curve_supply > 0 && params.curve_supply < TOKEN_SUPPLY, ElpidaError::InvalidParams);
    require!(params.virtual_token > params.curve_supply, ElpidaError::InvalidParams);
    require!(params.base_fee_bps <= 1_000, ElpidaError::InvalidParams);
    require!(params.snipe_start_bps >= params.base_fee_bps && params.snipe_start_bps <= 9_900, ElpidaError::InvalidParams);
    require!(params.snipe_window_secs <= 3_600, ElpidaError::InvalidParams);
    require!(params.max_creator_buy_bps <= 10_000, ElpidaError::InvalidParams);
    config.quote_mint = quote_mint;
    config.treasury = treasury;
    config.launch_fee = params.launch_fee;
    config.quote_decimals = decimals;
    config.model_version = MODEL_VERSION;
    config.virtual_quote = params.virtual_quote;
    config.virtual_token = params.virtual_token;
    config.curve_supply = params.curve_supply;
    config.base_fee_bps = params.base_fee_bps;
    config.snipe_start_bps = params.snipe_start_bps;
    config.snipe_window_secs = params.snipe_window_secs;
    config.max_creator_buy_bps = params.max_creator_buy_bps;
    config.bump = bump;
    Ok(())
}

pub struct OraclePrice { pub price: i64, pub exponent: i32, pub publish_time: i64 }

/// The config's pricing account, when oracle pricing is on (PDA ["pricing", config] owned by this program).
fn load_pricing(info: &AccountInfo, config: &Pubkey) -> Result<Option<PricingConfig>> {
    let (expected, _) = Pubkey::find_program_address(&[b"pricing", config.as_ref()], &crate::ID);
    require_keys_eq!(info.key(), expected, ElpidaError::PriceUnavailable);
    if info.data_is_empty() || *info.owner != crate::ID { return Ok(None); }
    let data = info.try_borrow_data()?;
    let p = PricingConfig::try_deserialize(&mut &data[..])?;
    require_keys_eq!(p.config, *config, ElpidaError::PriceUnavailable);
    Ok(Some(p))
}

/// Reads and checks a verified Pyth `PriceUpdateV2`: the bound account, owned by the Pyth receiver,
/// fully verified, for the configured feed, positive, fresh and with a tight confidence interval.
/// Layout: discriminator 8, write authority 32, verification level (1 = Full, 1 byte), then the price
/// message: feed id 32, price i64, conf u64, exponent i32, publish time i64.
pub fn read_price(info: &AccountInfo, p: &PricingConfig, now: i64) -> Result<OraclePrice> {
    require_keys_eq!(info.key(), p.price_feed, ElpidaError::PriceUnavailable);
    require_keys_eq!(*info.owner, PYTH_RECEIVER, ElpidaError::PriceUnavailable);
    let data = info.try_borrow_data()?;
    require!(data.len() >= 101 && data[..8] == PRICE_UPDATE_V2 && data[40] == 1, ElpidaError::PriceUnavailable);
    require!(data[41..73] == p.feed_id, ElpidaError::PriceUnavailable);
    let price = i64::from_le_bytes(data[73..81].try_into().unwrap());
    let conf = u64::from_le_bytes(data[81..89].try_into().unwrap());
    let exponent = i32::from_le_bytes(data[89..93].try_into().unwrap());
    let publish_time = i64::from_le_bytes(data[93..101].try_into().unwrap());
    require!(price > 0 && (-18..=0).contains(&exponent), ElpidaError::PriceUnavailable);
    require!(publish_time <= now + 30 && now - publish_time <= p.max_age_secs as i64, ElpidaError::PriceStale);
    require!((conf as u128) * BPS <= (price as u128) * (p.max_conf_bps as u128), ElpidaError::PriceUncertain);
    Ok(OraclePrice { price, exponent, publish_time })
}

/// USD (6 decimals) to quote base units at the oracle price, rounded up:
/// usd_e6 x 10^decimals x 10^-exponent / (price x 10^6).
pub fn usd_to_quote(usd_e6: u64, px: &OraclePrice, decimals: u32) -> Result<u64> {
    let scale = 10u128.pow(decimals + (-px.exponent) as u32);
    let num = (usd_e6 as u128).checked_mul(scale).ok_or(ElpidaError::MathOverflow)?;
    let den = (px.price as u128) * 10u128.pow(USD_DECIMALS);
    let v = num.div_ceil(den);
    require!(v <= u64::MAX as u128, ElpidaError::MathOverflow);
    Ok(v as u64)
}

/// Linear decay from `snipe_start_bps` at launch to `base_fee_bps` at the end of the window.
pub fn current_fee_bps(cfg: &CurveConfig, created_at: i64, now: i64) -> u64 {
    let base = cfg.base_fee_bps as u64;
    let window = cfg.snipe_window_secs as u64;
    let elapsed = now.saturating_sub(created_at).max(0) as u64;
    if window == 0 || elapsed >= window { return base; }
    base + (cfg.snipe_start_bps as u64 - base) * (window - elapsed) / window
}

#[derive(Accounts)]
pub struct OptionalBuyVersion {}

/// The fee for a trade: the decaying anti-snipe schedule on the curve, the flat base fee in a locked pool.
pub fn trade_fee_bps(cfg: &CurveConfig, pool: &CurvePool, now: i64) -> u64 {
    if pool.status == STATUS_LOCKED { cfg.base_fee_bps as u64 } else { current_fee_bps(cfg, pool.created_at, now) }
}

pub struct TradeQuote { pub gross: u64, pub net: u64, pub tokens: u64, pub fee: u64, pub base_fee: u64, pub surplus: u64, pub graduates: bool }

pub fn fees(gross: u64, fee_bps: u64, base_fee_bps: u64) -> (u64, u64, u64) {
    let fee = (gross as u128 * fee_bps as u128 / BPS) as u64;
    let base = ((gross as u128 * base_fee_bps as u128 / BPS) as u64).min(fee);
    (fee, base, fee - base)
}

/// Buy `gross_in` of quote. The final buy is partially filled: it takes exactly the remaining curve
/// supply and charges only the quote needed for it.
pub fn quote_buy(pool: &CurvePool, gross_in: u64, fee_bps: u64, base_fee_bps: u64) -> Result<TradeQuote> {
    require!(gross_in > 0, ElpidaError::FirstBuyRequired);
    let avail = (pool.virtual_token - pool.sold) as u128;
    let quote_side = (pool.virtual_quote as u128) + (pool.real_quote as u128);
    // A locked pool has no completion point: every buy is an ordinary constant-product swap.
    let remaining = if pool.status == STATUS_LOCKED { u128::MAX } else { (pool.curve_supply - pool.sold) as u128 };
    let mut gross = gross_in;
    let (mut fee, mut base, mut surplus) = fees(gross, fee_bps, base_fee_bps);
    let mut net = gross - fee;
    let mut tokens = avail * net as u128 / (quote_side + net as u128);
    let mut graduates = false;
    if tokens >= remaining {
        // Smallest net with avail*net/(quote_side+net) >= remaining, then the gross that yields it.
        let net_needed = (remaining * quote_side + (avail - remaining) - 1) / (avail - remaining);
        let gross_needed = (net_needed * BPS + (BPS - fee_bps as u128) - 1) / (BPS - fee_bps as u128);
        gross = (gross_needed as u64).min(gross_in);
        (fee, base, surplus) = fees(gross, fee_bps, base_fee_bps);
        net = gross - fee;
        tokens = remaining;
        graduates = true;
    }
    require!(tokens > 0, ElpidaError::BuyTooSmall);
    Ok(TradeQuote { gross, net, tokens: tokens as u64, fee, base_fee: base, surplus, graduates })
}

pub fn quote_sell(pool: &CurvePool, tokens_in: u64, fee_bps: u64, base_fee_bps: u64) -> Result<TradeQuote> {
    require!(tokens_in > 0 && tokens_in <= pool.sold, ElpidaError::InvalidSell);
    let avail = (pool.virtual_token - pool.sold) as u128;
    let quote_side = (pool.virtual_quote as u128) + (pool.real_quote as u128);
    let gross = (quote_side * tokens_in as u128 / (avail + tokens_in as u128)) as u64;
    require!(gross <= pool.real_quote, ElpidaError::InsufficientReserve);
    let (fee, base, surplus) = fees(gross, fee_bps, base_fee_bps);
    let net = gross - fee;
    require!(net > 0, ElpidaError::SellTooSmall);
    Ok(TradeQuote { gross, net, tokens: tokens_in, fee, base_fee: base, surplus, graduates: false })
}

/// Books a buy and returns the partner burn share of its base fee (quote still in the vault, not yet spent).
pub fn apply_buy(pool: &mut CurvePool, trade: &TradeQuote, now: i64, buyback_bps: u16) -> Result<u64> {
    pool.real_quote = pool.real_quote.checked_add(trade.net).ok_or(ElpidaError::MathOverflow)?;
    pool.sold = pool.sold.checked_add(trade.tokens).ok_or(ElpidaError::MathOverflow)?;
    let burn = split_fee(pool, trade, buyback_bps)?;
    if trade.graduates {
        pool.status = STATUS_GRADUATED;
        pool.graduated_at = now;
    }
    Ok(burn)
}

/// Splits the base fee: the creator always gets the larger half; the partner burn share (`buyback_bps` of the base
/// fee, 0 for standard pools) comes out of the protocol half and is returned for `partner_buyback`. Anything above
/// the base fee (the anti-snipe surplus) is locked as liquidity.
pub fn split_fee(pool: &mut CurvePool, trade: &TradeQuote, buyback_bps: u16) -> Result<u64> {
    let creator = trade.base_fee - trade.base_fee / 2;
    let burn = (trade.base_fee as u128 * buyback_bps as u128 / BPS) as u64;
    let protocol = trade.base_fee.checked_sub(creator).and_then(|v| v.checked_sub(burn)).ok_or(ElpidaError::MathOverflow)?;
    pool.protocol_fees = pool.protocol_fees.checked_add(protocol).ok_or(ElpidaError::MathOverflow)?;
    pool.creator_fees = pool.creator_fees.checked_add(creator).ok_or(ElpidaError::MathOverflow)?;
    pool.liquidity_bonus = pool.liquidity_bonus.checked_add(trade.surplus).ok_or(ElpidaError::MathOverflow)?;
    Ok(burn)
}

/// Spends `quote_in` (already in the vault) on the curve at its current price, with no fee, and returns the tokens
/// to burn. The quote joins the real reserve, so it ends up in the pool at migration. A buyback never completes the
/// curve: if it would reach the curve supply, buys nothing, or the curve is no longer trading, the quote is locked
/// as liquidity bonus instead and nothing is burned.
pub fn partner_buyback(pool: &mut CurvePool, quote_in: u64) -> Result<u64> {
    if quote_in == 0 { return Ok(0); }
    let avail = (pool.virtual_token - pool.sold) as u128;
    let quote_side = pool.virtual_quote as u128 + pool.real_quote as u128;
    let out = (avail * quote_in as u128 / (quote_side + quote_in as u128)) as u64;
    if pool.status == STATUS_LOCKED {
        // In the locked pool the buyback is a fee-free swap; the quote stays in the reserve even if it buys nothing.
        pool.real_quote = pool.real_quote.checked_add(quote_in).ok_or(ElpidaError::MathOverflow)?;
        pool.sold = pool.sold.checked_add(out).ok_or(ElpidaError::MathOverflow)?;
        return Ok(out);
    }
    if out == 0 || pool.status != STATUS_TRADING || pool.sold.checked_add(out).ok_or(ElpidaError::MathOverflow)? >= pool.curve_supply {
        pool.liquidity_bonus = pool.liquidity_bonus.checked_add(quote_in).ok_or(ElpidaError::MathOverflow)?;
        return Ok(0);
    }
    pool.real_quote = pool.real_quote.checked_add(quote_in).ok_or(ElpidaError::MathOverflow)?;
    pool.sold += out;
    Ok(out)
}

/// Burns curve-vault tokens bought back for a partner pool (the curve PDA owns the vault).
fn burn_from_vault<'info>(token_program: &Program<'info, Token>, mint: &AccountInfo<'info>, vault: &AccountInfo<'info>, pool: &AccountInfo<'info>, seeds: &[&[u8]], amount: u64) -> Result<()> {
    if amount == 0 { return Ok(()); }
    token::burn(CpiContext::new_with_signer(token_program.to_account_info(), Burn { mint: mint.clone(), from: vault.clone(), authority: pool.clone() }, &[seeds]), amount)
}

/// The launching wallet's live tier: its `["partner", creator]` record if it exists, holds 1000 or 2000 and has not
/// expired; otherwise 0 (standard). The address is seed-checked by the `Launch` accounts.
fn partner_share(info: &AccountInfo, creator: &Pubkey, now: i64) -> Result<u16> {
    if *info.owner != crate::ID || info.data_is_empty() { return Ok(0); }
    let p = PartnerConfig::try_deserialize(&mut &info.try_borrow_data()?[..])?;
    require_keys_eq!(p.creator, *creator, ElpidaError::PartnerTerms);
    Ok(if PARTNER_BPS.contains(&p.buyback_bps) && p.expires_at > now { p.buyback_bps } else { 0 })
}

/// Partner-tier fields stored after a migration record (`MIGRATION_EXT_LEN` bytes, written by the migrations of this
/// version): quote queued for buyback, base burned at harvests, buyback totals, and the venue (PumpSwap or Raydium).
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct MigrationExt { pub pending_buyback: u64, pub base_burned: u64, pub quote_spent: u64, pub bought_burned: u64, pub venue: u8, pub last_buyback_slot: u64 }
pub fn migration_ext_offset() -> usize { 8 + PumpMigration::INIT_SPACE }
impl MigrationExt {
    pub fn read(data: &[u8]) -> Option<MigrationExt> {
        let o = migration_ext_offset();
        if data.len() < o + MIGRATION_EXT_LEN || data[o] != EXT_VERSION { return None; }
        let u64_at = |i: usize| u64::from_le_bytes(data[i..i + 8].try_into().unwrap());
        // `last_buyback_slot` (bytes 34..42) was unused before the 1 November build, so older records read it as 0.
        Some(MigrationExt { pending_buyback: u64_at(o + 1), base_burned: u64_at(o + 9), quote_spent: u64_at(o + 17), bought_burned: u64_at(o + 25), venue: data[o + 33], last_buyback_slot: u64_at(o + 34) })
    }
    pub fn write(&self, data: &mut [u8]) -> Result<()> {
        let o = migration_ext_offset();
        require!(data.len() >= o + MIGRATION_EXT_LEN, ElpidaError::PartnerTerms);
        data[o] = EXT_VERSION;
        for (i, v) in [self.pending_buyback, self.base_burned, self.quote_spent, self.bought_burned].into_iter().enumerate() {
            data[o + 1 + i * 8..o + 9 + i * 8].copy_from_slice(&v.to_le_bytes());
        }
        data[o + 33] = self.venue;
        data[o + 34..o + 42].copy_from_slice(&self.last_buyback_slot.to_le_bytes());
        Ok(())
    }
}

/// Partner-tier fields stored after a pool's fixed layout (`POOL_EXT_LEN` bytes). Pools without them (launched
/// before this version) read as standard and are never written.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct PoolExt { pub buyback_bps: u16, pub burned: u64, pub quote_spent: u64 }
pub fn pool_ext_offset() -> usize { 8 + CurvePool::INIT_SPACE }
impl PoolExt {
    pub fn read(data: &[u8]) -> PoolExt {
        let o = pool_ext_offset();
        if data.len() < o + POOL_EXT_LEN || data[o] != EXT_VERSION { return PoolExt::default(); }
        let u64_at = |i: usize| u64::from_le_bytes(data[i..i + 8].try_into().unwrap());
        PoolExt { buyback_bps: u16::from_le_bytes([data[o + 1], data[o + 2]]), burned: u64_at(o + 3), quote_spent: u64_at(o + 11) }
    }
    pub fn write(&self, data: &mut [u8]) -> Result<()> {
        let o = pool_ext_offset();
        require!(data.len() >= o + POOL_EXT_LEN, ElpidaError::PartnerTerms);
        data[o] = EXT_VERSION;
        data[o + 1..o + 3].copy_from_slice(&self.buyback_bps.to_le_bytes());
        data[o + 3..o + 11].copy_from_slice(&self.burned.to_le_bytes());
        data[o + 11..o + 19].copy_from_slice(&self.quote_spent.to_le_bytes());
        Ok(())
    }
    /// Adds a buyback; returns whether anything changed (so standard pools are never written).
    pub fn record(&mut self, burned: u64, quote_in: u64) -> Result<bool> {
        if burned == 0 { return Ok(false); }
        self.burned = self.burned.checked_add(burned).ok_or(ElpidaError::MathOverflow)?;
        self.quote_spent = self.quote_spent.checked_add(quote_in).ok_or(ElpidaError::MathOverflow)?;
        Ok(true)
    }
}

/// A V2 pool's fee ledger, stored after the pool extension. `accrued` is the running total of fees at the token's own
/// rate (the anti-snipe surplus above it is liquidity, not fees); recipient i is owed floor(accrued x V2_SPLIT[i] /
/// 10,000) less what it has been paid. The split's rounding remainder (at most 4 base units) stays in the vault.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct V2Ext { pub fee_bps: u16, pub accrued: u64, pub paid: [u64; 5] }
pub fn v2_ext_offset() -> usize { pool_ext_offset() + POOL_EXT_LEN }
impl V2Ext {
    pub fn read(data: &[u8]) -> Option<V2Ext> {
        let o = v2_ext_offset();
        if data.len() < o + V2_EXT_LEN || data[o] != V2_EXT_VERSION { return None; }
        let u64_at = |i: usize| u64::from_le_bytes(data[i..i + 8].try_into().unwrap());
        let mut paid = [0u64; 5];
        for (i, p) in paid.iter_mut().enumerate() { *p = u64_at(o + 11 + i * 8); }
        Some(V2Ext { fee_bps: u16::from_le_bytes([data[o + 1], data[o + 2]]), accrued: u64_at(o + 3), paid })
    }
    pub fn write(&self, data: &mut [u8]) -> Result<()> {
        let o = v2_ext_offset();
        require!(data.len() >= o + V2_EXT_LEN, ElpidaError::NotV2);
        data[o] = V2_EXT_VERSION;
        data[o + 1..o + 3].copy_from_slice(&self.fee_bps.to_le_bytes());
        data[o + 3..o + 11].copy_from_slice(&self.accrued.to_le_bytes());
        for (i, p) in self.paid.iter().enumerate() { data[o + 11 + i * 8..o + 19 + i * 8].copy_from_slice(&p.to_le_bytes()); }
        Ok(())
    }
    /// What each recipient is owed now.
    pub fn owed(&self) -> [u64; 5] {
        let mut out = [0u64; 5];
        for i in 0..5 { out[i] = v2_share(self.accrued, i).saturating_sub(self.paid[i]); }
        out
    }
}

/// Recipient i's share of a running fee total, rounded down.
pub fn v2_share(accrued: u64, i: usize) -> u64 { (accrued as u128 * V2_SPLIT[i] as u128 / BPS) as u64 }

/// The fee of a V2 trade `now`: 90% at launch, falling linearly to the token's own fee over 60 seconds (as on EVM).
pub fn v2_fee_bps(own_bps: u16, created_at: i64, now: i64) -> u64 {
    let (own, start, window) = (own_bps as u64, V2_SNIPE_START_BPS as u64, V2_SNIPE_WINDOW_SECS as u64);
    let elapsed = now.saturating_sub(created_at).max(0) as u64;
    if elapsed >= window { return own; }
    own + (start - own) * (window - elapsed) / window
}

/// Books a V2 trade's fee: the part at the token's own rate joins the ledger, the anti-snipe surplus is locked as
/// liquidity. The legacy protocol / creator counters stay at zero for V2 pools.
pub fn v2_book_fee(pool: &mut CurvePool, ext: &mut V2Ext, trade: &TradeQuote) -> Result<()> {
    ext.accrued = ext.accrued.checked_add(trade.base_fee).ok_or(ElpidaError::MathOverflow)?;
    pool.liquidity_bonus = pool.liquidity_bonus.checked_add(trade.surplus).ok_or(ElpidaError::MathOverflow)?;
    Ok(())
}

/// The pool's V2 ledger when it trades through a V2 config (a V2 config's pools always have one), otherwise None.
pub fn v2_of(cfg: &CurveConfig, pool: &AccountInfo) -> Result<Option<V2Ext>> {
    if cfg.model_version != V2_MODEL_VERSION { return Ok(None); }
    Ok(Some(V2Ext::read(&pool.try_borrow_data()?).ok_or(ElpidaError::NotV2)?))
}

/// Books a V2 buy: reserves, the fee ledger, and completion of the curve.
pub fn v2_apply_buy(pool: &mut CurvePool, ext: &mut V2Ext, trade: &TradeQuote, now: i64) -> Result<()> {
    pool.real_quote = pool.real_quote.checked_add(trade.net).ok_or(ElpidaError::MathOverflow)?;
    pool.sold = pool.sold.checked_add(trade.tokens).ok_or(ElpidaError::MathOverflow)?;
    v2_book_fee(pool, ext, trade)?;
    if trade.graduates {
        pool.status = STATUS_GRADUATED;
        pool.graduated_at = now;
    }
    Ok(())
}

/// The V2 ticker rule: 1 to 10 ASCII letters or digits (not unique).
pub fn valid_v2_symbol(symbol: &str) -> bool { !symbol.is_empty() && symbol.len() <= MAX_SYMBOL && symbol.bytes().all(|b| b.is_ascii_alphanumeric()) }

/// The fee range a V2 config allows: from its minimum to 4%. Mainnet builds require the approved 1.00% minimum.
pub fn check_v2_config(params: &CurveParams) -> Result<()> {
    #[cfg(not(feature = "testnet"))]
    require!(params.base_fee_bps == V2_MAINNET_MIN_FEE_BPS, ElpidaError::InvalidParams);
    require!(params.base_fee_bps >= 1 && params.base_fee_bps <= V2_DEFAULT_FEE_BPS, ElpidaError::InvalidParams);
    require!(params.snipe_start_bps == V2_SNIPE_START_BPS && params.snipe_window_secs == V2_SNIPE_WINDOW_SECS, ElpidaError::InvalidParams);
    require!(params.max_creator_buy_bps == V2_FIRST_BUY_CAP_BPS, ElpidaError::InvalidParams);
    Ok(())
}

// ---------- V2 rewards helpers (S3) ----------

/// Days since 1970-01-01 to (year, month, day), UTC (Howard Hinnant's algorithm), as the EVM distributor.
pub fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + if m <= 2 { 1 } else { 0 }, m, d)
}

/// (year, month, day) to days since 1970-01-01, UTC.
pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468
}

/// When `round` starts (unix seconds).
pub fn round_start(d: &V2Distributor, round: u32) -> i64 {
    if d.period != 0 { return d.genesis + round as i64 * d.period as i64; }
    let index = d.genesis_month as i64 + round as i64;
    days_from_civil(index / 12, index % 12 + 1, 1) * 86_400
}

/// The round in progress at `now` (None before genesis).
pub fn current_round(d: &V2Distributor, now: i64) -> Option<u32> {
    if now < d.genesis { return None; }
    if d.period != 0 { return Some(((now - d.genesis) / d.period as i64) as u32); }
    let (y, m, _) = civil(now.div_euclid(86_400));
    Some((y * 12 + m - 1 - d.genesis_month as i64) as u32)
}

/// One payout's leaf, bound to this program, the distributor kind, the round, the asset and the position in the list.
pub fn v2_leaf(kind: u8, round: u32, asset: &Pubkey, index: u32, account: &Pubkey, amount: u64) -> [u8; 32] {
    let inner = hashv(&[b"elpida-v2", crate::ID.as_ref(), &[kind], &round.to_le_bytes(), asset.as_ref(), &index.to_le_bytes(), account.as_ref(), &amount.to_le_bytes()]).0;
    hashv(&[&inner]).0
}

/// Sorted-pair Merkle proof check (the order of each pair is by byte value, as OpenZeppelin's MerkleProof).
pub fn verify_proof(proof: &[[u8; 32]], root: [u8; 32], leaf: [u8; 32]) -> bool {
    let mut node = leaf;
    for p in proof { node = if node <= *p { hashv(&[&node, p]).0 } else { hashv(&[p, &node]).0 }; }
    node == root
}

/// What a vault holds of `asset`: native lamports above the account's own rent for wrapped SOL (after
/// `sweep_v2_sol`), otherwise its associated token account's balance.
fn vault_holding(asset: &Pubkey, vault: &AccountInfo, vault_token: &AccountInfo) -> Result<u64> {
    if *asset == WSOL_MINT { return Ok(vault.lamports().saturating_sub(EMPTY_ACCOUNT_RENT)); }
    token_amount(vault_token)
}

/// The flywheel's limits for one order, and the per-token cooldown record.
fn flywheel_checks(order: &mut V2FlywheelOrder, bump: u8, created_at: i64, now: i64, amount_in: u64, vault_balance: u64) -> Result<()> {
    require!(amount_in > 0 && amount_in as u128 * BPS <= vault_balance as u128 * V2_FLYWHEEL_MAX_SHARE_BPS, ElpidaError::FlywheelLimit);
    require!(now >= created_at.saturating_add(V2_FLYWHEEL_MIN_AGE_SECS), ElpidaError::FlywheelLimit);
    require!(order.last_at == 0 || now >= order.last_at.saturating_add(V2_FLYWHEEL_COOLDOWN_SECS), ElpidaError::FlywheelLimit);
    order.last_at = now;
    order.orders = order.orders.saturating_add(1);
    if order.bump == 0 { order.bump = bump; }
    Ok(())
}

struct Snapshot { real_quote: u64, virtual_quote_total: u64, token_reserve: u64, sold: u64, liquidity_bonus: u64, graduated: bool }
impl Snapshot {
    fn of(pool: &CurvePool) -> Self {
        Snapshot {
            real_quote: pool.real_quote, virtual_quote_total: pool.virtual_quote + pool.real_quote,
            token_reserve: pool.virtual_token - pool.sold, sold: pool.sold, liquidity_bonus: pool.liquidity_bonus,
            graduated: pool.status == STATUS_GRADUATED,
        }
    }
}

#[account]
#[derive(InitSpace, Copy)]
pub struct CurveConfig {
    pub quote_mint: Pubkey,
    pub treasury: Pubkey,
    pub launch_fee: u64,
    pub virtual_quote: u64,
    pub virtual_token: u64,
    pub curve_supply: u64,
    pub base_fee_bps: u16,
    pub snipe_start_bps: u16,
    pub snipe_window_secs: u32,
    pub max_creator_buy_bps: u16,
    pub quote_decimals: u8,
    pub model_version: u8,
    pub bump: u8,
}

/// Fixed layout (read by the web client): 8-byte discriminator, then fields in this order.
#[account]
#[derive(InitSpace)]
pub struct CurvePool {
    pub config: Pubkey,
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub reward: Pubkey,
    pub name: [u8; MAX_NAME],
    pub symbol: [u8; MAX_SYMBOL],
    pub virtual_quote: u64,
    pub virtual_token: u64,
    pub curve_supply: u64,
    pub real_quote: u64,
    pub sold: u64,
    pub liquidity_bonus: u64,
    pub protocol_fees: u64,
    pub creator_fees: u64,
    pub created_at: i64,
    pub graduated_at: i64,
    pub status: u8,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitializeCurve<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + CurveConfig::INIT_SPACE, seeds = [b"curve-config"], bump)]
    pub curve_config: Box<Account<'info, CurveConfig>>,
    pub quote_mint: Box<InterfaceAccount<'info, QuoteMint>>,
    /// CHECK: any wallet; protocol fees go to its quote-token associated account.
    pub treasury: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = authority, associated_token::mint = quote_mint, associated_token::authority = treasury, associated_token::token_program = token_program)]
    pub treasury_quote: Box<InterfaceAccount<'info, QuoteAccount>>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ ElpidaError::Unauthorized)]
    pub program: Program<'info, crate::program::ElpidaLaunchpad>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ ElpidaError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddCurveConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + CurveConfig::INIT_SPACE, seeds = [b"curve-config", quote_mint.key().as_ref()], bump)]
    pub curve_config: Box<Account<'info, CurveConfig>>,
    pub quote_mint: Box<InterfaceAccount<'info, QuoteMint>>,
    /// CHECK: any wallet; protocol fees go to its quote-token associated account.
    pub treasury: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = authority, associated_token::mint = quote_mint, associated_token::authority = treasury, associated_token::token_program = token_program)]
    pub treasury_quote: Box<InterfaceAccount<'info, QuoteAccount>>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ ElpidaError::Unauthorized)]
    pub program: Program<'info, crate::program::ElpidaLaunchpad>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ ElpidaError::Unauthorized)]
    pub program_data: Box<Account<'info, ProgramData>>,
    /// The quote mint's token program (SPL Token or Token-2022).
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateCurveConfig<'info> {
    pub authority: Signer<'info>,
    #[account(mut)]
    pub curve_config: Box<Account<'info, CurveConfig>>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ ElpidaError::Unauthorized)]
    pub program: Program<'info, crate::program::ElpidaLaunchpad>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ ElpidaError::Unauthorized)]
    pub program_data: Box<Account<'info, ProgramData>>,
}

#[derive(Accounts)]
pub struct CreateTestUsdc<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, seeds = [b"test-usdc"], bump, mint::decimals = 6, mint::authority = faucet_authority)]
    pub test_usdc: Box<Account<'info, Mint>>,
    /// CHECK: PDA that is the test mint's only minter.
    #[account(seeds = [b"test-usdc-authority"], bump)]
    pub faucet_authority: UncheckedAccount<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ ElpidaError::Unauthorized)]
    pub program: Program<'info, crate::program::ElpidaLaunchpad>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ ElpidaError::Unauthorized)]
    pub program_data: Box<Account<'info, ProgramData>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TestUsdcFaucet<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, mint::authority = faucet_authority, mint::token_program = token_program)]
    pub test_mint: Box<InterfaceAccount<'info, QuoteMint>>,
    /// CHECK: PDA minter.
    #[account(seeds = [b"test-usdc-authority"], bump)]
    pub faucet_authority: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = user, associated_token::mint = test_mint, associated_token::authority = user, associated_token::token_program = token_program)]
    pub user_token: Box<InterfaceAccount<'info, QuoteAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Launch<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(has_one = quote_mint, has_one = treasury)]
    pub curve_config: Box<Account<'info, CurveConfig>>,
    #[account(mint::token_program = quote_token_program)]
    pub quote_mint: Box<InterfaceAccount<'info, QuoteMint>>,
    /// CHECK: verified against curve_config.treasury; receives the SOL creation fee.
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    #[account(init, payer = creator, mint::decimals = TOKEN_DECIMALS, mint::authority = creator)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(init, payer = creator, space = 8 + CurvePool::INIT_SPACE + POOL_EXT_LEN, seeds = [b"curve", mint.key().as_ref()], bump)]
    pub pool: Box<Account<'info, CurvePool>>,
    #[account(init, payer = creator, associated_token::mint = mint, associated_token::authority = pool)]
    pub token_vault: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = creator, associated_token::mint = quote_mint, associated_token::authority = pool, associated_token::token_program = quote_token_program)]
    pub quote_vault: Box<InterfaceAccount<'info, QuoteAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = creator, token::token_program = quote_token_program)]
    pub creator_quote: Box<InterfaceAccount<'info, QuoteAccount>>,
    #[account(init, payer = creator, associated_token::mint = mint, associated_token::authority = creator)]
    pub creator_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// CHECK: PDA ["beta-gate"]; launches are open while it does not exist or is disabled.
    #[account(seeds = [b"beta-gate"], bump)]
    pub beta_gate: UncheckedAccount<'info>,
    /// CHECK: PDA ["beta-creator", creator]; must exist while the beta gate is enabled.
    #[account(seeds = [b"beta-creator", creator.key().as_ref()], bump)]
    pub beta_creator: UncheckedAccount<'info>,
    /// CHECK: PDA ["pricing", curve_config]; when it exists the fee and SOL curve are priced in USD.
    pub pricing: UncheckedAccount<'info>,
    /// CHECK: the Pyth price account bound in `pricing` (any account when pricing is off).
    pub price_update: UncheckedAccount<'info>,
    /// CHECK: Metaplex metadata PDA ["metadata", program, mint]; created and seed-checked by Metaplex.
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = MPL_TOKEN_METADATA)]
    pub token_metadata_program: UncheckedAccount<'info>,
    /// CHECK: PDA ["partner", creator]; when it holds a live tier, this pool buys back and burns that share of its fees.
    #[account(seeds = [b"partner", creator.key().as_ref()], bump)]
    pub partner: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct AddV2Config<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + CurveConfig::INIT_SPACE, seeds = [b"curve-config-v2", quote_mint.key().as_ref()], bump)]
    pub curve_config: Box<Account<'info, CurveConfig>>,
    pub quote_mint: Box<InterfaceAccount<'info, QuoteMint>>,
    /// CHECK: any wallet; the treasury share goes to its quote-token associated account.
    pub treasury: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = authority, associated_token::mint = quote_mint, associated_token::authority = treasury, associated_token::token_program = token_program)]
    pub treasury_quote: Box<InterfaceAccount<'info, QuoteAccount>>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ ElpidaError::Unauthorized)]
    pub program: Program<'info, crate::program::ElpidaLaunchpad>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ ElpidaError::Unauthorized)]
    pub program_data: Box<Account<'info, ProgramData>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct LaunchV2<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(has_one = quote_mint, has_one = treasury, constraint = curve_config.model_version == V2_MODEL_VERSION @ ElpidaError::NotV2)]
    pub curve_config: Box<Account<'info, CurveConfig>>,
    #[account(mint::token_program = quote_token_program)]
    pub quote_mint: Box<InterfaceAccount<'info, QuoteMint>>,
    /// CHECK: verified against curve_config.treasury; receives the SOL creation fee.
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    #[account(init, payer = creator, mint::decimals = TOKEN_DECIMALS, mint::authority = creator)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(init, payer = creator, space = 8 + CurvePool::INIT_SPACE + POOL_EXT_LEN + V2_EXT_LEN, seeds = [b"curve", mint.key().as_ref()], bump)]
    pub pool: Box<Account<'info, CurvePool>>,
    #[account(init, payer = creator, associated_token::mint = mint, associated_token::authority = pool)]
    pub token_vault: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = creator, associated_token::mint = quote_mint, associated_token::authority = pool, associated_token::token_program = quote_token_program)]
    pub quote_vault: Box<InterfaceAccount<'info, QuoteAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = creator, token::token_program = quote_token_program)]
    pub creator_quote: Box<InterfaceAccount<'info, QuoteAccount>>,
    #[account(init, payer = creator, associated_token::mint = mint, associated_token::authority = creator)]
    pub creator_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// CHECK: PDA ["beta-gate"]; launches are open while it does not exist or is disabled.
    #[account(seeds = [b"beta-gate"], bump)]
    pub beta_gate: UncheckedAccount<'info>,
    /// CHECK: PDA ["beta-creator", creator]; must exist while the beta gate is enabled.
    #[account(seeds = [b"beta-creator", creator.key().as_ref()], bump)]
    pub beta_creator: UncheckedAccount<'info>,
    /// CHECK: PDA ["pricing", curve_config]; when it exists the fee and SOL curve are priced in USD.
    pub pricing: UncheckedAccount<'info>,
    /// CHECK: the Pyth price account bound in `pricing` (any account when pricing is off).
    pub price_update: UncheckedAccount<'info>,
    /// CHECK: Metaplex metadata PDA ["metadata", program, mint]; created and seed-checked by Metaplex.
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = MPL_TOKEN_METADATA)]
    pub token_metadata_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct WithdrawV2Fees<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(has_one = quote_mint, has_one = treasury, constraint = curve_config.model_version == V2_MODEL_VERSION @ ElpidaError::NotV2)]
    pub curve_config: Box<Account<'info, CurveConfig>>,
    #[account(mint::token_program = quote_token_program)]
    pub quote_mint: Box<InterfaceAccount<'info, QuoteMint>>,
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [b"curve", mint.key().as_ref()], bump = pool.bump, has_one = mint, has_one = reward, constraint = pool.config == curve_config.key() @ ElpidaError::WrongConfig)]
    pub pool: Box<Account<'info, CurvePool>>,
    /// CHECK: verified against curve_config.treasury.
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: verified against pool.reward.
    pub reward: UncheckedAccount<'info>,
    /// CHECK: data-less PDA ["v2-vault", "airdrop"]; owns the trader-airdrop vault's token accounts.
    #[account(seeds = [b"v2-vault", V2_VAULT_AIRDROP], bump)]
    pub airdrop_vault: UncheckedAccount<'info>,
    /// CHECK: data-less PDA ["v2-vault", "flywheel"].
    #[account(seeds = [b"v2-vault", V2_VAULT_FLYWHEEL], bump)]
    pub flywheel_vault: UncheckedAccount<'info>,
    /// CHECK: data-less PDA ["v2-vault", "holder"].
    #[account(seeds = [b"v2-vault", V2_VAULT_HOLDER], bump)]
    pub holder_vault: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = payer, associated_token::mint = quote_mint, associated_token::authority = reward, associated_token::token_program = quote_token_program)]
    pub reward_quote: Box<InterfaceAccount<'info, QuoteAccount>>,
    #[account(init_if_needed, payer = payer, associated_token::mint = quote_mint, associated_token::authority = airdrop_vault, associated_token::token_program = quote_token_program)]
    pub airdrop_quote: Box<InterfaceAccount<'info, QuoteAccount>>,
    #[account(init_if_needed, payer = payer, associated_token::mint = quote_mint, associated_token::authority = flywheel_vault, associated_token::token_program = quote_token_program)]
    pub flywheel_quote: Box<InterfaceAccount<'info, QuoteAccount>>,
    #[account(init_if_needed, payer = payer, associated_token::mint = quote_mint, associated_token::authority = holder_vault, associated_token::token_program = quote_token_program)]
    pub holder_quote: Box<InterfaceAccount<'info, QuoteAccount>>,
    #[account(mut, associated_token::mint = quote_mint, associated_token::authority = treasury, associated_token::token_program = quote_token_program)]
    pub treasury_quote: Box<InterfaceAccount<'info, QuoteAccount>>,
    #[account(mut, associated_token::mint = quote_mint, associated_token::authority = pool, associated_token::token_program = quote_token_program)]
    pub quote_vault: Box<InterfaceAccount<'info, QuoteAccount>>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct V2Distributor { pub kind: u8, pub operator: Pubkey, pub period: u32, pub genesis: i64, pub genesis_month: u32, pub bump: u8 }

/// Per distributor and asset: what posted rounds still owe (PDA ["v2-reserved", kind, asset]).
#[account]
#[derive(InitSpace)]
pub struct V2AssetLedger { pub reserved: u64, pub bump: u8 }

/// One posted round for one asset (PDA ["v2-round", kind, asset, round]); a claim bitmap of `recipients` bits follows.
#[account]
#[derive(InitSpace)]
pub struct V2Round { pub kind: u8, pub round: u32, pub asset: Pubkey, pub root: [u8; 32], pub total: u64, pub claimed: u64, pub recipients: u32, pub posted_at: i64, pub expired: bool, pub bump: u8 }

/// The flywheel's record for one token (PDA ["v2-fly", mint]): last order, orders, quote spent, tokens burned.
#[account]
#[derive(InitSpace)]
pub struct V2FlywheelOrder { pub last_at: i64, pub orders: u32, pub spent: u64, pub burned: u64, pub bump: u8 }

#[derive(Accounts)]
#[instruction(kind: u8)]
pub struct InitV2Distributor<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + V2Distributor::INIT_SPACE, seeds = [b"v2-dist", &[kind][..]], bump)]
    pub distributor: Box<Account<'info, V2Distributor>>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ ElpidaError::Unauthorized)]
    pub program: Program<'info, crate::program::ElpidaLaunchpad>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ ElpidaError::Unauthorized)]
    pub program_data: Box<Account<'info, ProgramData>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(kind: u8, round_no: u32, root: [u8; 32], total: u64, recipients: u32)]
pub struct PostV2Root<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(seeds = [b"v2-dist", &[kind][..]], bump = distributor.bump, constraint = distributor.operator == operator.key() @ ElpidaError::Unauthorized)]
    pub distributor: Box<Account<'info, V2Distributor>>,
    /// CHECK: data-less vault PDA ["v2-vault", kind]; its lamports are the SOL pool.
    #[account(seeds = [b"v2-vault", v2_vault_seed(kind)], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: ATA(vault, asset); read for non-SOL assets (may not exist for SOL).
    pub vault_token: UncheckedAccount<'info>,
    pub asset_mint: Box<InterfaceAccount<'info, QuoteMint>>,
    #[account(init_if_needed, payer = operator, space = 8 + V2AssetLedger::INIT_SPACE, seeds = [b"v2-reserved", &[kind][..], asset_mint.key().as_ref()], bump)]
    pub ledger: Box<Account<'info, V2AssetLedger>>,
    #[account(init, payer = operator, space = 8 + V2Round::INIT_SPACE + (recipients as usize).div_ceil(8), seeds = [b"v2-round", &[kind][..], asset_mint.key().as_ref(), &round_no.to_le_bytes()], bump)]
    pub round: Box<Account<'info, V2Round>>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(kind: u8, round_no: u32)]
pub struct ClaimV2<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: data-less vault PDA ["v2-vault", kind].
    #[account(mut, seeds = [b"v2-vault", v2_vault_seed(kind)], bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"v2-round", &[kind][..], asset_mint.key().as_ref(), &round_no.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, V2Round>>,
    #[account(mut, seeds = [b"v2-reserved", &[kind][..], asset_mint.key().as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, V2AssetLedger>>,
    #[account(mint::token_program = token_program)]
    pub asset_mint: Box<InterfaceAccount<'info, QuoteMint>>,
    /// CHECK: the payee wallet named in the leaf; receives native SOL for SOL rounds.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
    /// CHECK: ATA(vault, asset) for non-SOL rounds (the client marks it writable then); checked by the token program as
    /// the transfer source. Unused for SOL rounds.
    pub vault_token: UncheckedAccount<'info>,
    /// The payee's associated token account for non-SOL rounds (created by the payer when missing).
    #[account(init_if_needed, payer = payer, associated_token::mint = asset_mint, associated_token::authority = recipient, associated_token::token_program = token_program)]
    pub recipient_token: Option<Box<InterfaceAccount<'info, QuoteAccount>>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(kind: u8, round_no: u32)]
pub struct ExpireV2<'info> {
    #[account(seeds = [b"v2-dist", &[kind][..]], bump = distributor.bump)]
    pub distributor: Box<Account<'info, V2Distributor>>,
    /// CHECK: the round's asset mint (seed only).
    pub asset_mint: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"v2-round", &[kind][..], asset_mint.key().as_ref(), &round_no.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, V2Round>>,
    #[account(mut, seeds = [b"v2-reserved", &[kind][..], asset_mint.key().as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, V2AssetLedger>>,
}

#[derive(Accounts)]
#[instruction(kind: u8)]
pub struct SweepV2Sol<'info> {
    /// CHECK: data-less vault PDA ["v2-vault", kind].
    #[account(mut, seeds = [b"v2-vault", v2_vault_seed(kind)], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: ATA(vault, wrapped SOL), closed into the vault.
    #[account(mut, address = get_associated_token_address_with_program_id(&vault.key(), &WSOL_MINT, &token_program.key()) @ ElpidaError::V2Terms)]
    pub vault_wsol: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(kind: u8)]
pub struct V2ConvertUsdc<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(seeds = [b"v2-dist", &[kind][..]], bump = distributor.bump, constraint = distributor.operator == operator.key() @ ElpidaError::Unauthorized)]
    pub distributor: Box<Account<'info, V2Distributor>>,
    /// The pricing config that names USDC (PDA ["pricing", curve config]).
    #[account(seeds = [b"pricing", pricing.config.as_ref()], bump)]
    pub pricing: Box<Account<'info, PricingConfig>>,
    /// CHECK: data-less vault PDA ["v2-vault", kind]; its lamports are the SOL pool; signs the wrap and the swap.
    #[account(mut, seeds = [b"v2-vault", v2_vault_seed(kind)], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: the SOL ledger PDA ["v2-reserved", kind, wrapped SOL]; may not exist yet (nothing reserved).
    #[account(seeds = [b"v2-reserved", &[kind][..], WSOL_MINT.as_ref()], bump)]
    pub sol_ledger: UncheckedAccount<'info>,
    /// CHECK: ATA(vault, wrapped SOL): must exist (the client creates it); pays the swap.
    #[account(mut, address = get_associated_token_address_with_program_id(&vault.key(), &WSOL_MINT, &token_program.key()) @ ElpidaError::RaydiumAccount)]
    pub vault_wsol: UncheckedAccount<'info>,
    /// CHECK: ATA(vault, USDC): must exist (the client creates it); receives the USDC.
    #[account(mut, address = get_associated_token_address_with_program_id(&vault.key(), &usdc_mint.key(), &token_program.key()) @ ElpidaError::RaydiumAccount)]
    pub vault_usdc: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = WSOL_MINT @ ElpidaError::WrongVenue)]
    pub wsol_mint: UncheckedAccount<'info>,
    /// CHECK: checked against the pricing config's USDC.
    pub usdc_mint: UncheckedAccount<'info>,
    /// CHECK: owner, mints and vaults checked when read.
    #[account(mut)]
    pub ray_pool: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = raydium::AUTHORITY @ ElpidaError::RaydiumAccount)]
    pub ray_authority: UncheckedAccount<'info>,
    /// CHECK: fixed address; Raydium checks it is the pool's config.
    #[account(address = raydium::AMM_CONFIG @ ElpidaError::RaydiumAccount)]
    pub amm_config: UncheckedAccount<'info>,
    /// CHECK: matched against the Raydium pool's stored vault.
    #[account(mut)]
    pub ray_vault_0: UncheckedAccount<'info>,
    /// CHECK: matched against the Raydium pool's stored vault.
    #[account(mut)]
    pub ray_vault_1: UncheckedAccount<'info>,
    /// CHECK: Raydium checks it is the pool's observation account.
    #[account(mut)]
    pub observation: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = raydium::PROGRAM @ ElpidaError::RaydiumAccount)]
    pub raydium_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct V2FlywheelCurve<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(seeds = [b"v2-dist", &[V2_DIST_AIRDROP][..]], bump = distributor.bump, constraint = distributor.operator == operator.key() @ ElpidaError::Unauthorized)]
    pub distributor: Box<Account<'info, V2Distributor>>,
    #[account(has_one = quote_mint, constraint = curve_config.model_version == V2_MODEL_VERSION @ ElpidaError::NotV2)]
    pub curve_config: Box<Account<'info, CurveConfig>>,
    #[account(mint::token_program = quote_token_program)]
    pub quote_mint: Box<InterfaceAccount<'info, QuoteMint>>,
    #[account(mut)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [b"curve", mint.key().as_ref()], bump = pool.bump, has_one = mint, constraint = pool.config == curve_config.key() @ ElpidaError::WrongConfig)]
    pub pool: Box<Account<'info, CurvePool>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = pool)]
    pub token_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = quote_mint, associated_token::authority = pool, associated_token::token_program = quote_token_program)]
    pub quote_vault: Box<InterfaceAccount<'info, QuoteAccount>>,
    /// CHECK: data-less flywheel vault PDA.
    #[account(seeds = [b"v2-vault", V2_VAULT_FLYWHEEL], bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = quote_mint, associated_token::authority = vault, associated_token::token_program = quote_token_program)]
    pub vault_quote: Box<InterfaceAccount<'info, QuoteAccount>>,
    #[account(init_if_needed, payer = operator, space = 8 + V2FlywheelOrder::INIT_SPACE, seeds = [b"v2-fly", mint.key().as_ref()], bump)]
    pub order: Box<Account<'info, V2FlywheelOrder>>,
    pub token_program: Program<'info, Token>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct V2FlywheelRaydium<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(seeds = [b"v2-dist", &[V2_DIST_AIRDROP][..]], bump = distributor.bump, constraint = distributor.operator == operator.key() @ ElpidaError::Unauthorized)]
    pub distributor: Box<Account<'info, V2Distributor>>,
    #[account(address = pool.config @ ElpidaError::WrongConfig)]
    pub curve_config: Box<Account<'info, CurveConfig>>,
    /// CHECK: matched against pool.mint; burned from, so writable.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = WSOL_MINT @ ElpidaError::WrongVenue)]
    pub quote_mint: UncheckedAccount<'info>,
    #[account(seeds = [b"curve", mint.key().as_ref()], bump = pool.bump, has_one = mint, constraint = pool.status == STATUS_MIGRATED @ ElpidaError::NotMigrated)]
    pub pool: Box<Account<'info, CurvePool>>,
    #[account(seeds = [b"pump-migration", mint.key().as_ref()], bump = migration.bump, constraint = migration.pump_pool == ray_pool.key() @ ElpidaError::RaydiumAccount)]
    pub migration: Box<Account<'info, PumpMigration>>,
    /// CHECK: data-less flywheel vault PDA; signs the swap.
    #[account(seeds = [b"v2-vault", V2_VAULT_FLYWHEEL], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: ATA(vault, wrapped SOL): pays the swap.
    #[account(mut, address = get_associated_token_address_with_program_id(&vault.key(), &WSOL_MINT, &token_program.key()) @ ElpidaError::RaydiumAccount)]
    pub vault_quote: UncheckedAccount<'info>,
    /// CHECK: ATA(vault, mint): receives the bought tokens, which are burned (must exist; the client creates it).
    #[account(mut, address = get_associated_token_address_with_program_id(&vault.key(), &mint.key(), &token_program.key()) @ ElpidaError::RaydiumAccount)]
    pub vault_base: UncheckedAccount<'info>,
    /// CHECK: matched against the migration record; owner checked when read.
    #[account(mut)]
    pub ray_pool: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = raydium::AUTHORITY @ ElpidaError::RaydiumAccount)]
    pub ray_authority: UncheckedAccount<'info>,
    /// CHECK: fixed address; Raydium checks it is the pool's config.
    #[account(address = raydium::AMM_CONFIG @ ElpidaError::RaydiumAccount)]
    pub amm_config: UncheckedAccount<'info>,
    /// CHECK: matched against the Raydium pool's stored vault.
    #[account(mut)]
    pub ray_vault_0: UncheckedAccount<'info>,
    /// CHECK: matched against the Raydium pool's stored vault.
    #[account(mut)]
    pub ray_vault_1: UncheckedAccount<'info>,
    /// CHECK: Raydium checks it is the pool's observation account.
    #[account(mut)]
    pub observation: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = raydium::PROGRAM @ ElpidaError::RaydiumAccount)]
    pub raydium_program: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = operator, space = 8 + V2FlywheelOrder::INIT_SPACE, seeds = [b"v2-fly", mint.key().as_ref()], bump)]
    pub order: Box<Account<'info, V2FlywheelOrder>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(creator: Pubkey)]
pub struct SetPartner<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// The native SOL pair: its treasury is the partner authority, as the factory treasury is on EVM.
    #[account(seeds = [b"curve-config", WSOL_MINT.as_ref()], bump = sol_config.bump, constraint = sol_config.treasury == authority.key() @ ElpidaError::Unauthorized)]
    pub sol_config: Box<Account<'info, CurveConfig>>,
    #[account(init_if_needed, payer = authority, space = 8 + PartnerConfig::INIT_SPACE, seeds = [b"partner", creator.as_ref()], bump)]
    pub partner: Box<Account<'info, PartnerConfig>>,
    pub system_program: Program<'info, System>,
}

/// An early-partner tier for one creator wallet (PDA ["partner", creator]); (0, 0) means ended.
#[account]
#[derive(InitSpace)]
pub struct PartnerConfig {
    pub creator: Pubkey,
    pub buyback_bps: u16,
    pub expires_at: i64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct ReopenCurve<'info> {
    #[account(mut, seeds = [b"curve", pool.mint.as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, CurvePool>>,
}

#[derive(Accounts)]
pub struct SetPricing<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub curve_config: Box<Account<'info, CurveConfig>>,
    #[account(init_if_needed, payer = authority, space = 8 + PricingConfig::INIT_SPACE, seeds = [b"pricing", curve_config.key().as_ref()], bump)]
    pub pricing: Box<Account<'info, PricingConfig>>,
    /// CHECK: validated by `read_price` and then bound.
    pub price_update: UncheckedAccount<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ ElpidaError::Unauthorized)]
    pub program: Program<'info, crate::program::ElpidaLaunchpad>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ ElpidaError::Unauthorized)]
    pub program_data: Box<Account<'info, ProgramData>>,
    pub system_program: Program<'info, System>,
}

/// Oracle pricing for one curve config (PDA ["pricing", config]).
#[account]
#[derive(InitSpace)]
pub struct PricingConfig {
    pub config: Pubkey,
    pub price_feed: Pubkey,
    pub feed_id: [u8; 32],
    pub max_age_secs: u32,
    pub max_conf_bps: u16,
    pub fee_usd_e6: u64,
    pub start_fdv_usd_e6: u64,
    pub usdc_mint: Pubkey,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct TestBuildCheck {}

/// The devnet SOL/asset conversion pool (test builds only). Its SOL is the account's lamports above rent
/// (`sol_reserve`); its asset sits in the PDA's associated token account (`quote_reserve`).
#[account]
#[derive(InitSpace)]
pub struct TestConversion {
    pub quote_mint: Pubkey,
    pub sol_reserve: u64,
    pub quote_reserve: u64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct SeedTestConversion<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init_if_needed, payer = authority, space = 8 + TestConversion::INIT_SPACE, seeds = [b"test-conversion", quote_mint.key().as_ref()], bump)]
    pub pool: Box<Account<'info, TestConversion>>,
    #[account(mint::token_program = quote_token_program)]
    pub quote_mint: Box<InterfaceAccount<'info, QuoteMint>>,
    #[account(mut, token::mint = quote_mint, token::authority = authority, token::token_program = quote_token_program)]
    pub authority_quote: Box<InterfaceAccount<'info, QuoteAccount>>,
    #[account(init_if_needed, payer = authority, associated_token::mint = quote_mint, associated_token::authority = pool, associated_token::token_program = quote_token_program)]
    pub pool_quote: Box<InterfaceAccount<'info, QuoteAccount>>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ ElpidaError::Unauthorized)]
    pub program: Program<'info, crate::program::ElpidaLaunchpad>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ ElpidaError::Unauthorized)]
    pub program_data: Box<Account<'info, ProgramData>>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TestConversionSwap<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [b"test-conversion", quote_mint.key().as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, TestConversion>>,
    #[account(mint::token_program = quote_token_program)]
    pub quote_mint: Box<InterfaceAccount<'info, QuoteMint>>,
    #[account(init_if_needed, payer = user, associated_token::mint = quote_mint, associated_token::authority = user, associated_token::token_program = quote_token_program)]
    pub user_quote: Box<InterfaceAccount<'info, QuoteAccount>>,
    #[account(mut, associated_token::mint = quote_mint, associated_token::authority = pool, associated_token::token_program = quote_token_program)]
    pub pool_quote: Box<InterfaceAccount<'info, QuoteAccount>>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Mainnet beta: when enabled, only allowlisted creators can launch.
#[account]
#[derive(InitSpace)]
pub struct BetaGate {
    pub authority: Pubkey,
    pub enabled: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct BetaCreator {
    pub creator: Pubkey,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct SetBetaGate<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init_if_needed, payer = authority, space = 8 + BetaGate::INIT_SPACE, seeds = [b"beta-gate"], bump)]
    pub beta_gate: Box<Account<'info, BetaGate>>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ ElpidaError::Unauthorized)]
    pub program: Program<'info, crate::program::ElpidaLaunchpad>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ ElpidaError::Unauthorized)]
    pub program_data: Box<Account<'info, ProgramData>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(creator: Pubkey)]
pub struct AllowBetaCreator<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [b"beta-gate"], bump = beta_gate.bump, has_one = authority @ ElpidaError::Unauthorized)]
    pub beta_gate: Box<Account<'info, BetaGate>>,
    #[account(init_if_needed, payer = authority, space = 8 + BetaCreator::INIT_SPACE, seeds = [b"beta-creator", creator.as_ref()], bump)]
    pub beta_creator: Box<Account<'info, BetaCreator>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeBetaCreator<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [b"beta-gate"], bump = beta_gate.bump, has_one = authority @ ElpidaError::Unauthorized)]
    pub beta_gate: Box<Account<'info, BetaGate>>,
    #[account(mut, close = authority, seeds = [b"beta-creator", beta_creator.creator.as_ref()], bump = beta_creator.bump)]
    pub beta_creator: Box<Account<'info, BetaCreator>>,
}

#[derive(Accounts)]
pub struct Trade<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(has_one = quote_mint)]
    pub curve_config: Box<Account<'info, CurveConfig>>,
    #[account(mint::token_program = quote_token_program)]
    pub quote_mint: Box<InterfaceAccount<'info, QuoteMint>>,
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [b"curve", mint.key().as_ref()], bump = pool.bump, has_one = mint, constraint = pool.config == curve_config.key() @ ElpidaError::WrongConfig)]
    pub pool: Box<Account<'info, CurvePool>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = pool)]
    pub token_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = quote_mint, associated_token::authority = pool, associated_token::token_program = quote_token_program)]
    pub quote_vault: Box<InterfaceAccount<'info, QuoteAccount>>,
    #[account(init_if_needed, payer = trader, associated_token::mint = quote_mint, associated_token::authority = trader, associated_token::token_program = quote_token_program)]
    pub trader_quote: Box<InterfaceAccount<'info, QuoteAccount>>,
    #[account(init_if_needed, payer = trader, associated_token::mint = mint, associated_token::authority = trader)]
    pub trader_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawFees<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(has_one = quote_mint, has_one = treasury)]
    pub curve_config: Box<Account<'info, CurveConfig>>,
    #[account(mint::token_program = quote_token_program)]
    pub quote_mint: Box<InterfaceAccount<'info, QuoteMint>>,
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [b"curve", mint.key().as_ref()], bump = pool.bump, has_one = mint, has_one = reward, constraint = pool.config == curve_config.key() @ ElpidaError::WrongConfig)]
    pub pool: Box<Account<'info, CurvePool>>,
    /// CHECK: verified against curve_config.treasury.
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: verified against pool.reward.
    pub reward: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = quote_mint, associated_token::authority = treasury, associated_token::token_program = quote_token_program)]
    pub treasury_quote: Box<InterfaceAccount<'info, QuoteAccount>>,
    #[account(init_if_needed, payer = payer, associated_token::mint = quote_mint, associated_token::authority = reward, associated_token::token_program = quote_token_program)]
    pub reward_quote: Box<InterfaceAccount<'info, QuoteAccount>>,
    #[account(mut, associated_token::mint = quote_mint, associated_token::authority = pool, associated_token::token_program = quote_token_program)]
    pub quote_vault: Box<InterfaceAccount<'info, QuoteAccount>>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// One per migrated curve: where its liquidity went and the principal that must stay locked.
#[account]
#[derive(InitSpace)]
pub struct PumpMigration {
    pub curve_pool: Pubkey,
    pub mint: Pubkey,
    pub pump_pool: Pubkey,
    pub lp_mint: Pubkey,
    pub lp_locked: u64,
    /// Liquidity units (lp / lp_supply * sqrt(base * quote)) at migration; never withdrawn.
    pub principal: u128,
    pub base_migrated: u64,
    pub quote_migrated: u64,
    pub harvested_lp: u64,
    pub harvested_base: u64,
    pub harvested_quote: u64,
    pub migrated_at: i64,
    pub bump: u8,
    pub authority_bump: u8,
}

#[derive(Accounts)]
pub struct MigrateToPumpswap<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(has_one = quote_mint)]
    pub curve_config: Box<Account<'info, CurveConfig>>,
    #[account(mint::token_program = quote_token_program)]
    pub quote_mint: Box<InterfaceAccount<'info, QuoteMint>>,
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [b"curve", mint.key().as_ref()], bump = pool.bump, has_one = mint, constraint = pool.config == curve_config.key() @ ElpidaError::WrongConfig)]
    pub pool: Box<Account<'info, CurvePool>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = pool)]
    pub token_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = quote_mint, associated_token::authority = pool, associated_token::token_program = quote_token_program)]
    pub quote_vault: Box<InterfaceAccount<'info, QuoteAccount>>,
    /// Data-less PDA that creates the PumpSwap pool and owns its LP tokens forever.
    #[account(mut, seeds = [b"pump-lp", mint.key().as_ref()], bump)]
    pub lp_authority: SystemAccount<'info>,
    #[account(init_if_needed, payer = payer, associated_token::mint = mint, associated_token::authority = lp_authority)]
    pub authority_base: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = payer, associated_token::mint = quote_mint, associated_token::authority = lp_authority, associated_token::token_program = quote_token_program)]
    pub authority_quote: Box<InterfaceAccount<'info, QuoteAccount>>,
    /// CHECK: the LP authority's Token-2022 LP account, created by PumpSwap.
    #[account(mut, address = get_associated_token_address_with_program_id(&lp_authority.key(), &lp_mint.key(), &token_2022_program.key()) @ ElpidaError::PumpAccount)]
    pub authority_lp: UncheckedAccount<'info>,
    #[account(init, payer = payer, space = 8 + PumpMigration::INIT_SPACE + MIGRATION_EXT_LEN, seeds = [b"pump-migration", mint.key().as_ref()], bump)]
    pub migration: Box<Account<'info, PumpMigration>>,
    /// CHECK: PumpSwap pool PDA; created and seed-checked by PumpSwap.
    #[account(mut)]
    pub pump_pool: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = PUMP_GLOBAL_CONFIG)]
    pub pump_global_config: UncheckedAccount<'info>,
    /// CHECK: PumpSwap LP mint PDA; created and seed-checked by PumpSwap.
    #[account(mut)]
    pub lp_mint: UncheckedAccount<'info>,
    /// CHECK: PumpSwap pool vault; created and checked by PumpSwap.
    #[account(mut)]
    pub pump_pool_base: UncheckedAccount<'info>,
    /// CHECK: PumpSwap pool vault; created and checked by PumpSwap.
    #[account(mut)]
    pub pump_pool_quote: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = PUMP_EVENT_AUTHORITY)]
    pub pump_event_authority: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = PUMP_AMM)]
    pub pump_amm_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct HarvestLpFees<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(has_one = quote_mint, has_one = treasury)]
    pub curve_config: Box<Account<'info, CurveConfig>>,
    /// CHECK: matched against curve_config.quote_mint.
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: matched against pool.mint.
    pub mint: UncheckedAccount<'info>,
    #[account(seeds = [b"curve", mint.key().as_ref()], bump = pool.bump, has_one = mint, has_one = reward, constraint = pool.config == curve_config.key() @ ElpidaError::WrongConfig, constraint = pool.status == STATUS_MIGRATED @ ElpidaError::NotMigrated)]
    pub pool: Box<Account<'info, CurvePool>>,
    #[account(mut, seeds = [b"pump-migration", mint.key().as_ref()], bump = migration.bump, has_one = pump_pool, has_one = lp_mint)]
    pub migration: Box<Account<'info, PumpMigration>>,
    /// CHECK: PDA signer only.
    #[account(seeds = [b"pump-lp", mint.key().as_ref()], bump = migration.authority_bump)]
    pub lp_authority: UncheckedAccount<'info>,
    // Token accounts below are checked in the handler (associated-token addresses) to keep this
    // struct's validation frame within the 4 KiB stack limit. Destinations must already exist.
    /// CHECK: ATA(lp_authority, mint).
    #[account(mut)]
    pub authority_base: UncheckedAccount<'info>,
    /// CHECK: ATA(lp_authority, quote_mint).
    #[account(mut)]
    pub authority_quote: UncheckedAccount<'info>,
    /// CHECK: Token-2022 ATA(lp_authority, lp_mint).
    #[account(mut)]
    pub authority_lp: UncheckedAccount<'info>,
    /// CHECK: matched against the migration record; owner checked when read.
    #[account(mut)]
    pub pump_pool: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = PUMP_GLOBAL_CONFIG)]
    pub pump_global_config: UncheckedAccount<'info>,
    /// CHECK: matched against the migration record.
    #[account(mut)]
    pub lp_mint: UncheckedAccount<'info>,
    /// CHECK: matched against the PumpSwap pool's stored vault.
    #[account(mut)]
    pub pump_pool_base: UncheckedAccount<'info>,
    /// CHECK: matched against the PumpSwap pool's stored vault.
    #[account(mut)]
    pub pump_pool_quote: UncheckedAccount<'info>,
    /// CHECK: verified against curve_config.treasury.
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: verified against pool.reward.
    pub reward: UncheckedAccount<'info>,
    /// CHECK: ATA(treasury, mint).
    #[account(mut)]
    pub treasury_base: UncheckedAccount<'info>,
    /// CHECK: ATA(treasury, quote_mint).
    #[account(mut)]
    pub treasury_quote: UncheckedAccount<'info>,
    /// CHECK: ATA(reward, mint).
    #[account(mut)]
    pub reward_base: UncheckedAccount<'info>,
    /// CHECK: ATA(reward, quote_mint).
    #[account(mut)]
    pub reward_quote: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = PUMP_EVENT_AUTHORITY)]
    pub pump_event_authority: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = PUMP_AMM)]
    pub pump_amm_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct MigrateToRaydium<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(has_one = quote_mint)]
    pub curve_config: Box<Account<'info, CurveConfig>>,
    /// The SOL pair only.
    #[account(address = WSOL_MINT @ ElpidaError::WrongVenue)]
    pub quote_mint: Box<Account<'info, Mint>>,
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [b"curve", mint.key().as_ref()], bump = pool.bump, has_one = mint, constraint = pool.config == curve_config.key() @ ElpidaError::WrongConfig)]
    pub pool: Box<Account<'info, CurvePool>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = pool)]
    pub token_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = quote_mint, associated_token::authority = pool)]
    pub quote_vault: Box<Account<'info, TokenAccount>>,
    /// Data-less PDA that creates the Raydium pool and owns its LP tokens forever (the same PDA as for PumpSwap).
    #[account(mut, seeds = [b"pump-lp", mint.key().as_ref()], bump)]
    pub lp_authority: SystemAccount<'info>,
    #[account(init_if_needed, payer = payer, associated_token::mint = mint, associated_token::authority = lp_authority)]
    pub authority_base: Box<Account<'info, TokenAccount>>,
    /// Closed again in the same instruction (it repays the caller); harvests recreate it.
    #[account(init_if_needed, payer = payer, associated_token::mint = quote_mint, associated_token::authority = lp_authority)]
    pub authority_quote: Box<Account<'info, TokenAccount>>,
    /// CHECK: the LP authority's LP account (SPL Token), created by Raydium.
    #[account(mut, address = get_associated_token_address_with_program_id(&lp_authority.key(), &lp_mint.key(), &token_program.key()) @ ElpidaError::RaydiumAccount)]
    pub authority_lp: UncheckedAccount<'info>,
    #[account(init, payer = payer, space = 8 + PumpMigration::INIT_SPACE + MIGRATION_EXT_LEN, seeds = [b"pump-migration", mint.key().as_ref()], bump)]
    pub migration: Box<Account<'info, PumpMigration>>,
    /// CHECK: Elpida's PDA for this token's Raydium pool; Raydium creates it (it signs, so nobody can take it first).
    #[account(mut, seeds = [b"ray-pool", mint.key().as_ref()], bump)]
    pub ray_pool: UncheckedAccount<'info>,
    /// CHECK: fixed address (1% tier); owner, discriminator and fee rate checked when read.
    #[account(address = raydium::AMM_CONFIG @ ElpidaError::RaydiumAccount)]
    pub amm_config: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = raydium::AUTHORITY @ ElpidaError::RaydiumAccount)]
    pub ray_authority: UncheckedAccount<'info>,
    /// CHECK: Raydium LP mint PDA; created and seed-checked by Raydium.
    #[account(mut)]
    pub lp_mint: UncheckedAccount<'info>,
    /// CHECK: Raydium vault PDA for token 0 (mints ordered by address); created and seed-checked by Raydium.
    #[account(mut)]
    pub ray_vault_0: UncheckedAccount<'info>,
    /// CHECK: Raydium vault PDA for token 1; created and seed-checked by Raydium.
    #[account(mut)]
    pub ray_vault_1: UncheckedAccount<'info>,
    /// CHECK: fixed address; Raydium's pool-creation fee receiver.
    #[account(mut, address = raydium::CREATE_POOL_FEE @ ElpidaError::RaydiumAccount)]
    pub create_pool_fee: UncheckedAccount<'info>,
    /// CHECK: Raydium observation PDA; created and seed-checked by Raydium.
    #[account(mut)]
    pub observation: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = raydium::PROGRAM @ ElpidaError::RaydiumAccount)]
    pub raydium_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct HarvestRaydiumFees<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(has_one = quote_mint, has_one = treasury)]
    pub curve_config: Box<Account<'info, CurveConfig>>,
    /// CHECK: matched against curve_config.quote_mint (wrapped SOL; the pool owner check rejects anything else).
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: matched against pool.mint.
    pub mint: UncheckedAccount<'info>,
    #[account(seeds = [b"curve", mint.key().as_ref()], bump = pool.bump, has_one = mint, has_one = reward, constraint = pool.config == curve_config.key() @ ElpidaError::WrongConfig, constraint = pool.status == STATUS_MIGRATED @ ElpidaError::NotMigrated)]
    pub pool: Box<Account<'info, CurvePool>>,
    #[account(mut, seeds = [b"pump-migration", mint.key().as_ref()], bump = migration.bump, has_one = lp_mint, constraint = migration.pump_pool == ray_pool.key() @ ElpidaError::RaydiumAccount)]
    pub migration: Box<Account<'info, PumpMigration>>,
    /// CHECK: PDA signer only.
    #[account(seeds = [b"pump-lp", mint.key().as_ref()], bump = migration.authority_bump)]
    pub lp_authority: UncheckedAccount<'info>,
    // Token accounts below are checked in the handler (associated-token addresses). Destinations must already exist.
    /// CHECK: ATA(lp_authority, mint).
    #[account(mut)]
    pub authority_base: UncheckedAccount<'info>,
    /// CHECK: ATA(lp_authority, quote_mint).
    #[account(mut)]
    pub authority_quote: UncheckedAccount<'info>,
    /// CHECK: ATA(lp_authority, lp_mint).
    #[account(mut)]
    pub authority_lp: UncheckedAccount<'info>,
    /// CHECK: matched against the migration record; owner checked when read.
    #[account(mut)]
    pub ray_pool: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = raydium::AUTHORITY @ ElpidaError::RaydiumAccount)]
    pub ray_authority: UncheckedAccount<'info>,
    /// CHECK: matched against the migration record.
    #[account(mut)]
    pub lp_mint: UncheckedAccount<'info>,
    /// CHECK: matched against the Raydium pool's stored vault.
    #[account(mut)]
    pub ray_vault_0: UncheckedAccount<'info>,
    /// CHECK: matched against the Raydium pool's stored vault.
    #[account(mut)]
    pub ray_vault_1: UncheckedAccount<'info>,
    /// CHECK: verified against curve_config.treasury.
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: verified against pool.reward.
    pub reward: UncheckedAccount<'info>,
    /// CHECK: ATA(treasury, mint).
    #[account(mut)]
    pub treasury_base: UncheckedAccount<'info>,
    /// CHECK: ATA(treasury, quote_mint).
    #[account(mut)]
    pub treasury_quote: UncheckedAccount<'info>,
    /// CHECK: ATA(reward, mint).
    #[account(mut)]
    pub reward_base: UncheckedAccount<'info>,
    /// CHECK: ATA(reward, quote_mint).
    #[account(mut)]
    pub reward_quote: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = raydium::PROGRAM @ ElpidaError::RaydiumAccount)]
    pub raydium_program: UncheckedAccount<'info>,
    /// CHECK: fixed address (Raydium's withdraw takes the memo program).
    #[account(address = MEMO_PROGRAM)]
    pub memo_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
}

impl<'info> HarvestRaydiumFees<'info> {
    #[inline(never)]
    fn check_token_accounts(&self) -> Result<()> {
        let spl = self.token_program.key();
        let (mint, quote, lp) = (self.mint.key(), self.quote_mint.key(), self.lp_mint.key());
        let (authority, treasury, reward) = (self.lp_authority.key(), self.treasury.key(), self.reward.key());
        for (account, owner, account_mint) in [
            (&self.authority_base, authority, mint), (&self.authority_quote, authority, quote), (&self.authority_lp, authority, lp),
            (&self.treasury_base, treasury, mint), (&self.treasury_quote, treasury, quote),
            (&self.reward_base, reward, mint), (&self.reward_quote, reward, quote),
        ] {
            require_keys_eq!(account.key(), get_associated_token_address_with_program_id(&owner, &account_mint, &spl), ElpidaError::RaydiumAccount);
        }
        Ok(())
    }
}

#[derive(Accounts)]
pub struct RaydiumBuyback<'info> {
    /// CHECK: matched against pool.mint; burned from, so writable.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = WSOL_MINT @ ElpidaError::WrongVenue)]
    pub quote_mint: UncheckedAccount<'info>,
    #[account(seeds = [b"curve", mint.key().as_ref()], bump = pool.bump, has_one = mint, constraint = pool.status == STATUS_MIGRATED @ ElpidaError::NotMigrated)]
    pub pool: Box<Account<'info, CurvePool>>,
    #[account(mut, seeds = [b"pump-migration", mint.key().as_ref()], bump = migration.bump, constraint = migration.pump_pool == ray_pool.key() @ ElpidaError::RaydiumAccount)]
    pub migration: Box<Account<'info, PumpMigration>>,
    /// CHECK: PDA signer only.
    #[account(seeds = [b"pump-lp", mint.key().as_ref()], bump = migration.authority_bump)]
    pub lp_authority: UncheckedAccount<'info>,
    /// CHECK: ATA(lp_authority, mint); receives the bought tokens, which are burned.
    #[account(mut, address = get_associated_token_address_with_program_id(&lp_authority.key(), &mint.key(), &token_program.key()) @ ElpidaError::RaydiumAccount)]
    pub authority_base: UncheckedAccount<'info>,
    /// CHECK: ATA(lp_authority, wrapped SOL); holds the queued SOL.
    #[account(mut, address = get_associated_token_address_with_program_id(&lp_authority.key(), &WSOL_MINT, &token_program.key()) @ ElpidaError::RaydiumAccount)]
    pub authority_quote: UncheckedAccount<'info>,
    /// CHECK: matched against the migration record; owner checked when read.
    #[account(mut)]
    pub ray_pool: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = raydium::AUTHORITY @ ElpidaError::RaydiumAccount)]
    pub ray_authority: UncheckedAccount<'info>,
    /// CHECK: fixed address; Raydium checks it is the pool's config.
    #[account(address = raydium::AMM_CONFIG @ ElpidaError::RaydiumAccount)]
    pub amm_config: UncheckedAccount<'info>,
    /// CHECK: matched against the Raydium pool's stored vault.
    #[account(mut)]
    pub ray_vault_0: UncheckedAccount<'info>,
    /// CHECK: matched against the Raydium pool's stored vault.
    #[account(mut)]
    pub ray_vault_1: UncheckedAccount<'info>,
    /// CHECK: Raydium checks it is the pool's observation account.
    #[account(mut)]
    pub observation: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = raydium::PROGRAM @ ElpidaError::RaydiumAccount)]
    pub raydium_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

impl<'info> HarvestLpFees<'info> {
    /// The quote mint's token program account (the quote mint is owned by SPL Token or Token-2022).
    fn quote_program_info(&self) -> AccountInfo<'info> {
        if *self.quote_mint.owner == anchor_spl::token_2022::ID { self.token_2022_program.to_account_info() } else { self.token_program.to_account_info() }
    }
    #[inline(never)]
    fn check_token_accounts(&self) -> Result<()> {
        let (spl, t22) = (self.token_program.key(), self.token_2022_program.key());
        let qp = *self.quote_mint.owner;
        require!(qp == spl || qp == t22, ElpidaError::UnsupportedQuote);
        let (mint, quote, lp) = (self.mint.key(), self.quote_mint.key(), self.lp_mint.key());
        let (authority, treasury, reward) = (self.lp_authority.key(), self.treasury.key(), self.reward.key());
        for (account, owner, account_mint, program) in [
            (&self.authority_base, authority, mint, spl), (&self.authority_quote, authority, quote, qp), (&self.authority_lp, authority, lp, t22),
            (&self.treasury_base, treasury, mint, spl), (&self.treasury_quote, treasury, quote, qp),
            (&self.reward_base, reward, mint, spl), (&self.reward_quote, reward, quote, qp),
        ] {
            require_keys_eq!(account.key(), get_associated_token_address_with_program_id(&owner, &account_mint, &program), ElpidaError::PumpAccount);
        }
        Ok(())
    }
}

// Trade events carry post-trade state so an indexer can derive price
// ((virtual_quote) / token_reserve), market cap and candles from events alone.
#[event]
pub struct PricingConfigSet { pub config: Pubkey, pub price_feed: Pubkey, pub fee_usd_e6: u64, pub start_fdv_usd_e6: u64, pub usdc_mint: Pubkey, pub price: i64, pub exponent: i32, pub publish_time: i64 }
#[event]
pub struct LaunchFeePaid { pub mint: Pubkey, pub payer: Pubkey, pub asset: Pubkey, pub amount: u64, pub price: i64, pub exponent: i32, pub publish_time: i64 }
#[event]
pub struct CurveConfigUpdated { pub config: Pubkey, pub quote_mint: Pubkey, pub virtual_quote: u64, pub virtual_token: u64, pub curve_supply: u64, pub launch_fee: u64, pub max_creator_buy_bps: u16 }
#[event]
pub struct BetaGateSet { pub authority: Pubkey, pub enabled: bool }
#[event]
pub struct BetaCreatorSet { pub creator: Pubkey, pub allowed: bool }
#[event]
pub struct CurveLaunched { pub creator: Pubkey, pub mint: Pubkey, pub pool: Pubkey, pub quote_in: u64, pub tokens_out: u64, pub fee: u64, pub real_quote: u64, pub virtual_quote: u64, pub token_reserve: u64, pub sold: u64 }
#[event]
pub struct CurveBought { pub pool: Pubkey, pub buyer: Pubkey, pub quote_in: u64, pub tokens_out: u64, pub fee: u64, pub anti_snipe_fee: u64, pub real_quote: u64, pub virtual_quote: u64, pub token_reserve: u64, pub sold: u64 }
#[event]
pub struct CurveSold { pub pool: Pubkey, pub seller: Pubkey, pub tokens_in: u64, pub quote_out: u64, pub fee: u64, pub anti_snipe_fee: u64, pub real_quote: u64, pub virtual_quote: u64, pub token_reserve: u64, pub sold: u64 }
#[event]
pub struct TestConversionSeeded { pub quote_mint: Pubkey, pub sol_reserve: u64, pub quote_reserve: u64 }
#[event]
pub struct TestConversionSwapped { pub quote_mint: Pubkey, pub sol_in: bool, pub amount_in: u64, pub amount_out: u64, pub sol_reserve: u64, pub quote_reserve: u64 }
#[event]
pub struct LockedPoolOpened { pub pool: Pubkey, pub mint: Pubkey, pub quote_reserve: u64, pub token_reserve: u64 }
#[event]
pub struct CurveGraduated { pub pool: Pubkey, pub mint: Pubkey, pub real_quote: u64, pub liquidity_bonus: u64, pub lp_tokens: u64 }
#[event]
pub struct FeesWithdrawn { pub pool: Pubkey, pub recipient: Pubkey, pub amount: u64 }
#[event]
pub struct CurveMigrated { pub pool: Pubkey, pub mint: Pubkey, pub pump_pool: Pubkey, pub lp_mint: Pubkey, pub base_amount: u64, pub quote_amount: u64, pub lp_locked: u64 }
#[event]
pub struct CurveReopened { pub pool: Pubkey, pub mint: Pubkey, pub graduated_at: i64, pub reopened_at: i64, pub real_quote: u64, pub liquidity_bonus: u64 }
#[event]
pub struct PartnerSet { pub creator: Pubkey, pub buyback_bps: u16, pub expires_at: i64 }
#[event]
pub struct PartnerPoolLaunched { pub pool: Pubkey, pub mint: Pubkey, pub creator: Pubkey, pub buyback_bps: u16 }
#[event]
pub struct PartnerBuyback { pub pool: Pubkey, pub quote_in: u64, pub tokens_burned: u64, pub total_burned: u64 }
#[event]
pub struct PartnerHarvest { pub pool: Pubkey, pub base_burned: u64, pub quote_queued: u64, pub pending_buyback: u64 }
#[event]
pub struct RaydiumMigrated { pub pool: Pubkey, pub ray_pool: Pubkey, pub lp_mint: Pubkey, pub raised: u64, pub creation_cost: u64, pub repaid: u64 }
#[event]
pub struct StrandedBuybackReleased { pub pool: Pubkey, pub amount: u64 }
#[event]
pub struct PartnerLpBuyback { pub pool: Pubkey, pub quote_in: u64, pub tokens_burned: u64, pub pending_buyback: u64, pub total_burned: u64 }
#[event]
pub struct LpFeesHarvested { pub pool: Pubkey, pub pump_pool: Pubkey, pub lp_burned: u64, pub base_out: u64, pub quote_out: u64, pub protocol_base: u64, pub protocol_quote: u64, pub lp_locked: u64 }

#[event]
pub struct V2ConfigAdded { pub config: Pubkey, pub quote_mint: Pubkey, pub min_fee_bps: u16 }
#[event]
pub struct V2PoolLaunched { pub pool: Pubkey, pub mint: Pubkey, pub creator: Pubkey, pub fee_bps: u16 }
/// `recipient`: 0 creator, 1 trader airdrop, 2 flywheel, 3 holder rewards, 4 treasury.
/// A V2 pool's graduated-pool fees: the token side burned, the quote side added to the five-way ledger.
#[event]
pub struct V2Harvested { pub pool: Pubkey, pub base_burned: u64, pub quote_accrued: u64, pub accrued: u64 }
#[event]
pub struct V2DistributorSet { pub kind: u8, pub operator: Pubkey, pub period: u32, pub genesis: i64 }
#[event]
pub struct V2RootPosted { pub kind: u8, pub round: u32, pub asset: Pubkey, pub root: [u8; 32], pub total: u64, pub recipients: u32, pub manifest_uri: String }
#[event]
pub struct V2Claimed { pub kind: u8, pub round: u32, pub asset: Pubkey, pub index: u32, pub account: Pubkey, pub amount: u64 }
#[event]
pub struct V2Expired { pub kind: u8, pub round: u32, pub asset: Pubkey, pub returned_to_pool: u64 }
#[event]
pub struct V2SolSwept { pub kind: u8, pub lamports: u64 }
#[event]
pub struct V2ConvertedToUsdc { pub kind: u8, pub sol_in: u64, pub usdc_out: u64 }
/// `venue`: 0 the curve, 1 Raydium.
#[event]
pub struct V2BoughtAndBurned { pub pool: Pubkey, pub mint: Pubkey, pub asset: Pubkey, pub spent: u64, pub burned: u64, pub supply_after: u64, pub venue: u8 }
#[event]
pub struct V2FeesPaid { pub pool: Pubkey, pub recipient: u8, pub to: Pubkey, pub amount: u64 }

#[error_code]
pub enum ElpidaError {
    #[msg("Only the program upgrade authority can initialize")] Unauthorized,
    #[msg("Quote token must have 6 to 9 decimals")] QuoteDecimals,
    #[msg("Name must be 1-32 bytes")] InvalidName,
    #[msg("Symbol must be 1-10 uppercase letters or digits")] InvalidSymbol,
    #[msg("Invalid curve parameters")] InvalidParams,
    #[msg("Positive buy required")] FirstBuyRequired,
    #[msg("Creator reward wallet required")] RewardRequired,
    #[msg("Slippage limit exceeded")] Slippage,
    #[msg("Buy too small")] BuyTooSmall,
    #[msg("Invalid sell amount")] InvalidSell,
    #[msg("Sell too small")] SellTooSmall,
    #[msg("Sell exceeds the curve reserve")] InsufficientReserve,
    #[msg("Curve is complete; trading continues on PumpSwap after migration")] CurveClosed,
    #[msg("Creator first buy exceeds the cap")] CreatorBuyCap,
    #[msg("Pool belongs to a different config")] WrongConfig,
    #[msg("Math overflow")] MathOverflow,
    #[msg("The curve is not complete yet")] NotComplete,
    #[msg("This curve has not migrated to PumpSwap")] NotMigrated,
    #[msg("No trading fees to harvest yet")] NothingToHarvest,
    #[msg("Unexpected PumpSwap account")] PumpAccount,
    #[msg("Harvest would reduce the locked liquidity")] PrincipalBreached,
    #[msg("This token cannot be a trading pair: PumpSwap or the curve cannot handle its token extensions")] UnsupportedQuote,
    #[msg("This instruction exists only on test networks")] TestNetworksOnly,
    #[msg("Launches are invite-only during the beta")] BetaClosed,
    #[msg("The fee schedule of an existing config cannot change; live pools read it")] FeeScheduleFixed,
    #[msg("The USD price is unavailable or not the configured oracle account")] PriceUnavailable,
    #[msg("The USD price is too old")] PriceStale,
    #[msg("The USD price is too uncertain right now")] PriceUncertain,
    #[msg("The creation fee rose above your limit; refresh the quote")] FeeAboveMax,
    #[msg("USDC fee payment is not available for this pair")] UsdcFeeUnavailable,
    #[msg("Token metadata must be an ipfs:// URI of at most 200 printable characters")] InvalidUri,
    #[msg("The curve can be reopened only 24 hours after it completed without migrating")] GraceNotOver,
    #[msg("Partner tiers are 10% or 20% with an expiry at most 180 days ahead, or (0, 0) to end one")] PartnerTerms,
    #[msg("SOL pairs graduate to Raydium; other pairs to PumpSwap")] WrongVenue,
    #[msg("Unexpected Raydium account")] RaydiumAccount,
    #[msg("No queued partner buyback to spend")] NothingToBuyBack,
    #[msg("A buyback ran less than a minute ago; the next one waits")] BuybackTooSoon,
    #[msg("This needs an ELPIDA V2 pool or config")] NotV2,
    #[msg("The token's fee must be between the pair's minimum and 4%")] V2FeeRange,
    #[msg("Nothing owed yet")] NothingToWithdraw,
    #[msg("Unused (kept so later error codes do not shift)")] V2HarvestPending,
    #[msg("Invalid distributor or round terms")] V2Terms,
    #[msg("This round has not ended yet")] RoundNotOver,
    #[msg("The vault does not hold enough beyond what earlier rounds still owe")] NotFunded,
    #[msg("Invalid payout proof")] BadProof,
    #[msg("This payout was already claimed")] AlreadyPaid,
    #[msg("This round is closed")] RoundClosed,
    #[msg("Flywheel limits: tokens a day old, at most 10% of the vault per order, one order per token every 6 hours")] FlywheelLimit,
    #[msg("The flywheel never completes a curve")] FlywheelWouldComplete,
}
