# Public markets and Railway persistence

The application now starts a read-only public EVM indexer alongside the web server.
Base Sepolia uses the model 10 factory `0xD64119914DDA7b206d01Fb2B334A630Ca94fD6d2`
(backfill from block 48209837). The earlier model 9 factory
`0xe605787F7260F5Dae2768d2F9E93E7F18EE14f91` (from block 47994800) is listed under `legacy` and
stays indexed in its own database, so its tokens remain listed, tradable and claimable; new
launches go only to the current factory. No wallet key is used by the indexer. Other EVM networks are enabled when their verified shared
factory and start block are configured in `packages/core/networks.mjs`.
Solana pools and trades are indexed by a separate worker, `packages/indexer/solana-indexer.mjs` (see `USD_PRICING_AND_UX.md`).

## Storage

Attach a Railway volume to ELPIDA at `/app/local-data`. The server automatically
uses `RAILWAY_VOLUME_MOUNT_PATH`; `ELPIDA_DATA_DIR` optionally overrides it.
For this Docker image's non-root user, Railway documents `RAILWAY_RUN_UID=0` as
the volume permission setting. The volume and account billing must be provisioned
in Railway by the account owner. A Git push does not create a volume.

SQLite WAL stores the index cursor, block hashes, launches, transfers, trades and
snapshots. Circle request IDs, metadata caches and published content also use
the storage directory. Keep one replica per attached SQLite volume. Back up the
volume through Railway. Without a volume, the index is rebuilt after redeployment;
unpublished browser-only metadata cannot be recovered from blockchain events.
Older tokens without an IPFS URI offer **Publish saved token details** in their
creator's browser. This requires a short-lived signature bound to chain, factory,
token and metadata hash. The server checks the signer against the indexed creator
and atomically stores the details. It cannot overwrite on-chain IPFS metadata.

Public contracts and assets survive refreshes and server restarts. The private
Hardhat simulation deliberately resets on process restart; saving its index does
not persist that blockchain. The website defaults to public Base Sepolia browsing
for new visitors, and no wallet connection is needed to discover indexed tokens.

## APIs and logs

- `GET /api/public/status`: network, cursor, head, lag, last successful sync and
  storage durability. Confirmations default to two blocks for these testnets;
  this is provisional confirmation, not a guarantee of finality.
- `GET /api/public/tokens?network=base-sepolia`: public token discovery.
- `GET /api/public/tokens/<address>?network=base-sepolia`: indexed token state.
- Append `/trades`, `/holders` or `/candles?interval=60&network=base-sepolia`.
  Candle intervals: 60, 300, 3600 or 86400 seconds. Empty intervals are not invented.
- Set `ELPIDA_RPC_84532` to a dedicated Base Sepolia RPC if the public endpoint is
  throttled. URLs and credentials are not returned by public status or logs.

The worker runs every 15 seconds, prevents overlapping scans, retries RPC failures
and rewinds orphaned blocks after reorgs. Event blocks and bounded-range end
checkpoints are stored; it does not query every empty block. SQLite transaction
commits make restart/backfill idempotent. Trade and holder APIs are bounded.

Railway logs now include `storage_ready`, `public_indexer_synced`,
`public_indexer_error`, `request_failed` and `client_error`. HTTP failures have
an `X-Request-Id`. Browser wallet failures report only operation and error code;
credentials, request bodies and signature payloads are never logged.

## Market-page definitions

The headline **market cap · FDV** is price times full minted supply (one billion).
The free-float capitalization is separately shown in Technical details. Wallet
holdings exclude curve/pool inventory and the known burn address; it is not a
claim that only purchased tokens exist. Total supply stays one billion unless
the token contract actually burns supply. Chart execution prices include trader
fees and are distinct from marginal spot prices. Historical USD charts apply
the current reference rate and explicitly label that conversion.

The chart-first layout, market-cap/price toggle, candle intervals, adjacent trade
panel and Trades/Holders views reference the visible Pons token interface at
https://ponsfamily.com/launchpad/0x39dbed3a2bd333467115de45665cc57f813c4571.
Pons docs (https://docs.ponsfamily.com/) describe immediate pool launches; Elpida
continues to use its agreed virtual curve and locked graduation. No Pons contracts,
branding, limit orders or social identities are represented as Elpida features.
