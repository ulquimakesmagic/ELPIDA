# Elpida.fun — V1 engineering starter

**Status: development prototype; NOT production-ready, audited, or deployed.**

For an online test preview, see [Railway setup](docs/RAILWAY_TESTING.md). The included Dockerfile serves the UI and API together; demo-chain state resets on restart.

Independent multichain memecoin launchpad targeting Solana, Ethereum, Base, BNB Chain and Robinhood Chain. New EVM factories enforce a $10 creation fee using an execution-time on-chain USD oracle, with optional 10 USDC payment independent of the trading pair. Native curves start at approximately $5,000 FDV before the first purchase. See [USD pricing, chain readiness and verification](docs/USD_PRICING_AND_UX.md); older native-pricing guides and configuration describe legacy deployments.

The localhost preview uses model 9: an oracle-priced native virtual curve (graduation at 16× the starting FDV), then actual Uniswap v3 graduation with a permanently locked full-range position. The SQLite indexer reads both curve and DEX trades. Base Sepolia wallet deployment is prepared; it requires your signatures and test funds. Model 8 (basic, no external DEX) serves other configured EVM previews. Solana and Robinhood USD-priced launches remain blocked pending verified pricing integrations. See [DEX testing guide](docs/BASE_SEPOLIA_DEX_TESTING.md).

See [current curve/pair guide](docs/VIRTUAL_CURVE_AND_PAIRS.md), [launchpad research](docs/LAUNCHPAD_RESEARCH.md) and [wallet/funding architecture](docs/WALLET_AND_CROSS_CHAIN_ARCHITECTURE.md). The direct-pool guide is historical.

## Agreed product requirements
- $10 token creation fee to protocol, calculated from a verified native USD feed at execution; optional 10 USDC payment on configured EVM networks.
- Mandatory developer first buy of any **valid positive** amount, atomic with launch.
- Virtual curve first, then locked liquidity funded by accumulated trades; no separate liquidity deposit.
- Native-asset pairing by default, or an approved paired token / tokenized stock; creation-fee payment is independent of the pair.
- 1.25% eligible trade fee; 50% protocol, 50% creator reward allocation.
- Creator reward recipients: wallets, verified X/social identities and domains.
- Holder rewards: creator-configurable minimum holdings, automatic accumulation and automatic batch distribution.
- Optional reward conversion into supported tokens or eligible tokenized stocks at configured thresholds.
- Optional custom quote pairs including other launchpad tokens and permitted tokenized stocks.
- Solana-only branded vanity mint suffix (not chosen yet).

## Compile and test locally
```bash
npm ci --ignore-scripts
npm run compile
npm test
```
`npm run compile` uses pinned Solidity 0.8.24 with optimization and the Shanghai EVM target, writing ABI and bytecode artifacts under `artifacts/`.
The compiler's `tmp` helper is overridden to version 0.2.7 to address temporary-file path vulnerabilities without changing the compiler version.

`npm test` runs the reference economics tests and deploys the EVM contracts to an in-memory Hardhat chain. Contract tests cover atomic launch and rollback, trade quotes and slippage, fee allocation and withdrawals, failed quote transfers, invalid trades, and reserve/inventory invariants across mixed trades. No wallet, RPC endpoint, or real funds are needed. Hardhat and the test quote token are development tools only. Use Node.js 22.13 or later on a supported even-numbered release (this setup was tested on Node.js 24).

Solana program tests (`npm run test:solana`) start a throwaway `solana-test-validator`, deploy the compiled program with the same code as `npm run solana:deploy`, and check launch, trading, fee payout and invariants. They are skipped when the Solana CLI is not installed (for example on plain Windows).

For the dependency-free reference-math checks alone, run `npm run test:math`. For contract tests alone, run `npm run test:evm`. These checks are not an audit, fuzz campaign, or verification of any target chain's deployed assets.

## Layout
- `apps/web`: responsive launchpad UI with local demo accounts and browser-wallet testnet mode (Base Sepolia, Ethereum Sepolia, BNB Chain Testnet, Robinhood Chain Testnet with MetaMask-style wallets; Solana Devnet with Phantom, Solflare or Backpack). Create a token lets you pick the chain.
- `apps/api`: loopback-only development server and isolated local chain
- `contracts/evm/src`: experimental Solidity token, native-priced factories (`ElpidaBetaFactory`, `ElpidaDexFactory`) and curves; earlier USDC-priced prototypes are kept for reference only
- `contracts/evm/testnet`: labelled test assets; local mock USDC enables fee-payment tests, with official test USDC addresses used for public previews
- `config/native-pricing.json`: legacy pricing only; new EVM fees use `packages/core/usd-oracles.mjs` and on-chain validation
- `contracts/solana`: Anchor locked-pool program, its compiled `build/elpida_launchpad.so` and build notes
- `packages/core`: BigInt reference economics and the testnet registry (`networks.mjs`)
- `packages/solana`: shared Solana client (instructions, account layouts, quote math) and RPC deploy helpers
- `tests`: Node unit tests
- `scripts`: Solidity compilation tooling, `solana-deploy.mjs` (`npm run solana:deploy`) and `native-pricing.mjs` (apply the pricing file)
- `db`: draft PostgreSQL schema
- `docs`: network matrix and security blockers

## Next engineering steps
1. Extend EVM tests with adversarial tokens, reentrancy and fuzz/property coverage; add Foundry tooling for deeper invariant campaigns.
2. Add Solana token metadata (Metaplex/Token-2022) and the branded mint suffix generator; harden the program (fuzzing, audit) and plan its upgrade authority.
3. Implement reward allocation, holder epoch and auto-distribution contracts.
4. Implement verified identity attestations and recovery.
5. Integrate direct DEX pools and reviewed permanent lockers on each supported chain.
6. Extend the localhost UI and testnet flows with persistent indexing, chain deployments, audits and staged rollout.

## Try the launchpad

Run `npm run dev` from this repository (in Windows PowerShell use `npm.cmd run dev`, or double-click `start-elpida.cmd` in the ELPIDA folder) and open http://localhost:3000. Local demo accounts can launch, buy, sell and distribute creator fees without a wallet. The network menu also connects your browser wallet to Base Sepolia, Ethereum Sepolia, BNB Chain Testnet or Robinhood Chain Testnet to deploy and use a testnet launchpad, or Phantom/Solflare to Solana Devnet after a one-time `npm run solana:deploy`. See [localhost and testnet instructions](docs/LOCALHOST_AND_TESTNET.md) for faucets and setup.

Do not use real assets with this code.

For official test USDC and a protected Circle test-wallet helper that supplies test ETH and USDC to your browser wallet, see [Circle test funding setup](docs/CIRCLE_TEST_FUNDING.md).
