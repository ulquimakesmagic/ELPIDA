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
