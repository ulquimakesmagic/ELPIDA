# ELPIDA V2.0 — keepers (roadmap step 6)

9 November 2026, branch `v2-keepers`. Test networks only. Every job runs from indexed chain data with the plans in
`packages/core/v2-keeper-plan.mjs`, so anyone can recompute every payout list and flywheel order.

## Decisions (Malik, 9 November)

- **Holder rewards.** Each token's 10% builds up. Once it reaches a set amount, it is paid to that token's holders:
  - native pairs in the native coin;
  - stock pairs in the stock (the fee already arrives in it);
  - USDC pairs converted to the native coin first.
  
  The threshold is $25 on mainnet and $0.25 on test networks, until Malik sets it.
- **Assumed, not yet confirmed by Malik:**
  - Holders share a payout by the same blend as the airdrop (20% equal, 40% square root, 40% pro-rata), over their
    time-weighted balance in the week, with the same 1% cap. Holdings shorter than a day in total don't count.
  - Linked wallets: wallets that received a token directly from its creator, and wallets first funded by the same
    **personal** wallet. Finding the funder needs a block-explorer key (`ELPIDA_EXPLORER_API_KEY`, Etherscan's
    multichain API). Without one, only creator transfers link wallets.
  - Funders that never link anyone (Malik, 9 November: exchange-funded users must not be joined):
    - contracts: bridges, routers, exchange batchers;
    - wallets with 5,000 or more transactions: exchange hot wallets, faucets, market makers;
    - addresses in `ELPIDA_FUNDER_IGNORE`;
    - any funder of more than 200 of the period's wallets.
    
    A funder's status is re-checked weekly.

## Contract change

`ElpidaV2Distributor` has three more constructor arguments: `convertible` (USDC), `swapRouter` (Uniswap v3
SwapRouter02) and `wrappedNative`. They are all zero to turn conversion off. Two functions use them:
- `convertToNative(amountIn, minOut, poolFee)`, operator only. It converts **unpromised** USDC into the native coin,
  and the proceeds stay in the distributor.
- `withdraw` of the wrapped coin, checked against the balance.

Only the holder distributor turns conversion on, and only where the network's Uniswap v3 router is SwapRouter02.
`ElpidaV2FlywheelVault.setRouter` may now also be called once by its deployer, because the operator is usually the
server keeper. On the operator panel, the distributors and the flywheel are deployed with the server keeper as
operator when it is configured (`/api/config` → `v2Keeper.address`), and with the connected wallet otherwise.

## Jobs (`apps/api/v2-keeper.mjs`)

| Job | When | What |
|---|---|---|
| Fees | Daily (and before each round) | `withdrawFees` for every V2 token with unpaid vault shares |
| Flywheel | Daily | The top 10 tokens by net buying from independent wallets over 7 days. A token needs at least 2 such buyers on test networks and 10 on mainnet. Each cycle spends up to 10% of the asset's balance, spread by net buying. Each order is checked against the pool's one-hour time-weighted price: a pool more than 10% above it is skipped. Otherwise the order is sent at the live quote less 1%. |
| Holder rewards | Each weekly round | Tokens whose holder share reached the threshold. USDC is converted first (at least 97% of the oracle value), then one round per payout asset is published, posted and pushed. |
| Trader airdrop | Each monthly round | Trades in the month, less trades on a token by wallets linked to its creator. Qualifying: $20 of volume, 2 active days, a first trade at least 7 days before the round ends. One round per pool asset, with the 20/40/40 blend and the 1% cap. Payouts under $1 carry to the next month. |

- **Published lists:** each payout list is published at
  `/api/public/v2-rewards/manifest/<chainId>/<distributor>/<round>/<asset>`, and that address is stored on chain with
  the root.
- **Keeper status:** it is in `/api/public/v2-rewards` (`keeper`).
- **Re-runs:** running a job again does nothing new.

## Configuration (Malik; Railway variables)

- `ELPIDA_V2_KEEPER_KEY`: a dedicated test-network keeper key. **It is never printed.** Fund its address with test gas
  on each network. Deploy V2 after setting it, so the reward contracts take the keeper as operator.
- `ELPIDA_EXPLORER_API_KEY` (optional): an Etherscan API key, for funder links.
- `ELPIDA_PUBLIC_URL` (optional): the base URL of the published lists (default https://elpida.fun).
- `ELPIDA_FUNDER_IGNORE` (optional): comma-separated exchange or service wallets that must never link the wallets they fund.

## Tests

`tests/v2-keeper.test.mjs`:
- Plans: time-weighted balances; airdrop qualification, linking and carry-forward; flywheel ranking without creator
  wallets or thin tokens, within 10% per cycle, with the price guard.
- End to end on the real contracts with a local Uniswap v3 USDC/WETH pool:
  - daily fees into the vaults;
  - flywheel burns of an ETH-paired token and a USDC-paired token;
  - holder rewards with USDC converted to ETH: traders who hold are paid; the creator, a creator-linked wallet and
    the pool are not; every payout is pushed and every proof checks;
  - the monthly airdrop in ETH and USDC: only the two independent traders qualify, all payouts are pushed;
  - re-running changes nothing.

## Creator holder strategies (Malik, 10 November)

A V2 launch on a public EVM test network can send the creator's 30% to a holder strategy instead of wallets. The launch
deploys `contracts/evm/v2/ElpidaV2CreatorRewards.sol` (NOT AUDITED) with this keeper as its operator and names it as the
token's creator vault. Its strategy and settings are fixed in the contract:

| Strategy | What the keeper does once the vault holds the threshold |
|---|---|
| Share fees with holders | pays the fees to holders |
| Buy a reward token | swaps the fees into the reward asset on the network's Uniswap v3 pool (fee tier fixed at launch from the deepest funded pool), then pays holders in it |
| Buy back and vest | buys the token through the V2 router (the token's own fee applies); holders receive it linearly over the vesting period, pushed daily |

- **Job `creator` (hourly).** It finds V2 tokens whose creator vault is such a contract with this keeper as operator, binds it to its token (anyone may; checked against the hook), and collects the creator share from the hook. When the vault holds at least the threshold, it swaps (with a 3% bound on the expected output), then posts a Merkle round and pushes every payout. The list is published at `/api/public/v2-rewards/manifest/<chain>/<vault>/<round>/<asset>`.
- **Who gets paid.** Holders are paid by their balance at that moment, at least the vault's minimum holding. The pool manager, the hook, the router, the factory, the reward vaults, the vault itself and the burn addresses are excluded. A USD minimum holding is local-simulation only for now.
- **What the keeper cannot do.** It cannot move funds anywhere but to the wallets in a posted round. It cannot post more than the vault holds unpromised, or swap below the threshold or with a zero minimum output. Anyone may pay any listed wallet with its proof.
- **Where it shows.** The token page shows a **Creator rewards** card with the strategy, settings, what has gathered toward the threshold and the latest rounds. The admin keepers card shows the `creator` job.
