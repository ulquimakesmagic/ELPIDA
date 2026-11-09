//! ELPIDA V2 on Solana: the fee ledger and fee schedule the program runs (the same functions, host-side).
//! Checked: the five shares never exceed the running total and leave at most 4 base units; paying what is owed
//! never pays a share twice; the anti-snipe schedule starts at 90% and reaches the token's own fee at 60 s; the
//! extension round-trips; and over any sequence of V2 trades the quote vault holds the reserve, the locked
//! anti-snipe surplus and every unpaid share, so withdrawals can never touch liquidity.
use ::elpida_launchpad::{quote_buy, quote_sell, v2_apply_buy, v2_book_fee, v2_fee_bps, v2_share, valid_v2_symbol, CurvePool, V2Ext, STATUS_GRADUATED, STATUS_TRADING, TOKEN_SUPPLY, V2_EXT_LEN, V2_SPLIT};
use proptest::prelude::*;

// ×5 curve, as on EVM: vT = 5/4 of supply, sale = vT (1 − 1/√5).
const VT: u64 = 1_250_000_000_000_000;
const CS: u64 = 690_983_005_625_052;

fn fresh(vq: u64) -> CurvePool {
    CurvePool {
        config: Default::default(), mint: Default::default(), creator: Default::default(), reward: Default::default(),
        name: [0; 32], symbol: [0; 10], virtual_quote: vq, virtual_token: VT, curve_supply: CS, real_quote: 0, sold: 0,
        liquidity_bonus: 0, protocol_fees: 0, creator_fees: 0, created_at: 0, graduated_at: 0, status: STATUS_TRADING, bump: 0,
    }
}

#[test]
fn split_is_the_evm_split() {
    assert_eq!(V2_SPLIT, [3_000, 3_000, 1_000, 1_000, 2_000]);
    assert_eq!(V2_SPLIT.iter().map(|v| *v as u32).sum::<u32>(), 10_000);
}

#[test]
fn fee_schedule_matches_evm() {
    assert_eq!(v2_fee_bps(125, 0, 0), 9_000);
    assert_eq!(v2_fee_bps(125, 0, 30), 125 + (9_000 - 125) * 30 / 60);
    assert_eq!(v2_fee_bps(125, 0, 59), 125 + (9_000 - 125) / 60);
    assert_eq!(v2_fee_bps(125, 0, 60), 125);
    assert_eq!(v2_fee_bps(400, 100, 10_000), 400);
    assert_eq!(v2_fee_bps(100, 100, 50), 9_000, "a clock before launch reads as launch");
}

#[test]
fn tickers() {
    for ok in ["HOPE", "hope", "Pepe2", "A", "ABCDEFGHIJ"] { assert!(valid_v2_symbol(ok), "{ok}"); }
    for bad in ["", "ABCDEFGHIJK", "HO PE", "HOPE!", "ÉLAN"] { assert!(!valid_v2_symbol(bad), "{bad}"); }
}

#[test]
fn ext_round_trips_and_leaves_older_pools_alone() {
    let o = ::elpida_launchpad::v2_ext_offset();
    let mut data = vec![0u8; o + V2_EXT_LEN];
    assert_eq!(V2Ext::read(&data), None, "no version byte: not a V2 pool");
    let ext = V2Ext { fee_bps: 250, accrued: 123_456_789, paid: [1, 2, 3, 4, 5] };
    ext.write(&mut data).unwrap();
    assert_eq!(V2Ext::read(&data), Some(ext));
    assert_eq!(V2Ext::read(&data[..o + V2_EXT_LEN - 1]), None, "a shorter account is not a V2 pool");
}

proptest! {
    #[test]
    fn shares_never_exceed_the_total(accrued in 0u64..u64::MAX / 2) {
        let sum: u64 = (0..5).map(|i| v2_share(accrued, i)).sum();
        prop_assert!(sum <= accrued);
        prop_assert!(accrued - sum <= 4);
    }

    #[test]
    fn owed_is_paid_once(steps in prop::collection::vec((1u64..1_000_000_000_000, any::<bool>()), 1..40)) {
        let mut ext = V2Ext { fee_bps: 125, ..Default::default() };
        let mut paid_total = [0u64; 5];
        for (fee, withdraw) in steps {
            ext.accrued += fee;
            if withdraw {
                let owed = ext.owed();
                for i in 0..5 { ext.paid[i] += owed[i]; paid_total[i] += owed[i]; }
                prop_assert_eq!(ext.owed(), [0; 5]);
            }
        }
        for i in 0..5 { prop_assert_eq!(paid_total[i] + ext.owed()[i], v2_share(ext.accrued, i)); }
    }

    /// The vault (everything bought in less everything sold out) always covers the reserve, the locked surplus and
    /// every unpaid share; trading fees and withdrawals never reach the liquidity.
    #[test]
    fn vault_covers_liquidity_and_owed_shares(
        own in 1u16..=400,
        vq in 1_000_000_000u64..100_000_000_000,
        ops in prop::collection::vec((any::<bool>(), 1u64..50_000_000_000, 0i64..120, any::<bool>()), 1..60),
    ) {
        let mut pool = fresh(vq);
        let mut ext = V2Ext { fee_bps: own, ..Default::default() };
        let mut vault: u128 = 0;
        for (buy, amount, at, withdraw) in ops {
            if pool.status != STATUS_TRADING { break; }
            let fee = v2_fee_bps(own, 0, at);
            if buy {
                let Ok(t) = quote_buy(&pool, amount, fee, own as u64) else { continue };
                prop_assert_eq!(t.base_fee + t.surplus, t.fee);
                v2_apply_buy(&mut pool, &mut ext, &t, at).unwrap();
                vault += t.gross as u128;
            } else {
                let tokens = (amount as u128 * pool.sold as u128 / 50_000_000_000u128) as u64;
                if tokens == 0 { continue; }
                let Ok(t) = quote_sell(&pool, tokens, fee, own as u64) else { continue };
                pool.real_quote -= t.gross; pool.sold -= tokens;
                v2_book_fee(&mut pool, &mut ext, &t).unwrap();
                vault -= t.net as u128;
            }
            if withdraw {
                let owed = ext.owed();
                for i in 0..5 { ext.paid[i] += owed[i]; vault -= owed[i] as u128; }
            }
            let owed: u128 = ext.owed().iter().map(|v| *v as u128).sum();
            prop_assert!(vault >= pool.real_quote as u128 + pool.liquidity_bonus as u128 + owed);
            prop_assert!(pool.sold <= CS);
            prop_assert!(pool.protocol_fees == 0 && pool.creator_fees == 0, "V2 pools never use the legacy counters");
        }
        if pool.status == STATUS_GRADUATED { prop_assert_eq!(pool.sold, CS); }
    }
}

#[test]
fn first_buy_cap_is_three_percent() {
    assert_eq!(TOKEN_SUPPLY as u128 * 300 / 10_000, 30_000_000_000_000);
}

// ---- S3: distributor schedule and Merkle proofs ----
use ::elpida_launchpad::{civil, current_round, days_from_civil, round_start, v2_leaf, verify_proof, V2Distributor};

#[test]
fn calendar_months_match_evm() {
    // 1 Nov 2026 00:00 UTC.
    let nov = days_from_civil(2026, 11, 1) * 86_400;
    assert_eq!(nov, 1_793_491_200);
    assert_eq!(civil(nov / 86_400), (2026, 11, 1));
    let d = V2Distributor { kind: 0, operator: Default::default(), period: 0, genesis: nov, genesis_month: (2026 * 12 + 11 - 1) as u32, bump: 0 };
    assert_eq!(round_start(&d, 0), nov);
    assert_eq!(round_start(&d, 1), days_from_civil(2026, 12, 1) * 86_400);
    assert_eq!(round_start(&d, 2), days_from_civil(2027, 1, 1) * 86_400, "rolls over the year");
    assert_eq!(round_start(&d, 4) - round_start(&d, 3), 28 * 86_400, "February 2027");
    assert_eq!(current_round(&d, nov - 1), None);
    assert_eq!(current_round(&d, days_from_civil(2026, 12, 31) * 86_400 + 86_399), Some(1));
    let weekly = V2Distributor { period: 7 * 86_400, genesis: nov, genesis_month: 0, ..d };
    assert_eq!(round_start(&weekly, 3), nov + 21 * 86_400);
    assert_eq!(current_round(&weekly, nov + 7 * 86_400), Some(1));
}

proptest! {
    #[test]
    fn civil_round_trips(days in -100_000i64..200_000) {
        let (y, m, d) = civil(days);
        prop_assert_eq!(days_from_civil(y, m, d), days);
    }
}

#[test]
fn merkle_proofs_bind_every_field() {
    use anchor_lang::prelude::Pubkey;
    let (asset, a, b, c) = (Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique());
    let leaves = [v2_leaf(0, 3, &asset, 0, &a, 10), v2_leaf(0, 3, &asset, 1, &b, 20), v2_leaf(0, 3, &asset, 2, &c, 30)];
    let h = |x: &[u8; 32], y: &[u8; 32]| if x <= y { anchor_lang::solana_program::keccak::hashv(&[x, y]).0 } else { anchor_lang::solana_program::keccak::hashv(&[y, x]).0 };
    let ab = h(&leaves[0], &leaves[1]);
    let root = h(&ab, &leaves[2]);
    assert!(verify_proof(&[leaves[1], leaves[2]], root, leaves[0]));
    assert!(verify_proof(&[ab], root, leaves[2]));
    for wrong in [v2_leaf(0, 3, &asset, 0, &a, 11), v2_leaf(1, 3, &asset, 0, &a, 10), v2_leaf(0, 4, &asset, 0, &a, 10), v2_leaf(0, 3, &asset, 1, &a, 10), v2_leaf(0, 3, &Pubkey::new_unique(), 0, &a, 10)] {
        assert!(!verify_proof(&[leaves[1], leaves[2]], root, wrong));
    }
}
