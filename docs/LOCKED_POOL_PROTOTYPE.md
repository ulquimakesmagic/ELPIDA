# Locked pool prototype

Historical direct-pool launch model, superseded 11 October 2026. The default app starts on a virtual curve without a deposit; see [current design](VIRTUAL_CURVE_AND_PAIRS.md). The locked custom test pool is used at graduation.

The default localhost and new EVM testnet deployments now use `ElpidaLockedFactory` and `ElpidaLockedPool`. Old `ElpidaFactory`/`ElpidaCurve` source and existing deployments are preserved as legacy references.

This is a custom constant-product test pool with real quote and token reserves, not an integration with a third-party DEX. The quote seed and full token supply initialize the pool; an atomic first buy follows. A creator approves 10 test USDC plus their seed plus first buy. The seed is permanently deposited and cannot be withdrawn as liquidity principal. There are no LP tokens, ownership/admin functions, unlock date or migration.

For buy input Q, fee = floor(Q × 125 / 10000), and output = floor(tokenReserve × (Q − fee) / (quoteReserve + Q − fee)). For token sell input T, gross quote output = floor(quoteReserve × T / (tokenReserve + T)), then deduct the 1.25% quote fee. Fees accrue outside reserves and split 50/50. Rounding remainder in the fee split goes to the creator. Fee claims are permissionless, destination constrained and cannot remove reserves.

Direct asset donations are not added to accounted reserves or fees and cannot be rescued. Only fixed-supply Elpida tokens and reviewed non-rebasing, non-transfer-tax quote assets are intended. The factory and pool reject incoming quote amounts that differ from expected funding. This code still needs adversarial tests, fuzzing and independent security review before real-asset deployment.

The UI defaults to 100 test USDC liquidity and 25 first buy (135 total with creation fee). Local demo launches seed 1,000 each. The deposit determines the initial reserve ratio and price; these are test defaults, not calibrated production economics.

Testnet browser deployments use a new `elpida:locked-pool-v2:deployment:<chainId>` storage key. Legacy deployment records remain untouched. Shared deployments are accepted only with `model: 'locked-pool-v2'`; their factory must report model version 2. Users need a new locked factory deployment before testing the new launch model.

Run `npm run dev` and open http://localhost:3000. Choose local demo accounts or an EVM testnet. For public tests, connect your own wallet, obtain native faucet gas and the configured test quote token, deploy the new launchpad, then enter the liquidity deposit and first buy. All amounts are test assets. Public-chain transactions have not been executed by this task.

`npm test` includes the legacy curve checks and the new locked-pool contract/API tests. They verify atomic funding and rollback, rejection of zero liquidity, initialization permissions, reserve conservation, slippage, fixed fee destinations and failure of reserve-removal selectors. Production rollout should replace this prototype with the chosen DEX and dedicated locker integration; see `LAUNCHPAD_RESEARCH.md`.
