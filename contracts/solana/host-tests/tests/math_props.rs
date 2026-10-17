//! Property tests for the Elpida curve math (the same functions the on-chain program runs).
//! Checked: solvency (every reachable state can buy back all sold tokens from the real reserve), the
//! constant-product invariant never decreases, prices move the right way, rounding never favours the
//! trader, the final buy fills the remaining supply exactly with the minimal charge, the anti-snipe
//! schedule, fee splits, LP-fee harvests never touch the principal, and the oracle conversion rounds up.
use ::elpida_launchpad::{current_fee_bps, fees, harvestable_lp, isqrt, liquidity_units, quote_buy, quote_sell, usd_to_quote, CurveConfig, CurvePool, OraclePrice, PumpState, TradeQuote, STATUS_GRADUATED, STATUS_TRADING};
use proptest::prelude::*;

const VT: u64 = 1_111_111_111_111_111; // 1B x 10/9, 6 decimals
const CS: u64 = 759_746_926_647_958; // 1B x sqrt(10)/(sqrt(10)+1)

fn fresh(vq: u64) -> CurvePool {
    CurvePool {
        config: Default::default(), mint: Default::default(), creator: Default::default(), reward: Default::default(),
        name: [0; 32], symbol: [0; 10], virtual_quote: vq, virtual_token: VT, curve_supply: CS, real_quote: 0, sold: 0,
        liquidity_bonus: 0, protocol_fees: 0, creator_fees: 0, created_at: 0, graduated_at: 0, status: STATUS_TRADING, bump: 0,
    }
}

fn k(pool: &CurvePool) -> u128 { (pool.virtual_quote as u128 + pool.real_quote as u128) * (pool.virtual_token - pool.sold) as u128 }

/// Mirrors the program's apply_buy / sell bookkeeping and returns the gross quote moved.
fn apply(pool: &mut CurvePool, buy: bool, amount: u64, fee_bps: u64) -> Option<TradeQuote> {
    if buy {
        let t = quote_buy(pool, amount, fee_bps, 125).ok()?;
        pool.real_quote += t.net; pool.sold += t.tokens;
        pool.protocol_fees += t.base_fee / 2; pool.creator_fees += t.base_fee - t.base_fee / 2; pool.liquidity_bonus += t.surplus;
        if t.graduates { pool.status = STATUS_GRADUATED; }
        Some(t)
    } else {
        let tokens = if pool.sold == 0 { return None } else { 1 + amount % pool.sold };
        let t = quote_sell(pool, tokens, fee_bps, 125).ok()?;
        pool.real_quote -= t.gross; pool.sold -= tokens;
        pool.protocol_fees += t.base_fee / 2; pool.creator_fees += t.base_fee - t.base_fee / 2; pool.liquidity_bonus += t.surplus;
        Some(t)
    }
}

/// Starting virtual quote: from $50 (testnet, 6-decimal USDC) up to large SOL curves (9 decimals).
fn vq() -> impl Strategy<Value = u64> { prop_oneof![1_000u64..100_000_000, 100_000_000u64..100_000_000_000_000] }
fn fee_bps() -> impl Strategy<Value = u64> { prop_oneof![Just(125u64), 125u64..=9_000] }
fn ops() -> impl Strategy<Value = Vec<(bool, u64, u64)>> { prop::collection::vec((any::<bool>(), 1u64..u64::MAX / 4, 125u64..=9_000), 1..60) }

proptest! {
    #![proptest_config(ProptestConfig { cases: std::env::var("PROPTEST_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(2_000), ..ProptestConfig::default() })]

    /// Through any sequence of buys and sells: the reserve stays solvent (selling every sold token back
    /// is always payable from `real_quote`), k never decreases, and the curve never oversells.
    #[test]
    fn solvent_through_any_trade_sequence(vq in vq(), ops in ops()) {
        let mut pool = fresh(vq);
        for (buy, amount, bps) in ops {
            if pool.status != STATUS_TRADING { break; }
            let k_before = k(&pool);
            let amount = if buy { amount % (vq.saturating_mul(20) + 1) + 1 } else { amount };
            if apply(&mut pool, buy, amount, bps).is_none() { continue; }
            prop_assert!(k(&pool) >= k_before, "k decreased");
            prop_assert!(pool.sold <= pool.curve_supply);
            if pool.sold > 0 {
                // Buying back every sold token at once is always covered by the real reserve. (Dust worth
                // less than one quote unit pays 0 and is refused as SellTooSmall; that is not insolvency.)
                let qs = pool.virtual_quote as u128 + pool.real_quote as u128;
                let owed = qs * pool.sold as u128 / (pool.virtual_token as u128);
                prop_assert!(owed <= pool.real_quote as u128, "reserve {} cannot cover {}", pool.real_quote, owed);
                if let Err(e) = quote_sell(&pool, pool.sold, 125, 125) {
                    prop_assert!(format!("{e:?}").contains("SellTooSmall"), "sell-all failed: {e:?}");
                    prop_assert_eq!(owed * 9_875 / 10_000, 0, "only dust may be unsellable");
                }
            }
        }
    }

    /// Buys: never more tokens than remain, never charge more than offered, price rises, k holds.
    #[test]
    fn buy_quote_is_safe(vq in vq(), sold_frac in 0u64..=1_000_000, gross in 1u64..u64::MAX / 4, bps in fee_bps()) {
        let mut pool = fresh(vq);
        // Reach a consistent mid-curve state with a first buy of up to ~2x the virtual quote.
        let first = ((vq as u128 * sold_frac as u128 / 500_000) as u64).max(1);
        let _ = apply(&mut pool, true, first, 125);
        if pool.status != STATUS_TRADING { return Ok(()); }
        if let Ok(t) = quote_buy(&pool, gross, bps, 125) {
            prop_assert!(t.gross <= gross);
            prop_assert!(t.tokens <= pool.curve_supply - pool.sold);
            prop_assert_eq!(t.net + t.fee, t.gross);
            let before = (pool.virtual_quote as u128 + pool.real_quote as u128, (pool.virtual_token - pool.sold) as u128);
            let after = (before.0 + t.net as u128, before.1 - t.tokens as u128);
            prop_assert!(after.0 * after.1 >= before.0 * before.1, "k decreased on buy");
            prop_assert!(after.0 * before.1 >= before.0 * after.1, "price fell on a buy");
            // Rounding favours the pool: tokens are at most the exact constant-product amount.
            prop_assert!((t.tokens as u128) * (before.0 + t.net as u128) <= before.1 * t.net as u128);
        }
    }

    /// The buy that completes the curve takes exactly the remaining supply. Its charge is minimal up to the
    /// fee's floor rounding: at most floor(10000 / (10000 - fee_bps)) + 1 base units more than strictly
    /// needed (2 units at the 1.25% base fee, 11 at the 90% launch fee), and that excess stays in the pool.
    #[test]
    fn final_buy_fills_exactly_with_minimal_charge(vq in vq(), first in 1u64..1_000_000_000_000, bps in fee_bps()) {
        let mut pool = fresh(vq);
        let _ = apply(&mut pool, true, first.min(vq.saturating_mul(2)).max(1), 125);
        if pool.status != STATUS_TRADING { return Ok(()); }
        let remaining = pool.curve_supply - pool.sold;
        let t = quote_buy(&pool, u64::MAX / 4, bps, 125).unwrap();
        prop_assert!(t.graduates);
        prop_assert_eq!(t.tokens, remaining);
        let (qs, avail) = (pool.virtual_quote as u128 + pool.real_quote as u128, (pool.virtual_token - pool.sold) as u128);
        prop_assert!(avail * t.net as u128 / (qs + t.net as u128) >= remaining as u128, "net does not cover the remaining supply");
        let max_over = 10_000 / (10_000 - bps) + 1;
        if t.gross > max_over + 1 {
            let less = quote_buy(&pool, t.gross - max_over - 1, bps, 125).unwrap();
            prop_assert!(!less.graduates && less.tokens < remaining, "the final buy overcharged by more than {} units", max_over);
        }
    }

    /// Sells: paid from the real reserve only, price falls, and a buy followed by selling everything it
    /// bought never returns more than was paid.
    #[test]
    fn sell_and_round_trip(vq in vq(), pay in 1u64..u64::MAX / 8, bps in fee_bps()) {
        let mut pool = fresh(vq);
        let pay = pay % (vq.saturating_mul(3) + 1) + 1;
        let Some(bought) = apply(&mut pool, true, pay, bps) else { return Ok(()); };
        if pool.status != STATUS_TRADING { return Ok(()); }
        let before = (pool.virtual_quote as u128 + pool.real_quote as u128, (pool.virtual_token - pool.sold) as u128);
        if let Ok(s) = quote_sell(&pool, bought.tokens, bps, 125) {
            prop_assert!(s.gross <= pool.real_quote);
            prop_assert!(s.net <= pay, "round trip profit: paid {} got {}", pay, s.net);
            let after = (before.0 - s.gross as u128, before.1 + bought.tokens as u128);
            prop_assert!(after.0 * after.1 >= before.0 * before.1, "k decreased on sell");
            prop_assert!(after.0 * before.1 <= before.0 * after.1, "price rose on a sell");
        }
    }

    /// Fee split: total = floor(gross x bps), base part capped by the total, surplus = the rest.
    #[test]
    fn fee_split(gross in any::<u64>(), bps in 0u64..=9_900, base in 0u64..=1_000) {
        let (fee, b, surplus) = fees(gross, bps, base);
        prop_assert_eq!(fee as u128, gross as u128 * bps as u128 / 10_000);
        prop_assert!(b <= fee && fee <= gross);
        prop_assert_eq!(b + surplus, fee);
    }

    /// Anti-snipe schedule: starts at the start fee, never increases, stays within bounds and ends at base.
    #[test]
    fn fee_schedule_decays(base in 0u16..=1_000, extra in 0u16..=8_900, window in 0u32..=3_600, created in 0i64..2_000_000_000, t1 in -100i64..10_000, dt in 0i64..10_000) {
        let start = base + extra;
        let cfg = CurveConfig { quote_mint: Default::default(), treasury: Default::default(), launch_fee: 0, virtual_quote: 1, virtual_token: 2, curve_supply: 1,
            base_fee_bps: base, snipe_start_bps: start, snipe_window_secs: window, max_creator_buy_bps: 0, quote_decimals: 6, model_version: 3, bump: 0 };
        let (a, b) = (current_fee_bps(&cfg, created, created + t1), current_fee_bps(&cfg, created, created + t1 + dt));
        prop_assert!(a >= base as u64 && a <= start as u64);
        prop_assert!(b <= a, "fee rose over time");
        prop_assert_eq!(current_fee_bps(&cfg, created, created + window as i64), base as u64);
        if window > 0 { prop_assert_eq!(current_fee_bps(&cfg, created, created), start as u64); }
    }

    /// LP-fee harvests: after withdrawing the harvestable LP pro rata, the position still holds at least
    /// its migrated principal, whatever the fee growth. Reachable PumpSwap states only: LP is minted as
    /// sqrt(base x quote) at creation and swap fees only grow that root, so lp_supply <= sqrt(base x quote).
    /// (On chain, harvest_lp_fees also re-checks the principal after withdrawing and reverts otherwise.)
    #[test]
    fn harvest_never_touches_principal(supply_ppm in 1u64..=1_000_000, own_ppm in 1u64..=1_000_000, base in 1_000u64..1u64 << 50, quote in 1_000u64..1u64 << 50, growth_bps in 0u64..50_000) {
        let root = isqrt(base as u128 * quote as u128);
        let lp_supply = ((root * supply_ppm as u128 / 1_000_000) as u64).max(1_000);
        prop_assume!(lp_supply as u128 <= root);
        let lp = ((lp_supply as u128 * own_ppm as u128 / 1_000_000) as u64).max(1);
        let state = PumpState { lp_supply, base, quote };
        let principal = liquidity_units(lp, &state).unwrap();
        let grown = PumpState { lp_supply, base, quote: (quote as u128 * (10_000 + growth_bps as u128) / 10_000).min(u64::MAX as u128) as u64 };
        let h = harvestable_lp(lp, principal, &grown).unwrap();
        prop_assert!(h <= lp);
        let out_base = (grown.base as u128 * h as u128 / lp_supply as u128) as u64;
        let out_quote = (grown.quote as u128 * h as u128 / lp_supply as u128) as u64;
        let after = PumpState { lp_supply: lp_supply - h, base: grown.base - out_base, quote: grown.quote - out_quote };
        if after.lp_supply > 0 && lp - h > 0 {
            prop_assert!(liquidity_units(lp - h, &after).unwrap() >= principal, "principal breached");
        }
        if growth_bps == 0 { prop_assert_eq!(h, 0, "harvest without fee growth"); }
    }

    /// Oracle conversion rounds up: the protocol never charges less than the USD amount.
    #[test]
    fn usd_to_quote_rounds_up(usd in 1u64..1_000_000_000_000, price in 1i64..1_000_000_000_000, exp in -12i32..=0, decimals in 6u32..=9) {
        let px = OraclePrice { price, exponent: exp, publish_time: 0 };
        if let Ok(v) = usd_to_quote(usd, &px, decimals) {
            let scale = 10u128.pow(decimals + (-exp) as u32);
            let lhs = usd as u128 * scale;
            let per = price as u128 * 1_000_000;
            prop_assert!(v as u128 * per >= lhs);
            prop_assert!(v == 0 || (v as u128 - 1) * per < lhs);
        }
    }

    #[test]
    fn isqrt_is_floor_sqrt(n in any::<u128>()) {
        let r = isqrt(n);
        prop_assert!(r.checked_mul(r).map_or(false, |sq| sq <= n));
        prop_assert!((r + 1).checked_mul(r + 1).map_or(true, |sq| sq > n));
    }
}
