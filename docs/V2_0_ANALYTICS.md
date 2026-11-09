# ELPIDA V2.0 — Rewards analytics (roadmap step 5, first part)

8 November 2026, branch `v2-analytics` (on top of `v2-vaults`). The analytics page gains a **Rewards** section,
built from the V2 contracts' events only:

- **Countdowns** to the end of the current trader-airdrop round (calendar month, UTC) and holder-reward round
  (fixed period). The end time is the one the distributor contract fixed. The page ticks every second and reloads when
  a round ends.
- **Vault sizes:** the trader airdrop, holder rewards and flywheel, in dollars when the chain's price is fresh (with
  the asset amount beside), plus the 7-day change and a daily chart of all three. A vault's size is its exact share of
  every token's running fee total (`splitAccrued`, as the hook computes it) less what it has paid out or spent. So it
  grows with every trade, whether or not the hook has paid it over yet.
- **Airdrop distribution:** for the latest round, how many traders were paid, the median, smallest and largest
  payouts, the top 1%'s share, and payouts by size band. Below that, every round with its pool, recipients, paid,
  unclaimed and posting transaction.
- **Check your payouts:** any wallet's airdrop and holder-reward payouts, with transaction links.
- **Flywheel:** cycles run, amount spent, tokens burned, and each buy-and-burn with the supply after it.

Server: `apps/api/v2-rewards-service.mjs` keeps one read-only `V2RewardsIndexer`
(`packages/indexer/v2-rewards.mjs`) per network with a pinned V2 deployment
(`networks.mjs` → `v2.shared`: hook, airdrop, holder, flywheel, block). It serves `/api/public/v2-rewards` and
`/api/public/v2-rewards/payouts?wallet=`. Mainnet entries are ignored. With no deployment pinned (today), the API
returns `{deployed: false}` and the page hides the section rather than showing invented figures.

UI: `apps/web/v2-rewards-view.mjs` and `.rw-*` styles in `docs.css` (CSP-safe: widths are set through CSSOM). Checked
in Chromium at desktop (dark) and phone (light) widths with figures from a local-chain run: two tokens, 24 days of
trading, a posted and paid round of 240 traders, and two flywheel burns.

Tests: `tests/v2-rewards-indexer.test.mjs` checks:
- vault sizes against the hook and vault balances, and the daily series;
- rounds, statistics and countdowns against the contracts;
- flywheel burns, wallet lookups, and that syncing again changes nothing;
- the service: hidden without a deployment, never on mainnet, no stale dollar figures.

`tests/api.test.mjs` covers the new routes.

Still to do in step 5: the V2 trading indexer, so V2 tokens list and trade on the site; the launch form's fee selector
and split preview; operator-panel deployment of V2 and its vaults; and the keepers that post rounds and run the
flywheel.
