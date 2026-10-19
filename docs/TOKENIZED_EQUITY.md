# Tokenized stocks and ETFs, 19 October 2026

Supersedes the xStocks-versus-Dinari plan. Dinari is not an integration target. This is research plus reversible groundwork. **No live capability is enabled, no contract was deployed, no funded transaction was made, and Elpida has no partnership with any provider.** Sources below were read on 19 Oct 2026; third-party articles are marked and are not treated as canonical.

## Provider mapping (one per network, no substitution)

| Network | Provider | Balance model |
|---|---|---|
| Ethereum | xStocks (Backed Finance) | Rebasing: `balanceOf()` already includes corporate actions |
| Solana | xStocks | SPL Token-2022 Scaled UI: raw balance constant, display = raw x multiplier |
| Robinhood Chain | Robinhood Stock Tokens | ERC-20 + ERC-8056 `uiMultiplier()`; oracle price includes the multiplier |
| BNB Smart Chain | Binance bStocks (BTech Holdings, ADGM) | BEP-20 + BEP-677 Scaled UI Amount |
| Base | Coinbase Tokenized Stocks | B20 precompile; WAD multiplier; Chainlink feeds are total-return (include the multiplier) |

Code: `getAsset(network, provider, address)` throws if the provider is not the designated one.

## Verified capability matrix

"Documented" means a provider page says something relevant. "Verified" would mean we tested it against the real contracts and have written provider confirmation. **Nothing is verified**, so every cell is OFF in code. The matrix records what stands in the way.

Legend: ? = unknown from the pages read. The six capabilities are independent flags per asset.

| Capability | Ethereum / Solana (xStocks) | Robinhood Chain | BNB (bStocks) | Base (Coinbase) |
|---|---|---|---|---|
| Launch quote reserve | OFF. Addresses not retrievable; transfer rules for non-whitelisted contracts ? | OFF. Addresses only in a live onchain table; chain id ? | OFF. No address list found | OFF. Addresses published; issuer transfer policy must allow the curve contract (`isAuthorized`) |
| Secondary trading | OFF. Third-party venues exist (Luno); DEX status ? | OFF. DEX availability ? | OFF. Binance spot documented; DEX ? | OFF. Page names Aerodrome, 1inch, 0x, Aave etc.; not tested by us |
| Graduated pool | OFF. Solana: PumpSwap refuses permanent-delegate mints; Meteora DAMM v2 path unbuilt | OFF. No known pool venue | OFF. PancakeSwap tradability ? | OFF. Raw-balance pool accounting vs multiplier untested |
| Reward conversion | OFF. Needs a verified pool and a fresh price | OFF | OFF | OFF. Chainlink feeds exist and are documented |
| Reward distribution | OFF. Whitelisting of recipient wallets ? | OFF. Sequencer filtering and pause roles | OFF. Issuer rules ? | OFF. Blocklist policy can revert transfers; handled by the ledger |
| Issuance / redemption | Not an Elpida feature. KYC/AML, whitelisted wallets, 24/5 | Not an Elpida feature. Authorised Participants (KYB), Mon 02:00 to Sat 02:00 CET | Not an Elpida feature. Via Binance | Not an Elpida feature. Authorized Participants only |

Per provider, what the pages say (details and URLs are in `config/tokenized-equity-registry.json`):

- **xStocks.** Docs: docs.xstocks.fi (overview, developers, dividends and stock splits, issuance and redemption). Corporate actions via a multiplier, activated at 00:30 UTC the day after ex-date; the docs advise pausing interactions briefly around activation. Primary market needs issuer KYC/AML and whitelisted wallets. Not offered to US persons or prohibited jurisdictions; the list is in assets.backed.fi legal documentation (not read). No addresses on the pages read. Pause/freeze/upgrade powers not documented there.
- **Robinhood Chain.** Docs: docs.robinhood.com/chain/stock-tokens and /contracts. 18 decimals, per-asset Chainlink feed, mint/burn windows Mon 02:00 to Sat 02:00 CET/CEST, not offered to US persons. The contracts page lists only WETH and USDG statically; stock tokens load from the onchain registry. Third-party analysis (Beosin, secondary) says the contract is upgradeable with pause layers and 13 roles, and sequencer-level filtering can reject transactions involving listed addresses. A TSLA address in that article was **not** copied into the registry.
- **Binance bStocks.** Page: binance.com/learn/bstocks. BEP-20 with BEP-677 Scaled UI Amount; dividends net of 30% US withholding and splits go through the multiplier; offered only in ADGM under the prospectus, not to US persons, on a secondary-market basis. No addresses, DEX status, oracle or pause/upgrade details found.
- **Coinbase on Base.** Pages: base.org/stocks, docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base, coinbase.com/tokenize. Ten tokens with published addresses (in the registry) and ten Chainlink feeds (8 decimals, total-return). B20 tokens are precompiles with issuer-set allow/blocklist policies, scheduled multiplier updates, and per-function pauses. Feeds update on 0.5% deviation or a 24 hour heartbeat in market hours and hold the last value out of hours. Reg S, eligible jurisdictions outside the US; mint/redeem for Authorized Participants only.

### Nigeria

No provider confirms eligibility for a Nigeria-based founder or company. Luno (a third party) offered xStocks to Nigerian retail users from 8 Sept 2025 and told reporters it was still awaiting regulatory approval. That does not establish eligibility for Elpida. Binance has a history of regulatory action in Nigeria. `evaluateEligibility()` is deny-by-default: a country counts only when a provider's confirmed list contains it, so Nigeria is blocked until a provider says otherwise in writing.

## Implementation (this PR)

- `config/tokenized-equity-registry.json`: providers, per-network balance semantics, eligibility, sources with access dates, unresolved questions, ten Coinbase assets, empty `verification` list.
- `packages/core/tokenized-equity.mjs` (pure, no secrets): routing, canonical validation, capability states, eligibility, `shareExposure`, `tokenValueUsd`, `referencePriceStatus`, `executableValuation`, `checkGraduation`, `verifyMigration`, `createRewardLedger`, sandbox fixtures.
- `GET /api/public/tokenized-equity?network=` returns provider identity, eligibility text, semantics, unresolved questions and each asset's capability states.
- `packages/core/pairs.mjs`: neutral "Tokenized stock" copy and `EQUITY_PROVIDERS`; the launch form's simulated-stock notice names the designated provider.
- `tests/tokenized-equity.test.mjs`: 18 tests for routing, no substitution, canonical validation, independent flags, fixtures, eligibility, multiplier handling, price status, executable valuation, graduation, migration and reward accounting.

### Valuation and graduation rules built in

- Equity reference price and executable token price are different inputs. `executableValuation` needs a fresh reference **and** a pool TWAP within a divergence limit (default 300 bps) and uses the lower of the two, so a thin pool cannot lift reserves.
- `referencePriceStatus`: `fresh` is usable; `stale` (market open) and `market-closed` show the last price but block graduation and reward conversion; invalid or future-dated data is `outage`.
- `checkGraduation` needs both the USD market cap and the **real** quote reserve in USD. `realQuoteReserve` subtracts virtual reserves. A null threshold returns `unresolved-threshold` and blocks. The repo has no numeric dual USD threshold in code today (it has start FDV $5,000 on mainnet and the 24 h grace), so both numbers are **unresolved decisions for Malik**; none was invented.
- `verifyMigration` requires the pool plus fees to equal the curve's reserves and, for multiplier tokens, an unchanged multiplier across the migration.
- Double-application guard: a total-return feed (Coinbase, Robinhood) is priced per raw token and the multiplier is never applied again; a plain equity price needs shares = raw x multiplier; if the kind of `balanceOf` is unverified the code refuses.

### Reward rules built in

`createRewardLedger` is idempotent per epoch, restricted recipients stay owed (never moved to other holders), failed transfers retry up to a limit then hold, replayed batch results are ignored. Corporate actions: rebasing balances and multiplier-denominated raw balances both stay correct for a vault holding the token because every holder shares the multiplier; whether the **issuer** passes dividends to a contract-held balance is unconfirmed for all five and is in the inquiries.

## Configuration and activation

All flags default off and are read server-side only.

- `ELPIDA_TOKENIZED_EQUITY=1` master switch.
- `ELPIDA_TOKENIZED_EQUITY_<PROVIDER>_<CAPABILITY>=1`, for example `ELPIDA_TOKENIZED_EQUITY_COINBASE_SECONDARY_TRADING`. Providers: `XSTOCKS`, `ROBINHOOD`, `BSTOCKS`, `COINBASE`. Capabilities: `LAUNCH_QUOTE`, `SECONDARY_TRADING`, `GRADUATED_POOL`, `REWARD_CONVERSION`, `REWARD_DISTRIBUTION`, `ISSUANCE_REDEMPTION`.
- A capability turns on only with both its flag and a `verification` record naming network, provider, capability, `verifiedAt` and evidence.
- No provider API credentials are needed or stored today. If a provider API is later used (for example xStocks price or asset endpoints), the key goes in a Railway variable and is never sent to the browser.
- Simulated fixtures (`sandboxFixtures()`) use network `fixture` and are labelled simulated. Existing TEST-STOCK stays labelled as not an issued token.

### Activation requirements (per provider, per capability)

1. Written provider confirmation of eligibility for the operating entity and of contract holders.
2. Addresses read from the provider's registry and matched onchain (for Base: `B20Created` events).
3. A recorded test on a testnet or fork: transfer to and from the curve, pool, and reward vault contracts, with `isAuthorized`/pause/whitelist checks.
4. Feed freshness test, including a market-closed weekend.
5. Mainnet checklist items C1 (audit) and the dual graduation thresholds decided.

## Missing items

- Official address lists for xStocks (Ethereum, Solana), Robinhood Chain and bStocks; Robinhood mainnet chain id and RPC.
- Eligibility confirmation for a Nigerian company/founder from all four providers.
- Whether contracts (curve, pool, vault) can hold and move each token; pause, freeze, upgrade powers.
- Meteora DAMM v2 graduation path for Solana xStocks (not built).
- Price feeds for xStocks and bStocks; what `balanceOf` returns for the raw+multiplier tokens.
- The two graduation thresholds (market cap USD, real reserve USD).
- Legal review (checklist D5).

## Integration inquiries (send from a business address; do not imply a partnership)

**xStocks.** "We are building ELPIDA, a multichain launchpad (testnet today), and would like to understand whether xStocks on Ethereum and Solana can be used as a quote asset and pool pair, and distributed as rewards to holders. Please share: the official registry of mint/contract addresses; pause, freeze, permanent-delegate and upgrade powers; whether transfers to and from non-whitelisted contract addresses are allowed; how the multiplier and `balanceOf` behave for contract-held balances; recommended price feeds; whether a Nigeria-incorporated company and its users are eligible; and any DEX or Meteora integration guidance."

**Robinhood Chain.** "ELPIDA is a launchpad on testnets. Can Robinhood Stock Tokens serve as a launch quote asset, AMM pair and reward asset? Please share the onchain registry address and mainnet chain id, how `balanceOf` relates to `uiMultiplier()`, the effect of pause roles and sequencer-level filtering on contract-held tokens, DEXs with supported pools, and whether a Nigeria-based company or its users are eligible. We are not a Robinhood partner."

**Binance bStocks.** "ELPIDA is a launchpad on BNB testnet. Please confirm where bStocks contract addresses are published, whether bStocks can be held and moved by smart contracts and listed on DEXs, how the BEP-677 multiplier interacts with AMM pools, the price feed and out-of-hours behaviour, pause/freeze/upgrade powers, and whether a Nigeria-based company or users may hold or distribute bStocks given the ADGM-only offering."

**Coinbase Tokenized Stocks.** "ELPIDA is a launchpad on Base Sepolia. We read the B20 documentation on docs.base.org. Please confirm: eligible jurisdictions and whether a Nigeria-based company or users qualify; whether our curve, pool and reward contracts need allowlisting under the token transfer policy; whether `balanceOf` returns raw or multiplied amounts; how Uniswap v3 style pools should account for multiplier changes; and the oracle registry address. We are not a Coinbase partner."

## Sources (accessed 19 Oct 2026)

Primary: docs.xstocks.fi pages above; docs.robinhood.com/chain/stock-tokens and /contracts; binance.com/learn/bstocks; base.org/stocks; docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base; coinbase.com/tokenize. Secondary (not canonical): Beosin Robinhood stock-token analysis, Trustswap US availability, Mariblock (Luno Nigeria), Hackernoon and The Defiant (bStocks).

## Robinhood Chain update (19 Oct 2026, later)

- Mainnet chain id **4663**, RPC `https://rpc.mainnet.chain.robinhood.com`, explorer `https://robinhoodchain.blockscout.com` (docs.robinhood.com/chain/connecting). Testnet 46630.
- Uniswap v2, v3 and v4 are live there and Uniswap says stock tokens are fully transferrable and tradable in its AMM pools (secondary source). This makes a self-integration path plausible without a partnership, because secondary use appears permissionless.
- Oracles: one Chainlink feed per token, same `AggregatorV3Interface`, updates 24/5, the price already includes the multiplier, `oraclePaused()` marks corporate-action windows. Read feed addresses from Chainlink's Robinhood page, do not hardcode them. This matches the price-per-raw-token handling in `tokenValueUsd`.
- Still open before enabling anything: the token address table on docs.robinhood.com/chain/contracts loads client-side and could not be read here, so no stock-token address is in the registry yet; contract-level behaviour with our curve, pool and vault (pause roles, sequencer filtering) is untested; eligibility for a Nigerian company is unconfirmed. Everything stays OFF.
- **Update:** the stock-token table was read in the browser from the official page and the 195 addresses are now in the registry (source URL on each row). Matching them against the onchain asset registry is still required before anything is enabled.

### Robinhood onchain check (19 Oct 2026, read-only)

Done through your Chrome and the public RPC (the sandbox cannot reach it). No wallet, no transactions.

- Chain id confirmed as 4663. TSLA is an EIP-1967 beacon proxy to a verified `Stock` implementation. The beacon is also the `AccessControlsRegistry` (`0xe10b6f6b275de231345c20d14ab812db62151b00`), which can block accounts, pause, upgrade and manage roles.
- **`balanceOf` returns the raw balance; `balanceOfUI` = raw x multiplier.** Confirmed on AAPL holders. This resolves the open question: Robinhood is `raw-with-multiplier` with a raw `balanceOf`, and the Chainlink price already includes the multiplier, so the valuation code uses a per-raw-token price and never multiplies again.
- Multipliers are already above 1 for AAPL, NVDA, SPY, SGOV and SCHD, so the multiplier is live and matters for accounting.
- The two biggest AAPL holders are a Uniswap v4 `PoolManager` and `Morpho`, and neither is blocked. Third-party contracts can hold these tokens now.
- Issuer powers: block any account, pause the registry or a token, `adminBurn` from any account, upgrade all tokens at once. These are a counterparty risk to reserves held by our contracts, and the launch UI should disclose them.
- Not done: running our own contracts against the tokens (needs a fork or testnet from a machine with RPC access).

### Coinbase on Base, from the Base docs page (19 Oct 2026)

docs.base.org/build-on-base/integrate-defi/list-tokenized-stocks adds: a public Tokenized Stocks API with no key (addresses, multipliers, NAV), the Onchain Registry at `0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD`, secondary holding and trading described as permissionless with KYC only for Authorized Participants, address blocklists that make a blocked transfer revert, `scaledBalanceOf` as canonical with `balanceOfUI` as raw x multiplier, no built-in timelock, and feeds identical to those in the registry. `balanceOf` is still not stated, so read it from the chain as done for Robinhood before use.
