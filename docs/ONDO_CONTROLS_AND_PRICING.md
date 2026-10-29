# Ondo controls and valuation groundwork, 28 October 2026

The subsequent [market-input validation phase](ONDO_MARKET_VALIDATION.md) adds full-reserve bidirectional execution samples and quote-USD checks. It does not install any production feed or independent pool.

The subsequent [issuer restriction rehearsal](ONDO_RESTRICTION_REHEARSAL.md) follows the confirmed compliance path and exercises real issuer methods on a local fork. It does not enable live pairing or close the complete privilege review.

This phase builds on the cached fork runner in PR #120. It adds read-only control observations and a pure valuation guard. It does not install a production feed policy, expose new stock launch options, alter Model 10 or wallet selection, or enable any live capability.

## Read-only observations

The inspector read issuer-listed Ethereum NVDAon, TSLAon and SPYon at block **26294021**, hash `0xa006d5da3793e8f9b02ba124eb3ec3d918ee764e318220d1d0a2b4d5cef7225c`. All three returned their registered symbol and 18 decimals. Only `eth_call`, `eth_getCode` and `eth_getStorageAt` are used after snapshot selection. No issuer account is impersonated and no role is exercised.

| Asset | Canonical Ethereum contract |
|---|---|
| NVDAon | `0x2d1f7226bd1f780af6b9a49dcc0ae00e8df4bdee` |
| TSLAon | `0xf6b1117ec07684d3958cad8beb1b302bfd21103f` |
| SPYon | `0xfedc5f4a6c38211c1338aa411018dfaf26612c08` |

The observed token runtime hash was identical: `0x9806c8207a455c012b2799be651ac0146d54866f92db90b502e5e2efa283bee9`.

All three had an ERC-1967 beacon-slot value pointing to `0x985462c9aa4d6c3ad59ae6e1e9c0c11347ed1598`, which had bytecode. Its `implementation()` probe returned `0xebbcb2cee51c2fee4062c9c1270dcb98b0b22250`, with code hash `0x7480293a8fad3f98f01f39aa59cd4e4c30d7fc4e7019e8f6e691eb5a9be53d11`. The beacon's `owner()` probe and each token's single enumerated default-admin member returned `0x3715b2154d2ff4c5b027c7a1f734b53f27bc34f1`. These are observed getter results, not a source audit or a claim about the legal identity of that account.

The token's `owner()`, `paused()`, `blocklist()`, `sanctionsList()` and `sharesMultiplier()` probes were unavailable or incompatible. Several role-name probes were also unavailable. An observed burner-role membership count of zero does not prove that burning is impossible or that membership cannot change. Empty implementation/admin slots do not exclude a beacon or other upgrade route. The verified-ABI endpoint returned HTTP 403, so this phase does not establish the complete privilege surface. **Issuer controls remain unverified.**

Run the inspector from the repository root:

```powershell
$env:ELPIDA_EQUITY_FORK_BLOCK = '26294021'
node --env-file=.env.ondo.local scripts/ondo-inspect.mjs ethereum NVDAon
```

Reports go to ignored `backups/equity-fork/ethereum-ondo-NVDAon-controls.json`. Omit the block variable to select recent state. A historical observation is not a current issuer-status check. Getter failures stay unverified; the inspector never treats them as evidence of absent controls. Role enumeration is capped at 16 members and records truncation.

## Comparing later control observations, 29 October 2026

The inspector accepts an optional third argument: a saved baseline report path. Copy reviewed evidence to a separate filename before running; the latest output file cannot itself be the baseline. The comparison never updates or accepts the baseline automatically.

```powershell
node --env-file=.env.ondo.local scripts/ondo-inspect.mjs ethereum NVDAon backups/equity-fork/ethereum-ondo-NVDAon-baseline-2026-10-28.json
```

It writes a separate `-drift.json` report and returns exit code 2 if observed fields change. Comparisons include token bytecode, proxy pointers and target bytecode, beacon implementation/owner, readable status getters and enumerable roles. Member order alone is ignored. Failed probes and truncated role membership remain explicitly unverified; loss of a previously observed value is a change requiring review. Different assets, wrong chain IDs, older blocks and conflicting hashes at the same height are rejected. This is an on-demand inspection tool, not an installed recurring monitor or an execution gate.

A fresh read-only NVDAon inspection on 29 October at block **26298112** matched the saved block 26294021 observations: **NO_OBSERVED_CHANGE**, zero changed fields and 14 unverified fields. This does not close the source/ABI audit or enable pairing. The strict focused gate passed 36 tests with no skips. A new full suite was started separately; the earlier 552-pass result below is historical evidence, not this run's result.

## Total-return valuation guard

Ondo describes its stocks as total-return trackers. Dividends and other adjustments affect the economics represented by each raw token. BNB and Solana wallets can display a scaled balance with a corresponding display-price adjustment; that does not change raw onchain balances. An ordinary stock-price feed and a token total-return price are therefore not interchangeable.

`packages/core/ondo-valuation.mjs` accepts raw integer balances and USD prices expressed as integer WAD values. It requires a caller-supplied reviewed policy for the exact network, token, reference feed and independent USD pool TWAP. Both prices must explicitly be per raw token. The guard rejects missing or stale asset status, active/unknown corporate actions, future or stale timestamps, insufficient TWAP history, identity substitutions and excessive reference/TWAP divergence. The lower price is used, with integer arithmetic. Display or shares-per-token multipliers are never applied again to an already total-return price.

This module computes whether a supplied valuation meets policy. It does not authorize trades, establish securities eligibility or verify the issuer's controls. No actual feed/TWAP adapter or production policy is configured in this phase. The caller must use trusted server time and independently reviewed feed/status sources; a policy ID supplied by an untrusted client must never be accepted as authorization. The asset-status input is an explicit execution policy, not an assumption that primary-market hours and DEX availability are identical.

Before activation, obtain verified source/ABI and audit the beacon and administrative permissions; monitor implementation and policy changes; validate a production total-return feed, corporate-action/status source and independent executable liquidity; resolve end-user and contract eligibility; and test issuer restrictions on a local fork. Existing registry gates remain in force throughout.

## Validation and sources

The expanded strict focused gate passes **51 tests with zero skips**, including the new valuation/control tests, existing cache/registry checks and evidence/documentation checks. The real inspector matched all three asset identities at the pinned block, while retaining `issuerControlsVerified: false`. The separate broader run for PR #120 completed with 552 passes, zero failures and 33 skips reporting a missing Solana validator on Windows. These skips are not Solana execution evidence.

- https://docs.ondo.finance/ondo-stocks/token-and-quote-pricing
- https://docs.ondo.finance/ondo-stocks/corporate-actions
- https://docs.ondo.finance/ondo-stocks/transferability
- Canonical asset pages: https://app.ondo.finance/assets/nvdaon, https://app.ondo.finance/assets/tslaon, https://app.ondo.finance/assets/spyon

## Source-confirmed token dependencies, 29 October 2026

The [Sourcify v2 record](https://sourcify.dev/server/v2/contract/1/0xebbcb2cee51c2fee4062c9c1270dcb98b0b22250?fields=all) identifies GMToken, compiled with solc 0.8.16. Its recorded onchain runtime hashes to the observed implementation hash above. Sourcify reports a runtime match with a CBOR metadata transformation; this is not a claim of independently reproduced byte-for-byte compilation.

GMToken's transfer hook checks its external pause manager and compliance contract, including the spender when distinct from both transfer parties. CONFIGURER_ROLE can change those dependencies and token name/symbol. MINTER_ROLE can mint; BURNER_ROLE can burn another account's tokens. Enumerable role administrators must be inspected even if a privileged role currently has zero members. Empty roles are not permanent guarantees.

At Ethereum block **26298737**, read-only NVDAon inspection matched that implementation hash. Compliance points to `0x54a8757c2fef8649830b158a8c19d3a670e80318`; the pause manager points to `0xfd48112e448417ca79305a518c4186df4b0a200a` and returned false for isTokenPaused(NVDAon). CONFIGURER_ROLE and BURNER_ROLE each had zero members; MINTER_ROLE had three. Each reported DEFAULT_ADMIN_ROLE as its administrator. These are snapshot observations, not approval of those authorities.

The inspector and drift comparison now cover those dependency pointers, their runtime hashes, token pause status, CONFIGURER_ROLE, MINTER_ROLE and role-admin identifiers. Their own source, proxy routes and control permissions still require verification; dependency runtime hashes alone do not capture changes behind a proxy. `issuerControlsVerified` and `dependencyControlsVerified` remain false. No capability flags, public deployment, fund transfer or issuer mutation occurred.

The completed pre-PR125 local suite had **566 passes, zero failures and 33 missing-Solana-validator skips** (599 total). This supersedes the previously pending full-suite status for PR124; it does not establish execution of the skipped Solana tests or validate subsequent changes.
