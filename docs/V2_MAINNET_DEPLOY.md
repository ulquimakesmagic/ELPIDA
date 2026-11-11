# V2 mainnet deployment runbook

Script: `scripts/v2-mainnet-deploy.mjs` (audit DEP-01). Release gate and scope: `docs/AUDIT_TRIAGE_2026-11-11.md`.
The first release is **Base only, creator rewards only** (airdrop, holder and flywheel shares accrue unpaid), with a
daily launch cap and a guardian who can stop new launches. Nothing here runs without Malik's approval file.

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

## Emergency stop

The guardian (or the Safe) calls `pauseLaunches()` on the factory: new launches stop; trading, fees and existing pools
continue. Only the Safe can `resumeLaunches()`. The contracts themselves cannot be changed or paused beyond that.
