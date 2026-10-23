# Launch guarantees (23 October 2026)

Two rules Malik set for every token Elpida launches, how each is enforced, and the cases they do not yet cover.

## 1. A token's curve is always open to trade and never needs reopening

| Where | Enforced by | Evidence |
|---|---|---|
| EVM, atomic factory (Base Sepolia `0x98a0…7145`, Ethereum Sepolia `0xD641…6d2`, BNB Testnet `0x8c48…fBbE`, mainnet) | **The contract.** The buy that completes the curve graduates it in the same transaction, or the whole buy reverts. So a curve is either trading or graduated, and trading continues on the DEX; it is never complete-but-closed. `reopen()` can never apply. If a pre-created pool blocks graduation (audit F-1), the site clears it within the same action. | `launch-guarantees.test.mjs`, `atomic-graduation.test.mjs`, `graduation-griefing.test.mjs` |
| Solana | **The site.** The buy that completes the curve and the PumpSwap migration go in **one transaction**. If the migration fails, the buy fails with it and the curve keeps trading. For SOL pairs, wrapping moves to its own transaction only if everything does not fit in one; buy and migration always stay together. A creator's first buy cannot complete the curve at launch, because the migration does not fit inside the launch transaction. | `solana.test.mjs` ("completing buy and PumpSwap migration in ONE transaction"), on the real program and PumpSwap fixtures |

**Not covered:**
- **Older EVM launchpads** (the earlier Base Sepolia factories kept for their existing tokens, such as AIZEN) graduate in a
  separate step. Their tokens can still be complete but not graduated. The token page and the keeper graduate them,
  and after 24 h anyone can reopen (checklist A8).
- **Solana curves completed outside the site.** The program allows a plain `buy` that completes the curve without
  migrating; on the site, the completing buy always migrates. Anyone can migrate such a curve from its token page,
  and the 24 h reopen remains the last resort. Making this airtight on-chain would need the program to migrate
  inside `buy`, which is a program change.

## 2. Token details are published at launch, inside the launch transaction, and never afterwards

| Where | Enforced by |
|---|---|
| Solana | **The program.** `launch` requires a valid metadata URI and writes immutable Metaplex metadata. The site also refuses to launch on a program without metadata support. |
| EVM, mainnet factory (`ElpidaAtomicDexFactory`, from 23 Oct) | **The contract.** `requiresMetadata()` is true: `launch` and `launchPaired` (which take no URI) revert with `metadata required`, and `launchWithPayment` reverts on an empty URI and on anything that is not `ipfs://`. The URI is recorded once in the launch transaction, and there is no setter. Every new deployment (mainnet, BNB, any redeploy) gets this. |
| EVM, everywhere | **The site.** It stages the details and passes the URI in the launch transaction. Where details cannot go in, the site refuses to launch and says why: an old launchpad without metadata support, or a chain whose shared launchpad is not set up yet (Robinhood Testnet today). |
| After launch | **Removed.** The signed "publish saved token details" option is gone from the token page. The server answers `410` on `/api/public/metadata/prepare` and `/save`. Details a creator signed on testnet before this rule (22–23 Oct) still display. |

**Not covered:** the two atomic factories deployed on testnet before 23 Oct (Base Sepolia `0x98a0…7145` and Ethereum
Sepolia `0xD641…6d2`) predate the on-chain rule (BNB Testnet's `0x8c48…fBbE` enforces it), so a direct contract call there can still launch without details.
The site never does. Redeploying them would enforce it on-chain too, but that is optional on testnet.
