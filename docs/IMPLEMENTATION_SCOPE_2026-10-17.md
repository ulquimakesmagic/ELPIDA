# Elpida implementation scope — 17 October 2026

This document supersedes older architectural proposals for shared USDC accounts and higher graduation targets. It records product decisions; it does **not** certify mainnet deployment readiness.

## Explicitly excluded

1. **Unified USDC cash balance**, platform-held cross-chain cash vault, and automated cross-chain balance routing. Users connect their **own wallet on each target chain** (or switch their EVM wallet network), fund it independently, and authorize launch and trade transactions on that chain. Optional local, same-chain USDC-to-native conversion is not a shared balance.
2. **Any bonding curve or graduation market-cap increase**. Preserve Model 10's existing start/graduate FDV, anti-sniping fee schedule, liquidity graduation mechanics and Solana alignment exactly as implemented. No new per-chain $150K/$200K targets or $30K/$50K reserve requirements.

## Retained launch requirements

- Solana, Ethereum, Base, BNB Chain, and Robinhood Chain remain the target networks. Testnet presence does not imply mainnet production readiness.
- $10 protocol launch fee, denominated in supported on-chain payment assets at validated pricing; wallet funds and gas are chain-local.
- Mandatory positive developer first buy, executed atomically with launch on supported paths.
- Existing Model 10 trade fees, split and first-minute anti-sniping liquidity bonus remain unchanged.
- Token creator allocations: wallets and identity-linked recipients; optional minimum-balance holder rewards, buyback/vesting, configured reward-token conversions and eligible tokenized stocks.
- Creator/holder distributions accumulate and execute automatically, with transparent, replay-safe batching and explicit asset eligibility.

## Current engineering focus

1. Secure secret handling and Solana upgrade authority. The shared ZIP previously contained secret-bearing files; rotate any real exposed keys and keep future archives free of credential material.
2. Hardening the **local** automatic holder reward vault: on-chain per-snapshot duplicate-payout protection; retry the **same** snapshot/batch after interrupted submissions instead of redistributing against a newly calculated snapshot.
3. Validate complete public testnet launch → trade → graduation → reward flow on each supported chain before considering deployment with real assets.
4. Replace trusted local identity/snapshot execution with independently verified, audited public-chain contracts and keeper infrastructure; ensure restricted tokenized-stock distribution compliance.

## Reward epoch hardening (this patch)

- `ElpidaRewardVault` tracks `epochPaid(asset, snapshotBlock, holder)`; the same holder cannot be paid twice for the same asset and snapshot, even across separate batches or vesting grants.
- `RewardEngine` stores a pending local epoch with its snapshot, payout amount, selected asset, recipients and confirmed batch cursor, and **resumes it** on the next processing tick after an interruption. It reconciles lost transaction receipts against `epochPaid` before retrying.
- This still uses a **trusted local executor** and **in-memory** pending-epoch state. A restart before persistence can lose the epoch plan. Production needs durable journal storage, on-chain committed snapshot/epoch roots, allowance for restricted assets, gas-funded keepers, and external auditing. These patches are not a production-ready autonomous rewards engine.

## Validation

- Solidity compiles with the repository's pinned compiler.
- Pure batch/reconciliation and economic tests pass.
- Solidity-backed integration test requires the Hardhat EDR native binary matching the current OS (the uploaded Windows dependencies cannot execute its Linux counterpart as-is).
