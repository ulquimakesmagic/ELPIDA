# Holder chat and trade filters

The token activity panel has Trades, Holders and Chat tabs. Chat supports multiple messages and direct replies; the holder thesis panel and editor have been removed.

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
exact signing message is reconstructed when validating a submission. Published message originals remain append-only. Moderation uses a separate audit table.

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

## Reports and moderation

Current holders can use Report on a message, select spam/scam/harassment/other,
and sign a separate, site-bound report. The signature binds the room, message ID,
reason, wallet, nonce and five-minute expiry. Reports are private server data;
one report per wallet/message and ten reports per wallet/hour are allowed. A report
does not automatically hide anything. Both preparation and submission check live
holdings; replay and altered requests fail. Reporting requires no transaction.

Trusted operators review reports on the server hosting the persistent database:

```powershell
node scripts/chat-moderation.mjs /data/public-holder-chat.sqlite reports
node scripts/chat-moderation.mjs /data/public-holder-chat.sqlite hide 42 "Scam impersonation"
node scripts/chat-moderation.mjs /data/public-holder-chat.sqlite restore 42 "Appeal accepted"
node scripts/chat-moderation.mjs /data/public-holder-chat.sqlite audit
```

Use the actual configured data directory. The command requires an existing database
and trusted filesystem access; there is no public moderation endpoint. Audit entries
record message ID, hide/restore state, reason and time. Operators should use their
authenticated host access logs to attribute actions. Hidden content is replaced by a
moderation notice in both messages and reply quotes. Originals remain available to
operators and backups; they are not erased. Polling refreshes the latest page within
15 seconds; older pages require Refresh, and already-read text cannot be recalled.

Posting now rejects equivalent text from the same wallet in the same room for ten
minutes (Unicode normalization, whitespace and case folding), and caps posting at
20 messages per ten minutes alongside the 15-second cooldown. These checks repeat
inside the save transaction. Limits are per wallet, not proof of a unique person.
