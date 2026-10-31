# Revenue flywheel proposal

User decisions, 1 November 2026:
- Budget: 10% of realized Elpida protocol fees received after existing partner buyback allocations.
- Rank: highest market capitalization, up to ten tokens.
- Purpose: buy back those tokens and burn them.

Creator fees, user deposits, liquidity principal, unrealized fee balances and the amounts already allocated to
partner buybacks do not count as protocol receipts. Budgets stay scoped to chain and revenue asset; no bridges,
mainnet spending, new keys or fund transfers are enabled.

The pure planner in packages/core/revenue-flywheel.mjs produces reviewable orders only (executionEnabled=false).
It requires trusted receipt and market records, excludes stale/unverified market caps, missing routes, issuer
restrictions and unavailable burn support, and rejects duplicate identities/receipts. Ranking is descending market
capitalization with a deterministic identity tie-break. The caller must persist consumed receipt IDs atomically
with execution; the planner alone is not an accounting ledger or a replay-safe keeper.

Proposed allocation, not yet a spending policy: ten equal budget slots (1% of received fees per slot). Fewer than
ten eligible tokens leave unused slots in treasury; integer dust stays unallocated. Market-cap source, minimum
liquidity/age requirements, price-impact limits, cadence, max spend, failed-order accounting, burn receipts and
operator/multisig permissions still need an execution design and tests before any keeper is enabled.

Market cap can be manipulated through shallow liquidity. Independent pricing and executable-depth checks must
precede purchases; a large displayed cap alone is insufficient evidence of a safe execution route.
