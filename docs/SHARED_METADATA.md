# Shared token metadata

## Implemented flow

1. Validate metadata before publishing or requesting a launch approval.
2. Store an uploaded logo as its own IPFS asset. A hosted image URL remains an external asset, whose contents can change.
3. Publish the JSON document containing the logo reference, description and links.
4. The updated model 5 factory launches the token and first buy atomically through `launchWithMetadata`. Its immutable `tokenMetadataURI(token)` registry and `MetadataPublished` event associate the IPFS URI with that token. The original `launch` method remains available for older integrations.
5. The indexer records the URI. A fresh browser can discover it from factory events and resolve the shared document without creator browser storage. Cards and the trading view display the metadata. Temporary gateway failures do not stop trading and are labeled in the UI.

Name and ticker are ERC-20 contract fields. Additional metadata uses the factory registry; third-party wallets/explorers do not automatically support that registry.

## Local testing

Local launches calculate valid CIDv1 raw-block identifiers and save immutable documents and uploaded logos in `local-data/ipfs-content`. The URI is bound on the simulated chain. Content survives server restarts and is served through `/api/content/{cid}` and `/api/metadata/resolve?uri=...` to all browsers accessing this server.

This local store is **not a public IPFS pinning service**. The simulated chain still resets when the server restarts. Local files cannot restore the chain.

## Enable public publishing

1. Create a Pinata API key with the `org:files:write` permission. See [Pinata upload documentation](https://docs.pinata.cloud/api-reference/endpoint/upload-a-file).
2. Copy `.env.example` to `.env` in `C:\Users\user\Desktop\OneForAll\ELPIDA\elpida-v1`. If `.env` already exists, add these fields without replacing it. Put the JWT in `PINATA_JWT`. Keep it out of browser code and project attachments. `.env` is ignored by source control.
3. Optionally set `ELPIDA_IPFS_GATEWAY` to a dedicated HTTPS gateway URL ending in `/ipfs/`, for example `https://NAME.mypinata.cloud/ipfs/`. A missing `https://` or `/ipfs/` is added automatically; an unusable value (plain `http`, credentials, query parameters) is ignored with an `ipfs_gateway_invalid` log line and the public `https://ipfs.io/ipfs/` gateway is used, so this optional setting can never stop the server. The resolver requires direct responses and refuses redirects.
4. Restart the server with `npm.cmd run dev` in PowerShell (or `npm run dev` in other shells). Config exposes readiness and the gateway URL, never the JWT. The server uses Pinata's `https://uploads.pinata.cloud/v3/files` endpoint with `network=public`, for both the image and JSON document.
5. Choose Base Sepolia, connect your wallet and deploy the updated launchpad. Existing older factories cannot acquire this immutable registry retroactively. If upgrading an existing saved deployment, the old record is archived in browser storage under `elpida:previous-factory:{chainId}:{factory}`. The active UI then shows the new factory; older tokens remain on their original contracts.
6. Launch a test token, approving the creation fee and signing the launch yourself. Upload failures stop before approval/launch. Successful uploads remain pinned if the wallet transaction is cancelled; pin retention is managed through the provider account.

Public shared publishing currently targets **Base Sepolia/model 5**. Other EVM preview networks retain model 4 and browser-local additional metadata. Solana's virtual-curve update is still pending.

Test launches no longer require Pinata or a metadata-enabled factory. When either is unavailable, Base uses its original launch method and browser-local metadata. If shared publishing is configured and supported, upload failures still stop the launch. Solana's USDC launch path is exposed, but its deployed program must be upgraded and its curve configuration initialized; DEX migration is not implemented.

No live Pinata upload or public deployment is verified until a server key and wallet signatures are supplied. IPFS retention depends on continued pinning; an immutable URI does not guarantee perpetual hosting.

The development API still binds to loopback and enforces local Host/Origin and CSRF checks. Deploying it as a public service requires wallet-authenticated upload authorization, abuse limits and production storage operations before exposing it.

## Validation

`node --test --test-concurrency=1 tests/metadata-store.test.mjs tests/metadata.test.mjs tests/dex-migration.test.mjs tests/dex-runtime.test.mjs tests/api.test.mjs`

Tests cover persistence for a fresh reader, public Pinata request shape with mocked responses, missing-key/provider failures, resolver bounds and integrity, on-chain URI association, first-buy rejection, indexer replay, DEX graduation/trading and fee payouts.
