# Automatic buyback after graduation (partner tokens)

**Status:** live on elpida.fun since 29 October 2026, on testnets only (never mainnet), with the keeper wallets
`0x2C60…933C` (EVM) and `x3Kv…jWVq` (Solana devnet). It stays off on any deployment without a keeper key.

## Why

A partner token (Partner 10% or Elite 20%) buys back and burns its share of trading fees in two places:

- **On the bonding curve: already automatic.** Every buy and sell burns its share in the same transaction.
- **After graduation: it waited for a click until now.** The share sits in the pool's trading fees until someone
  harvests them. Before this change, that only happened when a creator pressed "Claim fees" on Rewards.

The keeper does the harvest and the buyback on a schedule, so partner tokens keep burning without anyone clicking.
As a side effect, creators also receive their fee share without claiming: on Solana the harvest pays them directly,
and on EVM it credits their share in the fee splitter.

## What it does

The keeper checks every graduated partner token about every 10 minutes (`ELPIDA_BUYBACK_EVERY_MINUTES`).

**EVM** (Base Sepolia, Ethereum Sepolia, BNB Testnet, Robinhood Testnet):

1. `locker.collectFees()`. This credits the creator and the treasury and queues the quote-side burn share. The
   token-side share is burned at once.
2. `splitter.buyback()` when anything is queued. The contract spends at most 0.5% of the pool's quote balance per
   call, once per block, and only while the pool price is within about 1.5% of its 10-minute average (review finding
   E-1, sandwiching). When it refuses ("price away from average", "price history too short"), the keeper waits for
   its next run; a larger backlog drains over later runs.

**Solana** (devnet only): one transaction.

- On **Raydium**, `harvest_raydium_fees` followed by `raydium_buyback`. The buyback is capped at 0.5% of the pool's
  SOL depth and runs at most once a minute (review finding S-1). The keeper dry-runs it first; when it is too soon, it
  sends the harvest alone and the buyback waits. This is the same pair of instructions verified live with MASHLE (`DESIGN_PARTNER_TIERS.md` section 7).
- On **PumpSwap**, `harvest_lp_fees` only. Its token-side share burns; PumpSwap has no buyback, so since the
  1 November build the quote side of the share goes to the treasury instead of waiting (review finding S-2).

The keeper only calls permissionless instructions. Payouts can only go to the recipients fixed at launch, so the
keeper's wallet cannot redirect anything; it just pays network fees.

## Safety limits

| Limit | Default | Setting |
|---|---|---|
| Testnets only | EVM chain IDs 84532, 11155111, 97, 46630; Solana devnet. Mainnet is refused | (code) |
| Maximum cost per EVM transaction | 0.0005 native | `ELPIDA_BUYBACK_MAX_COST_ETH` |
| EVM gas per rolling 24 h, per chain | 0.005 native | `ELPIDA_BUYBACK_DAILY_BUDGET_ETH` |
| Solana fees per rolling 24 h | 0.02 SOL | `ELPIDA_BUYBACK_SOLANA_DAILY_BUDGET_SOL` |
| Smallest Solana harvest | 0.001 SOL of fees | `ELPIDA_BUYBACK_SOLANA_MIN_HARVEST_SOL` |
| Never spend more gas than the fees are worth | Native-quote EVM pools | (code) |

- A first Solana harvest may create up to five token accounts. Their rent is paid once and counts toward the day.
- Every run is journaled in `buyback-keeper.sqlite` on the persistent volume.
- A lease stops two processes running the same journal. On Railway the keeper refuses to start without a volume.

## Setup (Malik)

1. **Create the two keeper wallets** on your computer:

   ```
   node scripts/buyback-keeper-keys.mjs
   ```

   - It writes `local-data/buyback-keeper-evm.key` and `local-data/buyback-keeper-solana.json`. Both files are
     git-ignored and never printed.
   - It prints only the two **public** addresses.

2. **Fund the public addresses** with small test amounts:
   - a little test ETH on Base Sepolia and Ethereum Sepolia;
   - tBNB on BNB Testnet;
   - about 0.2 SOL on devnet (this covers first-use account rent).

3. **In Railway**, add two variables:
   - `ELPIDA_BUYBACK_EVM_KEY`: the contents of the `.key` file;
   - `ELPIDA_BUYBACK_SOLANA_KEY`: the contents of the `.json` file.

   Paste them yourself; never share them in chat. Then redeploy.

4. **Check `https://elpida.fun/api/buyback/status`.** Each chain should show the keeper's public address and
   `watching`. After the next run it shows the last transaction, and any error code.

## Not covered

- **Mainnet.** It needs its own wallets, budgets and explicit approval (mainnet checklist).
- **Automatic payout of the creator's EVM share.** Collecting credits it in the splitter, and the creator's existing
  "Claim fees" pays it out. Calling `claim` for every token on every run would add gas for little benefit.

## Verified live: Solana devnet, 29 October 2026

The keeper was switched on in Railway, its Solana wallet was funded with 0.5 devnet SOL, and Malik made three MASHLE
buys on the Raydium pool without touching Rewards. On its next round the keeper harvested and bought back by itself:
transaction `4NNU5ntY…Tj4tcJf3`, 22:33:28 Lagos time. Claude read it back from devnet:

- **Instructions:** HarvestRaydiumFees, Withdraw, RaydiumBuyback and SwapBaseInput, in one transaction.
- **Harvest:** 12,880,355 lamports and 121,550.000262 MASHLE of LP fees.
- **Paid out:**
  - the creator, 0.006440178 SOL and 60,775 MASHLE (50%);
  - the treasury, 0.003864106 SOL and 36,465 MASHLE (30%).
- **Burned at once:** 24,310.000052 MASHLE, the 20% token side.
- **Bought back:** the 20% SOL side, 2,576,071 lamports (exactly 20% of the harvest), bought 24,054.848294 MASHLE
  through the pool. All of it was burned, and the queue is empty.
- **The 1% cap held:** 0.0026 SOL spent against a cap of 0.051 SOL (1% of the pool's 5.10 SOL).
- **Keeper cost:** 0.00149344 SOL, of which 0.00148844 was one-time account rent.
- **Indexed `burned`:** 833,625.848259 before and 881,990.696605 after, exactly the two burns above.

The first round after the redeploy found the Solana index still loading (`config_unavailable`) and waited a full
interval. Errors like that now retry on the next tick, about a minute later.
