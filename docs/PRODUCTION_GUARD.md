# Production guard (mainnet checklist C4)

`apps/api/production-guard.mjs` runs when the server starts. On a **mainnet configuration** (`ELPIDA_SOLANA_CLUSTER=mainnet`)
it refuses to start until every check below passes. Testnet, devnet and local runs are never blocked (production ran on
devnet when this was added, so nothing changed for the live site). Reports name settings only and never print values.

Before switching a service to mainnet, preview the result with the service's variables loaded:

```
npm run check:production -- --as-mainnet
```

Exit code 0 means the server would start; 1 lists what is missing.

| Code | Refuses when | Fix |
|---|---|---|
| `solana_deployment_missing` | No Solana mainnet deployment record | Run the mainnet deploy in `MAINNET_BETA.md` |
| `solana_test_build` | The record is not the `mainnet` build (or has no build) | Deploy `elpida_launchpad-mainnet.so`; the deploy script verifies it on-chain |
| `solana_rpc_missing` / `solana_rpc_local` | `SOLANA_RPC_URL` is missing, a list, not HTTPS, or a local validator | One hosted HTTPS mainnet RPC (for example Helius) |
| `public_url_missing` / `public_url_invalid` | No valid `ELPIDA_PUBLIC_URL` (or `RAILWAY_PUBLIC_DOMAIN`) | `https://elpida.fun` |
| `pinning_missing` | `PINATA_JWT` is not set | Token details must be pinned to public IPFS |
| `storage_ephemeral` | Neither `RAILWAY_VOLUME_MOUNT_PATH` nor `ELPIDA_DATA_DIR` | Attach the persistent volume |
| `backup_disabled` | `ELPIDA_BACKUP_ENABLED` is not `true` | Configure off-site backups (`RAILWAY_BACKUPS_AND_MONITORING.md`) |
| `circle_test_funding` | `CIRCLE_API_KEY` or `ELPIDA_CIRCLE_ADMIN_TOKEN` is set | Remove the Circle test-wallet settings from the mainnet service |
| `tokenized_equity_on` / `tokenized_equity_flags` | `ELPIDA_TOKENIZED_EQUITY=1` or any capability flag is `1` | Tokenized stocks stay off for the mainnet beta |

Not refused, but noted in the log: `simulation_present`. The local simulation (fake funds, labelled as a simulation)
is still served next to mainnet.

What it does not cover: EVM mainnet (no EVM mainnet network is configured yet; add its checks when one is), the
multisig and treasury setup (C3), and the restore drill (C5). Tests: `tests/production-guard.test.mjs`.
