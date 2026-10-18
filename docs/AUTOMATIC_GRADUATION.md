# Automatic graduation — Base Sepolia

The API watches the shared Model 10 factory's indexed curves every 15 seconds.
Once a curve completes, a dedicated operator wallet submits `graduate()` with zero
native value. The operator pays gas; users do not need to click or fund migration.
The existing factory and AIZEN are supported. Pricing, reserves, fee splits,
permanent LP custody and the 24-hour reopen escape hatch are unchanged.

This patch implements the worker; it does not activate a funded production worker.
Only Base Sepolia (84532) is allowed. Other chains retain their existing flow.
The optional manual fallback is collapsed on Base Sepolia. The page reports when
automation is unconfigured, delayed or awaiting operator gas instead of promising
that an inactive service will migrate a token.

## Operator setup

1. Create a dedicated Base Sepolia gas wallet. Do not use a treasury, creator,
   Solana or mainnet key. Store its private key as a restricted mounted secret
   file outside source control. Never paste it into chat or the browser.
2. Set `ELPIDA_GRADUATION_KEY_FILE` to that file's absolute path in the API runtime.
   Fund its public address with Base Sepolia test ETH. The worker exposes only
   the public address at `/api/graduation/status`.
3. Keep `graduation-keeper.sqlite` and its WAL in the persistent API data directory.
   Railway refuses activation without its persistent volume. Run one API replica;
   workers sharing the same journal also coordinate through a database lease.
   Never run this wallet from another process or deploy a second independent
   journal with the same key.
4. Optional spending ceilings: `ELPIDA_GRADUATION_MAX_COST_ETH` (default 0.001 per
   transaction) and `ELPIDA_GRADUATION_DAILY_BUDGET_ETH` (default 0.01 per rolling
   24 hours). These are maximum gas costs, not fees charged to token holders.
5. Check `/api/graduation/status`, `/api/public/status` and operations incidents.
   A completed AIZEN should move from watching/submitted to graduated, then appear
   as migrated once the public index catches up. Record the public transaction
   before treating the live rehearsal as passed.

## Recovery and limits

Each candidate is rechecked on-chain for completion, lack of an existing pool,
factory/token identity, and factory registration. Gas estimation must succeed;
gas is bounded at 15 million, and both transaction and daily costs are capped.
Indexer staleness prevents new submissions. One pending transaction is allowed.
The signed transaction is committed before broadcast; RPC errors and restarts
rebroadcast identical bytes. Two canonical confirmations finalize the journal.
Failed receipts trigger a cooldown before fresh estimation. Already migrated or
reopened curves are skipped. No transaction redirects fees or transfers funds.

Low gas, RPC failure, spending ceilings, stuck transactions and nonce conflicts
surface in status/operations logs. A transaction pending over five minutes needs
operator attention. The worker does not silently raise its signed gas price;
resolve a stuck nonce through a reviewed replacement before resuming. Keep the
journal when restarting or rotating infrastructure. A funded worker and reliable
RPC/service uptime remain necessary: contracts cannot initiate transactions by
themselves. Mainnet automation and Solana rent sponsorship are separate work.

## Verification

`node --test tests/graduation-keeper.test.mjs` exercises durable recovery after an
ambiguous broadcast, provenance and chain checks, insufficient gas, simulation
failure, pending nonces, concurrency leases, retry cooldown, budget limits,
reorg receipts, completed/migrated exclusions and disabled configuration.
Existing EVM migration and fee tests cover the contract invoked by the worker.
