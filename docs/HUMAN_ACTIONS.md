# Actions that need Malik

## Atomic Base Sepolia deployment — verified 18 October 2026

Factory `0x98a0E75dbBe9EdA5D228319C72D496b814bA7145`, creation block
48289973, transaction `0x553fbbddcab2b001b27a7e5bc2ba6cff5240a7af9d7e12721f474de3ac1c48bb`.
Creation input exactly matches the compiled `ElpidaAtomicDexFactory` and its
constructor arguments. Model 10, optional-buy version 1, fee-accounting version
1 and automatic graduation are confirmed on chain. Treasury remains the
connected Zerion `0xf5B0…639D`; starting FDV $50, grace 86400 seconds, expected
Chainlink feed and Circle USDC. Native and USDC adapters use the registered
Uniswap V3 manager and 1% pool tier. User transaction
`0x6714859d6eded425199bf51d1fb5580487bbee6c9ce870066e9055f98110bebe`
successfully enabled USDC at block 48289999.

The registry selects this factory for new launches and keeps all earlier
factories indexed. Next: a fresh zero-creator-buy test token, curve trades,
final-buy atomic graduation and claims. This standard factory does not enable
configurable taxes; a verified V2 tax deployment remains a separate gate.

## Launch changes in source — 18 October 2026

See `IMPLEMENTATION_SCOPE_2026-10-18.md` and `DEX_DESTINATIONS_AND_FEES.md`.
Optional creator buys and atomic final-buy migration require a new standard EVM
factory; old deployed contracts retain their behavior. The wallet tools expose
the automatic-graduation factory upgrade when the old capability probe fails.
Only testnet funds are authorized. Keep old factories indexed.

The tax factory, V2 adapter/router and creator allocation flow are implemented
and rehearsed with local native/USDC pairs. A public tax deployment must be
verified and added as `network.taxDeployment` before its inputs are enabled.
Do not label a local V2 factory as an official Uniswap deployment. Solana
optional buys require a fresh program build and devnet upgrade; its binary has
not been rebuilt on this Windows host.

Updated 16 October 2026, after the model 10 Base Sepolia deployment. Items are in the order they unblock work.

## 1. Phase 1 merged; model 10 deployed on Base Sepolia (done, 16 October 2026)

- Factory `0xD64119914DDA7b206d01Fb2B334A630Ca94fD6d2`, block 48209837, treasury Zerion `0xf5B0…639D`. Pinned in `packages/core/networks.mjs`; the old model 9 factory is listed under `legacy` and stays indexed.
- Test funds came from the Circle helper wallet (`0xab0c…bd79`, wallet ID in the funding panel). It still holds some test ETH and 40 test USDC. Phantom's EVM address also holds 0.02 Base Sepolia ETH, but Phantom cannot use Base Sepolia.

## 2. Merge the pinning pull request

Merging redeploys Railway. The public indexer then indexes the new factory from block 48209837 (a few minutes) and keeps the model 9 database for JOSH, JUICEWRLD and ELTEST. Afterwards, launch one test token on Base Sepolia to exercise model 10 end to end. A full lifecycle at the $50 size needs about $120 of test funds (about 0.05 test ETH for a native curve, or 120 test USDC for a USDC curve), plus gas.

## 3. Upgrade the Solana devnet program (Phase 2) — done, 17 October 2026

Done from `elpida-v1` on the PC. The re-run printed `Program already deployed and up to date` (on-chain bytes equal build `4e96…9623`), and the run created the devnet USDC pair config `CGuXRR8e…EHBQ`. First launch on the upgraded program: P2HOPE `56frUGGQ…4zYd` (transaction `5Qg4cPba…98VQ`). Its Metaplex metadata has `is_mutable = false`, the curve PDA as update authority, an `ipfs://` URI pinned on Pinata, no mint or freeze authority, and a 1B supply. The steps are kept below for the mainnet upgrade.

Phase 2 adds the 24 h reopen escape hatch, immutable Metaplex metadata at launch and vanity mint addresses. The site keeps working before the upgrade: browsers detect the older program and launch with the earlier layout (token details stay in the browser, as today).

1. Merge the Phase 2 pull request, then on the PC run `git pull` in `elpida-v1`.
2. Check the new build: `certutil -hashfile contracts\solana\build\elpida_launchpad.so SHA256` must print `4e96db5726f91b9c5e0d7b8b9dafd779c6848307ea3350edbc10eda049199623`.
3. Make sure the devnet deployer `FeUWF…KaH8` (`local-data/solana-deployer.json`) holds about **5 devnet SOL**: about 4.8 SOL pays the temporary upload buffer and comes back after the upgrade; about 0.12 SOL stays, for the program growing by about 16 KB. Top up at faucet.solana.com if needed.
4. Double-click `solana-upgrade.cmd` in the ELPIDA folder (or `npm.cmd run solana:deploy -- --upgrade`). The upload resumes if interrupted.
5. Tell Claude when it finishes. The next Solana launch from the site then writes immutable metadata (visible in Phantom and Solscan), and the token page offers *Reopen curve trading* for a curve stuck 24 h after completion.

## 4. Turn on `hope` mint addresses (optional)

Add a Railway variable `ELPIDA_VANITY_KEY` with 32 random bytes as 64 hex characters (in PowerShell: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`). Keep a copy only if you want existing pre-ground keys to survive a key change; losing it just means they are ground again. After the redeploy the server grinds about one `hope` address every 9 minutes per CPU core in the background (three are kept ready; `ELPIDA_VANITY_TARGET` and `ELPIDA_VANITY_WORKERS` change that). Until one is ready, launches use a random address and say so.

## Not needed for Phase 1

No API keys, Railway variables or Solana actions are needed for Phase 1. Solana items arrive with Phase 2.
