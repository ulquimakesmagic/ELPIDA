# Actions that need Malik

## Pay in SOL for Solana stock pairs on devnet, 5 November 2026

No devnet DEX accepts Ondo-shaped mints, and Jupiter does not run on devnet, so the program's test build now has its
own small SOL/stock conversion pool. The mainnet build refuses it; on mainnet the same payments will go through
Jupiter. Two steps, both with the deploy key, after this PR is merged:

1. `git pull`, then check the build: `certutil -hashfile contracts\solana\build\elpida_launchpad.so SHA256` must print
   `469fe201f86f9297f9431cd7d912d018d034f909395645536742b348d6100f78`.
2. Upgrade the devnet program (about 6.5 devnet SOL, mostly refunded):
   `node scripts/solana-deploy.mjs --upgrade --keypair "C:\Users\HomePC\Desktop\OneForAll\ELPIDA\elpida-v1\local-data\solana-deployer.json"`
3. Seed the pool at Tesla's current share price (look it up; nothing is assumed), with 1 SOL by default:
   `node scripts/seed-solana-conversion.mjs --stock-usd <TSLA price> --keypair "C:\Users\HomePC\Desktop\OneForAll\ELPIDA\elpida-v1\local-data\solana-deployer.json"`
   Add `--dry-run` first to see the amounts. The script mints the tTSLAon it needs from the faucet.
4. Send Claude the output. Then on a tTSLAon-paired token page, choose SOL in the swap card's currency menu; on the
   launch form, choose "SOL, converted to tTSLAon first" for the first purchase.

## Solana stock pairing: devnet program upgrade, 4 November 2026

**Done, 5 November 2026.** Malik ran the upgrade with `--stock-pairs`. Checked on chain:
- The program data (`EoihUf…PpcV`, upgraded at slot 518968205) hashes to
  `788f760314f4f3b1b55d69651e901d3bf42595d8b73aa17728f72d8a88821a05`, the reviewed test build.
- The tTSLAon stand-in `HE4LBuPDgFQCHT88Z4UMh62xKoJaTAQuzNHjAvCkHjYd`: Token-2022, 9 decimals, ConfidentialTransferMint,
  DefaultAccountState, TransferHook (no program), MetadataPointer, ScaledUiAmount and Pausable. The deploy key holds the
  freeze and pause authority; the test faucet holds the mint authority.
- Its pair config `4SwHxekNysG2gwy97tFz1rMuTSrY3aVqsdNe2bXpna33` exists, with USD pricing on. The pair was added to
  `deployments/solana-devnet.json` in the launch-picker PR.

The steps below are kept for reference:

The program now lets a curve paired with an issuer-controlled stock (Ondo's TSLAon, SPYon, NVDAon on Solana) complete
into Elpida's own locked pool, because no Solana DEX accepts those mints today (`docs/SOLANA_STOCK_PAIRING.md`).
Devnet only; nothing changes for SOL pairs. Launches stay SOL-only on the site until this upgrade is in.

New SHA256 (Solana CLI 2.3.13): test build `788f760314f4f3b1b55d69651e901d3bf42595d8b73aa17728f72d8a88821a05`,
mainnet build `36f672d31b5677b992ab4d12566fc3832752e2bbbedab0b9a66af807fd9bbaaf`.

1. After the PR is merged, in `elpida-fork`: `git pull`, then check the build:
   `certutil -hashfile contracts\solana\build\elpida_launchpad.so SHA256` must print
   `788f760314f4f3b1b55d69651e901d3bf42595d8b73aa17728f72d8a88821a05`.
2. Make sure the deployer `FeUWF…KaH8` holds about **6.5 devnet SOL** (most of it is an upload buffer, refunded).
3. Run `node scripts/solana-deploy.mjs --upgrade --stock-pairs --keypair "C:\Users\HomePC\Desktop\OneForAll\ELPIDA\elpida-v1\local-data\solana-deployer.json"`.
   `--stock-pairs` creates the **tTSLAon** stand-in (Token-2022, 9 decimals, pause, freeze, transfer-hook authority,
   confidential transfers, scaled UI amount, exactly like Ondo's mint; no value) and its pair config.
4. Send Claude the output. If the script rewrites `deployments/solana-devnet.json`, do not commit it; Claude adds the
   stand-in pair to the launch picker and the operator panel in the next PR.

## Mainnet preview on forks: Model 10 and the stock pairs on every chain, 3 November 2026

One command previews Elpida on local copies of real mainnet state: Ethereum, BNB Chain, Robinhood Chain and Base.
Nothing is signed with your keys, nothing is sent and no funds are used.

1. In `elpida-fork`, add archive RPCs to `.env.ondo.local` (free tiers work: Alchemy, QuickNode or dRPC):
   `ELPIDA_EQUITY_FORK_RPC_ETHEREUM=...`, `ELPIDA_EQUITY_FORK_RPC_BNB=...`, `ELPIDA_EQUITY_FORK_RPC_ROBINHOOD=...`.
   Without one, that chain's stock steps are reported as SKIPPED.
2. Run `node --env-file=.env.ondo.local scripts/mainnet-preview.mjs` (or name chains: `... mainnet-preview.mjs ethereum bnb`).
   Per chain: Model 10 with the native coin on the real DEX and Chainlink feed, then each stock as the pair
   (TSLAon, SPYon and NVDAon on Ethereum and BNB; Robinhood's own TSLA, SPY, NVDA and AAPL on Robinhood Chain).
3. Send Claude `backups/mainnet-preview/summary.md` and the reports it lists. Model 11 joins the preview when its
   phase 4 lands.
## Pay a stock-paired first purchase in ETH: seed the conversion pools, 3 November 2026

A creator can now pay the first purchase of a stock- or token-paired launch in the native coin. The launch form
converts it into the pair asset on the network's DEX first (one extra confirmation), then launches with what it
received. It needs a funded native/stock pool on each testnet; none exists yet. Test assets only; no mainnet.

1. In `elpida-fork`: `node scripts/seed-conversion-pools.mjs`. The first run creates `local-data\test-liquidity-evm.key`
   and prints only its public address. It sends nothing.
2. Send that address test coin on each testnet: about 0.15 ETH on Ethereum Sepolia, Base Sepolia and Robinhood,
   and 0.15 tBNB on BNB Testnet (0.02 per pool for five stocks, plus gas).
3. Preview with `node scripts/seed-conversion-pools.mjs --dry-run`, then run it without `--dry-run`. It mints each test
   stock from its faucet and adds full-range liquidity to the 1% pool, priced at the stock's test feed against the
   launchpad's native/USD feed. Pools that already hold liquidity are skipped, so rerunning is safe.
   - One network only: `node scripts/seed-conversion-pools.mjs bnb-testnet`. Deeper pools: `--native 0.05`.
   - To use a wallet that already has test coin instead: `--key local-data/flywheel-keeper-evm.key`.
4. Send Claude the output. The launch form then offers **Pay first purchase with: ETH, converted to tNVDAon first**.

## Tokenized stocks: TSLAon and SPYon first, 2 November 2026

1. **Fork rehearsal:**
   - In `elpida-fork` (with the archive RPC in `.env.ondo.local`), run
     `node --env-file=.env.ondo.local scripts/equity-lifecycle-fork.mjs ethereum TSLAon ondo`. Run it again with
     `SPYon`.
   - It runs only on a local fork: nothing is sent to Ethereum, and no wallet or key is used.
   - Send Claude the two reports from `backups/equity-fork/`. They include the candidate Chainlink feeds at that block.
   - Optional: repeat with `$env:ELPIDA_EQUITY_RESTRICTIONS='1'` for the issuer pause and blocklist checks.
2. **Questions:** send the questions in `ONDO_PROVIDER_QUESTIONS.md` to Ondo and Chainlink. The priority is which
   TSLAon/SPYon feed variant to use and where the corporate-action status is published.
3. **Legal:** start the review of eligibility (who may hold and trade the stocks, and whether our contracts may hold them).
4. **Test pairs:** on the reviewed launchpads (Ethereum Sepolia and BNB Testnet), press **Add test pairs**.
   - It now deploys five Ondo-style stand-ins: tNVDAon, tTSLAon, tSPYon, tQQQon and tAAPLon.
   - Each one needs four confirmations (feed, stock, adapter, approval), all test gas.
   - It resumes where it stopped if you close the page.
5. **Icons:** stock icons are Ondo's own token icons, fetched by the server. Their use is covered by Ondo's terms for
   integrators, so check those before mainnet.

## Revenue flywheel wallet (testnets), 1 November 2026

The flywheel keeper buys the top ten tokens by market cap on each testnet and sends them to the dead address, from a
wallet you top up with 10% of the protocol fees the treasury received (`REVENUE_FLYWHEEL.md`).

1. In `elpida-fork`: `node scripts/flywheel-keeper-key.mjs`. It writes `local-data\flywheel-keeper-evm.key` and prints
   only the wallet's public address. Never paste the key anywhere but Railway.
2. In Railway, add the variable `ELPIDA_FLYWHEEL_EVM_KEY` with the file's contents. Railway redeploys.
3. Send that address test ETH / tBNB on each testnet: about 10% of what the treasury received there, plus 0.005 for
   gas. The first cycle runs within a minute of the redeploy, then every 24 hours.
4. Optional variables: `ELPIDA_FLYWHEEL_EVERY_HOURS` (24), `ELPIDA_FLYWHEEL_MAX_PER_CYCLE_ETH` (0.05),
   `ELPIDA_FLYWHEEL_GAS_RESERVE_ETH` (0.005).
## Security review fixes: redeploy the EVM launchpads and upgrade devnet, 1 November 2026

The independent review's fixes (E-1, E-2, E-3, S-1, S-2; details in `AUDIT_SCOPE.md` section 5) are in the source.
The app-side fix (E-2) works as soon as this is merged. The contract fixes only apply to launches on new launchpads,
so tokens already launched keep their current contracts and stay listed and tradable. Testnets only; nothing on
mainnet.

**EVM: done on all four testnets, 2 November 2026.** Malik deployed them, and each factory and adapter was checked on-chain:
it reports `REVIEW_FIXES_VERSION` 1, the treasury `0xf5B0…639D`, a $50 start and automatic graduation. Each one is now
pinned in `packages/core/networks.mjs`, and the previous factories stay indexed as legacy.

| Network | Factory | Pricing turned on (block) |
|---|---|---|
| Base Sepolia | `0x381c26893322cbadFbf83D0f2de69f52aA9Ab94c` | 53536219 |
| Ethereum Sepolia | `0x37Ca07Eb2A14E30051DbF78e4adCc7fBc1430477` | 12048655 |
| BNB Testnet | `0x4CabA05067171DbA4B840aDae1e652B8279dE499` | 140398704 |
| Robinhood Testnet | `0xEC353bfBCb22424aF0fA5E93dFA1728bfE702Ea8` | 147096680 |

Still open on the new launchpads:
- **Test pairs:** press **Add test pairs** again where you use them.
- **Ethereum Sepolia native router:**
  - The ordinary-wallet native router is bound to one factory, so the 1 November router (`0xDDCc…fd41`) serves only the now-legacy factory and is no longer pinned.
  - Until a new one is deployed, native-coin trades of USDC- or stock-paired tokens on the new launchpad need a wallet that can batch.
  - To fix it, after **Add test pairs**, open **Network and test funds → Deploy ordinary-wallet native router**. Then send Claude its address and creation hash to pin.
- **Partner tiers:** re-register active partners, your own Elite tier included, from the Partners tab.

The steps below are kept for reference:

1. On elpida.fun, open **Network and test funds** on that network and connect the **treasury wallet**.
2. Press **Deploy reviewed launchpad**. It deploys a new graduation adapter, then the factory, then turns on USD
   pricing. Test gas only, no deposit.
3. If you use test pairs there, press **Add test pairs** again: the new launchpad gets its own tNVDAon and adapters.
4. Send Claude the factory address and its deployment block for each network, so they can be pinned for every
   visitor. Partner tiers are per launchpad: re-register active partners (your own Elite tier included) on the new
   one from the Partners tab.

**Solana devnet program upgrade: done, 2 November 2026.**
- Malik ran the upgrade; the program data was extended by 10,240 bytes.
- The on-chain program data (`EoihUf…PpcV`, last deployed at slot 517891944) hashes to
  `3caabce1b7019f99244fd8cac4b845edd1b5e8001e0791eef6efcc369927e1c9`. That is exactly the reviewed test build.
- The pair configs and USD pricing were already up to date.

The steps below are kept for reference:

New SHA256 (Solana CLI 2.3.13, reproduced byte for byte from a fresh target): test build
`3caabce1b7019f99244fd8cac4b845edd1b5e8001e0791eef6efcc369927e1c9`, mainnet build
`b3e254cbafdd3d88a634c8989a7c57caa1da6e1ccd6d7d03f04b9c94c9afda7f`.

1. From `elpida-fork`, `git pull`, then check the build:
   `certutil -hashfile contracts\solana\build\elpida_launchpad.so SHA256` must print
   `3caabce1b7019f99244fd8cac4b845edd1b5e8001e0791eef6efcc369927e1c9`.
2. Make sure the deployer `FeUWF…KaH8` holds about **6.5 devnet SOL**. The program grows by about 5 KB (about
   0.04 SOL of rent, kept); the rest is an upload buffer refunded after the upgrade.
3. Run `node scripts/solana-deploy.mjs --upgrade --keypair "C:\Users\HomePC\Desktop\OneForAll\ELPIDA\elpida-v1\local-data\solana-deployer.json"`.
4. Send Claude the output. If the script rewrites `deployments/solana-devnet.json`, do not commit it
   (`git checkout -- deployments/solana-devnet.json`).

## Operator panel (`elpida.fun/#/monkey`), 26 October 2026

A read-only operations view: health and incidents, each factory's treasury balance (native and USDC), launches and
volume, indexers, the price relay, graduation and backups. It cannot send transactions.

- **Sign in** with your wallet on an EVM network: open `elpida.fun/#/monkey`, connect, then "Sign in with this
  wallet" and sign the message (free, no transaction). The server lets in the treasury of any configured factory,
  read from the contract, so on testnets your treasury wallet works with no setup.
- **Optional:** to let in other wallets, add the Railway variable `ELPIDA_ADMIN_ADDRESSES` (comma-separated
  addresses). This is needed on mainnet: the treasury there is a Safe, which cannot sign a message, so list the
  owners' own wallets. Addresses are public; this variable holds no secret.
- Sessions last eight hours and end on every redeploy.
- The page lives at `#/monkey`, not `#/admin`, so it is not the first thing a scanner finds. That only hides the
  door: the lock is the wallet signature, checked by the server on every request. `#/admin` shows "Page not found".

### Visitors tab (`#/monkey?tab=visitors`), 30 October 2026

Opt-in site analytics: visitors, page views, pages, tokens viewed, sources, countries, devices and networks, plus how
many visitors allowed or declined analytics. Only visitors who press "Allow analytics" on the cookie banner are counted.
Details and what is stored: [SITE_ANALYTICS.md](SITE_ANALYTICS.md). Nothing to set up.

- **Terms of Use:** every visitor reads and accepts the Terms (`apps/web/terms.mjs`, also at `#/terms`) before using
  the app. It is a draft written for Elpida: have a lawyer review it before mainnet. It leaves the operating entity,
  governing law and dispute forum to be filled in once decided.
- **Optional, decide with a lawyer before mainnet:** to name places in section 4 (Restricted Persons), add the Railway
  variable `ELPIDA_RESTRICTED_JURISDICTIONS`, comma separated (for example `United States, Canada, United Kingdom`).
  Empty by default; sanctioned places are always listed. It holds no secret.
- Changing the Terms in a way that matters: raise `TERMS_VERSION` and `TERMS_UPDATED` in `apps/web/terms.mjs` so every
  visitor accepts them again.

### Partners tab (`#/monkey?tab=partners`)

Devs apply from the footer link "Partner with Elpida" (`#/partners`). Each application proves its launching wallets
with a free signature and is stored privately on the server (`partner-applications.sqlite` in the data volume).

- **Review:** approve with a tier (Partner or Elite), a window (30 to 90 days; 60 by default) and the chains to
  register, or reject. Notes are visible to other operators. Every action records who did it.
- **Register (you sign):** approval does not touch the chain. For each chain the tab shows the factory's
  `setPartner` call. Connect the treasury wallet on that chain and press "Register with treasury", or paste the call
  into the treasury Safe on mainnet. The tab then reads the factory back and shows "registered".
- **Ending early:** "End partnership", then "Clear with treasury" on each chain. Tokens already launched keep their tier.
- Partner-tier launchpads deployed by Malik on 26 October 2026 and pinned for every visitor; the earlier ones stay
  indexed, so their tokens (VEGETA, MIDORIYA and the rest) stay listed and tradable:

  | Network | Factory | Block | Graduation adapter |
  |---|---|---|---|
  | Base Sepolia | `0xb5dAE15BCCe080a49e8b776E59B3d982269aC74C` | 50624512 | `0xe8280f27…5659` |
  | Ethereum Sepolia | `0x5aA283B8B12786314e76ac4E977B1E9275b407f6` | 12000324 | `0x2a0f0804…b79a` |
  | BNB testnet | `0x5795b25C7fA37638eEacd29848522f8Cd48a1156` | 139102664 | `0x33cef203…b9a6` |
  | Robinhood testnet | `0x4CabA05067171DbA4B840aDae1e652B8279dE499` | 143196574 | `0x8a9f579b…c031` |

  Each was checked on chain: `PARTNER_TIERS_VERSION` 1 on the factory and its adapter, automatic graduation on,
  treasury `0xf5B0…639D`. Solana registration arrives with the program upgrade.

## Cloudflare in front of elpida.fun, 20 October 2026

Nameservers moved from Vercel to Cloudflare; DNS, SSL and the `elpida-fallback` Worker are configured as recorded in
`DEPLOY_RESILIENCE.md`. Redeploys now show Elpida's own "updating" page. Still open for Malik: check the Railway
deploy logs for `backup_disabled`; if present, production has no off-site backups and that must be fixed before mainnet.
Search Console sitemap: Google's live test fetches it; the "Couldn't fetch" row is waiting on Google's refresh.

## Solana SOL pairs graduate to Raydium: devnet program upgrade, 28 October 2026

SOL pairs now graduate into a Raydium CPMM pool on the 1% fee tier; USDC and token pairs keep PumpSwap. Raydium's
pool-creation fee and rent (0.192 SOL) come out of the raised SOL. Tokens already on PumpSwap stay there. Tested on the
local validator against Raydium's real devnet program (`fixtures/raydium_cpmm.so`, sha256 `30a9273d…d8d1`, dumped by
Malik on 27 October). Devnet only; nothing on mainnet.

New SHA256 (Solana CLI 2.3.13, reproduced byte for byte from a fresh target): test build
`5134736605be538111c05991af495028debcc77f2ed536b33ef869c768a45a0d`, mainnet build
`363e69c68ca88466ae09acd37a33ca50eccc925840470d0f7dbdeed8eeb8c7f4`.

1. From `elpida-fork`, `git pull`, then check the build:
   `certutil -hashfile contracts\solana\build\elpida_launchpad.so SHA256` must print
   `5134736605be538111c05991af495028debcc77f2ed536b33ef869c768a45a0d`.
2. Make sure the deployer `FeUWF…KaH8` holds about **7.5 devnet SOL** (faucet.solana.com; it may take more than one
   request). The program grows by about 123 KB, so the upgrade extends it (about 0.86 SOL of rent, kept); about 6 SOL
   is an upload buffer refunded after the upgrade.
3. Run `npm.cmd run solana:deploy -- --upgrade --keypair "C:\Users\HomePC\Desktop\OneForAll\ELPIDA\elpida-v1\local-data\solana-deployer.json"`.
4. Send Claude the output. Do not commit `deployments/solana-devnet.json` if the script rewrites it
   (`git checkout -- deployments/solana-devnet.json`).
5. A first devnet graduation on Raydium: the SOL pair is priced from $5,000 starting FDV, so completing a curve takes
   roughly 60–70 devnet SOL of buys at today's price. Spread over a few wallets, or ask Claude to size a cheaper test.

## Solana partner tiers: devnet program upgrade, 26 October 2026

`contracts/solana/build/*.so` were rebuilt with early-partner tiers (Solana CLI 2.3.13, reproduced byte for byte).
New SHA256: test build `331765ca50908c188126cd167ec7b3a1f93c5c0dd046bc22dc0cf041c0471b4e`, mainnet build
`f469dde710b5d1d6c303cf88af3cdbe4735b8e17471948f1b0325ca7ea5bca1e`. Devnet only; nothing on mainnet.

1. From `elpida-fork`, `git pull`, then check the build:
   `certutil -hashfile contracts\solana\build\elpida_launchpad.so SHA256` must print
   `331765ca50908c188126cd167ec7b3a1f93c5c0dd046bc22dc0cf041c0471b4e`.
2. Make sure the deployer `FeUWF…KaH8` holds about **6 devnet SOL** (faucet.solana.com). The program grows by about
   41 KB, so the upgrade extends it (about 0.3 SOL of rent, kept); the rest is a buffer refunded after the upgrade.
3. Run `npm.cmd run solana:deploy -- --upgrade --keypair "C:\Users\HomePC\Desktop\OneForAll\ELPIDA\elpida-v1\local-data\solana-deployer.json"`.
   It stops before uploading anything if the key is not the upgrade authority.
4. Send Claude the output. The site detects the new program by itself (`partner_tiers_version`): launches then pass the
   creator's partner record, and the Partners tab shows Solana as available.
5. Registering a Solana partner needs the SOL pair's treasury, which on devnet is that same deploy key. Either connect
   it in Phantom (import the key) and press "Register with treasury" in the Partners tab, or run the command the tab
   shows, for example:
   `npm.cmd run solana:partner -- --creator <wallet> --bps 2000 --days 60 --keypair "<path to solana-deployer.json>"`
   (`--status` reads a wallet's tier; `--bps 0 --expires 0` ends one).

Not in this upgrade: spending the quote side of a partner pool's LP-fee share on a PumpSwap buyback. Harvests already
burn the token side and keep the quote side with the pool's LP authority, recorded as `pending_buyback`; the capped
buyback instruction comes next and is checked on devnet, because the local validator lacks pump's fee program.

## Solana binaries rebuilt, 19 October 2026

`contracts/solana/build/*.so` were rebuilt from current source (optional creator buy) with Solana CLI 2.3.13. New SHA256: test build `89d96d53856ba206a8a3a96b0b971d503d6fcfb0dd028587cf654fbc5f6d0b88`, mainnet build `1a1db96d0654a10ffc321e01cd055bd4c807d5ff1ad243bdabe04e02a25f865a`. The hash quoted in item 3 below (`4e96…9623`) belongs to the earlier build. The devnet program has not been upgraded from these yet; that is the next Solana step. See `MAINNET_CHECKLIST_2026-10-19.md`.

## Resuming work — updated 23 October 2026

Read `CODEBASE_CATCHUP_2026-10-23.md` and the latest entries in
`MAINNET_CHECKLIST_2026-10-19.md`. SONGOKU graduation, DEX trades and claims are
recorded complete on 21 October; Ethereum Sepolia is now enabled and pinned.
Next public lifecycle gap is the Base Sepolia USDC pair (A4). Solana binaries
have been rebuilt but still require the devnet upgrade and verification. Tax
launches remain gated. `AGENTS.md` requires fetching and reviewing new work
before continuing a resumed chat.

## Previous test-funds plan (18 October; SONGOKU steps now complete)

SONGOKU's zero-buy launch, buys, sell and shared-wallet fee claim were verified
in this chat. The later A2/A3/A5 evidence closes graduation and post-migration
trading/claims; do not repeat the earlier outstanding-work assumption. See
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

## 3b. Upgrade the Solana devnet program to the 19 Oct build (checklist B1) — done, 23 October 2026

Done from `elpida-fork` with the original deployer passed directly:
`npm.cmd run solana:deploy -- --upgrade --keypair "C:\Users\HomePC\Desktop\OneForAll\ELPIDA\elpida-v1\local-data\solana-deployer.json"`.
The program printed `Program upgraded.` Then run `git checkout -- deployments/solana-devnet.json` so the record keeps the
published TEST-MEME mint (that run created a duplicate test mint; scripts now reuse the published ones). The steps below
are kept for the next upgrade.


The 23 Oct attempt from `elpida-fork` stopped because the program's keys live in `elpida-v1`. Two private files matter;
never paste, commit or share either:

- `local-data/solana-deployer.json` is the deployer `FeUWF…KaH8`, the program's **upgrade authority**. Only it can upgrade.
- `contracts/solana/keys/elpida_launchpad-keypair.json` is the program keypair. It is only needed for a brand-new
  deployment; upgrades now use the program address from the source.

1. **Pull first** (`git pull` in `elpida-fork`). The 23 Oct second attempt still ran the old script (its error points
   at line 64), so the fix in #74 was not on the PC yet.
2. **Find the original deployer.** It is not at `..\elpida-v1`. Search the Desktop for every copy:
   `Get-ChildItem $HOME\Desktop -Recurse -Filter solana-deployer.json -ErrorAction SilentlyContinue | Select-Object FullName`
   Then print only the public address of each one (this never shows the secret):
   `node -e "const w=require('@solana/web3.js');console.log(w.Keypair.fromSecretKey(Uint8Array.from(require(process.argv[1]))).publicKey.toBase58())" "<full path>"`
   The one that prints `FeUWF…KaH8` is the upgrade authority. Ignore `elpida-fork\local-data\solana-deployer.json`:
   it is the empty keypair the first attempt created.
3. Copy it over the empty one: `Copy-Item "<full path>" .\local-data\solana-deployer.json -Force`. If none prints
   `FeUWF…KaH8`, stop and tell Claude: the program cannot be upgraded without it (a fresh program would be deployed
   instead, about 5.8 devnet SOL).
4. Check the build: `certutil -hashfile contracts\solana\build\elpida_launchpad.so SHA256` must print
   `89d96d53856ba206a8a3a96b0b971d503d6fcfb0dd028587cf654fbc5f6d0b88`.
5. Make sure `FeUWF…KaH8` holds about **5 devnet SOL** (faucet.solana.com); most of it is a temporary buffer refunded
   after the upgrade.
6. Run `npm.cmd run solana:deploy -- --upgrade`. It prints the deployer and program first. If the deployer is not the
   upgrade authority, it stops before uploading anything and says which address is.
7. Send Claude the output.

## 3c. Squads multisig rehearsal on devnet (checklist C3) — done, 24 October 2026

Run by Malik and read back from devnet: every step passed (transactions in the checklist, C3). Kept below for a rerun.

Proves, before mainnet, that a 2-of-2 Squads vault controls program upgrades. It uses a **throwaway copy** of the
program; the live devnet program (`ANkA5…`) is never touched. Devnet SOL only, and all of it except fees comes back.

1. Top up the devnet deployer `FeUWF…KaH8` to about **7.5 devnet SOL** at faucet.solana.com (it had 6.59 on 24 Oct).
2. From `elpida-fork`, after `git pull`:
   `node scripts/squads-devnet-trial.mjs --keypair "C:\Users\HomePC\Desktop\OneForAll\ELPIDA\elpida-v1\local-data\solana-deployer.json"`
3. It installs Squads' SDK once into a temporary folder, then:
   - deploys the throwaway program;
   - creates a 2-of-2 multisig (the deployer plus a second key it saves in `local-data/squads-trial`);
   - hands the upgrade authority to the vault and checks the deployer alone is refused;
   - proposes an upgrade, checks one approval is not enough, approves with both and executes;
   - hands authority back through Squads, then closes the throwaway program to return its rent.

   An interrupted run resumes where it stopped.
4. Send Claude `local-data/squads-trial/state.json` (addresses and signatures only). Never send the other files in that
   folder: they are keys.

## 3d. Robinhood Chain testnet: test DEX, relayed price, then a launch — open

Robinhood's testnet has no Uniswap v3 and no Chainlink feed, so the site deploys labelled test copies
(`MULTICHAIN_TESTNETS.md`, "Robinhood Chain testnet"). Test ETH only.

1. **Relay key (testnet only).** In PowerShell:
   `node -e "console.log('0x'+require('crypto').randomBytes(32).toString('hex'))"`
   Add it on Railway as the variable `ELPIDA_TESTNET_RELAY_KEY`. Never paste it anywhere else, and never use it for
   anything but this relay. Railway redeploys; the relay's address then shows on
   `https://elpida.fun/api/public/status` under `relay.address` (an address, safe to share).
2. **Test ETH.** At `faucet.testnet.chain.robinhood.com`, send 0.01 test ETH to your wallet (`0xf5B0…639D`). For the
   relay wallet, use the faucet again the next day, or send it 0.002 test ETH from your wallet (enough for years of
   price posts at 0.01 gwei).
3. **Deploy the test DEX and price feed.** On elpida.fun: Network and funds → Robinhood Chain Testnet → connect your
   wallet → **Set up test DEX and price feed** (6 confirmations). An interrupted setup resumes. Send Claude the
   addresses it shows. **Done 24 Oct**; registered (addresses in `MULTICHAIN_TESTNETS.md`). Fund the relay
   `0x3d060E857f39665D672472A8F82e18FdfAF994FC` with about 0.002 test ETH so it can post prices.
4. Claude registers them (a PR). After it deploys: **Set up launchpad**, then launch a test token as on the other
   testnets. Completing a curve takes about $130 of test ETH in total (about 4 to 5 days of faucet); launching and
   trading need far less.

## 4. Turn on `hope` mint addresses (optional)

Add a Railway variable `ELPIDA_VANITY_KEY` with 32 random bytes as 64 hex characters (in PowerShell: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`). Keep a copy only if you want existing pre-ground keys to survive a key change; losing it just means they are ground again. After the redeploy the server grinds about one `hope` address every 9 minutes per CPU core in the background (three are kept ready; `ELPIDA_VANITY_TARGET` and `ELPIDA_VANITY_WORKERS` change that). Until one is ready, launches use a random address and say so.

## Not needed for Phase 1

No API keys, Railway variables or Solana actions are needed for Phase 1. Solana items arrive with Phase 2.
