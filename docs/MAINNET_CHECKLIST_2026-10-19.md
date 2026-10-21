# Mainnet checklist, 19 October 2026

Turns the gates in `MAINNET_READINESS.md` into concrete work with an owner and the evidence that closes each one. It is a planning aid, not a security approval. Nothing here authorizes a mainnet deployment or real funds. Plan: one validated chain first (recommended: Base), creator-wallet rewards only.

Owners: **Malik** (wallet actions, funds, accounts), **Claude** (code, tests, docs, UI), **Other agent** (contracts and indexer work already in flight), **Auditor** (independent, external).

Status as of today: testnet only. Public site live at elpida.fun.

## A. Testnet lifecycle evidence (Base Sepolia first)

| # | Gate | Status | Evidence that closes it | Owner |
|---|------|--------|--------------------------|-------|
| A1 | Zero-creator-buy launch, buys, sell, shared-wallet fee claim | Done (SONGOKU) | Tx hashes and balances recorded | Malik |
| A2 | Atomic graduation: final buy creates the V3 pool; failure reverts only that buy | **Done (21 Oct)**: SONGOKU `0x27a4…0e4b` on the atomic factory `0x98a0…7145` (model 10). One transaction `0x284ca031a4fd714a984a491d485776940c8d9261564729657f9c4a86a09d5535` (block 48364694) emitted Bought, CurveCompleted, PoolCreated, Initialize, Mint/IncreaseLiquidity (full-range position 83037), position to locker `0x2A71…b56d`, then Graduated. Pool `0x7c4C…E3FC` (Uniswap v3, 1%), liquidity locked, fee splitter `0x9c6F…Ce1d`. The revert-only-that-buy path is covered by `atomic-graduation.test.mjs` | Malik (funds), Claude (checks) |
| A3 | Post-graduation buy and sell on the DEX, indexed on the token page | **Done (21 Oct)**: SONGOKU pool buy `0x6bf48beae98950e0e816b845e84d4d7a2a963776628486938a4b17322970bcf4` and pool sell `0x454d242e065e7dd855c7fdc532414c05f4ff7b3f92e184a985b7088b87d402ff` are Uniswap v3 swaps on `0x7c4C…E3FC`, indexed as `dexPool` buy and sell with the right amounts | Trades appear in the indexer with correct side, price and fees | Malik, Claude |
| A4 | USDC-pair launch end to end | Open | Same as A1 to A3 on a USDC curve (enabled at block 48289999) | Malik |
| A5 | Fee collection and claims after graduation | **Done (21 Oct)**: curve `withdrawFees` `0xabba0cc50a005a85834dec72c9b0e945d22b37e0d88cd6ab7352a61ec1636887`, locker `collectFees` `0x10d1d79c504f9fa01ccefd9a4eead968b602417bb29ba44dbfd4ad8b75e14913`, splitter `claim` `0x3aa3a139790eac32a0e131817ce70f0fa103655a92e4475bfa41bc66df168077` and `0x3950759d369a3552528b0e0bb554538122e42947781ab3cc8a82803a7953acf8`, all successful; curve fee ledgers now 0. It took four signatures, now one on batching wallets (`WALLET_CONFIRMATIONS.md`) | Creator and protocol claims succeed; amounts match the fee ledger | Malik, Claude |
| A6 | Restart and recovery: restart the service, catch up the index, simulate an RPC outage | **Done (21 Oct), simulated**: `tests/restart-recovery.test.mjs` injects random RPC failures (5%) mid-sync with 16+ restarts from the SQLite file, in per-block and 100-block range modes, and a full outage during new trades; the result is identical to a clean rebuild (trades, snapshots, holders, indexed block), and an outage never advances the index. Note: a block is all-or-nothing, so a very unreliable RPC (25%+ failures) stalls on busy blocks; the operations monitor already raises a critical alert on indexer lag | Claude |
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
| C2 | Economic invariant and adversarial tests (fee splits, rounding, griefing at the cap, anti-snipe) | EVM done (21 Oct): `tests/economic-invariants.test.mjs` runs seeded random multi-trader sequences on ETH and USDC curves (3 seeds each, ~30 trades, across the anti-snipe minute) checking after every trade exact backing, token conservation, exact 1.25% base fee and 50/50 split, locked anti-snipe surplus, price direction, no round-trip profit, then a full bank run and fee withdrawal; plus exact oversized final buys. Existing scenario tests cover cap griefing, failed payouts and reopen. Solana program equivalent still open | Test file and passing run; more seeds via `ELPIDA_FUZZ_SEEDS` | Claude, Other agent |
| C3 | Treasury and upgrade keys: move from a single connected wallet to a multisig with a hardware signer; document who can upgrade what | Open | Addresses, signer list, upgrade authority transferred and verified on chain | Malik |
| C4 | Production config excludes test faucets and test instructions | Done for Solana mainnet (21 Oct): the server refuses to start on a failing mainnet config; `npm run check:production -- --as-mainnet` previews it. EVM mainnet checks to add when an EVM mainnet is configured | `PRODUCTION_GUARD.md`, `tests/production-guard.test.mjs` | Claude |
| C5 | Backup restore drill and incident procedure | Open | A timed restore from the offsite backup into a clean service; written runbook | Claude, Malik |
| C6 | Dependency and secrets review (no keys in repo, minimal env, rotated credentials) | **Repo side done (21 Oct)**: no secrets in the tree or the full 213-commit history, 0 npm vulnerabilities, no secret logged or served, ignore rules hardened; `npm run security:scan` guards against regressions. Credential rotation for the mainnet service is Malik's step | `SECURITY_REVIEW_2026-10-21.md`, `tests/secret-scan.test.mjs` | Claude, Malik |

## D. Product and operations

| # | Gate | Status | Evidence | Owner |
|---|------|--------|----------|-------|
| D1 | Per-chain DEX addresses, quote assets, price feeds and finality settings confirmed | Open per chain | Table of verified addresses with links | Other agent, Claude |
| D2 | Token tax stays disabled on public networks until a verified `taxDeployment` is registered | Enforced in code | Verified V2 deployment, then registry entry | Other agent |
| D3 | Holder rewards, buybacks, tokenized-stock rewards, identity claims stay off | Off | UI hides them; tests confirm | Claude |
| D4 | Pay the Railway past-due balance; confirm the plan covers production load and backups | **Paid (21 Oct)**, Pro plan restored; backups check still open | Account in good standing | Malik |
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
- Later on 21 Oct: A2 done (SONGOKU atomic graduation), A6 done (restart and recovery tests), C2 done for EVM (invariant tests), C4 done for Solana mainnet (production guard), D4 paid.
- Still the long poles: A3 to A5 and A7 (post-graduation trades, USDC pair, claims, other chains; needs Malik's wallet), C1 (audit not booked), C3 (multisig), D5 (legal).
