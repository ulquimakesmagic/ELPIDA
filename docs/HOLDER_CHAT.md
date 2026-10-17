# Holder chat and trade filters

The token activity panel has Trades, Holders and Chat tabs. The existing holder
thesis feed remains separate: chat supports multiple messages and direct replies.

Chat reading is public. Posting requires a connected wallet with a positive live
balance of that exact token on the selected network. Balance checks happen both
when preparing the signature and when saving the signed message. There is no
minimum rank or top-holder restriction. Messages remain visible when their author
later sells; their presence does not attest to a current balance.

Each signature commits to the site, network, token, author, message digest, reply
ID, nonce and five-minute expiry. EVM signatures are recovered to the claimed
wallet. Solana uses Ed25519 verification. Wallet Standard Solana adapters now
expose message signing only if advertised, bind the selected account and require
that the returned signed bytes exactly match the request. Unsupported message
signing is reported without submitting a message. No token transfer, approval,
gas fee or server-held user signing key is involved.

Messages are plain text, up to 1,000 characters, with a 15-second per-wallet,
per-room cooldown. The service caps stored messages and pending challenges. It
uses parameterized SQLite queries, atomic nonce consumption and a second cooldown
check at commit. Replies must reference a message in the same room. The API
returns bounded cursor pages; the interface loads 50 messages at a time, polls the
latest page every 15 seconds while visible, and pauses polling while browsing older
messages. Refresh returns to the latest page. Posting and reading also have request
limits. Existing Host, Origin and CSRF protections apply to the new routes.

`public-holder-chat.sqlite` is stored in the configured data directory/volume and
included in the existing SQLite online backup and restore allowlist. Unsigned draft
text is not persisted: challenges store a digest and signature context, and the
exact signing message is reconstructed when validating a submission. Published
messages are append-only; this feature does not add editing or moderation tools.

The Trades tab has an All / Buys / Sells dropdown. It filters the recent indexed
trade window while preserving order. Counts and empty-state wording identify that
window; it does not claim to search the full historical archive. Holdings and
headline market totals are unchanged.

Validation on 2026-10-17:
- Chat, wallet discovery and storage/backup checks: 15 passed.
- HTTP chat, application and shell regression checks: 13 passed.
- Final HTTP chat recheck after storage hardening: passed.
- Existing holder thesis, wallet dialog and batch checks also passed.

Coverage includes spoofing, tampering, lost holdings, expired challenges, nonce
replay, cross-room replies, EVM/Solana signatures, persistence, pagination, quotas,
backup/restore, plaintext round trips, CSRF and foreign-origin rejection. Tests post
only to ephemeral local instances, never live community chats. Browser visual
verification remains pending; earlier browser access was declined and not bypassed.
No contracts, Model 10 pricing or wallet-chain separation changed.
