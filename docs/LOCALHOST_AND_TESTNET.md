# Localhost and public testnets

**Current setup:** follow [Virtual curve and pairs](VIRTUAL_CURVE_AND_PAIRS.md). Deposit instructions below are historical. New EVM factories use `curve-pairs-v3`; new-model Solana launches require a program update and are currently blocked.

All development files live in `Desktop/OneForAll/ELPIDA/elpida-v1`.

The default model is now a permanently locked real-reserve pool. See [the pool guide](LOCKED_POOL_PROTOTYPE.md). Existing curve deployments remain separate; create a new locked-pool factory for the new browser flow. The earlier simulated public-wallet flow was checked before this model change; the new model has local contract/API/browser verification, not a completed public deployment.

## Start the UI

```powershell
cd C:\Users\user\Desktop\OneForAll\ELPIDA\elpida-v1
npm ci --ignore-scripts
npm run dev
```

Use Node.js 22.13 or later on a supported even-numbered release. Open http://localhost:3000. If dependencies are already installed, only `npm run dev` is needed. After pulling changes that add dependencies (such as the Solana library), run `npm install --ignore-scripts` once.

On Windows PowerShell, `npm` may be blocked by the script execution policy ("running scripts is disabled"). Use `npm.cmd run dev`, run `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` once, or double-click `start-elpida.cmd` in the ELPIDA folder. If port 3000 is already in use, open the server that is already running or start on another port: `$env:PORT=3001; npm.cmd run dev`.

The server binds to loopback, compiles the contracts, creates an isolated Hardhat chain, and deploys the factory and a test-only USDC mock. It seeds three actual demo launches. No external RPC, wallet, gas purchase or private key is required for local testing.

1. Choose Creator or Trader from the network menu. Each starts with 10,000 local test USDC before its seeded launch fees and buys.
2. Create a token with a name, symbol, positive liquidity deposit, positive first buy, and creator reward wallet. The fee, permanent deposit and first buy execute atomically after approval. Default amounts total 135 test USDC.
3. Select View & trade on a token. Review the quote and included fee, then buy or sell. Token approvals use exact amounts; slippage is adjustable from 0.5% to 5%.
4. Open My tokens to see your holdings. Open Creator rewards to pay accrued protocol and creator fees to their fixed recipients.
5. Use Get test USDC for another 1,000 local units.

The local chain and listing history reset when the server stops. Wallet addresses in the demo are public Hardhat development accounts; their keys are never used on a public network or exposed by the app. The local faucet cannot mint Circle USDC.

## Use a public testnet

The network menu offers Base Sepolia, Ethereum Sepolia, BNB Chain Testnet and Robinhood Chain Testnet. Each has wallet connection, launchpad deployment, launch, buy, sell and fee-payout flows. All network details are in `packages/core/networks.mjs` and [the chain matrix](CHAIN_MATRIX.md). The full flow has been exercised in a browser against a simulated chain with Robinhood Chain Testnet's chain ID. A real public-network deployment still has to be confirmed with your funded wallet.

1. Open http://localhost:3000 in Chrome, Edge or another browser with MetaMask or another Ethereum wallet extension. The embedded app browser may not have a wallet extension.
2. In the network menu, pick a testnet. Approve adding/switching to it and connect your test wallet.
3. Get gas from that network's faucet (the link appears under the deploy button).
   - **Base Sepolia / Ethereum Sepolia:** also get Circle test USDC from https://faucet.circle.com for that network.
   - **BNB Chain Testnet / Robinhood Chain Testnet:** Circle publishes no test USDC there, so deployment also creates **Elpida tUSDC** (no value). After deploying, use **Get 1,000 tUSDC** as often as you need.
4. Choose **Deploy testnet launchpad** and approve it in your wallet (two confirmations on tUSDC networks). The treasury is your connected wallet, so the 10-USDC launch fee comes back to you during testing.
5. Create a token: approve the exact total (100 liquidity + 25 first buy + 10 fee = 135 test USDC), then confirm the launch and permanent liquidity deposit.
6. Buy/sell from token cards and check transactions with the explorer links. Creator fees go to the reward wallet set at launch.

No private key or seed phrase is needed by the app or server.

### Choose the chain when creating a token

Create a token starts with **Launch on**: the local devnet, any EVM testnet or Solana Devnet. If you pick a different network from the one you are using, the app connects the right wallet first (MetaMask-style for EVM, Phantom/Solflare/Backpack for Solana) and then launches. An empty creator reward wallet defaults to the connected wallet on the chosen chain. EVM testnets still need their launchpad deployed from the network menu before the first launch.

## Use Solana Devnet

Solana uses the Anchor program in `contracts/solana` (same locked-pool rules: 10 USDC fee, permanent liquidity deposit, atomic first buy, 1.25% fee split 50/50). Programs are deployed from a terminal, not the browser, so do this once per deployment:

1. In the `elpida-v1` folder run `npm.cmd run solana:deploy` (or `npm run solana:deploy`). The first run creates a deployer keypair at `local-data/solana-deployer.json` and prints its address. Keep that file private; it is the program's upgrade authority.
2. Fund that address with about **5.8 devnet SOL** at https://faucet.solana.com (choose Devnet; signing in with GitHub raises the limit). Most of it is rent locked in the program account.
3. Run `npm.cmd run solana:deploy` again. It uploads the compiled program (about a minute), initializes it with Circle devnet USDC and your deployer wallet as treasury (use `-- --treasury <address>` for another wallet), and writes `local-data/solana-devnet.json`.
4. Restart `npm.cmd run dev`. **Solana Devnet** in the network menu and in Create token is now live.

To use it, install Phantom (or Solflare/Backpack), turn on Testnet Mode in Phantom (Settings → Developer Settings) so it shows devnet balances, get devnet SOL for fees from https://faucet.solana.com and Solana Devnet test USDC from https://faucet.circle.com. A launch needs 135 test USDC with the default amounts. The deploy step and this flow were verified end to end against a local `solana-test-validator`; a public devnet deployment still has to be run with your funded keypair.

To let testers share your deployment without copying `local-data`, put the program ID in `solanaDevnet.shared` in `packages/core/networks.mjs`: `shared: { programId: '…' }`.

Solana tokens have a fixed 1B supply with 6 decimals, no mint or freeze authority, and their name and symbol stored in the Elpida pool account. They have no Metaplex metadata yet, so wallets may show them as unknown tokens.

### Share one launchpad with testers

By default each browser deploys and remembers its own factory (in local storage, per chain), so testers on different browsers would not see each other's tokens. To give everyone the same launchpad on a network, deploy once, then copy the factory address, deployment block and transaction hash from the explorer into that network's `shared` field in `packages/core/networks.mjs`:

```js
shared: { model: 'locked-pool-v2', factory: '0x…', block: 12345678, hash: '0x…' },
```

On tUSDC networks the app reads the quote token from the factory, so there is nothing else to fill in. Restart `npm run dev`. The menu then shows "Shared team … factory" and disables re-deployment.

Listings are discovered from factory events in batches; this is a prototype reader, not a production indexer. A wallet/RPC with a lower log-range limit may require smaller query batches.

## Verification

`npm run compile` compiles the production prototype sources. `npm test` runs economics, contract integration, localhost API and (when the Solana CLI is installed) Solana program checks against a throwaway `solana-test-validator`. `npm run test:ui` runs just the localhost API lifecycle, including request-origin protection and fee payouts. Browser interaction checks verify the user flows independently of API checks.

## Current scope

The local simulator, four EVM testnets (Base Sepolia, Ethereum Sepolia, BNB Chain Testnet, Robinhood Chain Testnet) and Solana Devnet (after `npm run solana:deploy`) are enabled. There is no shared cross-chain cash balance, DEX graduation, automatic holder reward distribution, social verification, or production backend yet. The contracts remain experimental and unaudited. Testnet support does not establish mainnet readiness.
