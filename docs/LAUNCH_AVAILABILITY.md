# Test launch availability

All network launch paths are exposed in the launch form. This enables test flows; it does not deploy contracts or enable mainnet launches.

| Network | Pair | Setup |
| --- | --- | --- |
| Local devnet | ETH or USDC | Ready; simulated funds |
| Base Sepolia | ETH or USDC | Connect wallet, fund test balances and deploy factory; real Uniswap v3 migration |
| Ethereum Sepolia | ETH or USDC | Connect wallet, fund test balances and deploy factory; custom test pool |
| BNB Chain Testnet | tBNB or Elpida tUSDC | Connect wallet and deploy quote token/factory; custom test pool |
| Robinhood Chain Testnet | ETH or Elpida tUSDC | Connect wallet and deploy quote token/factory; custom test pool |
| Solana Devnet | USDC only | Upgrade and initialize the curve program, then connect a Solana wallet; DEX migration unfinished |

Pinata is optional for test launches. Base uses shared IPFS metadata when both the provider and compatible factory are available. Otherwise additional metadata stays in the creator browser. A configured provider failure still stops submission. Other EVM previews and Solana currently use browser-local additional metadata.

## Solana setup found during verification

The executable devnet program `ANkA5pytoVkiKQbjzd5NdPWKgmwfsihNJvSfg3vtKLNz` does not match the current build, and the current `curve-config` account is missing. The deployer had approximately 0.81 devnet SOL; the upgrade estimate was 2.17 devnet SOL, including the temporary upload buffer. These values can change.

Fund the deployer `FeUWFps7CYtrXNXosirwJCfFQM5Na6PamEV6hpFcKaH8` with about 1.5 additional **devnet SOL** through [Solana's faucet](https://faucet.solana.com). Then, in the project folder, run:

```powershell
npm.cmd run solana:deploy -- --upgrade
```

The upgrade keeps the program ID and initializes the current curve configuration. Existing older model accounts are not exposed by the current curve UI. Restart the preview afterward and connect Phantom, Solflare or Backpack with devnet enabled. The native SOL pair is disabled because this program implements USDC curves only. SPL token decimals are 6; the EVM token decimals remain 18.

Solana preview trades start at a 90% anti-sniping fee, which decays to 1.25% over 60 seconds. The creator first buy uses 1.25%. Completed curves pause until a migration instruction is implemented; the UI does not offer a working DEX migration action.
