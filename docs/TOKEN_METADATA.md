# Token launch metadata

Open `http://localhost:3000/launch` or choose **Create a token**.

The form collects a name, ticker, description and logo, with optional website, X/Twitter, Telegram and Discord links. Logos accept PNG, JPEG, WebP, GIF, AVIF and BMP files up to 5 MB on every supported chain, or a public HTTPS image URL. The preview updates as you type. The existing network, permanent trading pair, first buy and creator reward wallet remain part of the launch. Supply is fixed at 1 billion and decimals at 18.

The UI requires a description and logo. The API accepts older launches without these fields for compatibility, but validates any supplied metadata before paying or approving a launch. Text is rendered as text; executable URL schemes, misleading social domains and disguised image uploads are rejected.

The same 5 MB decoded-file limit and format validation apply to simulation, EVM wallets and Solana wallets. Browser-local testnet metadata uses IndexedDB for full-size images, with older localStorage entries still readable. Large draft images remain available while completing the launch; reselect them after a page reload. Uploaded SVG files are not accepted because they can contain active content.

## Storage

- **Local devnet:** model 5 now records an immutable IPFS metadata URI on the simulated chain and stores the documents in `local-data/ipfs-content`. All browsers accessing the server can read them. Local content is not pinned publicly. The chain resets at server restart.
- **Base Sepolia:** the updated factory records the IPFS reference during launch. Configure server-side Pinata publishing to enable this path. A fresh browser reads the URI from chain events and resolves shared metadata.
- **Other public EVM previews:** additional metadata remains browser-local until their factories are updated.

See [shared metadata setup](SHARED_METADATA.md) for configuration, compatibility and retention details. The existing launch method remains supported; the new method includes the metadata URI. Public transactions require your wallet signatures.

Verify with `node --test --test-concurrency=1 tests/metadata.test.mjs tests/api.test.mjs`.
