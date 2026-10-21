# Mainnet checklist, 19 October 2026

Turns the gates in `MAINNET_READINESS.md` into concrete work with an owner and the evidence that closes each one. It is a planning aid, not a security approval. Nothing here authorizes a mainnet deployment or real funds. Plan: one validated chain first (recommended: Base), creator-wallet rewards only.

Owners: **Malik** (wallet actions, funds, accounts), **Claude** (code, tests, docs, UI), **Other agent** (contracts and indexer work already in flight), **Auditor** (independent, external).

Status as of today: testnet only. Public site live at elpida.fun.

## A. Testnet lifecycle evidence (Base Sepolia first)

| # | Gate | Status | Evidence that closes it | Owner |
|---|------|--------|--------------------------|-------|
| A1 | Zero-creator-buy launch, buys, sell, shared-wallet fee claim | Done (SONGOKU) | Tx hashes and balances recorded | Malik |
| A2 | Atomic graduation: final buy creates the V3 pool; failure reverts only that buy | Open | A fresh token driven to the cap on the atomic factory `0x98a0…7145`; pool address, locked position owner, tx hashes | Malik (funds), Claude (checks) |
| A3 | Post-graduation buy and sell on the DEX, indexed on the token page | Open | Trades appear in the indexer with correct side, price and fees | Malik, Claude |
| A4 | USDC-pair launch end to end | Open | Same as A1 to A3 on a USDC curve (enabled at block 48289999) | Malik |
| A5 | Fee collection and claims after graduation | Open | Creator and protocol claims succeed; amounts match the fee ledger | Malik, Claude |
| A6 | Restart and recovery: restart the service, catch up the index, simulate an RPC outage | Open | Index identical before and after; no skipped transactions | Claude |
| A7 | Repeat A2 to A5 on each other chain you intend to enable | Open per chain | One validated chain does not validate the others | Malik |
| A8 | Old curves (AIZEN): keeper or manual graduation path still works | Open | One old curve graduated via the keeper | Other agent |

## B. Solana

| # | Gate | Status | Evidence | Owner |
|---|------|--------|----------|-------|
| B1 | Devnet program upgraded to the build with optional creator buy | Open | `solana:deploy -- --upgrade` run; the expected binary hash in `HUMAN_ACTIONS.md` item 3 (`4e96…9623`) is now stale because the binaries were rebuilt on 19 Oct; record the new hash | Malik, Claude (update doc) |
| B2 | Solana suite green against the rebuilt binaries | Done (26/26) | Test log | Claude |
| B3 | Post-graduation (PumpSwap) market indexing complete | Open | Trades, price and liquidity after migration visible and checked against chain | Other agent |
| B4 | Mainnet build confirms `TestNetworksOnly` on test instructions | Open | `test_build_check` run on the target cluster before configuring | Malik |

## C. Security and review (the long pole)

| # | Gate | Status | Evidence | Owner |
|---|------|--------|----------|-------|
| C1 | Independent audit: contracts, oracle validation, graduation adapter, fee locker, Solana program | Not started | Written report, findings fixed or documented | Auditor (Malik engages) |
| C2 | Economic invariant and adversarial tests (fee splits, rounding, griefing at the cap, anti-snipe) | Partly covered by unit tests | Property tests added; results recorded | Claude, Other agent |
| C3 | Treasury and upgrade keys: move from a single connected wallet to a multisig with a hardware signer; document who can upgrade what | Open | Addresses, signer list, upgrade authority transferred and verified on chain | Malik |
| C4 | Production config excludes test faucets and test instructions | Done for Solana mainnet (21 Oct): the server refuses to start on a failing mainnet config; `npm run check:production -- --as-mainnet` previews it. EVM mainnet checks to add when an EVM mainnet is configured | `PRODUCTION_GUARD.md`, `tests/production-guard.test.mjs` | Claude |
| C5 | Backup restore drill and incident procedure | Open | A timed restore from the offsite backup into a clean service; written runbook | Claude, Malik |
| C6 | Dependency and secrets review (no keys in repo, minimal env, rotated credentials) | Open | Checklist signed off | Claude, Malik |

## D. Product and operations

| # | Gate | Status | Evidence | Owner |
|---|------|--------|----------|-------|
| D1 | Per-chain DEX addresses, quote assets, price feeds and finality settings confirmed | Open per chain | Table of verified addresses with links | Other agent, Claude |
| D2 | Token tax stays disabled on public networks until a verified `taxDeployment` is registered | Enforced in code | Verified V2 deployment, then registry entry | Other agent |
| D3 | Holder rewards, buybacks, tokenized-stock rewards, identity claims stay off | Off | UI hides them; tests confirm | Claude |
| D4 | Pay the Railway past-due balance; confirm the plan covers production load and backups | Open | Account in good standing | Malik |
| D5 | Legal, terms and risk disclosures reviewed for the launch jurisdiction | Not started | Reviewed by a professional | Malik |
| D6 | Domain: elpida.fun live; `ELPIDA_PUBLIC_URL` set; X redirect URI updated if X verification is used | Mostly done | Site loads on the domain; verification flow tested | Malik |
| D7 | Public status page and an owner for monitoring and incident response | Open | Alerts reach a person | Malik, Claude |

## Suggested order

1. A2 to A6 on Base Sepolia, and B1 on Solana devnet (these need testnet funds and your wallet).
2. C2 and C4 in parallel (code work).
3. Engage the auditor early, since scheduling usually takes the longest (C1).
4. C3 and C5 before any mainnet deployment.
5. A limited beta: one chain, small caps, creator-wallet rewards only, invite-only gate on.

There is no honest date until C1 and A2 to A7 are done. My rough judgement is several weeks of testnet soak plus the audit before a limited beta, and that depends mostly on audit availability.

## Update, 21 October 2026

- **D6 done.** elpida.fun is on Cloudflare (DNS, Automatic SSL, fallback Worker for redeploys); SEO pages, sitemap and token link previews are live. See `DEPLOY_RESILIENCE.md`.
- **Graduation thresholds resolved without a contract change.** Stock-paired curves graduate on completion like every curve (rule `on-completion`); the retired $15,000 real-reserve floor was unreachable under Model 10 (about $12,013 at completion). Native and USDC curves were never affected. Not a mainnet blocker.
- **bStocks excluded in code** (ADGM-only offering). Tokenized stocks remain off and are not on the mainnet-beta path.
- **Backups:** Railway shows an `elpida-backups` bucket (about 839 MB on 21 Oct); C5 still needs a timed restore drill and a check that `backup_disabled` is absent from production logs.
- Still the long poles: A2 to A7 (testnet evidence, needs Malik's wallet), C1 (audit not booked), C3 (multisig), D5 (legal).
