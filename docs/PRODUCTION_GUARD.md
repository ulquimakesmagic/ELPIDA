# Production guard (mainnet checklist C4)

`apps/api/production-guard.mjs` runs when the server starts. On a **mainnet configuration** (`ELPIDA_SOLANA_CLUSTER=mainnet`,
or the EVM mainnet site `ELPIDA_MODE=mainnet`, see `docs/MAINNET_SITE.md`) it refuses to start until every check below passes. Testnet, devnet and local runs are never blocked (production ran on
devnet when this was added, so nothing changed for the live site). Reports name settings only and never print values.

Before switching a service to mainnet, preview the result with the service's variables loaded:

```
npm run check:production -- --as-mainnet        # Solana switched to mainnet
npm run check:production -- --as-mainnet-site   # the EVM mainnet site (ELPIDA_MODE=mainnet)
```

Exit code 0 means the server would start; 1 lists what is missing.

| Code | Refuses when | Fix |
|---|---|---|
| `solana_deployment_missing` | No Solana mainnet deployment record | Run the mainnet deploy in `MAINNET_BETA.md` |
| `solana_test_build` | The record is not the `mainnet` build (or has no build) | Deploy `elpida_launchpad-mainnet.so`; the deploy script verifies it on-chain |
| `solana_rpc_missing` / `solana_rpc_local` | No Solana RPC in `SOLANA_RPC_URL` or `SOLANA_RPC_URLS`, or one is a local validator | Hosted HTTPS mainnet RPCs (for example Helius); several, comma-separated, for failover |
| `solana_rpc_invalid` | An entry in `SOLANA_RPC_URL(S)` is not a single HTTPS URL (the entry is never printed) | Fix or remove that entry |
| `public_url_missing` / `public_url_invalid` | No valid `ELPIDA_PUBLIC_URL` (or `RAILWAY_PUBLIC_DOMAIN`) | `https://elpida.fun` |
| `pinning_missing` | `PINATA_JWT` is not set | Token details must be pinned to public IPFS |
| `storage_ephemeral` | Neither `RAILWAY_VOLUME_MOUNT_PATH` nor `ELPIDA_DATA_DIR` | Attach the persistent volume |
| `backup_disabled` | `ELPIDA_BACKUP_ENABLED` is not `true` | Configure off-site backups (`RAILWAY_BACKUPS_AND_MONITORING.md`) |
| `circle_test_funding` | `CIRCLE_API_KEY` or `ELPIDA_CIRCLE_ADMIN_TOKEN` is set | Remove the Circle test-wallet settings from the mainnet service |
| `evm_mainnet_none` | `ELPIDA_MODE=mainnet` but no EVM mainnet deployment record is `ready` (the reason per chain is printed) | Deploy, run the Safe batch and `verify` (`V2_MAINNET_DEPLOY.md`) |
| `evm_rpc_missing` / `evm_rpc_invalid` | No `ELPIDA_RPC_<chainId>` (for Base: `ELPIDA_RPC_8453`), or it is not a hosted HTTPS URL | A private RPC (for example Alchemy); browsers keep using the public one |
| `keeper_missing` / `keeper_invalid` / `keeper_mismatch` | `ELPIDA_V2_KEEPER_KEY` is missing, malformed, or not the keeper named in the deployment plan | The keeper wallet's private key from the plan |
| `distributions_on` | `ELPIDA_V2_DISTRIBUTIONS=on` | The first mainnet release pays creator rewards only; remove it |
| `testnet_worker_keys` | A test-network worker key is set (Model 10 graduation, flywheel, buyback, testnet relay) | Keep those on the testnet site |
| `solana_devnet_on_mainnet_site` | The mainnet site would serve Solana devnet | Leave `ELPIDA_SOLANA_CLUSTER` unset (Solana stays off there) or set it to `mainnet` once Solana is on mainnet |

Not refused, but noted in the log: `simulation_present`. The local simulation (fake funds, labelled as a simulation)
is still served next to mainnet. `tokenized_equity_on` / `tokenized_equity_flags_unused`: stock pairs are allowed on
mainnet (Malik, 18 November 2026); a stock is offered only when `ELPIDA_TOKENIZED_EQUITY=1`, its capability flag is
`1`, it is in the verified stock list and the chain's Safe has approved it.

What it does not cover: the multisig and treasury setup (C3; the deploy script checks the Safe) and the restore drill
(C5). Tests: `tests/production-guard.test.mjs`, `tests/mainnet-site.test.mjs`.
