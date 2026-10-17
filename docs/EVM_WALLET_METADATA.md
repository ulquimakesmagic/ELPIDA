# EVM wallet token images

Solana uses its own wallet-readable metadata path. EVM ERC20s do not acquire a logo
merely by storing an image in a launch factory's registry. This change leaves all
contracts, Model 10 terms, and existing Solana metadata unchanged.

## Configuration and use

1. Set `ELPIDA_PUBLIC_URL` to the public HTTPS origin, or use Railway's existing
   `RAILWAY_PUBLIC_DOMAIN`. Requests never choose the exported origin via proxy headers.
2. Keep `PINATA_JWT` server-side to pin new uploaded images and metadata to public
   IPFS. The live configuration checked on 2026-10-17 already reports public
   publishing enabled. No new secret is needed for this feature.
3. Publish a logo when launching. For an older token without on-chain metadata,
   connect its creator wallet and use the existing **Publish saved token details**
   action if that browser still has the image/details. It requires a creator
   signature; Elpida does not sign it for you. Missing images cannot be invented or
   recovered by exporting a list. Published details remain immutable.
4. The public token list is `/api/wallet-tokenlist.json`, optionally filtered with
   `?network=base-sepolia`. It includes only registered EVM launch factories whose
   current and legacy indexes have validated and synchronized. Chain IDs and
   checksummed contract addresses identify entries; names do not establish identity.
5. On an EVM token page, open **About → Wallet logo and token metadata**, inspect
   **Open token image**, then use **Add to wallet**. The selected wallet must already
   be on the correct chain. It receives address, symbol, decimals and the public image
   URL through `wallet_watchAsset`; no accounts, chain switch, signature or transfer
   is requested by this action. Unsupported and rejected requests are reported honestly.

Uploaded logos use absolute HTTPS `/api/content/<CID>` URLs (or an IPFS gateway).
Legacy, creator-signed raster data images are served at
`/api/wallet-logo/<network>/<token-address>` and exported as HTTPS URLs, without
republishing or altering the signed metadata. Browser-only data images are excluded.
The image route never fetches a caller-supplied URL. Token-list and public image GETs
allow cross-origin consumers; config, mutations and all other origin checks remain
protected. Token-list versions are persisted and increment for additions, removals
and metadata changes; an unready index returns 503 rather than an incomplete list.

## Phantom limitations

The token list is a standard export, not an automatic submission to Phantom or a
promise that it will ingest it. Phantom may rely on its own token-data providers,
and wallet method support and testnet coverage vary. A logo is separate from a
verified badge. This cannot force a logo into Phantom, even if another wallet
accepts the image. Compare the exact chain and contract address when checking it.
The actual Phantom holdings view has not been inspected because browser access was
declined earlier. No real wallet account request or signature was made for testing.

References:
- https://github.com/Uniswap/token-lists
- https://eips.ethereum.org/EIPS/eip-747
- https://help.phantom.com/articles/38425812822419

Validation on 2026-10-17: the end-to-end local HTTP/contract rehearsal passed;
all 6 wallet-token unit/API tests, 17 metadata/network/shell regression tests,
and 25 application/public-indexer/wallet regression tests passed. Browser visual
verification and an actual Phantom holdings check remain pending.
