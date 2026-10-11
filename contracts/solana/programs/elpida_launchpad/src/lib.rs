//! Elpida launchpad for Solana, model 3: virtual-reserve bonding curve. NOT AUDITED.
//!
//! - Trading pairs: one `CurveConfig` per quote mint (wrapped SOL for native SOL, USDC, an xStock or
//!   another approved token), each with its own curve parameters and creation fee in that asset.
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
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::pubkey;
use anchor_lang::system_program;
use anchor_spl::associated_token::{get_associated_token_address_with_program_id, AssociatedToken};
use anchor_spl::token_2022::Token2022;
use anchor_spl::token::spl_token::instruction::AuthorityType;
use anchor_spl::token::{self, Mint, MintTo, SetAuthority, Token, TokenAccount, Transfer};
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

pub const PUMP_AMM: Pubkey = pubkey!("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
pub const PUMP_GLOBAL_CONFIG: Pubkey = pubkey!("ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw");
pub const PUMP_EVENT_AUTHORITY: Pubkey = pubkey!("GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR");
const PUMP_CREATE_POOL: [u8; 8] = [233, 146, 209, 142, 207, 104, 64, 188];
const PUMP_WITHDRAW: [u8; 8] = [183, 18, 70, 156, 148, 109, 161, 34];
/// SOL lent to the LP-authority PDA so it can pay PumpSwap's account rent; the rest is refunded.
pub const MIGRATION_RENT_LAMPORTS: u64 = 50_000_000;
/// Largest single test-faucet mint, in whole units of the test asset (10,000,000).
pub const TEST_FAUCET_MAX_WHOLE: u64 = 10_000_000;
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
    /// Creation fee in the quote asset's base units (about $10 worth).
    pub launch_fee: u64,
}

#[program]
pub mod elpida_launchpad {
    use super::*;

    /// One-time setup by the program's upgrade authority: quote mint, treasury and curve parameters.
    pub fn initialize_curve(ctx: Context<InitializeCurve>, params: CurveParams) -> Result<()> {
        let bump = ctx.bumps.curve_config;
        let (quote_mint, treasury) = (ctx.accounts.quote_mint.key(), ctx.accounts.treasury.key());
        check_quote_mint(&ctx.accounts.quote_mint.to_account_info())?;
        write_config(&mut ctx.accounts.curve_config, quote_mint, ctx.accounts.quote_mint.decimals, treasury, &params, bump)
    }

    /// Upgrade authority: an additional curve config for another quote mint, PDA ["curve-config", quote_mint].
    /// Every config is created only here or by `initialize_curve`; pools record the config they use.
    pub fn add_curve_config(ctx: Context<AddCurveConfig>, params: CurveParams) -> Result<()> {
        let bump = ctx.bumps.curve_config;
        let (quote_mint, treasury) = (ctx.accounts.quote_mint.key(), ctx.accounts.treasury.key());
        check_quote_mint(&ctx.accounts.quote_mint.to_account_info())?;
        write_config(&mut ctx.accounts.curve_config, quote_mint, ctx.accounts.quote_mint.decimals, treasury, &params, bump)
    }

    /// TEST NETWORKS ONLY (devnet / localnet): creates "Elpida tUSDC", a valueless 6-decimal stand-in
    /// for USDC at PDA ["test-usdc"] whose only minter is `test_usdc_faucet`. Never create on mainnet.
    pub fn create_test_usdc(_ctx: Context<CreateTestUsdc>) -> Result<()> {
        test_networks_only()
    }

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

    pub fn launch(ctx: Context<Launch>, name: String, symbol: String, first_buy: u64, min_tokens_out: u64, reward: Pubkey) -> Result<()> {
        check_beta(&ctx.accounts.beta_gate.to_account_info(), &ctx.accounts.beta_creator.to_account_info())?;
        let name = name.trim().to_string();
        require!(!name.is_empty() && name.len() <= MAX_NAME, ElpidaError::InvalidName);
        require!(
            !symbol.is_empty() && symbol.len() <= MAX_SYMBOL && symbol.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()),
            ElpidaError::InvalidSymbol
        );
        require!(first_buy > 0, ElpidaError::FirstBuyRequired);
        require!(reward != Pubkey::default(), ElpidaError::RewardRequired);

        let a = &ctx.accounts;
        let tp = a.token_program.to_account_info();
        let decimals = a.quote_mint.decimals;
        quote_transfer(&a.quote_token_program, &a.quote_mint, a.creator_quote.to_account_info(), a.treasury_quote.to_account_info(), a.creator.to_account_info(), a.curve_config.launch_fee, decimals, &[])?;
        token::mint_to(
            CpiContext::new(tp.clone(), MintTo { mint: a.mint.to_account_info(), to: a.token_vault.to_account_info(), authority: a.creator.to_account_info() }),
            TOKEN_SUPPLY,
        )?;
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
        let now = Clock::get()?.unix_timestamp;

        let pool = &mut ctx.accounts.pool;
        pool.config = ctx.accounts.curve_config.key();
        pool.mint = mint_key;
        pool.creator = creator_key;
        pool.reward = reward;
        pool.name = name_bytes;
        pool.symbol = symbol_bytes;
        pool.virtual_quote = cfg.virtual_quote;
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

        // Mandatory creator first buy at the base fee (exempt from the anti-snipe schedule).
        let trade = quote_buy(pool, first_buy, cfg.base_fee_bps as u64, cfg.base_fee_bps as u64)?;
        require!(trade.tokens >= min_tokens_out, ElpidaError::Slippage);
        if cfg.max_creator_buy_bps > 0 {
            require!(trade.tokens as u128 * BPS <= TOKEN_SUPPLY as u128 * cfg.max_creator_buy_bps as u128, ElpidaError::CreatorBuyCap);
        }
        apply_buy(pool, &trade, now)?;
        let bump = pool.bump;
        let pool_key = pool.key();
        let snapshot = Snapshot::of(pool);
        let a = &ctx.accounts;
        quote_transfer(&a.quote_token_program, &a.quote_mint, a.creator_quote.to_account_info(), a.quote_vault.to_account_info(), a.creator.to_account_info(), trade.gross, decimals, &[])?;
        let seeds: &[&[u8]] = &[b"curve", mint_key.as_ref(), &[bump]];
        token::transfer(
            CpiContext::new_with_signer(a.token_program.to_account_info(), Transfer { from: a.token_vault.to_account_info(), to: a.creator_token.to_account_info(), authority: a.pool.to_account_info() }, &[seeds]),
            trade.tokens,
        )?;
        emit!(CurveLaunched {
            creator: creator_key, mint: mint_key, pool: pool_key, quote_in: trade.gross, tokens_out: trade.tokens, fee: trade.fee,
            real_quote: snapshot.real_quote, virtual_quote: snapshot.virtual_quote_total, token_reserve: snapshot.token_reserve, sold: snapshot.sold,
        });
        if snapshot.graduated { emit!(CurveGraduated { pool: pool_key, mint: mint_key, real_quote: snapshot.real_quote, liquidity_bonus: snapshot.liquidity_bonus, lp_tokens: TOKEN_SUPPLY - snapshot.sold }); }
        Ok(())
    }

    pub fn buy(ctx: Context<Trade>, gross_in: u64, min_tokens_out: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let cfg: CurveConfig = **ctx.accounts.curve_config;
        let pool = &mut ctx.accounts.pool;
        require!(pool.status == STATUS_TRADING, ElpidaError::CurveClosed);
        let fee_bps = current_fee_bps(&cfg, pool.created_at, now);
        let trade = quote_buy(pool, gross_in, fee_bps, cfg.base_fee_bps as u64)?;
        require!(trade.tokens >= min_tokens_out, ElpidaError::Slippage);
        apply_buy(pool, &trade, now)?;
        let (mint_key, bump, pool_key) = (pool.mint, pool.bump, pool.key());
        let snapshot = Snapshot::of(pool);
        let a = &ctx.accounts;
        quote_transfer(&a.quote_token_program, &a.quote_mint, a.trader_quote.to_account_info(), a.quote_vault.to_account_info(), a.trader.to_account_info(), trade.gross, a.quote_mint.decimals, &[])?;
        let seeds: &[&[u8]] = &[b"curve", mint_key.as_ref(), &[bump]];
        token::transfer(
            CpiContext::new_with_signer(a.token_program.to_account_info(), Transfer { from: a.token_vault.to_account_info(), to: a.trader_token.to_account_info(), authority: a.pool.to_account_info() }, &[seeds]),
            trade.tokens,
        )?;
        emit!(CurveBought {
            pool: pool_key, buyer: a.trader.key(), quote_in: trade.gross, tokens_out: trade.tokens, fee: trade.fee, anti_snipe_fee: trade.surplus,
            real_quote: snapshot.real_quote, virtual_quote: snapshot.virtual_quote_total, token_reserve: snapshot.token_reserve, sold: snapshot.sold,
        });
        if snapshot.graduated { emit!(CurveGraduated { pool: pool_key, mint: mint_key, real_quote: snapshot.real_quote, liquidity_bonus: snapshot.liquidity_bonus, lp_tokens: TOKEN_SUPPLY - snapshot.sold }); }
        Ok(())
    }

    pub fn sell(ctx: Context<Trade>, tokens_in: u64, min_quote_out: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let cfg: CurveConfig = **ctx.accounts.curve_config;
        let pool = &mut ctx.accounts.pool;
        require!(pool.status == STATUS_TRADING, ElpidaError::CurveClosed);
        let fee_bps = current_fee_bps(&cfg, pool.created_at, now);
        let trade = quote_sell(pool, tokens_in, fee_bps, cfg.base_fee_bps as u64)?;
        require!(trade.net >= min_quote_out, ElpidaError::Slippage);
        pool.real_quote = pool.real_quote.checked_sub(trade.gross).ok_or(ElpidaError::MathOverflow)?;
        pool.sold = pool.sold.checked_sub(tokens_in).ok_or(ElpidaError::MathOverflow)?;
        split_fee(pool, &trade)?;
        let (mint_key, bump, pool_key) = (pool.mint, pool.bump, pool.key());
        let snapshot = Snapshot::of(pool);
        let a = &ctx.accounts;
        token::transfer(
            CpiContext::new(a.token_program.to_account_info(), Transfer { from: a.trader_token.to_account_info(), to: a.token_vault.to_account_info(), authority: a.trader.to_account_info() }),
            tokens_in,
        )?;
        let seeds: &[&[u8]] = &[b"curve", mint_key.as_ref(), &[bump]];
        quote_transfer(&a.quote_token_program, &a.quote_mint, a.quote_vault.to_account_info(), a.trader_quote.to_account_info(), a.pool.to_account_info(), trade.net, a.quote_mint.decimals, &[seeds])?;
        emit!(CurveSold {
            pool: pool_key, seller: a.trader.key(), tokens_in, quote_out: trade.net, fee: trade.fee, anti_snipe_fee: trade.surplus,
            real_quote: snapshot.real_quote, virtual_quote: snapshot.virtual_quote_total, token_reserve: snapshot.token_reserve, sold: snapshot.sold,
        });
        Ok(())
    }

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
    /// Permissionless once the curve is complete: seeds a PumpSwap pool with the remaining supply and
    /// all raised quote (curve reserve + locked anti-snipe bonus). The LP tokens stay in a program PDA
    /// forever. The caller pays PumpSwap's account rent (refunded surplus) and the transaction fee.
    pub fn migrate_to_pumpswap(ctx: Context<MigrateToPumpswap>) -> Result<()> {
        require!(ctx.accounts.pool.status == STATUS_GRADUATED, ElpidaError::NotComplete);
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
        let pool = &mut ctx.accounts.pool;
        pool.status = STATUS_MIGRATED;
        pool.real_quote = 0;
        pool.liquidity_bonus = 0;
        emit!(CurveMigrated { pool: pool_key, mint: mint_key, pump_pool, lp_mint, base_amount, quote_amount, lp_locked });
        Ok(())
    }

    /// Permissionless: withdraws only the LP tokens that represent trading-fee growth since migration
    /// (liquidity units above the migrated principal) and splits the proceeds 50/50 between the
    /// protocol treasury and the creator reward wallet. The principal liquidity stays locked.
    pub fn harvest_lp_fees(ctx: Context<HarvestLpFees>) -> Result<()> {
        ctx.accounts.check_token_accounts()?;
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
        let (protocol_base, protocol_quote) = (base_out / 2, quote_out / 2);
        for (from, to, amount) in [
            (a.authority_base.to_account_info(), a.treasury_base.to_account_info(), protocol_base),
            (a.authority_base.to_account_info(), a.reward_base.to_account_info(), base_out - protocol_base),
        ] {
            if amount > 0 {
                token::transfer(
                    CpiContext::new_with_signer(a.token_program.to_account_info(), Transfer { from, to, authority: a.lp_authority.to_account_info() }, &[authority_seeds]),
                    amount,
                )?;
            }
        }
        let quote_program = a.quote_program_info();
        for (to, amount) in [(a.treasury_quote.to_account_info(), protocol_quote), (a.reward_quote.to_account_info(), quote_out - protocol_quote)] {
            if amount > 0 {
                ti::transfer_checked(
                    CpiContext::new_with_signer(quote_program.clone(), ti::TransferChecked { from: a.authority_quote.to_account_info(), mint: a.quote_mint.to_account_info(), to, authority: a.lp_authority.to_account_info() }, &[authority_seeds]),
                    amount, a.curve_config.quote_decimals,
                )?;
            }
        }
        let after = PumpState::read(&a.pump_pool.to_account_info(), &a.pump_pool_base.to_account_info(), &a.pump_pool_quote.to_account_info())?;
        let lp_after = token_amount(&a.authority_lp.to_account_info())?;
        require!(liquidity_units(lp_after, &after)? >= a.migration.principal, ElpidaError::PrincipalBreached);
        let (pool_key, pump_pool) = (a.pool.key(), a.pump_pool.key());
        let migration = &mut ctx.accounts.migration;
        migration.lp_locked = lp_after;
        migration.harvested_lp = migration.harvested_lp.checked_add(harvest).ok_or(ElpidaError::MathOverflow)?;
        migration.harvested_base = migration.harvested_base.checked_add(base_out).ok_or(ElpidaError::MathOverflow)?;
        migration.harvested_quote = migration.harvested_quote.checked_add(quote_out).ok_or(ElpidaError::MathOverflow)?;
        emit!(LpFeesHarvested { pool: pool_key, pump_pool, lp_burned: harvest, base_out, quote_out, protocol_base, protocol_quote, lp_locked: lp_after });
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

/// Test-only instructions exist in every build but succeed only when compiled with `--features testnet`.
/// The mainnet build (`build/elpida_launchpad-mainnet.so`) rejects them, so it can never mint test assets.
fn test_networks_only() -> Result<()> {
    require!(cfg!(feature = "testnet"), ElpidaError::TestNetworksOnly);
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

/// Linear decay from `snipe_start_bps` at launch to `base_fee_bps` at the end of the window.
pub fn current_fee_bps(cfg: &CurveConfig, created_at: i64, now: i64) -> u64 {
    let base = cfg.base_fee_bps as u64;
    let window = cfg.snipe_window_secs as u64;
    let elapsed = now.saturating_sub(created_at).max(0) as u64;
    if window == 0 || elapsed >= window { return base; }
    base + (cfg.snipe_start_bps as u64 - base) * (window - elapsed) / window
}

pub struct TradeQuote { pub gross: u64, pub net: u64, pub tokens: u64, pub fee: u64, pub base_fee: u64, pub surplus: u64, pub graduates: bool }

fn fees(gross: u64, fee_bps: u64, base_fee_bps: u64) -> (u64, u64, u64) {
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
    let remaining = (pool.curve_supply - pool.sold) as u128;
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

fn apply_buy(pool: &mut CurvePool, trade: &TradeQuote, now: i64) -> Result<()> {
    pool.real_quote = pool.real_quote.checked_add(trade.net).ok_or(ElpidaError::MathOverflow)?;
    pool.sold = pool.sold.checked_add(trade.tokens).ok_or(ElpidaError::MathOverflow)?;
    split_fee(pool, trade)?;
    if trade.graduates {
        pool.status = STATUS_GRADUATED;
        pool.graduated_at = now;
    }
    Ok(())
}

fn split_fee(pool: &mut CurvePool, trade: &TradeQuote) -> Result<()> {
    let protocol = trade.base_fee / 2;
    pool.protocol_fees = pool.protocol_fees.checked_add(protocol).ok_or(ElpidaError::MathOverflow)?;
    pool.creator_fees = pool.creator_fees.checked_add(trade.base_fee - protocol).ok_or(ElpidaError::MathOverflow)?;
    pool.liquidity_bonus = pool.liquidity_bonus.checked_add(trade.surplus).ok_or(ElpidaError::MathOverflow)?;
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
    /// CHECK: verified against curve_config.treasury.
    pub treasury: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = quote_mint, associated_token::authority = treasury, associated_token::token_program = quote_token_program)]
    pub treasury_quote: Box<InterfaceAccount<'info, QuoteAccount>>,
    #[account(init, payer = creator, mint::decimals = TOKEN_DECIMALS, mint::authority = creator)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(init, payer = creator, space = 8 + CurvePool::INIT_SPACE, seeds = [b"curve", mint.key().as_ref()], bump)]
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
}

#[derive(Accounts)]
pub struct TestBuildCheck {}

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
    #[account(init, payer = payer, space = 8 + PumpMigration::INIT_SPACE, seeds = [b"pump-migration", mint.key().as_ref()], bump)]
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
pub struct CurveGraduated { pub pool: Pubkey, pub mint: Pubkey, pub real_quote: u64, pub liquidity_bonus: u64, pub lp_tokens: u64 }
#[event]
pub struct FeesWithdrawn { pub pool: Pubkey, pub recipient: Pubkey, pub amount: u64 }
#[event]
pub struct CurveMigrated { pub pool: Pubkey, pub mint: Pubkey, pub pump_pool: Pubkey, pub lp_mint: Pubkey, pub base_amount: u64, pub quote_amount: u64, pub lp_locked: u64 }
#[event]
pub struct LpFeesHarvested { pub pool: Pubkey, pub pump_pool: Pubkey, pub lp_burned: u64, pub base_out: u64, pub quote_out: u64, pub protocol_base: u64, pub protocol_quote: u64, pub lp_locked: u64 }

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
}
