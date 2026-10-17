# Token header creator fees

The token header displays **Creator fees**: cumulative creator earnings, including
fees already claimed. Rewards continues to show balances available for payout.

For indexed EVM curves, exact integer accounting replays the complete Bought,
Sold and AntiSnipeFee history. It applies the base-fee split and excludes the
anti-snipe liquidity bonus. Claims do not subtract earnings. The replay checks
its resulting sold amount against the indexed snapshot before returning a total.

For graduated Uniswap v3 positions, creator shares from the locker's historical
PositionFeesCollected events are added to currently collectible fees. The latter
are read with an eth_call simulation of collectFees at the indexed block; no real
transaction, approval, signature or transfer is submitted. Only the creator half
counts even when creator and protocol recipients use the same wallet. Unrelated
splitter deposits do not count as LP trading fees.

The quote asset and token fees are shown separately, without assigning an invented
historical USD value. Native ETH and its WETH pool representation are combined as
one quote denomination. Integer amounts retain their on-chain precision in the API;
the header formats them for display.

GET /api/creator-fees?network=base-sepolia&token=ADDRESS starts a bounded background
read and returns loading, ready or unavailable. One token job runs at a time, with
up to four independent RPC requests and 200 blocks per request. Settled LP history
is cached in the existing index SQLite database and checked against its canonical
block hash before reuse; reorgs invalidate it. Results refresh after one minute.
The header polls while attached; the first historical scan can take longer.

Unsupported Solana and older custom-pool lifetime histories show Unavailable;
they do not substitute unclaimed balances or an estimated total. This change does
not enable public holder reward treasuries, alter pricing, or change payouts.

Validation: local contract tests cover base-fee rounding and anti-snipe exclusion,
native curve earnings before/after payout, both graduated LP asset earnings before
and after collection/claims, persistent incremental LP history, and HTTP loading
to ready behavior. Browser visual verification remains pending.
