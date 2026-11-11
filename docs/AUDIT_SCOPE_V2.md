# Audit brief: ELPIDA V2 (11 November 2026)

ELPIDA V2 is the launchpad version that goes to mainnet. **Mainnet waits for this audit and its fixes** (Malik,
11 November 2026). `AUDIT_SCOPE.md` describes the earlier Model 10 contracts. Those stay live on testnets for tokens
already launched, but they are not what goes to mainnet.

The code to audit is the `main` commit at engagement time (record its hash). It was written from `7946489`, plus the
open setup-fix PRs. Freeze `main` for the audit once the testnet proof below is complete.

## 1. Scope

### EVM: 10 files, about 1,350 source lines

Solidity 0.8.24, Uniswap v4 hook. Counts are non-comment lines.

| File | Lines | Role |
|---|---|---|
| `contracts/evm/v2/ElpidaV2Hook.sol` | 321 | Owns every pool's liquidity from the first trade, forever. It charges the token's own fee (1.25% default, up to 4%) plus the anti-snipe fee, and accrues the five-way split (30% creator, 30% trader airdrop, 10% flywheel, 10% holder rewards, 20% treasury). It pays each share to its vault. |
| `contracts/evm/v2/ElpidaV2Factory.sol` | 123 | Launch with the $10 fee (native coin at the oracle price, or USDC). Starts the curve at $20k and graduates at $100k. Caps the dev first buy at 3%. Approves pair assets: fixed amounts, or stocks priced from a feed at launch (`approvePricedQuote`, `quoteVirtual`), where a stale or invalid feed blocks launches. |
| `contracts/evm/v2/ElpidaV2Token.sol` | 50 | Fixed-supply ERC-20 with no owner and no mint. |
| `contracts/evm/v2/ElpidaV2Distributor.sol` | 164 | Merkle rounds per round and asset, for the trader airdrop and holder rewards. Operator posts the root. Claims have a 12-round window, then expire back to the pool. |
| `contracts/evm/v2/ElpidaV2UsdcDistributor.sol` | 175 | Version 3. Receives a finished round from its parent distributor and converts it to the payout stablecoin through a Uniswap v3-style router (SwapRouter02, or a deadline-style router such as PancakeSwap). The minimum output is set by the operator. Posts and pays rounds in that stablecoin only. |
| `contracts/evm/v2/ElpidaV2FlywheelVault.sol` | 78 | Buys back and burns the top-10 tokens with its 10% share. |
| `contracts/evm/v2/ElpidaV2CreatorRewards.sol` | 156 | Version 2. Creator strategies: share with holders, paired-asset rewards, or buyback. The threshold and minimum holding are immutable, recorded in units and in USD (`thresholdUsdE6`, `minimumHoldingUsdE6`). |
| `contracts/evm/v2/ElpidaV2IdentityAllocation.sol` | 80 | Creator fee split across a wallet, a verified X account and a website. |
| `contracts/evm/v4/ElpidaV4Router.sol` | 83 | The swap router the site uses for V2 pools. |
| `ElpidaCreate2Deployer` (in `contracts/evm/v4/ElpidaV4Factory.sol`) | small | Places the hook at an address with the right v4 permission bits. |

Out of scope:
- Uniswap v4 core and periphery, Uniswap v3 / PancakeSwap v3 routers, Chainlink feeds, OpenZeppelin.
- Everything in `contracts/evm/src` (Model 9 and Model 10) and `contracts/evm/v4/ElpidaV4Hook.sol` (Model 11, retired
  for new launches).
- `contracts/evm/testnet/*`. These are labelled test assets (test stocks, test dollars, relay feed). Each refuses
  mainnet chain ids, and auditors should confirm none is deployable or referenced on mainnet.

### Solana: one Anchor program, separate line item

`contracts/solana/programs/elpida_launchpad/src/lib.rs` has 3,425 lines and 82 instructions in total. The V2 part to
review:

- **Launch and fees:** `add_v2_config`, `launch_v2`, `withdraw_v2_fees`, and the fee booking (`v2_book_fee`,
  `v2_apply_buy`, `v2_fee_bps`).
- **Distributors:** `init_v2_distributor`, `post_v2_root`, `claim_v2`, `expire_v2`, `sweep_v2_sol`.
- **New, not yet reviewed by anyone:** `v2_convert_usdc`. The operator swaps SOL that no round has promised into
  USDC through Raydium CPMM. The USDC must be `pricing.usdc_mint`.
- **Flywheel:** `v2_flywheel_curve`, `v2_flywheel_raydium`.
- **Graduation and LP fees:** graduation to Raydium CPMM and the LP-fee harvest that feeds the five-way split
  (`migrate_to_raydium`, `harvest_raydium_fees`).
- **Test-only instructions** must refuse to run off test clusters (`test_networks_only`).

### Off-chain components that hold power (review the trust, not the code line by line)

- **Keeper** (`apps/api/v2-keeper.mjs`, `apps/api/v2-keeper-solana.mjs`). It is the distributor operator. It
  builds the round lists (airdrop formula, holder snapshots, minimum holding in USD), posts the roots, converts to
  the stablecoin, and pays its own gas from each native sweep (at most 10%).
  - EVM conversions require at least 97% of a fresh QuoterV2 quote.
  - Solana conversions require at least 95% of the SOL/USD price, and use at most 2% of the pool's SOL per
    conversion.
  - A compromised keeper could post a wrong root. What bounds it on chain?
- **Price inputs:** Chainlink and relay feeds on EVM, Pyth on Solana. Check the staleness and validity rules in the
  factory, the hook and `v2_convert_usdc`.

## 2. Roles and trust

| Role | Powers | Mainnet holder |
|---|---|---|
| Treasury | Approves pair assets (add-only), receives the 20% share and launch fees | Safe multisig, from deployment (immutable) |
| Distributor operator | Posts roots, converts to stablecoin, sweeps | Keeper wallet, one per chain, funded separately |
| Solana upgrade authority | Upgrades the program | Squads multisig (rehearsed on devnet, 24 Oct) |
| Creator | Receives the 30% share through its strategy vault; no power after launch | — |

## 3. Invariants to review

- Fee conservation: the five shares sum exactly to the fee on every trade, and anti-snipe surplus goes to the locked
  pool.
- Liquidity can never leave the hook (EVM) or the program's PDA (Solana).
- Vault accounting: each vault's balance equals what it accrued minus what it paid out.
- Payout soundness: a round pays at most what it posted, and every leaf is claimable once. Expiry returns only what
  was unclaimed. A one-recipient sweep into the USDC distributor cannot be claimed twice.
- Conversion bounds: `minOut` is enforced, only unpromised balances can be converted, and a wrong stablecoin or pool
  is refused.
- Launch pricing: a stale or zero feed blocks a priced launch and never prices it at a wrong value.
- Creator strategies: immutable after launch; thresholds are enforced in units; the USD minimum is applied
  off-chain by the keeper (state whether that is acceptable).
- First buy at most 3%; fee at most 4%.

Evidence: the full suite (`PATH=/root/sol/solana-release/bin:$PATH npm test`, about 860 tests), including
`v2-hook`, `v2-browser`, `v2-keeper`, `v2-usdc-rewards`, `v2-payout-stables`, `v2-creator-rewards`,
`v2-stock-feeds`, `v2-rewards-indexer` and `solana.test.mjs` (V2 S1–S5).

## 4. Before the audit starts (the testnet proof)

On each chain (Base Sepolia, Ethereum Sepolia, BNB testnet, Robinhood testnet, Solana devnet), record transaction
hashes for:

1. a launch with a first buy;
2. buys and sells;
3. a graduation at $100k;
4. one paid trader airdrop round and one paid holder round, in the stablecoin;
5. a flywheel buyback and burn;
6. each creator strategy;
7. a stock-paired launch where stocks exist.

## 5. After the audit

1. Fix the findings, redeploy on testnets and repeat section 4.
2. Then go to mainnet, one chain first.
