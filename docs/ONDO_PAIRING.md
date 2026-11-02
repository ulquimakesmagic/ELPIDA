# Ondo stock quote pairing — groundwork, 2026-10-28

## Update, 2 November 2026: first stocks, chains, picker

**First stocks: TSLAon and SPYon on Ethereum (decided by Malik, 2 November).** They replace NVDAon as the first targets.
- **Feeds exist:** Chainlink feeds for TSLAon, SPYon and QQQon are live on Ethereum, and Euler accepts the tokens as
  collateral against them. We found no NVDAon feed on Ethereum.
- **Still open:** which variant to use (Ondo API or Calculated), and where the corporate-action status is published.
  Both questions are in `ONDO_PROVIDER_QUESTIONS.md`, to be sent by Malik.
- **The fork rehearsal records both variants:** `scripts/equity-lifecycle-fork.mjs` reads each candidate feed at the
  fork block, with its price, its age against the heartbeat and the spread between the two variants. It approves none.

**Chains:**
| Chain | Ondo stocks | Status |
|---|---|---|
| Ethereum | Native (TSLAon, SPYon, NVDAon in the registry) | First. Feeds exist; NVDAon rehearsed on a fork on 28 Oct; TSLAon and SPYon next |
| BNB Chain | Native (same three in the registry) | Second. No Ondo feed found yet; fork untested |
| Robinhood Chain | Selected stocks, bridged | After a feed is confirmed. Our earlier fork tests there used Robinhood's own stock tokens |
| Base | No canonical Ondo stock token | Not planned for Ondo (Coinbase's tokenized stocks are a separate provider) |
| Solana | Token-2022 mints with issuer extensions | Not now. See "What Solana needs" below |

So stock pairing is not "every chain except Solana". It is Ethereum first, then BNB, then Robinhood Chain once each has
a feed and a passing fork rehearsal. Base has no Ondo stocks to pair with.

**What Solana needs** (a separate project, several weeks):
1. **A decision:** an exception to "new Solana launches pair with SOL only" (1 November) for stock pairs.
2. **The program:** Token-2022 quote vaults and transfers (`transfer_checked`, plus the extra accounts a transfer hook
   needs), with an allowlist of the issuer extensions we accept (pausable, permanent delegate, default account state).
3. **A graduation venue that accepts those mints.** Raydium CPMM's support for these extensions is unverified. Meteora
   DAMM v2 lists xStocks, which carry a permanent delegate, so it would be the candidate venue.
4. **A reference feed on Solana** for the corporate-action and stale-price gate.
5. **Before any upgrade:** a labelled Token-2022 stand-in on devnet, then a program upgrade (devnet SOL) and the added
   code in the audit scope.

**The picker** (`apps/web/stock-picker.mjs`) is a searchable dropdown, so it scales to Ondo's full list:
- **The button** shows the chosen stock: its icon, symbol, Stock/ETF, company and the number of stocks available.
- **The list** has a search box that matches the ticker, the symbol or the company name, and supports arrow keys,
  Enter and Escape. Only stocks the launchpad has approved are listed.
- **Icons:** Ondo's own token icons, through `/api/public/stock-icon/<SYMBOL>.png`. A test stand-in shows the icon of
  the stock it imitates, with a flask badge and a Test label. Without an icon, the stock gets a ticker tile.
- **Catalog:** company names and types come from Ondo's public asset list (476 assets on 2 November 2026, 473 of them
  stocks, ETFs or funds). The server fetches it every 6 hours and caches it on the volume (`/api/public/stock-catalog`).
  It is display only.
- **Test stand-ins:** testnets now have five Ondo-style stand-ins (tNVDAon, tTSLAon, tSPYon, tQQQon and tAAPLon)
  after **Add test pairs**.
- **Mainnet:** each real stock still needs its own approval on the launchpad, once its feed and checks pass.

Update, 29 October: a [testnet Ondo-style stock pair (tNVDAon)](TESTNET_ONDO_STOCK.md) lets stock-paired launches, the issuer pause and blocklist, and the graduation price gate be tried end to end on Ethereum Sepolia and BNB Testnet. It is a labelled stand-in with no value; live Ondo pairing stays off.

This phase adds Ondo as an explicitly selected provider alongside existing providers on Ethereum, BNB Chain, Solana and Robinhood Chain. It does not activate public stock launches, change Model 10, change wallet selection, or submit transactions. Base is not included. Nine issuer-sourced canonical records are imported: NVDAon, TSLAon and SPYon on Ethereum, BNB and Solana. Ticker matching and third-party address lists are insufficient. Contract transfer and price semantics remain unverified.

The public discovery endpoint accepts `provider=ondo`, for example `/api/public/tokenized-equity?network=ethereum&provider=ondo`. Omitting the provider retains existing defaults. Discovery lists the imported assets with every capability disabled. These are not launch options. Mainnet Ondo addresses cannot be resolved through testnet aliases.

## What pairing means

An ELPIDA token/Ondo-stock pool holds actual stock tokens as its quote reserve. This is different from periodically buying stocks with creator rewards. Launch quote reserves, secondary trading, graduated pools, reward conversion, reward distribution and direct issuance/redemption retain separate capability gates. Verifying one does not enable another.

Ondo's technical documentation lists Ethereum, BNB Chain and Solana, plus selected bridged stocks on Robinhood Chain and HyperEVM. HyperEVM is outside ELPIDA's current network registry. The October 27 Robinhood announcement describes Uniswap v4 StablePair pools between matching stock tokens; those pools do not establish compatibility with ELPIDA's token/stock graduation route.

## Next verification phase

1. Address discovery complete for NVDAon, TSLAon and SPYon on Ethereum, BNB and Solana. Confirm the exact deployment bytecode and issuer control roles. Do not copy mainnet assets into testnet configuration.
2. Confirm raw transfer behavior, corporate-action accounting, freeze/pause/upgrade powers and the proposed curve, router and pool contracts' ability to hold and transfer each asset. Solana needs extension-aware venue checks independently from EVM.
3. Establish fresh total-return pricing and executable liquidity checks. A stock's quoted market price is not necessarily an executable swap price. Do not apply dividend/display scaling twice or assume all operations remain available outside market hours.
4. Rehearse launch without creator purchase, buy, sell, curve completion, automatic graduation, post-graduation swaps and fee claims against a pinned fork. Check issuer pauses, stale prices, failed transfers and conservation of raw reserves. Existing local ERC-20 lifecycle tests are harness evidence only, not Ondo approval.
5. Resolve jurisdiction and contract-custody eligibility, then record per-asset, per-chain capability evidence before enabling any flag. Nigeria remains unconfirmed. Direct issuer onboarding and secondary-market eligibility are distinct requirements.

## Primary sources

- https://docs.ondo.finance/ondo-stocks/technical
- https://docs.ondo.finance/ondo-stocks/corporate-actions
- https://docs.ondo.finance/ondo-stocks/eligibility
- https://docs.ondo.finance/ondo-stocks/secondary-market-restrictions
- https://ondo.finance/blog/ondo-stocks-live-on-robinhood-chain-and-uniswap

The shared conversation is background context, not evidence of an Ondo partnership or permission to distribute securities.

## Address discovery and fork rehearsal

`node scripts/ondo-assets.mjs` fetches official issuer asset pages and writes `backups/ondo-address-review.json` for review. It does not edit the registry. The parser reads structured asset records rather than arbitrary page addresses, checks chain identity, and rejects redirects, duplicates and conflicting records. The nine registry records were retrieved with this tool on 28 October.

The local-only EVM runner accepts:

```powershell
$env:ELPIDA_EQUITY_FORK_RPC = '<read-only archive RPC URL>'
$env:ELPIDA_EQUITY_HOLDER = '<existing funded holder address>'
node scripts/equity-lifecycle-fork.mjs ethereum NVDAon ondo
```

Use `bnb` for the BNB deployment. The holder is impersonated only inside Hardhat; no wallet or private key is used. Upstream calls read chain ID, block height and balances. All contract deployment, funding transfers, trades and graduation occur on the local fork at the recorded upstream block. Reports include network, provider, symbol, address and source. Ondo mode uses the atomic factory, publishes test metadata and launches with no creator purchase. This checks transfer/pool compatibility, not issuer eligibility or a production oracle.

The initial public archive endpoints returned HTTP 403. Subsequent real Ethereum NVDAon testing succeeded through an authenticated archive RPC on 28 October. The evidence below supersedes that access blocker for this one asset and snapshot. BNB and Solana remain untested; no stock-pair capability or deployment flag was enabled.

## Local validation

28 focused registry/discovery/accounting tests, 10 API integration tests and three local EVM lifecycle tests pass (41 total, no skips). Lifecycle coverage includes legacy 6-decimal quotes and atomic graduation with zero creator buy at both 6 and 18 decimals. The 18-decimal check caught a missing quoteDust term in the rehearsal balance assertion; conservation now includes separately recorded migration dust without changing any production contract.

The earlier broad suite finished with 534 passes, 30 environmental skips and no failures, before the cached-runner changes. The current focused strict gate passes 37 tests with no skips, covering RPC cache behavior, discovery, provider isolation and mock lifecycle checks. The cached-runner broad suite subsequently completed with 552 passes, zero failures and 33 missing-Solana-validator skips on Windows; the skips do not establish Solana execution coverage. Issuer-control, oracle and eligibility checks remain open.

## Real NVDAon fork result and repeatable runs

The next phase's read-only issuer observations and valuation guard are documented in [ONDO_CONTROLS_AND_PRICING.md](ONDO_CONTROLS_AND_PRICING.md). They do not enable live pairing or configure a production stock feed.

[ondo-ethereum-nvda-lifecycle-2026-10-28.json](evidence/ondo-ethereum-nvda-lifecycle-2026-10-28.json) records 15 passing checks at Ethereum block **26294021**, hash `0xa006d5da3793e8f9b02ba124eb3ec3d918ee764e318220d1d0a2b4d5cef7225c`. The quote is the issuer-listed NVDAon contract `0x2d1f7226bd1f780af6b9a49dcc0ae00e8df4bdee`. It covers zero creator purchase, exact buys/sells and curve fees, atomic graduation, migration dust, price continuity, permanent LP custody, pool swaps, fee collection and exact 50/50 creator/treasury pool-fee claims on both assets.

This is an ELPIDA deployment and a local Uniswap v3 deployment on a mainnet fork. It is not a public deployment or a test of liquidity in an existing public pool. The rehearsal uses 20 stock tokens as a virtual quote reserve and a mock native USD feed; it does not verify a production stock oracle, issuer admin controls, future corporate actions, restricted recipients, partner buyback tiers or legal eligibility. No live verification records were added to the registry.

Run from the repository root, with the archive URL configured locally:

```powershell
$env:ELPIDA_EQUITY_HOLDER = '0x3cd7caa5109d1634b5EA7DC9D469314439981a69'
node --env-file=.env.ondo.local scripts/equity-cached-fork.mjs ethereum NVDAon ondo
```

The supervisor remembers a pin under `cache/equity-rpc/` and verifies that block's hash against the upstream before each run. `--fresh` chooses new state. `ELPIDA_EQUITY_FORK_BLOCK` explicitly selects a block. Never treat cached checks at an old block as a current issuer-status check.

Only reads with an explicit pinned block are cached. They are forwarded by canonical block hash and stored in a chain/hash namespace with checksums; identical in-flight reads coalesce. Mutable tags and failures are not cached. URLs and credentials are excluded from cache entries. The loopback gateway refuses transaction methods; all writes run in the child Hardhat simulation. The final replay used eight upstream reads and 4,983 cache hits with no upstream failures.

Each upstream request has a 25-second deadline. The default rehearsal limit is 300 seconds (`ELPIDA_EQUITY_FORK_TIMEOUT_SEC`, maximum 3600). The supervisor stops a timed-out child and records **INCOMPLETE**, preserving completed check results. Rerunning starts a new local simulation using the same cached upstream state. A five-second interruption was verified to produce INCOMPLETE rather than PASS. Reports and caches stay in ignored directories; publish only reviewed, credential-free evidence.
