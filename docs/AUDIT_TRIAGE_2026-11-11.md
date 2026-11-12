# Pre-mainnet audit triage — 11 November 2026

An AI-led pre-mainnet review ran on 11 November against `7e51a70` / `ad399e1` (contracts, keepers, web, Solana). It is
**not an independent security audit**, and nothing in this repository may present it as one. Its findings were re-checked
against `0b79117`; almost every code finding was confirmed. This file is the single current release gate: it replaces
`MAINNET_READINESS.md` (13 Oct) and `MAINNET_CHECKLIST_2026-10-19.md`, which are now historical.

## Decision (Malik, 11 November 2026): Option B

No external audit firm before the first release. The first release is **Base mainnet only**, after the fixes below and
a long stress test of the hook's accounting, labelled "not independently audited", and restricted (audit Batch 1):

- creator rewards (the 30% share) pay from day one;
- the trader airdrop, holder rewards and flywheel shares **accrue in their contracts but are not paid out** until the
  accounting has been watched in production (the keeper's distribution jobs stay off on mainnet);
- a daily launch cap, and a stop for new launches that the treasury or a named guardian can pull without touching
  trading or existing pools (`ElpidaV2Factory.pauseLaunches`, `setDailyLaunchCap`);
- Ethereum, BNB and Solana follow, each with its own evidence. Robinhood comes last, or not at all, while it pays in a
  test dollar.

The deployment itself still needs Malik's explicit go-ahead at the time (CLAUDE.md: never touch mainnet without it).

## Fix plan

| PR | Findings |
|---|---|
| Contracts | EVM-02 (`claimMany` skips paid leaves), EVM-03 (`SafeCast` start price), EVM-07 (exact-output tests; found and fixed a 1-unit rounding leak into the bonus), stress test (audit 1.2), launch stop and daily cap, EVM-06 doc numbers |
| Keepers | BE-01 lease, BE-02 two confirmations and a re-read, BE-03 same-byte resend on Solana, BE-04 manifest published only once its root is on chain, BE-05 backups and chain-derived holder totals, BE-07 replay cap and gas budget, BE-11 sanitised errors, EVM-01 per-recipient fallback, mainnet distributions off |
| Public copy (this PR) | WEB-01, WEB-02, WEB-03, WEB-04, REF-01, custody wording in `AUDIT_SCOPE_V2.md`, DOC-01, SOL-08/09/11 and the SOL-05 doc overstatement |
| Web and operations | WEB-05, WEB-06, OPS-01, BE-06, BE-08, BE-09, a claim button for airdrop and holder leaves |
| Mainnet deploy path | DEP-01: approval file, $20,000 start, treasury must be a contract (Safe), post-deploy checks, deployment record, fork rehearsal |
| Solana program (before Solana mainnet) | SOL-03, SOL-04, SOL-05 on-chain floor, SOL-07, SOL-09, SOL-10, SOL-12, SOL-06 build-hash check in CI |

## Owner actions

1. **CI (REL-01).** GitHub has not started a workflow job since 8 November: *"recent account payments have failed or
   your spending limit needs to be increased."* Fix the billing or spending limit, then require both checks in branch
   protection. Until then, evidence is the full local suite run before every merge.
2. **Custody.** A Safe on Base as the treasury; a separate keeper key; a guardian address for the launch stop. Squads
   for the Solana upgrade authority and treasury before Solana mainnet.
3. **Approval.** Sign off the deployment record before the mainnet deploy script will run.

## Corrections to the review

- Its 43 skipped Solana tests were an environment gap on the reviewer's machine (no `solana-test-validator`); merges
  here run the full suite with the validator. The CI gap itself is real.
- The backend notes' "CSRF token is a constant" was withdrawn by the lead reviewer: it is random per process. The
  Origin check plus the JSON content type is the control that matters.
