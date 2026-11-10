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

## Model 11 retired for new launches (Malik, 9 November)

V2 replaces Model 11.
- **Removed:** the operator panel's Model 11 card (deploy, test-stock approvals), the `deploy-v4` and
  `approve-v4-stock` wallet actions, and the Model 11 option in the launch form. A saved draft that chose Model 11
  falls back to Model 10.
- **Kept:** pinned Model 11 launchpads stay indexed, and their tokens keep their quotes, trades and fee payouts
  through the Model 11 router.
- **Kept on BNB testnet:** the test PoolManager card, because V2 deploys on top of it.

## Model 10 off the launch page; native coin for V2 pair-asset tokens (Malik, 9 November)

- **Launch page.** ELPIDA V2 is the only launch model wherever its launchpad exists; the model choice is gone. A network
  without V2 shows that it cannot launch yet. Model 10 (and Model 11) tokens keep trading. The local simulation keeps
  its own test curve.
- **First buy in the native coin.** On a V2 launch paired with USDC or a test stock, the first buy can be paid in the
  pair asset or in the native coin. The coin is swapped into the pair asset on the network's conversion pool (a separate
  confirmation, at most 1% below the quote) just before the launch, which buys with the swap's guaranteed minimum. If
  the launch then stops, the pair asset stays in the wallet. The 3% first-buy cap applies to the converted amount.
- **Trading with the native coin.** The token page's "Native coin" option now works for V2 (and Model 11) tokens paired
  with an ERC-20: a buy converts the coin into the pair asset on the conversion pool and then buys on the v4 pool; a
  sell does the reverse. Each hop keeps a 1% margin. One confirmation when the wallet batches calls, otherwise separate
  steps; extra pair asset stays in the wallet. It needs a funded conversion pool for that pair on the network.

## Creator splits, burn tag, stock card (Malik, 10 November)

- **Creator splits on V2 (EVM test networks).** The launch form's creator wallets step accepts up to 8 wallets with
  percentages. A split deploys `ElpidaCreatorAllocation` (no owner; wallets and shares fixed for good) right before the
  launch, and the launch names it as the token's creator vault, so the hook pays the creator's 30% into it. A retry with
  the same wallets and shares reuses the contract this browser deployed. The token page shows a **Creator split** card:
  each wallet, its share and what it can claim, and **Collect and pay out**, which collects the token's fees from the
  pool and pays that wallet (anyone may press it; the money only goes to that wallet). One wallet works as before.
  Holder strategies and X or website allocations are the next phases.
- **Burn tag.** The Explore and token-page tag shows only the flame and the percentage; the full text is its tooltip.
- **Stock pair card.** Long asset lists stay inside the card (shortened, full list on hover).
- **Native route errors.** Two Sepolia test stocks share the symbol tNVDAon (Model 10's has an ETH conversion pool,
  V2's `0x8Db1…D921` does not yet). The operator's conversion-liquidity picker shows each stock's address, and the token
  page names the exact asset whose pool is missing.
- **Holder strategies on V2 (EVM test networks).** "Share fees with holders", "Buy a reward token for holders" and
  "Buy back and vest to holders" are selectable in the launch form when the server's V2 keeper is running; see
  docs/V2_0_KEEPERS.md (Creator holder strategies). X and website allocations are the next phase.
