# Self-audit, October 2026: free tools before the paid audit

This complements `AUDIT_SCOPE.md`, which holds the audit brief, the Slither triage and our findings F-1 to F-8. Here
are the free tools that brief does not cover: two fuzz campaigns, Mythril on the in-scope EVM bytecode, and
`cargo clippy` plus `cargo audit` on the Solana program. It also records the decision not to cap the creator's first
buy. **Nothing here is an audit.** These tools find patterns; they do not prove safety.

Scope and settings are the same as the brief's: Solidity 0.8.24, optimizer on with 1 run, `shanghai`. Run in
October 2026 against `main` as of PR #88 (EVM sources unchanged since; the Solana program unchanged since its
rebuild noted in `HUMAN_ACTIONS.md`).

## Summary

| Tool | Target | Result |
|---|---|---|
| Invariant fuzz (`economic-invariants`) | Curve, ETH and USDC pairs | 43 seeds, 88 of 88 runs passed |
| Lifecycle fuzz (`fuzz-lifecycle`, new) | Launch → curve → atomic graduation → pool swaps → fee collection → claims | 30 seeds, 64 of 64 runs passed |
| Mythril | 6 in-scope contracts | No real issue. 1 contract clean, 10 pattern findings triaged below, 1 contract [MIGRATION_ADAPTER_RESULT] |
| `cargo clippy` | Solana program | 4 style warnings; no correctness issue |
| `cargo audit` | Solana dependencies | 0 vulnerabilities; 3 warnings in transitive crates from Anchor 0.31.2 |
| Aderyn | EVM sources | Not run here (needs `binaries.soliditylang.org`, blocked in this workspace); command below |

New informational note: **S-1**, a narrowing cast on Solana. No change is required before the audit.

## 1. Fuzzing

**Invariant fuzz** (`tests/economic-invariants.test.mjs`): random buys, sells, fee withdrawals and full exits by
several traders, in random order. It checks that the curve's balance always equals its reserve plus fees plus the
liquidity bonus, that tokens are conserved, that fees are exact and that a buy-then-sell never profits. `npm test`
runs seeds 1, 7 and 42; the campaign added 40 more with `ELPIDA_FUZZ_SEEDS`. Result: 88 of 88 runs passed (43
seeds, each with an ETH and a USDC curve, plus the fixed checks in the file).

**Lifecycle fuzz** (`tests/fuzz-lifecycle.test.mjs`, added with this report): each run deploys the atomic factory and
then, from a seed:

- trades the curve at random, including dust sells (the sell quote refuses dust exactly as the sale does);
- ends with an oversized completing buy, which must fill exactly the remaining supply and graduate in the same
  transaction;
- swaps through the router on the new pool, collects fees with the locker's `collectFees` and pays both recipients
  through the splitter.

After every step it checks token conservation, curve liabilities, the splitter balance against what it owes, and
that the LP position never leaves the locker. At the end, after the final payouts, the curve and the splitter hold
nothing. `npm test` runs seeds 3 and 11 for both pairs; the campaign used 30 seeds via `ELPIDA_LIFECYCLE_SEEDS`.
Result: 64 of 64 runs passed.

Reproduce a campaign:

```
ELPIDA_FUZZ_SEEDS=100,101,102 node --test tests/economic-invariants.test.mjs
ELPIDA_LIFECYCLE_SEEDS=100,101,102 node --test tests/fuzz-lifecycle.test.mjs
```

## 2. Mythril (symbolic execution of the bytecode)

Mythril runs on the deployed runtime bytecode, one contract at a time. The workspace has 8 GB of memory and two
Mythril runs side by side were killed, so each contract runs alone. Unnamed functions were mapped back to source by
selector: `0xc7385485` is `tokenMetadataURI(address)`, `0x48153279` is `previewBuy(uint256)`.

| Contract | Finding | Assessment |
|---|---|---|
| `ElpidaV3FeeLocker` | none | — |
| `ElpidaToken` | SWC-101 (integer underflow) in `name()` and `symbol()` | **False positive.** The arithmetic is the compiler's own string-copy routine for a stored `string`. The contract's only `unchecked` block is the balance decrement in `_transfer`, directly after `require(balance >= amount)`. |
| `ElpidaAtomicDexFactory` | SWC-101 in `tokenMetadataURI(address)` | **False positive.** That is the auto-generated getter of `mapping(address => string) public tokenMetadataURI` in `ElpidaDexFactory`: the same string-copy routine, in a view. The factory has no `unchecked` blocks. |
| `ElpidaDexCurve` | SWC-116 (block timestamp) ×4 in `previewBuy(uint256)` | **Intended.** `currentFeeBps()` lowers the anti-snipe fee from 90% to 1.25% over the first 60 s using `block.timestamp`. A block producer can shift that by seconds, which moves the fee within the same window; the extra over the base fee goes to locked liquidity, not to anyone. Same as Slither's `timestamp` entries in the brief. |
| `ElpidaFeeSplitter` | SWC-101 in `claim(address,address)` | **False positive.** No `unchecked` blocks; with 0.8 checked arithmetic an underflow reverts and cannot wrap. |
| `ElpidaFeeSplitter` | SWC-114 (transaction order dependence) in `claim` | **Not exploitable.** `claim` pays only the fixed treasury or creator, whatever the caller or order; front-running a claim just pays the same recipient earlier. |
| `ElpidaFeeSplitter` | SWC-107 (state access after external call) ×2 in `claim` | **Guarded.** The amount is zeroed before the payout (checks-effects-interactions) and `guarded` blocks re-entry; the post-call accesses are the event and the lock reset. |
| `ElpidaV3MigrationAdapter` | [MIGRATION_ADAPTER_ROW] | [MIGRATION_ADAPTER_ASSESSMENT] |

Commands (Mythril 0.24 in a Python virtual environment; `<Name>.hex` is the runtime bytecode from `scripts/compile.mjs`):

```
myth analyze -f <Name>.hex --bin-runtime --execution-timeout 900 -o json > <Name>.json
```

## 3. Solana program: clippy and dependencies

`cargo clippy` on `programs/elpida_launchpad` reports four warnings, none about correctness:

- `AccountInfo::realloc` is deprecated in favour of `resize` (line 115, generated by Anchor's `#[program]`
  expansion). Changes with the Anchor upgrade below.
- Three manual `div_ceil` reimplementations (lines 680, 879 and 880): `(a + b - 1) / b`. They round up on purpose:
  `harvestable_lp` keeps at least the principal in the PumpSwap position, and the partial-fill path charges the
  smallest amount that buys the remaining tokens. `overflow-checks = true` is set in the release profile and every
  divisor is positive (`root > 0` is required; `avail - remaining > 0` on that branch; `BPS - fee_bps > 0`).

**S-1 (Informational): narrowing before the cap.** In the partial-fill path,
`gross = (gross_needed as u64).min(gross_in)` narrows a `u128` to `u64` before taking the minimum. `gross_needed` is
at most about `gross_in` plus one lamport, so it can only exceed `u64::MAX` if a buyer sends about 18 billion SOL.
It is unreachable, but taking the minimum first (`gross_needed.min(gross_in as u128) as u64`) states the bound
directly. Worth doing with the next program change; it does not justify an upgrade by itself.

`cargo audit` (cargo-audit 0.22.2) finds **no vulnerabilities**. It warns about three transitive crates, all brought in
by Anchor 0.31.2 and `solana-program`:

| Advisory | Crate | Kind |
|---|---|---|
| RUSTSEC-2025-0141 | `bincode` 1.3.3 | unmaintained |
| RUSTSEC-2025-0161 | `libsecp256k1` 0.6.0 | unmaintained |
| RUSTSEC-2026-0097 | `rand` 0.7.3 | unsound with a custom logger calling `rand::rng()`; the program does not use randomness |

None is reachable in a way that matters for the program's logic. The fix is the Anchor and Solana SDK upgrade,
which removes all three. Plan it together with S-1 and the `realloc` deprecation, and rebuild and re-verify the
binaries afterwards (`HUMAN_ACTIONS.md`).

## 4. Design decision: the creator's first buy is not capped

The creator may buy any amount in the launch transaction, at the base fee and without the anti-snipe fee
(`initialBuy`). **Decision (24 Oct, Malik): no cap.** Instead, the size is shown to everyone:

- the launch flow states the share of supply the first buy takes;
- the token page labels the creator's trades "Dev" and marks them on the chart;
- the safety card shows what the dev bought and holds now, and flags a holding above 5%.

What a first buy does to a curve starting at a $5,000 valuation (ETH at $2,500), measured on the curve model:

| First buy | Valuation after | Dev share of supply |
|---|---|---|
| $500 | $5,928 | 9.1% |
| $1,000 | $6,935 | 16.8% |
| $3,000 | $11,754 | 38.6% |
| $5,000 | $17,837 | 52.3% |
| $10,000 | $38,573 | 71.1% |
| about $12,000 or more | graduates in the launch transaction | 76% (the whole sale) |

Auditors should treat this as accepted design, not a finding. A large first buy is visible on-chain and on the page
before anyone else buys.

## 5. Aderyn (to run on a machine with internet access)

Aderyn downloads its compiler from `binaries.soliditylang.org`, which this workspace cannot reach. On a normal PC:

```
npm install -g @cyfrin/aderyn
aderyn . --src contracts/evm/src --output docs/security/aderyn-2026-10.md
```

If the flags differ in the installed version, `aderyn --help` lists them. Commit the report next to the Slither one
and triage it the same way, in `AUDIT_SCOPE.md` section 5.
