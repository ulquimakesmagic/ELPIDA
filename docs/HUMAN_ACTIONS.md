# Actions that need Malik

Updated 15 October 2026, after Phase 1 (model 10 contract fixes). Items are in the order they unblock work.

## 1. Review and merge Phase 1

Phase 1 is on the branch `phase-1-model-10`. Merging it into `main` and pushing redeploys Railway.

What changes on the hosted site after the redeploy:
- The shared simulation runs model 10 (10x curve, anti-snipe fee, dev badge, reopen button).
- Simulated token addresses change, because tokens are now created by `ElpidaDexCurveDeployer`. The existing simulation journal on the Railway volume still replays its launches, but old buys, sells and graduations refer to addresses that no longer exist. They are skipped and logged as `simulation_replay_skipped`. Nothing real is affected (simulation only). For a clean demo, delete `local-data/simulation-journal-v2.jsonl` on the volume before the redeploy. It is recreated with fresh seed launches.
- Base Sepolia keeps using the pinned model 9 factory until step 2. It stays readable and tradable as a legacy model.

On Windows, `npm.cmd ci` now works: the lockfile was out of sync before.

## 2. Deploy the model 10 launchpad on Base Sepolia (Phase 3 can start right after)

1. Open the site, choose **Base Sepolia**, connect the treasury wallet and open **Network and funds → Set up launchpad**.
2. Sign up to four transactions:
   - the native migration adapter (skipped if this browser already saved one);
   - the factory, which deploys `ElpidaDexFactory` with a **$50 starting FDV** and a **24 h graduation grace** (the browser enforces these terms);
   - **Activate verified USD pricing**;
   - the USDC adapter and **Approve USDC trading**.
3. Copy the new factory address and deployment block from the success message (or the browser's saved record) and send them over. They get pinned in `packages/core/networks.mjs` as `model: 'curve-dex-v10'`.

Funds: deployment gas only, roughly 0.003–0.005 Base Sepolia ETH in total. The wallet had about 0.005 ETH on 13 October, so top up from the Base faucet first. A full public lifecycle test at the $50 size needs about **$120 of test funds** (about 0.05 test ETH for a native curve, or 120 test USDC from faucet.circle.com for a USDC curve), plus gas.

## Not needed for Phase 1

No API keys, Railway variables or Solana actions are needed for Phase 1. Solana items arrive with Phase 2.
