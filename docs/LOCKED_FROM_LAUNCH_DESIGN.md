# Locked liquidity from launch and creator milestone reward

Agent implementation brief, 1 November 2026. Design only; no contract changes, deployments or fund movements are authorized by this brief. User requested a plan that another agent can implement. Do not replace deployed contracts or alter existing Model 10 pools.

## Product direction and decisions

- New launches should eventually trade in a permanently locked DEX pool from the first trade. Reaching a target marks a one-time graduation milestone in that same pool, without moving liquidity or changing the pool address.
- Prefer Uniswap on EVM and Raydium on Solana. Stop creating new PumpSwap destinations once the replacement passes its gates. Keep existing PumpSwap pools tradable, indexed and claimable; removing legacy readers would strand users.
- Creator purchase stays optional, including a genuinely zero-purchase launch. Separate wallets per chain remain unchanged.
- Proposed incentive: up to $400 to the fixed creator reward recipient on successful graduation. This is a proposed reward, not a promise or enabled feature.
- Preserve the existing 10% revenue flywheel as a separate budget. Do not fund rewards out of creator fee liabilities, the flywheel allocation or locked liquidity principal.

## Reference and what it establishes

The user's Flywheel launch screenshot shows a $6,000 reference graduation target, a $500 reference graduation fee taken from pool liquidity, and trading continuing in the same locked Uniswap v4 pool. The live form confirms Uniswap v4 from launch and discloses a graduation fee from liquidity. This is UI evidence, not an audit of its contracts, pool accounting or fee recipient. It does not establish that its graduation fee pays the creator. Its displayed fee model also differs from Elpida's; do not copy its fee rates.

References checked 1 November 2026:
- https://flywheel.cash/v2/create
- https://developers.uniswap.org/docs/get-started/concepts/liquidity-providers/concentrated-liquidity
- https://github.com/Uniswap/v4-core (hooks and pool accounting; pin a reviewed release before coding)
- https://github.com/raydium-io/raydium-docs-v1/blob/main/getting-started/faq.mdx
- https://github.com/raydium-io/raydium-cp-swap (pool initialization and token constraints)

## Architecture constraints: not a migration-button change

Current Model 10 uses virtual reserves, roughly 759.747M sale tokens of the 1B supply and a 10x terminal FDV. The initial virtual quote reserve is not real deposited liquidity. A plain two-asset constant-product pool requires real backing; copying virtual reserves into a Raydium CPMM or Uniswap full-range pool does not preserve its solvency or Model 10 prices.

EVM standard launches currently graduate to full-range V3 positions; tax tokens use their own V2-compatible route. The current V3 fee locker intentionally has no decrease-liquidity, rescue, transfer or upgrade method. Solana SOL pairs already graduate to Raydium CPMM; some other supported pairs retain PumpSwap. None of those facts prove that Raydium can host the exact existing virtual curve from inception.

The implementing agent must first deliver a math/feasibility report for each chain:
1. Real token and quote balances at a zero-buy launch; who supplies any seed quote, and its irrevocable lock.
2. Buy/sell reserve equations, executable sell backing, rounding, supply allocation and end-target definition.
3. Whether exact Model 10 execution can be preserved through a custom settlement/hook design. If not, use a new explicitly named model with user-approved economics. Never relabel a different curve as Model 10.
4. Price discontinuity, arb, launch cost, donation handling and LP share ownership before/after the milestone.
5. A proof that every public trading path enforces the intended fee policy. A frontend/router-only surcharge is bypassable.

### EVM track

Evaluate a new Uniswap v4 pool plus immutable hook and permanent liquidity controller. Hooks/custom accounting can support custom swap logic, but this is a candidate architecture, not proof of Model 10 equivalence. Verify official v4 deployments per chain, chain IDs, PoolManager/PositionManager identities and hook permissions. Do not assume a Uniswap v4 deployment exists on every supported chain, or silently substitute PancakeSwap. Disable new launches on unsupported chains for this model while preserving legacy trading.

Use a single immutable canonical pool ID, registry entry and fixed fee recipients. The hook/controller must have no general principal-withdrawal or arbitrary-call path. Define the bounded milestone state transition, emit a once-only event and leave the pool ID and trading rules unchanged. Tax tokens and restricted stock tokens require separate compatibility proofs; initial release may exclude them visibly rather than claim universal support.

### Solana track

Evaluate Raydium CPMM from launch with genuine funded reserves and program-controlled permanently locked LP, with fee rights protected independently. If exact virtual pricing requires a custom program or a different pool type, return a feasibility decision before implementation; do not pretend Raydium CPMM has Uniswap v4 hooks. Verify mint extensions, transfer restrictions, quote whitelist, pool fees, PDA derivation, LP authority and token-program IDs against pinned Raydium code. Support SOL first. Add USDC/other quotes only after full lifecycle tests. Token-2022/permanent-delegate assets stay disabled until explicitly compatible and issuer-approved.

## Creator reward: recommended funding design

Do not remove $400 from existing locked pools. A permanently locked principal claim and a privileged principal withdrawal conflict. The recommended design is a separately funded GraduationRewardEscrow, paid from a capped non-flywheel portion of realized protocol revenue (or an explicit sponsor budget). It must not receive user liquidity or creator fee liabilities.

Proposed terms, subject to product sign-off before money-moving code:
- A maximum $400 reference reward per token, reserved from available escrow funds at launch if advertised as guaranteed; otherwise visibly mark eligibility as conditional and do not promise $400.
- Fix the denomination policy at launch: either a disclosed fixed native/quote amount based on a verified launch-time USD reference, or a stablecoin-denominated obligation. Do not describe a fixed ETH amount as permanently worth $400.
- Require verified canonical launch, successful once-only milestone, locked principal, a sustained observation window, adequate executable depth and sufficient finalized **net protocol receipts generated by that launch** to cover the reward plus operating costs. Creator receipts are not protocol receipts. Deduct partner burns, flywheel earmarks, refunds and previously committed liabilities first.
- Unique wallets or volume alone do not establish genuine demand. Simulate creator-controlled wallets buying up, graduating, selling down and claiming; reward farming must not be profitable after all recoverable assets/fees are accounted for. If that invariant cannot be established, disable the incentive or pay only a fraction of that launch's net earned revenue.
- Credit the fixed creator recipient(s) only, with the chosen immutable allocation. Use pull-based claims and reentrancy protection. A rejecting recipient or unfunded bonus must not stop trading or graduation.
- Explicit escrow reservation, earned, claimable, paid and released accounting; chain-scoped replay protection, finality and reorg recovery. Record funding and payout events for analytics.

If the user instead selects a liquidity-funded design, require a **new model** with a capped, immutable and upfront-disclosed milestone fee. Define the exact one-time deduction and post-fee reserve invariant before launch. It cannot use existing fee-only lockers, must never expose general withdrawal permission, and must not be marketed as all deposited liquidity permanently nonwithdrawable. Recompute LP depth, price impact, target and farming economics. No implementation of this alternative is approved by this brief.

## Delivery phases and acceptance criteria

1. Feasibility/math PR: compare unchanged Model 10, funded CPMM and custom v4 settlement; publish numerical traces and subsidy requirements. Choose the chain-specific design explicitly.
2. EVM prototype: new versioned factory/hook/controller, no deployment. Real v4 local/fork tests, CREATE/pool proof, native and approved quote routes, zero creator buy, concurrent swaps and exactly-once milestone.
3. Solana prototype: genuine Raydium local-validator integration, supported quotes, zero buy, lock evidence, permissionless trades, fee harvest and same pool before/after milestone. No new PumpSwap pools in this version; existing ones remain supported.
4. Reward escrow PR after signed-off funding terms. Test payout authorization, insolvency prevention, replay, rounding, recipient failures, farming, reentrancy and no principal path. Tests must quantify attack profit, not only check flags.
5. Index/UI PR: expose model, pool identity, actual lock proof, milestone, bonus denomination/funding/eligibility/claim status; do not say 'migration' when assets never move. Distinguish vested bonus from creator trading fees and lifetime earnings.
6. Public testnet rehearsal: separate creator/treasury wallets, optional zero buy, buy/sell, milestone crossing without pool change, claims, lock ownership and preserved principal; independently verify receipts and balances. Include delayed RPC, reboot, reorg, stale oracle, fee-on-transfer and insufficient-funding cases.
7. Independent audit and economic review of the new architecture before any mainnet consideration. Existing Model 10 tests and chain-wallet isolation must continue to pass.

## What locked liquidity does and does not promise

A permanent lock prevents withdrawal through the locked LP position. It does not prevent creator selling, external pools, issuer freezes, price manipulation or loss. A $400 bonus is not a reason to claim tokens cannot rug or that holders will profit. Describe verifiable custody and funding facts rather than guarantees about creator behavior.
