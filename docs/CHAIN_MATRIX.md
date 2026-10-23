# Chain matrix

Testnet values live in `packages/core/networks.mjs` (one place for the UI, server and docs).

## Testnets (enabled in the app)

| Network | Chain ID | Public RPC | Explorer | Gas faucet | Quote token |
| --- | --- | --- | --- | --- | --- |
| Base Sepolia | 84532 | https://sepolia.base.org | https://sepolia.basescan.org | https://docs.base.org/get-started/get-funds | Circle test USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (6 dp) |
| Ethereum Sepolia | 11155111 | https://ethereum-sepolia-rpc.publicnode.com | https://sepolia.etherscan.io | https://cloud.google.com/application/web3/faucet/ethereum/sepolia | Circle test USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` (6 dp) |
| BNB Chain Testnet | 97 | https://bsc-testnet-rpc.publicnode.com (dataseed dropped: pruned, load-balanced nodes) | https://testnet.bscscan.com | https://www.bnbchain.org/en/testnet-faucet | Elpida tUSDC, deployed by the app (Circle issues no USDC on BNB Chain) |
| Robinhood Chain Testnet | 46630 | https://rpc.testnet.chain.robinhood.com | https://explorer.testnet.chain.robinhood.com | https://faucet.testnet.chain.robinhood.com | Elpida tUSDC, deployed by the app (no Circle test USDC published) |
| Solana Devnet | — | https://api.devnet.solana.com | https://explorer.solana.com/?cluster=devnet | https://faucet.solana.com | Circle test USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (6 dp). Enabled once `npm run solana:deploy` has deployed program `ANkA5pytoVkiKQbjzd5NdPWKgmwfsihNJvSfg3vtKLNz` |

Circle test USDC faucet (Base Sepolia, Ethereum Sepolia, Solana Devnet): https://faucet.circle.com

Elpida tUSDC (`contracts/evm/testnet/ElpidaTestUSDC.sol`) is a testnet-only, 6-decimal token named "Elpida Test USDC (no value)" with a public faucet capped at 1,000 per claim. It must never be deployed to mainnet. The app verifies the token's symbol and decimals before using it.

Public RPCs are rate-limited. For heavier testing, use a provider endpoint (Alchemy, QuickNode, Chainstack, etc.) in your wallet.

## Mainnet targets

| Network | VM | Status | Notes |
| --- | --- | --- | --- |
| Solana | SVM / Anchor | Prototype program, devnet-ready | Vanity mint suffix and token metadata still to do; upgrade authority must be secured |
| Ethereum | EVM / Solidity | Prototype source only | Native Circle USDC (6 dp) |
| Base | EVM / Solidity | Prototype source only | Native Circle USDC (6 dp) |
| BNB Chain | EVM / Solidity | Prototype source only | USDC on BNB Chain is a bridged **18-decimal** token. The factory now scales the fee and curve to the quote decimals; verify the exact asset before deployment |
| Robinhood Chain (chain ID 4663) | EVM / Solidity | Prototype source only | Canonical USDC, tokenized assets and DEX integrations must be verified before deployment |

Do not infer an asset is canonical merely because its ticker is USDC. Never enable a chain until RPC, gas, custody, liquidity and transfer restrictions are tested.

Sources: Base, Circle, BNB Chain and Robinhood Chain developer docs (checked 2026-10-10).
