# Creator rewards and custom pairs

Implemented in the local EVM / Uniswap test environment. Public EVM and Solana deployments still use their existing single reward wallet. Advanced public launch configurations are blocked before any launch transaction rather than silently ignored.

## Launch controls

The launch form offers creator wallets, fee distributions to holders, another reward-token purchase, main-token buyback with linear vesting, and exclusive wallet/X/domain allocations. Wallet and identity percentages total exactly 100% of the creator share. The platform's 50% share of eligible fees remains separate. Reward policies and wallet recipients are fixed when the vault is deployed.

Creation fees remain 10 test USDC. Native and USDC trading are retained. Local custom trading pairs use team-approved same-chain quote templates with a matching migration adapter. Graduated USDC-paired Elpida tokens can be selected as quote assets. TEST-STOCK is an explicitly simulated local asset, not an issued xStock. Get one simulated stock using the test-funds button (120 local test USDC). No arbitrary token address entry is accepted by the local launch API.

Custom-pair starting reserve templates use the quote asset's price at approval, not an ongoing dollar peg. Price and market cap for these pairs are displayed in quote-token units; the indexer does not invent USD values. Graduation retains the selected quote asset and permanently locks the Uniswap v3 position.

## Holder rounds

A local worker processes treasuries after trading and every 30 seconds while localhost runs. Collection from migrated Uniswap positions reaches the same vault. Native position rewards in WETH are unwrapped for native payouts. Eligible holder balances are read at a recorded block; liquidity pools, curve inventories, known dead addresses and reward treasuries are excluded. Minimum holdings are in whole main-token units; thresholds are in the trading asset's units.

Payout weight = wallet eligible main-token balance / total eligible main-token balances. This spends the full distribution budget among eligible holders. It does not divide by the one-billion total including unsold curve inventory. Largest-remainder rounding conserves base units. Distribution transactions are capped at 64 recipients per batch; balances already paid cannot be replayed from the treasury.

Fee distribution sends the original trading asset. Another-token mode buys a compatible same-source curve token or swaps through a migrated Uniswap market, then distributes it. When the requested reward token is already the trading quote, fees are distributed directly without a redundant swap. Buyback mode buys the main token and creates linear vesting grants for eligible holders; anyone can trigger a claim, but the recipient cannot be changed.

## Verified identity escrow

Wallet allocations accrue as claimable balances at their configured address. X and domain allocations accrue in an on-chain identity bucket. The local verifier can bind each identity once to a proven payout wallet. No launch creator can claim an unverified identity's bucket.

Domain verification requires a ten-minute nonce tied to chain 31337, the exact vault, domain and payout wallet, a signed wallet message, and an exact `_elpida.DOMAIN` DNS TXT record. Wrong signatures, expired challenges and missing records are rejected. Successful challenges are consumed.

X verification uses OAuth 2.0 authorization code + S256 PKCE, random state, a callback cookie, authenticated `/2/users/me`, an exact allocated-handle match and a signed payout wallet. The authenticated X user ID is retained with the local allocation. OAuth secrets/tokens are server-only; no posting permission is requested. Configure ELPIDA_X_CLIENT_ID, ELPIDA_X_CLIENT_SECRET if applicable, and ELPIDA_X_REDIRECT_URI in the server environment. Register the exact callback `http://localhost:3000/api/rewards/x/callback`. Without credentials, X fees remain unverified and locked.

## Scope and trust

This is a prototype with a trusted local snapshot executor and identity verifier using a Hardhat demo signer, not a permissionless audited rewards protocol. The local chain, policies, challenges and OAuth sessions reset on restart. Before a public rollout, persist/recover policies from on-chain commitments, use an independently reviewed snapshot/attestation scheme, secure verifier keys, fund a keeper, add confirmed-block / holding-period protections, and validate identity recovery rules. No private user keys are collected.

Real xStocks need issuer-confirmed addresses and current wrappers, supported-chain token-standard adapters, corporate-action handling and jurisdiction eligibility. The mock's fixed price is solely for deterministic local testing. Public custom-pair quote templates need robust pricing, supply/depth eligibility and route checks; local price templates are not production oracles.

## Research and UI breakdown

Flaunch's manager approach informed the separate reward strategy, weighted recipient rows and accumulated-fee claim view: https://docs.flaunch.gg/managers and https://docs.flaunch.gg/references/api .

Pump's holder-rewards documentation informed the explicit creation-time holder choice and automatic payout history: https://github.com/pump-fun/pump-public-docs/blob/main/docs/HOLDER_REWARDS_README.md .

Pons documentation informed keeping launch, graduation and fee explanations adjacent to the selected pair: https://docs.ponsfamily.com/ . These are design references, not claims of identical implementations.

The original saved ELPIDA starter source specifies wallet/social/domain recipients, minimum-holder settings, accumulated batch distributions and optional supported-token/tokenized-stock conversion. The cached first chat did not expose its detailed assistant replies, so no additional historical terms were assumed.

Technical references: https://docs.xstocks.fi/developers/wrapped-xstocks and https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code .

Validation: reward runtime integration covers allocation/claim isolation, wrong proof rejection and nonce reuse, weighted holder payouts, simulated-stock conversion, same-chain Elpida reward purchases, linear vesting and non-replay, custom quote assets, locked Uniswap migration and post-migration fee distribution. DNS resolver and X account responses are mocked in automated tests; no real domain or X account was claimed. The browser exercise launched a local buyback/vesting token.
