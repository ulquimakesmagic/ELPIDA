# Audit brief: Elpida mainnet launchpad (checklist C1, 23 October 2026)

Elpida is a multichain memecoin launchpad. This brief is for auditors quoting and reviewing the EVM contracts that
will run on mainnet. **Nothing here is audited yet.** Commit to audit: the `main` commit that merges this file
(record the hash at engagement).

## 1. Scope

**EVM, in scope: 9 files, 631 source lines** (Solidity 0.8.24, optimizer on with 1 run, `shanghai`). Everything that
`ElpidaAtomicDexFactory` deploys or calls:

| File | SLOC | Role |
|---|---|---|
| `contracts/evm/src/ElpidaAtomicDexFactory.sol` | 8 | Mainnet factory: `ElpidaDexFactory` with graduation inside the completing buy, and token details required at launch |
| `contracts/evm/src/ElpidaDexFactory.sol` | 101 | Launch (native or approved-asset pair), $10 fee, metadata URI once, curve deployer |
| `contracts/evm/src/ElpidaUsdPricing.sol` | 63 | Chainlink-compatible USD pricing, configured once, staleness checks |
| `contracts/evm/src/ElpidaDexCurve.sol` | 196 | Virtual constant-product curve, anti-snipe fee, fees, completion, graduation, reopen |
| `contracts/evm/src/ElpidaV3MigrationAdapter.sol` | 122 | Uniswap v3 / PancakeSwap v3 pool creation, repricing a pre-created pool, full-range mint |
| `contracts/evm/src/ElpidaV3FeeLocker.sol` | 53 | Holds the LP position forever; anyone can collect fees into the splitter |
| `contracts/evm/src/ElpidaFeeSplitter.sol` | 41 | Pool fees, 50/50 to two fixed recipients |
| `contracts/evm/src/ElpidaToken.sol` | 40 | Fixed-supply ERC-20 (1B, no mint, no owner, no hooks) |
| `contracts/evm/src/ElpidaInterfaces.sol` | 7 | Shared minimal ERC-20 interface |

**Out of scope:** every other file in `contracts/evm/src` (earlier models, the tax-token experiment and holder
epochs; none is deployed on mainnet); OpenZeppelin `Math`; Uniswap v3 and PancakeSwap v3; Chainlink; the web app
and server.

**Solana (separate engagement):** `contracts/solana/programs/elpida_launchpad/src/lib.rs`, 1,223 source lines
(Anchor, 28 instructions). It has the same curve as the EVM. The test-only instructions refuse to run off test
clusters (`test_networks_only`, checklist B4).

## 2. How it works

1. **Launch.** `launch*` charges $10 in native coin at the oracle price (or exactly 10 USDC). That goes to the
   treasury, and any excess `msg.value` is refunded. The deployer creates the token and curve, the full 1B supply
   goes to the curve, and the creator's optional first buy happens atomically at the base fee. The metadata URI must
   be `ipfs://` and is written once.
2. **Curve.**
   - Virtual reserves: `virtualToken = 1B × 10/9` and `virtualQuote = startFdv × 10/9` at the oracle price.
   - The sale ends at `SALE_CAP = 1B × √10/(√10+1)`, where the price is 10× the start. The remaining supply is
     reserved for liquidity.
   - Fees: a base fee of 1.25%, split 50/50 between protocol and creator. During the first 60 s an anti-snipe fee
     falls from 90% to the base. Anything above the base goes to `liquidityBonus`, which is locked into graduation
     liquidity.
   - Buys that would cross the cap are partially filled, and the unused native value is refunded.
3. **Graduation (atomic factory).** The buy that reaches `SALE_CAP` calls `_graduate`. The adapter:
   - creates the pool, or reprices one that already exists, swapping at most 2% of each asset with the price limit
     set to the target;
   - mints a full-range position and transfers it to a new locker.

   If any step fails, the whole buy reverts. Leftover tokens are burned to `0xdead`, and quote dust is recorded in
   `quoteDust`.
4. **Escape hatch.** For a curve that completed but did not graduate (non-atomic factories), anyone can call
   `reopen()` after `graduationGrace` (24 h on mainnet).
5. **Fees.** Curve fees are paid with `withdrawFees`/`claimFees`, which never revert because a recipient fails.
   Pool fees are paid with locker `collectFees`, then splitter `claim`. All of these are permissionless and pay
   only to the two recipients fixed at launch.

## 3. Roles and trust

- **Treasury** (immutable, set at factory deployment). It receives launch fees and the protocol share of fees. It can
  call `configureUsdPricing` **once** and `approveQuote` (add-only, immutable templates). It has no other powers:
  no owner, pause, upgrade, rescue, fee change or withdrawal of users' funds.
  - **Deployment consequence:** the treasury cannot be changed later, so the mainnet treasury must be the multisig
    from the start (checklist C3). It must also be able to receive the native coin (a Safe can), or every native
    launch reverts.
- **Creator:** receives the creator fee share. They have no special powers after launch.
- **External trust:**
  - the configured feed: positive answer, complete round, not in the future, at most `maxPriceAge` old;
  - the DEX position manager, factory and WETH: read and checked against each other in the adapter constructor.

## 4. Invariants we test and want reviewed

- The curve is always exactly backed: the contract's quote balance equals `realReserve + protocolFees +
  creatorFees + liquidityBonus` (plus `quoteDust` after graduation). Tokens are conserved across curve, holders and
  pool.
- Fees are exact, and the split rounds toward the creator by at most 1 wei per trade.
- The price moves the right way, and a buy-then-sell round trip never profits.
- A full bank run (every holder sells everything) succeeds.
- An oversized final buy fills exactly the remaining supply and pays only what it used.
- A failed migration reverts the completing buy and leaves no frozen curve.
- Fee steps succeed with nothing owed, so batching them is safe.
- The pool position can never leave the locker.

Evidence: `tests/economic-invariants.test.mjs` (seeded multi-trader fuzzing, ETH and USDC curves),
`atomic-graduation`, `graduation-safety`, `dex-migration`, `pancake-compat`, `usd-pricing`, `curve-fee-recipient`,
`one-confirmation` and `graduation-griefing`. The full suite has 391 tests:
`PATH=<solana bin>:$PATH npm test`.

`npm run test:chain-fork -- <network>` runs the whole lifecycle (13 checks) on a fork of a real testnet DEX and
feed. It passed on Ethereum Sepolia (Uniswap v3) and BNB Testnet (PancakeSwap v3), and on forks of the four intended
mainnets with mainnet terms (14 checks each): Base, Ethereum and Robinhood Chain (Uniswap v3) and BNB Chain
(PancakeSwap v3), each against its real Chainlink feed. Base Sepolia was exercised live
instead (section 6).

## 5. Findings from our own review (before the audit)

Static analysis: Slither 0.11 with solc 0.8.24 (same settings as the build), on the in-scope files. It reported
82 results: 17 High, 23 Medium and 42 Low, all patterns. Our triage is below. We expect auditors to confirm or
overturn it.

| Slither result | Our assessment |
|---|---|
| `arbitrary-send-eth` (×4): factory fee/refund, curve `_pay`/`_trySend`, splitter `claim` | False positive. Recipients are the immutable treasury and creator, `msg.sender` (refunds, sell proceeds), or the buyer of a partially filled buy. |
| `reentrancy-eth` / `reentrancy-balance` / `reentrancy-no-eth` (×17) | Guarded. The curve uses `nonReentrant` on every state-changing entry; the factory, adapter, locker and splitter use their own `entered` flags. Sells follow checks-effects-interactions. See F-2 for an ordering note. |
| `incorrect-equality` (×9) | Intended. Exact balance-difference checks refuse fee-on-transfer and rebasing assets; the rest are zero checks and the cap check. |
| `divide-before-multiply` (×2): locker ticks | Intended: rounding the full-range ticks to the pool's spacing. |
| `unused-return` (×7) | Intended: partial tuple reads (`slot0`, `positions`, `mint`, `latestRoundData`, `initialBuy`). |
| `uninitialized-local` (`timestamp` in `_chargeLaunchFee`) | Harmless (F-3). |
| Low: `timestamp` (×15), `reentrancy-benign`/`-events` (×27) | Timestamps are only used for the 60 s fee window, oracle staleness and grace periods. |

Our findings:

- **F-1 (Medium, design): graduation can be blocked by a narrow liquidity band in a pre-created pool.**
  - Anyone can create the token's pool before graduation. A thin mispriced pool is corrected (chain-fork check 11),
    and so is deep full-range liquidity: 339M tokens at 1/10,000 of the price did not block it.
  - But ~10M tokens (1.3% of the sale) placed in a narrow band at 80–97% of the graduation price absorb the
    adapter's 2% repricing budget. The completing buy then reverts with `pool price mismatch` while the curve keeps
    trading.
  - Nothing is lost, and the griefer risks nothing either: the revert undoes the swap.
  - Anyone can clear it by buying the band on the pool, at or below the curve's price, after which completion
    graduates (`tests/graduation-griefing.test.mjs`).
  - Options:
    - (a) keep the design and add an "unblock" step to the app's final buy: detect the band, buy it, then complete;
    - (b) widen the budget when the corrective swap trades only at prices no worse than the target, since the price
      limit already guarantees that;
    - (c) on failure, complete without graduating and rely on retry plus `reopen`.

  Options (b) and (c) change the contracts and need a redeploy on testnets. **Decision (23 Oct, Malik): (a).** The app
  now dry-runs a completing buy. If it fails with `pool price mismatch` and the token is cheaper in the pool than at
  graduation, the same action first buys the pool up to the exact graduation price (a v3 price limit, so never above
  it; unused native coin is refunded), then completes (`apps/web/graduation-unblock.mjs`, tests in
  `graduation-griefing.test.mjs`). A pool priced above the curve clears itself, because holders profit by selling
  into it; the app explains this instead of sending. The contracts are unchanged. Auditors may still recommend (b).
- **F-2 (Low): order of calls in launch.** `_chargeLaunchFee` pays the treasury and refunds `msg.sender` before the
  token and curve are created. It is guarded by `entered`, and no state another call could use is pending. Moving
  the refund to the end would make the order conventional.
- **F-3 (Informational):** `_chargeLaunchFee` re-checks `usdFeed != 0` after already reverting when it is zero.
- **F-4 (Low):** `migrate` is permissionless and refunds `min(balance, supplied)` to its caller. Assets sent to the
  adapter by mistake could be taken by the next caller. In normal operation the adapter holds nothing between
  calls.
- **F-6 (Design, resolved 23 Oct): token details on-chain at launch.** The mainnet factory now requires them.
  `ElpidaAtomicDexFactory.requiresMetadata()` returns true; `launch` and `launchPaired` revert with
  `metadata required`, and `launchWithPayment` reverts on an empty or non-`ipfs://` URI. The Solana program already
  required a URI. Older factories are unchanged (`launch-guarantees.test.mjs`).
- **F-8 (Low, older factories only): a reopened curve's completion quote reverts.** `reopen()` clears `complete` but a
  completed curve has `sold == SALE_CAP`, so `_completionQuote` computes `remaining = 0`, `net = 0` and underflows on
  `net - 1` (panic 0x11). `completionQuote()`, `remainingAtBaseFee()` and every buy revert until a holder sells; selling
  works. Seen live on Base Sepolia (AIZEN, reopened 23 Oct), where it also stopped our indexer, which is now guarded
  (`tests/reopened-curve.test.mjs`). Unreachable with `ElpidaAtomicDexFactory`: the completing buy graduates in the same
  transaction or reverts, so no curve is ever complete without a pool. Fix if kept: return 0 when `remaining == 0`.
- **F-7 (Low, L2 deployments): no sequencer-uptime check.** On rollups (Base, Robinhood Chain), Chainlink recommends
  checking the L2 sequencer uptime feed before trusting a price. `ElpidaUsdPricing` checks staleness (`maxPriceAge`)
  but not the sequencer. Impact is limited: the price sets only the $10 launch fee and the starting valuation of new
  curves, never trade prices or payouts. Options: accept (staleness bounds it), or add an optional uptime feed with a
  grace period. Noted 23 Oct while adding the Robinhood mainnet fork check.
- **F-5 (Informational, operations):** the treasury is immutable and must accept the native coin (see section 3).

## 6. Deployments for reference (testnets)

| Network | Factory | Block |
|---|---|---|
| Base Sepolia (Uniswap v3) | `0x98a0E75dbBe9EdA5D228319C72D496b814bA7145` | 48289973 |
| Ethereum Sepolia (Uniswap v3) | `0xD64119914DDA7b206d01Fb2B334A630Ca94fD6d2` | 11972040 |
| BNB Testnet (PancakeSwap v3; requires token details) | `0x8c48b67E3D541955ec5DCf99629c4270aC6CfBbE` | 138485798 |

All three have been exercised live end to end: launch, completion with graduation in the same transaction, DEX
trades and claims. The transaction hashes are in `MAINNET_CHECKLIST_2026-10-19.md` (A2–A7) and
`MULTICHAIN_TESTNETS.md`.

## 7. Reproducing the static analysis

```
pip install slither-analyzer
# solc 0.8.24 static binary from the ethereum/solidity GitHub release
slither contracts/evm/src/ElpidaAtomicDexFactory.sol --solc <solc-0.8.24> \
  --solc-remaps "@openzeppelin/=node_modules/@openzeppelin/" \
  --solc-args "--optimize --optimize-runs 1 --evm-version shanghai" --filter-paths node_modules --exclude-informational
```

The scope was reduced on 23 Oct by moving `IERC20Minimal` into `ElpidaInterfaces.sol`, so the mainnet contracts no
longer import the older curve and pool prototypes. With every embedded metadata hash stripped, the executable
bytecode of all 36 compiled contracts is byte-for-byte identical before and after.

The report this command produced is committed at `docs/security/slither-2026-10-25.json` (slither 0.11.6, solc
0.8.24): 82 results, 17 High, 23 Medium and 42 Low, each with its detector, file and line. `tests/claims.test.mjs`
fails if the committed counts stop matching this section, so a re-run that changes the result has to update both.
