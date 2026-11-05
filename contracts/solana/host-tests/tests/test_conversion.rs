//! The devnet SOL/asset conversion pool (test builds only): constant product after a 0.3% fee that stays in the pool.
use ::elpida_launchpad::{test_conversion_out, TEST_CONVERSION_FEE_BPS};
use proptest::prelude::*;

#[test]
fn quotes_match_constant_product_after_fee() {
    assert_eq!(TEST_CONVERSION_FEE_BPS, 30);
    // 2 SOL and 0.43 TSLA-like units (9 decimals): 1 SOL in, 0.997 SOL after the fee.
    let out = test_conversion_out(2_000_000_000, 430_000_000, 1_000_000_000).unwrap();
    assert_eq!(out, (430_000_000u128 * 997_000_000 / (2_000_000_000 + 997_000_000)) as u64);
    assert!(test_conversion_out(0, 1, 1).is_err());
    assert!(test_conversion_out(1, 1, 0).is_err());
    assert!(test_conversion_out(1_000_000, 1, 1).is_err(), "an output that rounds to zero is refused");
}

proptest! {
    #![proptest_config(ProptestConfig { cases: std::env::var("PROPTEST_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(5_000), ..ProptestConfig::default() })]
    /// k never falls, the pool is never emptied, and a round trip never returns more than went in.
    #[test]
    fn swaps_never_drain_or_lose_value(x in 1_000u64..u64::MAX / 4, y in 1_000u64..u64::MAX / 4, amount in 1u64..u64::MAX / 4) {
        let Ok(out) = test_conversion_out(x, y, amount) else { return Ok(()) };
        prop_assert!(out < y);
        let (x2, y2) = (x as u128 + amount as u128, y as u128 - out as u128);
        prop_assert!(x2 * y2 >= x as u128 * y as u128, "k fell");
        if x2 <= u64::MAX as u128 {
            if let Ok(back) = test_conversion_out(y2 as u64, x2 as u64, out) { prop_assert!(back < amount, "round trip profit"); }
        }
    }
}
