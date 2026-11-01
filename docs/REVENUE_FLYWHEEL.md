# Revenue flywheel proposal

User decisions, 1 November 2026:
- Budget: 10% of realized Elpida protocol fees received after existing partner buyback allocations.
- Rank: highest market capitalization, up to ten tokens.
- Purpose: buy back those tokens and burn them.

Creator fees, user deposits, liquidity principal, unrealized fee balances and the amounts already allocated to
partner buybacks do not count as protocol receipts. Budgets stay scoped to chain and revenue asset; no bridges,
mainnet spending, new keys or fund transfers are enabled.

## Execution, 1 November 2026: a keeper wallet the treasury tops up

Decision (Malik): no on-chain fee split. The treasury sends 10% of the protocol fees it received to a dedicated
flywheel wallet, by hand; a keeper on the server spends that wallet. This replaces the receipt ledger below for now:
the wallet's balance is the budget, and what goes in is decided by the treasury, outside the contracts.

`apps/api/flywheel-keeper.mjs`, testnets only (Base Sepolia, Ethereum Sepolia, BNB Testnet, Robinhood Testnet, local):

- **Cadence:** one cycle per chain every 24 hours (`ELPIDA_FLYWHEEL_EVERY_HOURS`).
- **Budget:** the wallet balance less a gas reserve (`ELPIDA_FLYWHEEL_GAS_RESERVE_ETH`, 0.005), at most
  `ELPIDA_FLYWHEEL_MAX_PER_CYCLE_ETH` (0.05) per cycle, split into **ten equal slots**.
- **Eligible:** Elpida tokens from the public index on that chain, paired with the native coin, at least a day old,
  not restricted, ranked by circulating market cap (`planFlywheelCycle` in `packages/core/revenue-flywheel.mjs`).
- **Caps:** on the curve a slot is at most 25% of what is left to complete it, so the flywheel never graduates a
  curve; on a pool at most 0.5% of its quote balance. Whatever a slot cannot spend stays in the wallet.
- **Guards:** a pool order runs only while the pool price is within 150 ticks of its 10-minute average (the same rule
  as the partner buyback, review finding E-1); the keeper asks a pool to keep 16 price points the first time. A dry
  run sets the minimum output, less 1% slippage.
- **Burn:** what each order bought is sent to `0x…dEaD` in the next transaction (Elpida tokens have no burn function,
  so this is a dead-address transfer, labelled as such). Every order is journalled before it is sent; tokens left by
  an interrupted order are sent to the dead address at the next cycle.
- **Public record:** `GET /api/public/flywheel` and the Analytics page list each chain's burn orders, amount spent and
  the burn transactions.

Not covered yet: USDC and stock pairs (the budget is the native coin, no conversion), Solana, and reconciling top-ups
against received fees. Setup steps are in `HUMAN_ACTIONS.md`.

## Original planning notes

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


## Agent execution brief - next contract/accounting phase

The Analytics page now explains the approved 10% / top-ten-by-market-cap policy and explicitly says execution is disabled. It does not display estimated treasury balances as received revenue or invented burn totals.

Implement the following in a separate PR sequence. No live spending is enabled by the analytics change:

1. Receipt ledger: index finalized protocol payouts to the configured treasury/intake, scoped by chain, asset, transaction hash and log/instruction index. Verify origin, fixed recipient and exact balance/transfer amount; exclude treasury self-transfers, arbitrary deposits, creator shares, LP principal, and fees already assigned to partner burns. Shared creator/treasury addresses need role-aware allocation evidence so a combined payout is not wholly treated as protocol revenue. Persist raw integer amounts and reorg reversals, not floating point dollars.
2. Budget reservations: durable SQLite transaction records received, earmarked (10%), reserved, spent, refunded and carried amounts. A receipt must fund a budget only once; orders and receipt claims must survive a restart. Never mark a failed swap as spent or release funds still committed to a pending transaction. Lock the epoch by chain/asset. Separate flywheel funds from the proposed creator bonus budget.
3. Market snapshot: highest eligible market capitalization at a fixed finalized height/time, with immutable token identity and verified Elpida launch provenance. Fix FDV versus circulating-cap methodology, source freshness, minimum age, liquidity/depth and price-manipulation checks in versioned policy. Ranking is not spend authorization. Never let one wallet's thin-liquidity spot mark set a large purchase budget.
4. Orders: ten equal slots are currently a proposal, not an approved execution policy. Confirm this before enabling a spender. The existing planner leaves empty slots unspent, applies deterministic ties and spends within each chain/asset scope. Global cross-chain ranking/bridging is not implemented. A global list would require an explicit rule for revenue on chains without a selected eligible token; do not bridge or redistribute silently.
5. Execution: allowlisted immutable routes, exact maximum inputs, per-hop minimum outputs and deadlines, price-impact/depth caps, bounded approvals cleared after swaps, no arbitrary calldata, no arbitrary recipients. Use a guarded escrow/keeper authorization model with a multisig-controlled limited budget. Only spend already reserved amounts. Execute burns atomically when supported or keep a distinct pending-burn liability; verify true supply destruction versus a dead-address transfer and label them separately.
6. Claims/indexing: record quotes, policy version, snapshot, funding receipt IDs, order ID, execution receipt, actual spend, acquired amount and burn proof. Expose read-only endpoints for received revenue, budget, reserved/pending, spent, token burns and last successful cycle. Include coverage gaps. Never count externally initiated burns as flywheel purchases.
7. Test: duplicate receipts, same-address recipients, self-transfers, reorgs, restart between submission and receipt, concurrent keepers, partial failures, spent/remaining conservation, price spoofing, hostile tokens, failed burns, transfer taxes, stale quotes, restricted equity assets and no route. Compare ten-token ranking to authoritative snapshots and ensure unfilled slots/dust are retained.
8. Testnet-only deployment and rehearsal with capped test funds, followed by independent review. Publish a reconciled ledger and burn receipts before changing Analytics from Planned to Active. No mainnet deployment or revenue spending is authorized here.
