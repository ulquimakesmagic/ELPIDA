# USDC payment paths

Launch fees remain independently selectable: oracle-priced native currency or 10 units of verified USDC. USDC can deviate from one dollar; native gas is separate.

USDC trading pairs keep the curve, buys, sells, creator fees and graduated locked pool denominated in USDC. New EVM DEX setup and pricing activation automatically include the approved six-decimal USDC asset (adapter deployment, then quote approval). Existing deployments offer the owner “Finish USDC setup” directly on the launch card; this requires wallet confirmations once per deployment and then applies to every creator. Network and funds offers the same recovery action. The starting valuation is 5,000 USDC, with the existing supply and curve formula. Existing launches are unchanged. Wallet connection alone never triggers setup transactions.

Native-paired launches and buys also have an explicit USDC funding step. It quotes a direct USDC/wrapped-native Uniswap v3 pool, compares available fee tiers, approves a bounded amount and executes exact-output conversion plus unwrapping in one router transaction. The launch or buy remains a separate transaction. Cancelling that later action leaves the native funds in the wallet. This is not automatic settlement or sponsored gas.

The configured router must match the configured factory and wrapped asset. Quotes expire after 60 seconds; the submitted router call has a deadline and an on-chain maximum USDC spend. Missing or unfunded routes fail closed. This version supports only configured EVM Uniswap routes; it does not provide Solana conversion or cross-chain bridging.

Solana deployment preparation includes the canonical configured USDC mint as an optional direct pair. It requires a deployed pair configuration; this change does not deploy or approve it automatically. USDC mint identity, SPL owner, initialization and six decimals are checked before configuration.

Local simulation includes mock USDC and a dedicated mock-funded routing pool. These assets have no value. Public deployments must have approved pair configurations and actual funded swap routes; the local simulation is not evidence of public-route availability.

Validation covers combined fee/first-purchase allowances, direct buys/sells, six-decimal creator reward displays, conversion budget rejection without spending, conversion and native purchase, and USDC graduation with permanent liquidity locking followed by a DEX trade. Existing native graduation, journal replay, reward strategies, API protection and wallet discovery regressions are checked separately. Solana validator tests require an installed validator.
