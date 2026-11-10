# Actions that need Malik

## USDC payouts for the trader airdrop and holder rewards (EVM test networks), 10 November 2026

After the USDC payouts PR is merged and Railway has redeployed, on each EVM test network (Base Sepolia, Ethereum
Sepolia, Robinhood Chain testnet; BNB Chain testnet has no SwapRouter02, so it keeps paying in kind for now):
1. Operator panel → Launchpads → switch to the network → V2 card → **Deploy USDC payout distributors** (2 confirmations).
2. Send me the two addresses it shows (`usdcAirdrop`, `usdcHolder`) to pin in `networks.mjs`.
3. For assets you want converted, make sure a Uniswap v3 pool to USDC (or to WETH) has liquidity, e.g. the test stock
   tNVDAon. Without one, that asset stays in its vault and the keeper card says so; nothing is lost.
Rounds already posted keep paying as before. The flywheel is unchanged.

## Optional: X sign-in for X allocations (V2 test networks)

Website allocations verify with a DNS record and need nothing from you. To let X account owners claim their share:
1. Create an app at developer.x.com with OAuth 2.0 (read-only scopes: tweet.read, users.read).
2. Set its callback URL to `https://elpida.fun/api/rewards/x/callback`.
3. In Railway add `ELPIDA_X_CLIENT_ID`, `ELPIDA_X_CLIENT_SECRET` and `ELPIDA_X_REDIRECT_URI=https://elpida.fun/api/rewards/x/callback`.
Until then X shares stay held in their allocation contract (nobody can take them).

## ELPIDA V2 on Solana devnet: upgrade and set up, after step 4a is merged

The program in `contracts/solana/build` carries ELPIDA V2 steps 1 to 3 (V2 pairs, `launch_v2`, the five-way fee ledger,
graduated-pool harvests, reward rounds and the flywheel; docs/V2_0_SOLANA.md). Existing Solana tokens keep trading as
before. The deployer wallet `FeUWFps7CYtrXNXosirwJCfFQM5Na6PamEV6hpFcKaH8` already holds the 10 devnet SOL it needs
(most of it comes back after the upgrade; about 2 SOL stays as rent for the larger program). In your ELPIDA folder
(PowerShell), after `git pull`:

1. Check the build: `certutil -hashfile contracts\solana\build\elpida_launchpad.so SHA256` must print
   `54b53d5411cbf3373d6dcadf25855317ef256e37a6597d62233cf2fd3238e8ce`. (Mainnet build, not deployed:
   `3e0977f6ccaccdbc9a2f2a40e754fb157d10f355f2c2dc1c7884f78445473838`.)
2. Create the keeper's Solana key: `node scripts/solana-keeper-key.mjs`. It prints the keeper address and where the key
   file is (`local-data\solana-v2-keeper.json`). Never send the file to anyone.
3. Send that keeper address about 1 devnet SOL (it pays network fees and round accounts; reward funds never pass
   through it).
4. Upgrade and set up V2 in one run:
   `npm.cmd run solana:deploy -- --upgrade --v2 --keeper <keeper address> --keypair "C:\Users\HomePC\Desktop\OneForAll\ELPIDA\elpida-v1\local-data\solana-deployer.json"`
   It upgrades the program, creates the V2 SOL pair (1.00% minimum fee, $50 → $250 test curve) with USD pricing, and
   the monthly airdrop and weekly holder distributors run by the keeper. It writes `deployments/solana-devnet.json`.
5. Commit and push `deployments/solana-devnet.json` (or send it to Claude to commit), so the site offers V2 on Solana.
6. In Railway, add `ELPIDA_V2_KEEPER_SOLANA_KEY`: open `local-data\solana-v2-keeper.json` and paste its whole content
   (a list of numbers) as the value. Step 4b's keeper uses it for payouts, rounds and the flywheel.

## ELPIDA V2 on Robinhood Chain testnet, 9 November 2026

Robinhood Chain testnet has no Uniswap v4, so V2 there runs on a labelled test copy of Uniswap's own PoolManager (the
published v4-core 1.0.2 contract, unchanged), exactly as on BNB Chain testnet. USD pricing comes from the relay feed
the server already keeps (Chainlink ETH/USD copied from Base Sepolia). Tokens on it trade through Elpida's router only;
Uniswap's site and aggregators do not route to a test copy. Mainnet needs Uniswap's own v4 deployment on that chain.

After this PR is merged and Railway has redeployed:

1. Operator panel (`elpida.fun/#/monkey`), **Launchpads** tab, switch to Robinhood Chain Testnet and connect the
   deployer wallet (it needs some test ETH; the faucet is in the **Test funds** tab).
2. Press **Deploy test PoolManager (1 confirmation)**.
3. Then **Deploy ELPIDA V2 test launchpad** (10 steps, resumable), as on the other chains.
4. Optional: **Approve test stocks as V2 pairs**.
5. Send Claude the test PoolManager address and the V2 deployment JSON the page shows, to be pinned.
6. Send the keeper wallet (`0x95d3…5124`) a little Robinhood testnet ETH for gas.

## Model 11 retired for new launches, 9 November 2026 — nothing to do

Malik decided Model 11 is no longer needed: ELPIDA V2 is built on the same Uniswap v4 design (one pool, liquidity locked
from the first trade) and replaces it. The operator panel no longer offers the Model 11 card (deploy, test-stock
approvals), and the launch form no longer offers Model 11. Its pinned launchpads on Base Sepolia, Ethereum Sepolia
and BNB testnet stay indexed, so tokens already launched on them keep trading, charting and paying fees. The
sections below about Model 11 are history. The BNB testnet test PoolManager stays: V2 needs it there.

## Model 11 stock pairs on BNB Chain testnet, 6 November 2026

After this PR is merged and Railway has redeployed:
1. Open the operator panel, **Launchpads** tab, on BNB Chain testnet, with the treasury wallet (`0xf5B0…639D`).
2. Under **Test stock pairs** in the Model 11 card, press **Approve tNVDAon for Model 11** (one confirmation each;
   the other test stocks the same way). It starts at the same price as on Model 10.
3. Launch with **Launch model: Model 11 test** and the tNVDAon pair, with a small first buy in tNVDAon (get some from
   the **Test funds** tab). Then buy and sell it.
4. Optional: pause tNVDAon in the Pairs tab. Trades should stop with the reason and fees stay held. Unpause it, and
   trades and fee payouts resume.

## Model 11 on BNB Chain testnet, and test funds moved to the operator panel, 6 November 2026

**Done, 6 November 12:15.** Pinned in `networks.mjs`: test PoolManager `0x251E30304241c21d76219e56f3611d8b53F03a13`
(block 141138906), factory `0xA05eEe6f4443707EF6a88D4aE478c297342C0fd2`, hook `0x11C491F546491259f6B017E95fd918bBA7dC28CC`,
router `0xA2DC3f5Ae12811404a4667C147c60D46748865fB`, from block 141139092. Once Railway has redeployed, launch a small
Model 11 token on BNB Chain testnet and buy and sell it.

BNB Chain testnet has no Uniswap v4 (Uniswap deployed it on BNB mainnet only), so Model 11 there runs on a labelled
test copy of Uniswap's own PoolManager (the published v4-core 1.0.2 contract, unchanged). After this PR is merged and
Railway has redeployed:

1. Operator panel (`elpida.fun/#/monkey`), **Launchpads** tab, switch to BNB Chain testnet and connect the deployer
   wallet (it needs some tBNB; the faucet is now in the **Test funds** tab).
2. Press **Deploy test PoolManager (1 confirmation)**.
3. Then **Deploy Model 11 test launchpad (about 7 confirmations)**.
4. Send Claude what the page shows (PoolManager, factory, hook, router, block) to be pinned.

Test funds (the gas faucet, the test pair assets and Circle's test USDC) are now only in the operator panel's
**Test funds** tab. The public Network and wallet dialog keeps the network choice and the wallet connection.

## Model 11 test launchpad (Uniswap v4) on Base Sepolia and Ethereum Sepolia, 6 November 2026

**Done, 6 November 11:09.** Both test launchpads are deployed and pinned in `networks.mjs`:
- Ethereum Sepolia: factory `0x1136B6D2410b1B32Ec6039aD92a0B110A934aCE9`, hook `0xbe3C898140D32DFcAa1DeE5B1BaDE36BCe4B68cC`, router
  `0xC5FA99cFd6c752199BCb37f9dEF3fb94279b7B3c`, from block 12075675;
- Base Sepolia: factory `0x70e5E07a4EBBCcE5144DEd022a1ADE2019538Da3`, hook `0x8D4342B2fB2E52822CD6c4ceECb4628b1B90e8cC`, router
  `0x1136B6D2410b1B32Ec6039aD92a0B110A934aCE9`, from block 55188766.

The Ethereum Sepolia run stopped twice on lagging RPC nodes (after the hook, and at the third signature with "replacement
transaction underpriced"); both are handled now. Once Railway has redeployed, try step 4 below.

Model 11 keeps the launch curve inside one Uniswap v4 pool, with its liquidity locked from the first trade. It is not
audited: test networks only, and every Model 11 token is labelled as a test. Nothing here touches mainnet or the
Model 10 launchpads, which keep working as before. After this PR is merged and Railway has redeployed, on each of
Base Sepolia and Ethereum Sepolia:

1. Open the operator panel (`elpida.fun/#/monkey`), sign in, and open the **Launchpads** tab (6 November: every
   launchpad deployment moved there; visitors no longer see setup buttons). Switch to the network and connect the
   deployer wallet: it becomes this launchpad's treasury and needs a little test ETH for gas (about 0.05).
2. Press **Deploy Model 11 test launchpad (about 7 confirmations)**: the CREATE2 deployer, the factory ($50 starting
   FDV, token details required), the hook, connecting the hook, USD pricing, the USDC pair, then the router. The page
   first spends a few seconds finding the hook's address (its last bits are its Uniswap v4 permissions). If a step is
   rejected or fails, press the button again: finished steps are kept.
3. Send Claude the addresses the page shows (factory, hook, router, block). Claude pins them in
   `packages/core/networks.mjs` (`v4.shared`), so the site lists Model 11 tokens for every visitor.
4. Then try it: on the launch form, under **Launch model**, choose **Model 11 test · Uniswap v4**, launch with a small
   first buy, then buy and sell on the token page.

Uniswap's own v4 PoolManager is used on each network (Base Sepolia `0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408`,
Ethereum Sepolia `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543`); the page checks it has code before deploying.

## Pay in SOL for Solana stock pairs on devnet, 5 November 2026

**Status, 5 November 22:40:** the devnet program is upgraded (step 2 done). That run created a second tTSLAon
(`EmRwecYo…AxwpS`) because the local deploy state had lost the first one; the scripts now always reuse the published
mint. The tTSLAon to use stays `HE4LBuPDgFQCHT88Z4UMh62xKoJaTAQuzNHjAvCkHjYd` (ISSHIKI is paired with it); the second
one is an unused test token. For step 3, in PowerShell type the price itself, without `<` `>`:
`git checkout -- deployments/solana-devnet.json`, `git pull`, then
`node scripts/seed-solana-conversion.mjs --stock-usd 440 --mint HE4LBuPDgFQCHT88Z4UMh62xKoJaTAQuzNHjAvCkHjYd --dry-run --keypair <deploy key path>`
(440 is only an example: use Tesla's share price now), and the same without `--dry-run`.


No devnet DEX accepts Ondo-shaped mints, and Jupiter does not run on devnet, so the program's test build now has its
own small SOL/stock conversion pool. The mainnet build refuses it; on mainnet the same payments will go through
Jupiter. Two steps, both with the deploy key, after this PR is merged:

1. `git pull`, then check the build: `certutil -hashfile contracts\solana\build\elpida_launchpad.so SHA256` must print
   `469fe201f86f9297f9431cd7d912d018d034f909395645536742b348d6100f78`. (Mainnet build, not deployed:
   `cc522b88b97554235b3412d5bca8f40ee6513b735a12414d2c850b688739b0de`.)
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

The steps below are kept for reference:

1. On elpida.fun, open **Network and test funds** on that network and connect the **treasury wallet**.
2. Press **Deploy reviewed launchpad**. It deploys a new graduation adapter, then the factory, then turns on USD
   pricing. Test gas only, no deposit.
3. If you use test pairs there, press **Add test pairs** again: the new launchpad gets its own tNVDAon and adapters.
4. Send Claude the factory address and its deployment block for each network, so they can be pinned for every
   visitor.

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

### Partner programme: retired, 9 November 2026

Malik retired the partner programme. The "Partner with Elpida" form, its page (`#/partners`), the admin Partners tab
and the partner tags on Explore and token pages are gone, along with the application endpoints. Tokens launched with a
tier keep it on chain (their contracts are immutable) and the buyback keeper still burns their share; the site no longer
labels them. `partner-applications.sqlite` stays in the data volume untouched; delete it there if no longer wanted.

In their place, Explore cards and token pages tag any token the flywheels have bought and burned with the share of its
1B supply burned so far (V2 flywheel vault burns plus the Model 10 flywheel keeper's).

- Launchpads deployed by Malik on 26 October 2026 and pinned for every visitor; the earlier ones stay
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

## 3e. ELPIDA V2 on a test network (keeper, deploy, pin) — open

1. In Railway, set `ELPIDA_V2_KEEPER_KEY` to a **new** test-network key used for nothing else. Do not reuse the treasury
   or relay key, and never paste it into chat. Optionally set `ELPIDA_EXPLORER_API_KEY` (an Etherscan API key) so
   linked wallets are found by their funder. Redeploy.
2. Send test gas to the keeper address. The operator panel shows it in the V2 card once step 1 is done.
3. Operator panel → Launchpads → the network → **Deploy V2 test launchpad**. Keep the minimum fee at 1.00% unless you
   decide otherwise.
4. Send the JSON the card shows (factory, hook, router, airdrop, holder, flywheel, keeper, block, minFeeBps). It is
   pinned in `networks.mjs` as `v2.shared`. V2 then lists, trades and shows Rewards for everyone, and the keeper starts.
5. Still to decide: the holder payout threshold ($0.25 on test networks for now), the mainnet minimum fee, and
   confirming the assumed holder blend and linking rule (docs/V2_0_KEEPERS.md).

## 4. Turn on `hope` mint addresses (optional)

Add a Railway variable `ELPIDA_VANITY_KEY` with 32 random bytes as 64 hex characters (in PowerShell: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`). Keep a copy only if you want existing pre-ground keys to survive a key change; losing it just means they are ground again. After the redeploy the server grinds about one `hope` address every 9 minutes per CPU core in the background (three are kept ready; `ELPIDA_VANITY_TARGET` and `ELPIDA_VANITY_WORKERS` change that). Until one is ready, launches use a random address and say so.

## Not needed for Phase 1

No API keys, Railway variables or Solana actions are needed for Phase 1. Solana items arrive with Phase 2.
