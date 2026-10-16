# Actions that need Malik

Updated 16 October 2026, after the model 10 Base Sepolia deployment. Items are in the order they unblock work.

## 1. Phase 1 merged; model 10 deployed on Base Sepolia (done, 16 October 2026)

- Factory `0xD64119914DDA7b206d01Fb2B334A630Ca94fD6d2`, block 48209837, treasury Zerion `0xf5B0…639D`. Pinned in `packages/core/networks.mjs`; the old model 9 factory is listed under `legacy` and stays indexed.
- Test funds came from the Circle helper wallet (`0xab0c…bd79`, wallet ID in the funding panel). It still holds some test ETH and 40 test USDC. Phantom's EVM address also holds 0.02 Base Sepolia ETH, but Phantom cannot use Base Sepolia.

## 2. Merge the pinning pull request

Merging redeploys Railway. The public indexer then indexes the new factory from block 48209837 (a few minutes) and keeps the model 9 database for JOSH, JUICEWRLD and ELTEST. Afterwards, launch one test token on Base Sepolia to exercise model 10 end to end. A full lifecycle at the $50 size needs about $120 of test funds (about 0.05 test ETH for a native curve, or 120 test USDC for a USDC curve), plus gas.

## Not needed for Phase 1

No API keys, Railway variables or Solana actions are needed for Phase 1. Solana items arrive with Phase 2.
