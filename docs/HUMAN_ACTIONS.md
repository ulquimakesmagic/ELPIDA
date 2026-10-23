# Actions that need Malik

## Cloudflare in front of elpida.fun, 20 October 2026

Nameservers moved from Vercel to Cloudflare; DNS, SSL and the `elpida-fallback` Worker are configured as recorded in
`DEPLOY_RESILIENCE.md`. Redeploys now show Elpida's own "updating" page. Still open for Malik: check the Railway
deploy logs for `backup_disabled`; if present, production has no off-site backups and that must be fixed before mainnet.
Search Console sitemap: Google's live test fetches it; the "Couldn't fetch" row is waiting on Google's refresh.

## Solana binaries rebuilt, 19 October 2026

`contracts/solana/build/*.so` were rebuilt from current source (optional creator buy) with Solana CLI 2.3.13. New SHA256: test build `89d96d53856ba206a8a3a96b0b971d503d6fcfb0dd028587cf654fbc5f6d0b88`, mainnet build `1a1db96d0654a10ffc321e01cd055bd4c807d5ff1ad243bdabe04e02a25f865a`. The hash quoted in item 3 below (`4e96…9623`) belongs to the earlier build. The devnet program has not been upgraded from these yet; that is the next Solana step. See `MAINNET_CHECKLIST_2026-10-19.md`.

## Next test funds: finish SONGOKU, then tax rehearsal

SONGOKU's zero-buy launch, buys, sell and shared-wallet fee claim are verified.
Automatic graduation and post-migration trading remain outstanding. See
`BASE_SEPOLIA_TAX_REHEARSAL.md` for the snapshot, acceptance checks and separate
V2 deployment order; `config/base-sepolia-tax-plan.json` is an inert plan, not
an active registry entry. No official Base Sepolia V2 factory was found in the
Uniswap registry; the planned test deployment must be labelled accordingly.

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

## 3b. Upgrade the Solana devnet program to the 19 Oct build (checklist B1) — open

The 23 Oct attempt from `elpida-fork` stopped because the program's keys live in `elpida-v1`. Two private files matter;
never paste, commit or share either:

- `local-data/solana-deployer.json` is the deployer `FeUWF…KaH8`, the program's **upgrade authority**. Only it can upgrade.
- `contracts/solana/keys/elpida_launchpad-keypair.json` is the program keypair. It is only needed for a brand-new
  deployment; upgrades now use the program address from the source.

1. In PowerShell, from `elpida-fork`, copy the original deployer over the empty one the first attempt created:
   `Copy-Item ..\elpida-v1\local-data\solana-deployer.json .\local-data\solana-deployer.json -Force`
   (adjust `..\elpida-v1` to where that folder is). The empty keypair holds nothing, so overwriting it loses nothing.
2. Check the build: `certutil -hashfile contracts\solana\build\elpida_launchpad.so SHA256` must print
   `89d96d53856ba206a8a3a96b0b971d503d6fcfb0dd028587cf654fbc5f6d0b88`.
3. Make sure `FeUWF…KaH8` holds about **5 devnet SOL** (faucet.solana.com); most of it is a temporary buffer refunded
   after the upgrade.
4. Run `npm.cmd run solana:deploy -- --upgrade`. It prints the deployer and program first. If the deployer is not the
   upgrade authority, it stops before uploading anything and says which address is.
5. Send Claude the output.

## 4. Turn on `hope` mint addresses (optional)

Add a Railway variable `ELPIDA_VANITY_KEY` with 32 random bytes as 64 hex characters (in PowerShell: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`). Keep a copy only if you want existing pre-ground keys to survive a key change; losing it just means they are ground again. After the redeploy the server grinds about one `hope` address every 9 minutes per CPU core in the background (three are kept ready; `ELPIDA_VANITY_TARGET` and `ELPIDA_VANITY_WORKERS` change that). Until one is ready, launches use a random address and say so.

## Not needed for Phase 1

No API keys, Railway variables or Solana actions are needed for Phase 1. Solana items arrive with Phase 2.
