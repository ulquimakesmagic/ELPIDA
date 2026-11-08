# ELPIDA V2.0 — reward contracts (roadmap step 4)

8 November 2026, branch `v2-vaults` (on top of `v2.0`). **Prototype, not audited, local chain only.** Nothing is
deployed.

The V2 hook pays each fee share straight to its recipient. The 30% creator share goes to the creator's vault, and
the treasury receives only its 20% (and the $10 launch fees). The other three shares go to the contracts below, one
set per chain. No wallet is topped up by hand, and the treasury never holds airdrop, holder or flywheel money
(Malik, 8 November).

| Share | Recipient | What its money can do |
|---|---|---|
| 30% trader airdrop | `ElpidaV2Distributor` "trader-airdrop", rounds = calendar months (UTC) | Pay wallets listed in a posted round |
| 10% holder rewards | `ElpidaV2Distributor` "holder-rewards", rounds = fixed period (weekly recommended) | Pay wallets listed in a posted round |
| 10% flywheel | `ElpidaV2FlywheelVault` | Buy V2 tokens through the Elpida router and `burn()` them |

## Distributor

- **Schedule on chain.** `roundStart(n)`, `roundEnd(n)` and `currentRound()` are fixed at deployment: calendar months
  from a 1st of the month, or fixed periods of at least a day, all at 00:00 UTC. The site's countdown
  (`packages/core/v2-rounds.mjs`, `countdown`) reads the same schedule, and a test checks they agree for 30 months
  from several start dates, including a leap February.
- **Posting.** After a round ends, the operator (the keeper key) posts one Merkle root per payout asset, with the
  round's total and number of recipients, and a link to the full public list. Rules: once per round and asset; not
  before the round ends; the total must be covered by funds not already promised to earlier rounds.
- **Paying.** Anyone may pay any listed wallet with its proof. The keeper pushes a whole round with `claimMany`, and a
  wallet can also claim for itself. A transfer that fails (a wallet that refuses, a paused stock) is skipped and stays
  claimable.
- **Unclaimed amounts.** After 12 more rounds, anyone may return what a round left unclaimed to the pool for later
  rounds. It never goes to the operator or the treasury.
- **What the operator can't do.** It has no other power: the contract's only state-changing functions are
  `postRoot`, `claim`, `claimMany` and `expire` (tested).
- **Proofs can't be reused.** Each leaf binds the chain, the distributor, the round, the asset, the wallet and the
  amount.
- **Payout lists.** `buildRound` builds the list, root and proofs. `allocateAirdrop` (`v2-airdrop.mjs`) decides the
  trader amounts. `roundStats` gives the public figures for the analytics page: recipients, total, median, smallest,
  largest, the top 1%'s share, and counts by size band.

## Flywheel vault

- `buyAndBurn(token, amountIn, minTokensOut, cycle)`, operator only. Rules:
  - the token must come from this V2 factory and be at least a day old;
  - at most 10% of the vault's balance of that asset per order;
  - one order per token every six hours;
  - the keeper sets the minimum out from a time-weighted price.
- Everything bought is burned in the same transaction. `totalSupply` falls, and `BoughtAndBurned` records the amount
  spent, the tokens burned and the new supply.
- Each pool's own quote asset is used: ETH for ETH pairs, USDC for USDC pairs. No asset is converted.
- The router is set once by the operator after deployment, because the hook needs the vault's address first. The
  vault's only state-changing functions are `buyAndBurn` and `setRouter` (tested). Nothing can withdraw its funds.
- The keeper decides which tokens to buy (decision C9: the top 10 by net buy volume from wallets not linked to the
  creator, with a minimum number of independent traders). The contract limits the damage a wrong or compromised
  keeper could do. It can't stop the keeper picking poor tokens. Its choices are public in the events.

## Tests

`tests/v2-vaults.test.mjs` (4 tests, with the hook paying the real contracts):

- **Schedules:** contract and site agree; bad schedules are refused.
- **Trader airdrop:** funded with exactly the 30% share; can't be posted early, by others, or over-funded; posted
  once; paid in one push; a refusing wallet is skipped and stays reserved; can't be paid twice or with a wrong
  amount; expires back to the pool after 12 rounds; round statistics.
- **Holder rewards:** weekly rounds, paid in USDC from a USDC pool.
- **Flywheel:** gets exactly the 10% share while the treasury gets only its 20%; rejects other callers, young
  tokens, oversized orders, unknown tokens and repeat orders within six hours; real burns in ETH and USDC pools; no
  approval left behind.

Sizes: distributor 4,982 bytes, flywheel vault 3,384.

## Not done yet

- The keepers: daily `withdrawFees`, monthly and weekly payout lists from the indexer, and flywheel cycles.
- Indexer and analytics: vault sizes by day, the countdown, distribution statistics and the flywheel's burns
  (next phase). Until V2 is deployed on a test network, those sections stay hidden instead of showing invented
  figures.
- The holder-reward formula (snapshot frequency and minimum payout are still open, §25).

## Deployment status

Local implementation and automated tests only.
