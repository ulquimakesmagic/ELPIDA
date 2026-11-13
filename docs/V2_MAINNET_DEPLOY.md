# V2 mainnet deployment runbook

Script: `scripts/v2-mainnet-deploy.mjs` (audit DEP-01). Release gate and scope: `docs/AUDIT_TRIAGE_2026-11-11.md`.
The first release is **Base only, creator rewards only** (airdrop, holder and flywheel shares accrue unpaid), with a
daily launch cap and a guardian who can stop new launches. Nothing here runs without Malik's approval file.

This deployer applies the rules of the deployment gate from #234 (`packages/core/v2-deploy-gate.mjs`): the $20,000
start, an approval no older than 14 days, a contract treasury, and `verifyDeployment` of the deployed factory and hook
against a gate plan built from what was deployed (kept in the record as `gate`). `scripts/deploy-v2.mjs` (#234) checks a
plan whose vaults already exist; this script deploys the vaults itself, so its approval pins the plan file instead.

## 0. Dress rehearsal on Base Sepolia (recommended first)

`deployments/plans/base-sepolia-rehearsal.json` runs the exact procedure below (steps 1–6) on Base Sepolia with test ETH:
a real Safe (create it in the Safe app on Base Sepolia with the same owners and threshold you will use on mainnet), a
real approval file, `deploy`, the Transaction Builder import and signing, and `verify`. Use the Base Sepolia RPC
(`https://sepolia.base.org`) as `ELPIDA_MAINNET_RPC_URL`. Afterwards, launch one token through the rehearsal factory and
pull the guardian stop once. The rehearsal deployment is not pinned into the site.

## 1. Fill the plan (Malik)

`deployments/plans/base-mainnet.json`: `treasury` (a Base Safe, 2-of-N or stricter), `keeper` (a fresh wallet used
only by the server keeper), `guardian` (a wallet that can only stop new launches). Confirm or change `minFeeBps` (100 =
1%) and `dailyLaunchCap`. The PoolManager is Uniswap's v4 deployment on Base; the ETH/USD feed and USDC are checked on
chain by step 2.

## 2. Check, then rehearse

```
ELPIDA_MAINNET_RPC_URL=<Base RPC> node scripts/v2-mainnet-deploy.mjs check --plan deployments/plans/base-mainnet.json
node scripts/v2-mainnet-deploy.mjs rehearse --plan deployments/plans/base-mainnet.json --fork <Base RPC>
```

`check` reads only. `rehearse --fork` runs the full deployment on a local fork of Base with a throwaway deployer and
the Safe's batch sent by impersonation, then launches a token and checks it starts at $20,000 and that the guardian stop
works. It needs no key and touches nothing real. (In CI it runs on a local chain with mocks:
`tests/v2-mainnet-deploy.test.mjs`.)

## 3. Approve (Malik)

Merge `deployments/approvals/base-mainnet-<first 16 hex of the plan's SHA-256>.json`:

```json
{ "planSha256": "<full SHA-256 printed by check>", "approvedBy": "Malik", "date": "YYYY-MM-DD",
  "statement": "I approve deploying exactly this plan to mainnet with real funds." }
```

Any later edit to the plan changes its hash and voids the approval.

## 4. Deploy

```
ELPIDA_MAINNET_RPC_URL=<Base RPC> ELPIDA_MAINNET_DEPLOYER_KEY=<fresh wallet with ~0.02 ETH, never reused> \
  node scripts/v2-mainnet-deploy.mjs deploy --plan deployments/plans/base-mainnet.json
```

It deploys the CREATE2 deployer, factory ($20,000 start, token details required), trader-airdrop and holder
distributors and flywheel vault (operator: the keeper), the hook (mined address) and the router; waits two confirmations
per step; reads every constructor argument back; writes `deployments/base-mainnet.json` (resumable) and
`deployments/base-mainnet-safe-batch.json`.

## 5. Safe batch (treasury owners)

Safe app → Apps → Transaction Builder → load `base-mainnet-safe-batch.json`: `setHook`, `configureUsdPricing`,
`approveQuote(USDC, 25,000 USDC virtual)`, `setGuardian`, `setDailyLaunchCap`. Owners sign and execute.

## 6. Verify, then pin

```
ELPIDA_MAINNET_RPC_URL=<Base RPC> node scripts/v2-mainnet-deploy.mjs verify --plan deployments/plans/base-mainnet.json
```

When the record says `"status": "ready"`, the site's network entry is added in a separate PR (mainnet labels, the
keeper with `ELPIDA_V2_DISTRIBUTIONS` unset so distributions stay off, the deploy block for the indexer).

## 7. Publish the source on BaseScan

```
node scripts/v2-explorer-verify.mjs --plan deployments/plans/base-mainnet.json
```

Needs `ELPIDA_MAINNET_RPC_URL` and `ETHERSCAN_API_KEY` (a free key from etherscan.io; one key covers Base and Base
Sepolia, and verification stays free). Both may be set in `.env`; the key is never printed. The script compares each
contract's creation code on chain with this checkout's build, takes the constructor arguments from the creation
transactions (the hook's from the CREATE2 call), and submits a self-contained Standard JSON input for all seven
contracts. Line endings are part of the metadata hash: a Windows checkout builds with CRLF, so when the build on disk
does not match it tries the other line ending (the 13 November rehearsal was built with CRLF). Run it from the commit in
the deployment record; a contract that matches neither build is reported, not submitted. Once verified, the guardian
and the Safe can use the explorer's Read and Write tabs.

## Emergency stop

The guardian (or the Safe) calls `pauseLaunches()` on the factory: new launches stop; trading, fees and existing pools
continue. Only the Safe can `resumeLaunches()`. The contracts themselves cannot be changed or paused beyond that.
