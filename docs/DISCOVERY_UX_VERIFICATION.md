# Discovery and launch UX verification

The header chain selector is now the single selection control. It uses official local assets, named options, selected states, arrow/Home/End navigation, Escape dismissal and focus return. Rewards and Portfolio are wallet-gated both in navigation and on direct routes. Chain selection does not request access to a wallet.

Explore exposes All (verified USD market cap descending), Migrating (complete but not graduated), Graduated and New (creation time descending). Missing/stale USD prices sort after priced tokens. Ties use chain and address. Cards show chain and pair icons, price, full-supply market cap, real curve reserve or DEX quote balance, age and a genuine indexed execution-price comparison over 24h. A sufficiently close prior-day execution and a recent execution are required; no launch baseline or synthetic percentages are generated. DEX quote balance is not a two-sided TVL estimate.

The shared display price keeper prefers fresh Pyth readings over EVM reference oracles. The authenticated server key stays server-side. Confidence, identity, exponent, publish timestamp and freshness are checked. Timestamped fallback sources are labelled and source details are accessible on touch screens. EVM and Solana transaction fee enforcement is unchanged. No browser price authorizes payment.

Launch chain changes preserve metadata and reward drafts, clear incompatible pair/payment selections and return to pair validation. Public reward limitations remain enforced; a saved simulation strategy must be revised explicitly to an available public strategy. Exact token and USDC approvals, launch gas estimation, native fee caps/refunds, quotes, pending states and retry-preserved inputs are retained. No wallet transaction was signed during these UI checks.

Capabilities evaluated:
- Privy connect/create and authentication: https://docs.privy.io/wallets/connectors/usage/connect-or-create and https://docs.privy.io/authentication
- Dynamic embedded wallet security: https://docs.dynamic.xyz/wallets/embedded-wallets/architecture-security
- Coinbase Smart Wallet/paymaster: requires configured bundler/paymaster policies and sponsorship budget.

Embedded wallets, passkey sign-in, ERC-4337/7702 batching and sponsored gas are not configured in this project. They have no misleading working buttons. Wallet-managed gas options remain available in the wallet; the app does not fabricate supported Slow/Average/Fast estimates. Pre-sign simulation currently includes existing quote and launch gas checks, not an independent full asset-delta simulator.

Icon provenance (unaltered, chain/asset identification only; no endorsement implied):
- Ethereum: https://ethereum.org/assets (official ethereum-org-website repository, eth-diamond-purple.png)
- Solana: https://solana.com/branding (solanaLogoMark.svg)
- BNB Chain: https://www.bnbchain.org/en/brand-guidelines (BNB Chain_Symbol_Yellow.svg). Brand guidelines request project approval; confirm permission before commercial brand use.
- Base: https://github.com/base/brand-kit (Base_square_blue.svg)
- Robinhood Chain: https://docs.robinhood.com/chain/brand-guidelines/ (chain feather-symbol.png)

Focused automated checks cover USD ordering, stale pricing, lifecycle filters, actual 24h history requirements, exact curve limits and existing API and transaction safeguards. Browser verification covers public navigation, icons, keyboard selection, launch draft preservation and responsive layouts. Contract economics and treasury allocations are unchanged.
