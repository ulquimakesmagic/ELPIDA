//! Property tests for the locked pool that issuer-controlled quotes (Ondo's tokenized stocks) graduate into: the
//! completing buy opens it, and every later trade is a constant-product swap against the vaults, with the program's
//! own bookkeeping (`quote_buy`, `quote_sell`, `apply_buy`, `split_fee`, `partner_buyback`, `open_locked_pool`).
//! Checked: k never decreases, every quote unit stays accounted for, holders can always sell everything back, the
//! token vault is never drained, nothing completes or leaves the pool, and the venue test reads raw mint TLVs.
use ::elpida_launchpad::{
    apply_buy, locked_pool_extensions, open_locked_pool, partner_buyback, quote_buy, quote_sell, split_fee, trade_fee_bps,
    CurveConfig, CurvePool, STATUS_GRADUATED, STATUS_LOCKED, STATUS_TRADING, TOKEN_SUPPLY,
};
use anchor_lang::prelude::Pubkey;
use proptest::prelude::*;

const VT: u64 = 1_111_111_111_111_111;
const CS: u64 = 759_746_926_647_958;

fn fresh(vq: u64) -> CurvePool {
    CurvePool {
        config: Default::default(), mint: Default::default(), creator: Default::default(), reward: Default::default(),
        name: [0; 32], symbol: [0; 10], virtual_quote: vq, virtual_token: VT, curve_supply: CS, real_quote: 0, sold: 0,
        liquidity_bonus: 0, protocol_fees: 0, creator_fees: 0, created_at: 0, graduated_at: 0, status: STATUS_TRADING, bump: 0,
    }
}

fn config(base_fee_bps: u16) -> CurveConfig {
    CurveConfig {
        quote_mint: Pubkey::default(), treasury: Pubkey::default(), launch_fee: 0, virtual_quote: 1, virtual_token: VT,
        curve_supply: CS, base_fee_bps, snipe_start_bps: 9_000, snipe_window_secs: 600, max_creator_buy_bps: 0,
        quote_decimals: 9, model_version: 3, bump: 0,
    }
}

/// Buys the whole curve (paying with the anti-snipe fee in force) and opens the locked pool, as the completing buy
/// does on chain. Returns the pool and the quote paid in.
fn graduated(vq: u64, bps: u64, tier: u16) -> (CurvePool, u128) {
    let mut pool = fresh(vq);
    let t = quote_buy(&pool, u64::MAX / 4, bps, 125).unwrap();
    assert!(t.graduates);
    let burn = apply_buy(&mut pool, &t, 0, tier).unwrap();
    partner_buyback(&mut pool, burn).unwrap();
    assert_eq!(pool.status, STATUS_GRADUATED);
    open_locked_pool(&mut pool).unwrap();
    (pool, t.gross as u128)
}

fn k(pool: &CurvePool) -> u128 { pool.real_quote as u128 * (TOKEN_SUPPLY - pool.sold) as u128 }
fn vq() -> impl Strategy<Value = u64> { prop_oneof![1_000u64..100_000_000, 100_000_000u64..100_000_000_000_000] }
fn ops() -> impl Strategy<Value = Vec<(bool, u64)>> { prop::collection::vec((any::<bool>(), 1u64..u64::MAX / 4), 1..80) }

proptest! {
    #![proptest_config(ProptestConfig { cases: std::env::var("PROPTEST_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(2_000), ..ProptestConfig::default() })]

    /// Opening the pool keeps every quote unit (the anti-snipe bonus joins the reserve) and the reserves are exactly
    /// the vault contents: quote = real reserve, tokens = supply minus everything sold or burned.
    #[test]
    fn opening_moves_the_bonus_into_the_reserve(vq in vq(), bps in 125u64..=9_000, tier in prop::sample::select(vec![0u16, 1_000, 2_000])) {
        let mut before = fresh(vq);
        let t = quote_buy(&before, u64::MAX / 4, bps, 125).unwrap();
        let burn = apply_buy(&mut before, &t, 0, tier).unwrap();
        partner_buyback(&mut before, burn).unwrap();
        let mut pool = before.clone();
        open_locked_pool(&mut pool).unwrap();
        prop_assert_eq!(pool.status, STATUS_LOCKED);
        prop_assert_eq!(pool.real_quote as u128, before.real_quote as u128 + before.liquidity_bonus as u128);
        prop_assert_eq!(pool.liquidity_bonus, 0);
        prop_assert_eq!((pool.virtual_quote, pool.virtual_token), (0, TOKEN_SUPPLY));
        prop_assert_eq!(pool.sold, before.sold);
        prop_assert!(open_locked_pool(&mut pool).is_err(), "a locked pool cannot be opened twice");
    }

    /// Any sequence of buys and sells in the locked pool, with partner burns: k never decreases, no trade completes
    /// anything, every quote unit is accounted for, the token vault is never emptied, and holders can always sell
    /// all they hold.
    #[test]
    fn locked_pool_is_solvent_through_any_trade_sequence(vq in vq(), ops in ops(), base in 25u16..=500, tier in prop::sample::select(vec![0u16, 1_000, 2_000])) {
        let (mut pool, mut paid_in) = graduated(vq, 125, tier);
        let cfg = config(base);
        let fee = trade_fee_bps(&cfg, &pool, 0);
        prop_assert_eq!(fee, base as u64, "the locked pool charges the flat base fee, never the anti-snipe fee");
        let mut paid_out = 0u128;
        let mut burned = 0u128;
        for (buy, amount) in ops {
            let k_before = k(&pool);
            let out = if buy {
                let amount = amount % pool.real_quote.saturating_mul(4).max(1) + 1;
                let Ok(t) = quote_buy(&pool, amount, fee, fee) else { continue };
                prop_assert!(!t.graduates);
                prop_assert_eq!(t.gross, amount, "a locked-pool buy is never partially filled");
                prop_assert_eq!(t.surplus, 0);
                // A buy that would overflow the u64 reserve is refused and the transaction reverts.
                let saved = pool.clone();
                let Ok(out) = apply_buy(&mut pool, &t, 0, tier).and_then(|burn| partner_buyback(&mut pool, burn)) else { pool = saved; continue };
                paid_in += t.gross as u128;
                out
            } else {
                let held = pool.sold as u128 - burned;
                if held == 0 { continue; }
                let tokens = (1 + amount as u128 % held) as u64;
                let Ok(t) = quote_sell(&pool, tokens, fee, fee) else { continue };
                pool.real_quote -= t.gross; pool.sold -= tokens;
                let burn = split_fee(&mut pool, &t, tier).unwrap();
                paid_out += t.net as u128;
                partner_buyback(&mut pool, burn).unwrap()
            };
            burned += out as u128;
            prop_assert_eq!(pool.status, STATUS_LOCKED);
            prop_assert!(k(&pool) >= k_before, "k decreased");
            prop_assert!(pool.sold < TOKEN_SUPPLY, "the token vault was emptied");
            prop_assert_eq!(pool.liquidity_bonus, 0);
            let vault = pool.real_quote as u128 + pool.protocol_fees as u128 + pool.creator_fees as u128;
            prop_assert_eq!(vault, paid_in - paid_out, "every quote unit is accounted for");
            let held = pool.sold as u128 - burned;
            if held > 0 {
                if let Err(e) = quote_sell(&pool, held as u64, fee, fee) {
                    prop_assert!(format!("{e:?}").contains("SellTooSmall"), "holders cannot sell everything: {e:?}");
                }
            }
        }
    }
}

/// The locked pool continues at the curve's closing price within the price step a PumpSwap migration has.
#[test]
fn opening_price_matches_the_curve_close() {
    for vq in [50_000_000u64, 30_000_000_000, 85_000_000_000_000] {
        let mut pool = fresh(vq);
        let t = quote_buy(&pool, u64::MAX / 4, 125, 125).unwrap();
        apply_buy(&mut pool, &t, 0, 0).unwrap();
        let curve = (pool.virtual_quote as f64 + pool.real_quote as f64) / (pool.virtual_token - pool.sold) as f64;
        let migrated = (pool.real_quote as f64 + pool.liquidity_bonus as f64) / (TOKEN_SUPPLY - pool.sold) as f64;
        open_locked_pool(&mut pool).unwrap();
        let locked = pool.real_quote as f64 / (TOKEN_SUPPLY - pool.sold) as f64;
        assert!((locked / migrated - 1.0).abs() < 1e-9, "the locked pool opens where a migration would");
        assert!((locked / curve - 1.0).abs() < 0.02, "vq {vq}: curve closes at {curve}, pool opens at {locked}");
    }
}

/// Raw Token-2022 mint data: 82-byte base, padding to 165, account type 1, then (type u16, length u16, value) TLVs.
fn mint_with(extensions: &[(u16, usize)]) -> Vec<u8> {
    let mut data = vec![0u8; 165];
    data.push(1);
    for (kind, len) in extensions {
        data.extend_from_slice(&kind.to_le_bytes());
        data.extend_from_slice(&(*len as u16).to_le_bytes());
        data.extend(std::iter::repeat(7u8).take(*len));
    }
    data
}

#[test]
fn venue_follows_the_mint_extensions() {
    // Ondo's stocks: ConfidentialTransferMint, DefaultAccountState, TransferHook, MetadataPointer, TokenMetadata,
    // ScaledUiAmount, Pausable.
    assert!(locked_pool_extensions(&mint_with(&[(4, 65), (6, 1), (14, 64), (18, 64), (19, 120), (25, 56), (26, 33)])));
    for kind in [4u16, 14, 25, 26] {
        assert!(locked_pool_extensions(&mint_with(&[(18, 64), (kind, 8)])), "extension {kind} needs the locked pool");
    }
    // Metadata only, or a classic-sized mint: graduates as before.
    assert!(!locked_pool_extensions(&mint_with(&[(18, 64), (19, 90)])));
    assert!(!locked_pool_extensions(&vec![0u8; 82]));
    assert!(!locked_pool_extensions(&mint_with(&[])));
    // A wrong account type or a truncated TLV is never read as a locked venue.
    let mut wrong = mint_with(&[(26, 33)]);
    wrong[165] = 2;
    assert!(!locked_pool_extensions(&wrong));
    assert!(!locked_pool_extensions(&mint_with(&[(18, 64)])[..170]));
}
