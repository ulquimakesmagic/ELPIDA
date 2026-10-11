# Solana mainnet beta

How to run Elpida on Solana mainnet as a guarded beta. It uses real funds, and the contracts are **not audited**: get a security review before opening launches to the public.

## What the beta gives you

- **A mainnet build without test code.** `build/elpida_launchpad-mainnet.so` refuses the tUSDC and test faucet instructions. The deploy script checks this on-chain and stops if the wrong build is deployed.
- **Open launches, with an invite-only switch.** Launches are open by default while only the team is testing. The beta gate is created but off; add `--invite-only` at deploy time, or switch it on later, so that only creators on the allowlist can launch. Anyone can always trade, and a separate beta admin key manages the list.
- **Real pairs:**
  - USDC (Circle mainnet USDC), from $5k to $50k FDV with a 10 USDC creation fee.
  - SOL, priced in dollars at the SOL price you give at deploy time (`--sol-usd`).
  - Pair parameters are fixed once created, so the SOL pair's dollar range moves with the SOL price.
- **Multisig control.** The upgrade authority can be handed to a Squads vault. After that, upgrades and gate changes need the multisig's approval.
- **A server-side RPC.** The browser reaches Solana through the server (`/api/solana-rpc`). Your Helius key stays on the server, and only the calls the app needs are forwarded, rate limited per visitor.

## Before you start

| What | Why |
|---|---|
| About 9 SOL on a new deployer wallet | About 4.3 SOL stays locked as program rent. About 4.3 SOL is a temporary upload buffer, refunded when the deploy finishes. Fees are small. |
| A treasury address | Receives protocol fees. Use a Squads vault or a wallet you control. |
| A Squads multisig (recommended) | Takes over upgrades and gate changes. Use its **vault** address, not the multisig account. |
| A beta admin wallet | Manages the allowlist day to day. It cannot upgrade the program or move funds. |
| A Helius (or other) mainnet RPC URL | For the deploy and for the server's RPC proxy. |
| The current SOL price | Prices the SOL pair. |

## Deploy

**Easiest:** double-click `solana-mainnet-deploy.cmd` in the `ELPIDA` folder. It asks for the RPC URL, the treasury and the SOL price, shows the dry run, deploys only after you type YES, and can publish the deployment record so Railway uses it. The steps below are what it runs.


Run these from `elpida-v1`. The deployer keypair is created at `local-data/solana-deployer-mainnet.json` on first run. Keep it private and fund it first.

1. **Dry run.** Shows the cost and the settings without spending anything:

   ```
   node scripts/solana-deploy.mjs --cluster mainnet --rpc <helius url> --treasury <vault or wallet> --sol-usd <price> --beta-admin <admin wallet>
   ```

2. **Deploy.** Add `--yes`. Launches stay open. Add `--invite-only` to start with the gate on, plus `--allow <creator>` for each first creator if the beta admin is the deployer:

   ```
   node scripts/solana-deploy.mjs --cluster mainnet --rpc <helius url> --treasury <vault> --sol-usd <price> --beta-admin <admin wallet> --yes
   ```

   This deploys the mainnet build, confirms it rejects test instructions, creates the USDC and SOL pairs, and creates the beta gate (off unless `--invite-only`). It writes `local-data/solana-mainnet.json`.

3. **Allowlist creators (only matters while the gate is on).** Sign with the beta admin key:

   ```
   node scripts/solana-beta.mjs allow <creator wallet> --keypair <admin key file> --rpc <helius url>
   node scripts/solana-beta.mjs status --rpc <helius url>
   ```

4. **Hand control to Squads.** Do this last, after checking `status`:

   ```
   node scripts/solana-beta.mjs transfer-authority --to <Squads vault> --keypair local-data/solana-deployer-mainnet.json --rpc <helius url> --yes
   ```

## Serve it

The deploy writes `deployments/solana-mainnet.json`. This public record has addresses only and no keys. Commit and push it, because Railway never sees `local-data`.

Then set these variables (in Railway: your service → Variables; locally: `.env`) and redeploy or restart:

```
ELPIDA_SOLANA_CLUSTER=mainnet
SOLANA_RPC_URL=<your Helius mainnet URL>
```

The app then shows **Solana · mainnet beta**. It warns about real funds at launch. If you turn invite-only on, wallets that aren't on the list are told launching is invite-only.

## Day to day

| Task | Command |
|---|---|
| See the gate, the admin and the allowlist | `solana-beta.mjs status` |
| Add or remove a creator | `solana-beta.mjs allow <wallet>` / `revoke <wallet>` (beta admin key) |
| Turn invite-only on or off, or change the admin | `solana-beta.mjs set-gate --admin <wallet> --enabled true` (or `false`). Once the upgrade authority is a multisig, add `--export` and approve the printed instruction in Squads. |
| Upgrade the program | `solana-beta.mjs prepare-upgrade --multisig <vault>`. This uploads the new mainnet build to a buffer owned by the vault; then in Squads go to Programs, choose Upgrade and use that buffer. |

## Not in this beta

- **xStocks on Solana.** PumpSwap refuses them; it needs a Meteora graduation path.
- **Advanced creator rewards.** Holder payouts, buybacks, and X and website allocations are local only. Mainnet launches use creator-wallet rewards.
- **EVM mainnet.** Base would need the factory deployed from a Safe, real USDC and Uniswap addresses, and an indexer.
- **An audit.** Keep the beta small until one is done.
