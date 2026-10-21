# Dependency and secrets review, 21 October 2026 (mainnet checklist C6)

Scope: this repository (all branches, full history), its npm dependencies, how the server reads and reports
configuration, and what must be rotated before mainnet. It is not an audit of the contracts (C1).

## Results

| Check | Result |
|---|---|
| Committed secrets, working tree | **None.** `npm run security:scan` (PEM keys, assigned 32-byte hex keys, Solana keypair arrays, API keys in URLs, JWTs, AWS, GitHub, Circle and Stripe-style keys, mnemonics) |
| Committed secrets, full history | **None** across all 213 commits on every branch (`npm run security:scan -- --history` on a full, unshallowed clone) |
| Secret-looking file names tracked | None (`.env`, keypair, `id.json`, `.pem`, `.key`) |
| npm dependencies | **0 known vulnerabilities** (`npm audit`, production and all) |
| Logs | Configuration is logged as names and true/false only; no code path logs a key, token or URL with credentials |
| Public API | `/api/config` exposes demo account names and addresses only; `/health` exposes a 12-character commit id; the production guard reports setting names only |
| Key files | Operator and vanity keys are read from files/env at startup and never written to logs; ethers redacts invalid keys in its errors |
| Ignore rules | `.env*`, `local-data/` (deploy keypairs), `contracts/solana/keys/` were already ignored; added `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `id.json`, `*keypair*.json` to `.gitignore` and `.dockerignore` |

The scanner is a regression guard: `tests/secret-scan.test.mjs` fails the suite if a secret pattern is ever committed.

## Secrets the services use (names only)

| Setting | Purpose | On mainnet |
|---|---|---|
| `SOLANA_RPC_URL` | Private RPC (contains the provider key) | New mainnet key; required by the production guard |
| `PINATA_JWT` | IPFS pinning | New key for the mainnet service |
| `ELPIDA_BACKUP_S3_ACCESS_KEY_ID`, `ELPIDA_BACKUP_S3_SECRET_ACCESS_KEY` | Off-site backups | New bucket credentials scoped to one bucket |
| `ELPIDA_BACKUP_ENCRYPTION_KEY` | Encrypts backups | New key for mainnet; **keep the old key** wherever old backups must stay restorable |
| `ELPIDA_GRADUATION_KEY_FILE` | Base Sepolia operator gas wallet | Testnet only; a mainnet keeper needs its own wallet with a small balance and a daily budget |
| `ELPIDA_VANITY_KEY` | Encrypts pre-ground Solana mint keys at rest | New key for mainnet |
| `ELPIDA_X_CLIENT_ID`, `ELPIDA_X_CLIENT_SECRET` | X verification | Rotate if the testnet secret was ever pasted anywhere |
| `PYTH_API_KEY` | Price data | Rotate with the others |
| `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `ELPIDA_CIRCLE_ADMIN_TOKEN` | Circle **test** wallet funding | **Must be absent** (the production guard refuses to start otherwise) |

## Before mainnet (Malik)

1. Create the mainnet service with **fresh** values for every secret above; do not copy testnet values across.
2. Keep each secret only in Railway Variables (and a password manager), never in chat, screenshots or files in the repo.
3. Move the treasury and upgrade authority from the single connected wallet to a multisig (C3).
4. Run `npm run security:scan -- --history` and `npm audit --omit=dev` before the release, and
   `npm run check:production -- --as-mainnet` with the mainnet service's variables.

## Not covered here

Contract and program security (C1, the audit), Railway and GitHub account security (two-factor on both is strongly
recommended), and browser-wallet phishing risks for users.
