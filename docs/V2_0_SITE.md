# ELPIDA V2.0 — on the site (roadmap step 5)

8 November 2026, branch `v2-site` (on top of `v2-analytics`). V2 can now be deployed from the operator panel, launched from
the launch form, listed, and traded, on test networks only. V2 reuses Model 11's pool design and router.

## Operator panel (Launchpads tab)

**"ELPIDA V2 test launchpad"** deploys, from the connected wallet, in about 12 confirmations:
1. the CREATE2 deployer;
2. the factory ($50 test starting market cap, graduation at ×5, token details required);
3. the trader-airdrop distributor (monthly rounds from the 1st of the month, UTC);
4. the holder-reward distributor (weekly);
5. the flywheel vault;
6. the hook at a mined address, wired to the three contracts and with the minimum fee typed in the card (1.00% by default);
7. pricing, the USDC pair ($50 × 5/4 = 62.5 USDC virtual quote), the router, and the flywheel's router.

The wallet becomes the treasury and the reward keeper. Each step is saved, so a failed or rejected step resumes where it
stopped. The card then shows the addresses to pin in `networks.mjs` as `v2.shared`:
`factory, hook, router, airdrop, holder, flywheel, block, minFeeBps`.

## Launch form

- **Launch model:** a third choice, "ELPIDA V2 test · your fee", appears where a V2 launchpad exists.
- **Trading fee:** presets (minimum, 1.25% default, 2%, 3%, 4%) and a free entry in whole basis points. Below them, the
  split of a $1,000 trade: creator, traders' airdrop, flywheel, holders, treasury. The text notes that the fee can
  never be changed and that anti-snipe applies for the first minute.
- **Pairs:** the native coin or USDC.
- **First buy:**
  - The estimate uses the V2 curve.
  - The hint and the validation explain the 3% cap.
  - `launchV2` refuses anything over the exact maximum before signing, and shows that maximum.
  - The contract enforces the cap again.
- **Review:** shows the model, the fee and the split. "Fixed after launch" lists the fee.

## Listing and trading

- `packages/indexer/v2-indexer.mjs` (`V2Indexer`) indexes V2 launches with Model 11's pool reader, plus V2's ABIs. It
  reads each token's own fee (`feeBps`, its anti-snipe schedule) and the five fee ledgers (owed and paid) from the hook.
- `apps/api/public-indexer.mjs` opens it for any test network with `v2.shared` pinned, after
  `verifyV2Deployment` checks the wiring.
- In the browser, V2 tokens are `isV4Token` (same router path) and `isV2Token`. Quotes, trades and fee payouts use
  the V2 router and hook. A token from another V2 launchpad is refused.
- Token page: a "V2 test · x.xx% fee" tag, and a trade note explaining the fee and the five-way split.
- `ElpidaV2Hook.liquidityOf(token)` was added so the indexer reads the pool's positions directly.

## Tests

- `tests/v2-indexer.test.mjs`: listings, trades with the real trader, fee ledgers before and after graduation, and
  deployment checks.
- `tests/v2-browser.test.mjs`: the operator deploys everything from the page; the creator's terms; a first buy over
  3%, a bad ticker and a 4.01% fee are each refused before sending; a launch at 2.5% with the maximum first buy; quote
  equals trade; buy and sell; the fee payout reaches the flywheel vault.
- `tests/launch-model.test.mjs`: the launch form offers, reviews and sends the V2 fee.

The launch form was checked in Chromium: the model choice, the fee presets at 3%, and the $1,000 split.

## Still to do

- The keepers: daily `withdrawFees`, monthly and weekly payout lists, and flywheel cycles.
- The holder-reward formula (§25).
- Solana.
- Pinning V2 on test networks once Malik deploys it from the operator panel.

## Deploy fixes (9 November)

- **Lagging wallets.** Every V2 deploy step sends its own nonce: the highest of the wallet's and the site's pending
  counts, and the last one sent + 1. A step refused as "nonce too low", "already known" or "replacement transaction
  underpriced" is asked again, up to three times. Trust Wallet's RPC builds from a block behind.
- **Resuming.** A payout contract or flywheel vault from an earlier attempt is reused only if it names the intended
  operator: the server keeper when `/api/config` shows one, otherwise the wallet. A holder distributor must also have
  the intended conversion settings. Otherwise the contract is deployed again, then the hook after it.
- **Test stock pairs on V2.** The V2 card lists the network's test stocks (from the Pairs tab) with **Approve for V2**.
  The pair is approved at the same starting market cap as on Model 10: V2's virtual quote is 9/8 of Model 10's. The
  launch form offers stock pairs on V2, and holders of a stock-paired token are paid in that stock.
