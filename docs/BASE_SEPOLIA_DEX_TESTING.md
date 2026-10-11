# Model 5: locked Uniswap v3 graduation

The working project is `Desktop/OneForAll/ELPIDA/elpida-v1`. Synced ChatGPT project sources remain read-only. The pre-change source is saved in `backups/base-sepolia-dex-20261011`.

## What is implemented

- Localhost runs published Uniswap v3 factory, manager, quoter and router bytecode against a simulated chain. Tokens start on Elpida's virtual curve and graduate into a real v3 pool when the curve completes.
- Pair selection is ETH or USDC; the 10 USDC creation fee is independent of pairing. ETH is wrapped into WETH for the DEX pool. Curve reserves accumulated from traders fund graduation.
- A full-range position is minted at the terminal curve price, then transferred atomically into an immutable locker. The locker has no liquidity withdrawal, NFT transfer, approval, rescue or upgrade method. Anyone may trigger fee collection; payouts always go to the fixed treasury and creator reward wallets.
- Curve trades charge 1.25%. The chosen v3 tier charges 1%. Fees earned by Elpida's locked position split 50/50. Other liquidity providers earn their own fees; the platform does not own fees from every position or unrelated pools. External router trades through this position also generate fees.
- Post-migration fees are paid in both pool assets. Native-pair fees are WETH, not USDC or automatically unwrapped ETH. The trading flow wraps ETH buys and unwraps WETH sell proceeds. No transfer-tax token or additional router surcharge is used.
- SQLite indexes pool Swap events, exact trade amounts, candles, the v3 square-root price, FDV, circulating supply estimate and locker ownership. Pool balances include uncollected fees; balances are not used as the v3 spot price. Collected claimable fees are shown separately from curve fees. Uncollected position fees are settled by Distribute accrued fees.

## Local test

1. Run `npm run dev` in the project and open http://localhost:3000.
2. Use a seeded token or launch a new token. Open View & trade, then Finish curve to buy its remaining allocation with simulated funds. Native pairs are easiest to finish without repeated USDC faucet claims.
3. Select Graduate to Uniswap v3. Confirm the token card shows permanently locked liquidity.
4. Buy and sell after graduation. Creator rewards → Distribute accrued fees collects the position and pays its two assets to the fixed recipients.

`npm run test:dex` runs four focused checks of actual v3 pools with ETH and USDC, price continuity, empty-pool pre-initialization recovery, both-direction swaps, fee distribution withdrawal rejection, failed-migration rollback, ETH sell unwrapping, index replay and reorg rollback. Existing model 3/4 contracts and their tests are preserved.

## Public Base Sepolia handoff

The browser prepares model 5 only on Base Sepolia (chain 84532). Other EVM network previews retain model 4 custom pools. Public model 5 deployment has not been submitted by the agent.

1. Open localhost in a browser with an Ethereum wallet extension. Use a test wallet and select Base Sepolia in Elpida's network menu.
2. Get Base Sepolia ETH for gas/native trades and Circle test USDC from the faucet links in the menu. Creation requires 10 USDC; a USDC curve needs approximately 16,000 net USDC to complete, while Base Sepolia uses a deliberately smaller native virtual reserve of 0.02 ETH and completes at approximately 0.06 net ETH (localhost retains the 6.4 ETH target). Fees are additional. These are test calibration values, not live USD oracle targets.
3. Connect wallet and select Deploy launchpad. Sign the migration adapter deployment, then the factory deployment. The browser saves confirmed addresses and the factory's deployment block. An already-confirmed adapter is reused after interrupted setup. The deploying wallet becomes protocol treasury.
4. Sign creation approval and launch. Complete the curve, sign graduation, trade through the DEX, and collect/distribute rewards. Inspect each transaction in the explorer.
5. For persistent public indexing, set `ELPIDA_RPC_URL`, `ELPIDA_FACTORY`, `ELPIDA_FROM_BLOCK` (from the saved deployment), and `ELPIDA_CONFIRMATIONS`, then run `npm run indexer`. The worker is read-only; no private key is required. The browser currently discovers public launches directly; connecting its listings to the persistent worker is a separate integration.

## Verified DEX configuration

Published [Uniswap Base deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments):

| Contract | Base Sepolia address |
| --- | --- |
| v3 factory | `0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24` |
| Position manager | `0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2` |
| SwapRouter02 | `0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4` |
| QuoterV2 | `0xC5290058841028F1614F3A6F0F5816cAd0df5E27` |
| WETH | `0x4200000000000000000000000000000000000006` |
| Circle test USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

On 2026-10-11, read-only RPC checks confirmed chain 84532, code at the five DEX addresses, manager.factory(), manager.WETH9(), and tick spacing 200 at fee tier 10000. Browser setup rechecks manager configuration.

## Limits to review before mainnet

These contracts are not audited. A previously initialized empty pool is repriced to the terminal price without spending migration funds. If a third party seeds an active pool at a mismatched price, migration reverts atomically; reserve funds remain in the curve, and the pool must return to an acceptable price before migration can proceed. This deliberate protection is not complete mitigation of graduation griefing.

Migration consumes at least 99.99% of each proposed asset allocation. Unused token dust is burned; unused quote dust remains in the curve and is accounted as quoteDust (WETH for native pairs). It is not offered as claimable fees. The adapter permanently binds the DEX manager and fee tier. Each other chain needs its own verified DEX adapter/configuration and tests. Solana's new curve/graduation program remains pending.

## Validation completed

Regression suite: 42 passed, zero failed, six Solana validator tests skipped. Final model 5 focused suite: four passed, zero failed (two overlap with the regression suite; 44 unique passing checks overall). Compilation succeeded; model 5 factory and adapter runtime bytecode remain below the EVM 24,576-byte limit. npm audit against the lockfile reported zero vulnerabilities. Published SwapRouter02 ABI/bytecode is vendored with package provenance, original artifact hash and license so its obsolete build dependency tree is not part of the declared dependencies.
