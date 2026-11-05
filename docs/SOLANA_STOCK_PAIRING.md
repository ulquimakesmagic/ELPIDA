# Solana stock pairing: what Ondo's mints are, and where they can graduate (4 November 2026)

Decided 3 November: Solana gets stock pairing (an exception to "new Solana launches pair with SOL only"), including
paying the creator's first purchase in SOL. This records what was read from mainnet and the venue decision it forces.

## What Ondo's Solana stocks are (read from mainnet, 3 November 2026)

| Mint | Program | Decimals | Extensions |
|---|---|---|---|
| TSLAon `KeGv…ondo` | Token-2022 | 9 | ScaledUiAmount (×1), MetadataPointer + TokenMetadata, **Pausable**, DefaultAccountState (initialized), **ConfidentialTransferMint**, **TransferHook (authority set, no program yet)** |
| SPYon `k18W…ondo` | Token-2022 | 9 | same; ScaledUiAmount ×1.00947 |
| NVDAon `gEGt…ondo` | Token-2022 | 9 | same; ScaledUiAmount ×1.00172 |

All three also have a **freeze authority**. No permanent delegate. Consequences:
- **Pause and freeze:** Ondo can stop every transfer or freeze any account, including a curve vault.
- **Transfer hook:** a hook program can be switched on at any time. Every transfer would then need the hook's extra
  accounts, and the hook may refuse program-owned accounts (Cointelegraph: hooks can block "transfers into certain
  smart contracts"). Today no hook runs.
- **Corporate actions:** ScaledUiAmount changes the displayed amount; raw balances do not move. Prices and UI amounts
  must apply the multiplier once (the registry's `raw-with-multiplier` model).

**Our program already accepts these mints as a quote** (`check_quote_mint` refuses only transfer fees, non-transferable,
permanent delegate, an active hook and a frozen default state). Only the upgrade authority can add a quote config, so
nothing is exposed today. The problem is graduation.

## Where Ondo's stocks trade on Solana today

Jupiter routes SOL → TSLAon as SOL → USDC → TSLAx (xStocks) → TSLAon, the last hop on **Manifest**, an order book.
Raydium's pool list has **no pool** for TSLAon, SPYon or NVDAon. So the SOL-paid first purchase can go through Jupiter
(one swap, then the launch, as on EVM); graduation needs a pool that accepts the mint.

## Which pools accept these mints

| Venue | Pausable | ConfidentialTransferMint | ScaledUiAmount | Transfer hook | Freeze authority | Route for Ondo mints |
|---|---|---|---|---|---|---|
| Raydium CPMM (our SOL graduation) | not supported | not supported | supported | registry only | not addressed | Raydium admin registers the mint (`support_mint`); Pausable may still be refused |
| Orca Whirlpools | not supported | non-confidential only | not supported | TokenBadge | TokenBadge | not possible (Pausable, ScaledUiAmount) |
| Meteora DAMM v2 | admin whitelist | admin whitelist | admin whitelist | admin whitelist | not stated | Meteora admin creates a token badge for each mint |
| Elpida's own pool (new) | we decide | we decide | we decide | we decide | we decide | no third party; we build and audit it |

Sources: Raydium's Token-2022 support matrix (docs.raydium.io/reference/token-2022-support), Orca's token extensions
page (docs.orca.so), Meteora's DAMM v2 README (github.com/MeteoraAg/damm-v2).

## The decision (Malik, 4 November 2026): option 3

**Decided: Elpida's own locked pool now, and Meteora DAMM v2 for each stock once Meteora badges it.**

### How the locked pool works (program change, 4 November 2026)

- **Which pairs use it.** A quote mint is a *locked-pool venue* when it is a Token-2022 mint with ConfidentialTransferMint
  (4), TransferHook (14), ScaledUiAmount (25) or Pausable (26) (`locked_pool_venue`). Ondo's stocks carry all four.
  Every other pair graduates exactly as before (SOL to Raydium, other tokens to PumpSwap).
- **Opening.** The buy that completes such a curve (a trade or the creator's launch buy) opens the pool in the same
  instruction: status `STATUS_LOCKED` (3), the anti-snipe bonus joins the quote reserve, and the virtual reserves become
  the real ones (`virtual_quote = 0`, `virtual_token = TOKEN_SUPPLY`). Event `LockedPoolOpened`. No migration step, no
  third party, nothing left waiting.
- **Trading.** `buy` and `sell` keep working: the same curve formulas now price x·y = k with x = the quote reserve and
  y = the token vault. The fee is the flat base fee (no anti-snipe), split as on the curve (creator half, protocol half,
  partner burns as fee-free buybacks). No completion point, so a buy is never partially filled.
- **Locked.** No instruction withdraws the reserve: `withdraw_fees` pays only accrued fees, `reopen_curve` and both
  migrations refuse a locked pool (`migrate_to_pumpswap` also refuses locked-venue mints outright).
- **Issuer controls.** If Ondo pauses the stock or freezes an account, the affected trades fail and nothing changes;
  trading resumes when the control is lifted. If Ondo switches on a transfer hook, trades fail until the program
  passes the hook's extra accounts (Ondo question 4); the reserve stays in the vaults either way.
- **Checked by:** host property tests (`contracts/solana/host-tests/tests/locked_pool.rs`: k never falls, every quote
  unit accounted for, holders can always sell everything, the token vault is never emptied, the pool opens at the
  curve's closing price) and a validator test with an Ondo-shaped stand-in mint (`tests/solana.test.mjs`, "Solana stock
  pairs (Ondo stand-in)": pause and freeze during the curve and in the pool, the completing buy, trades matching the
  client, refused migration and reopen, fee payout).

### What is still to do

1. ~~Devnet upgrade~~: done 5 November 2026 (`docs/HUMAN_ACTIONS.md`); tTSLAon stand-in `HE4L…HjYd`.
2. ~~Launch picker~~: done 5 November. The picker offers a Solana stock only while its mint is a locked-pool venue,
   not paused and without a transfer hook; the operator panel's Pairs tab shows each Solana stock pair with those
   checks. Approval itself is creating the pair config, signed by the upgrade authority (deploy key on devnet; the
   Squads vault on mainnet once the registry verifies a stock).
3. **SOL-paid first purchase** through Jupiter (mainnet) and a devnet SOL/stand-in pool, resumable like the EVM version.
4. **Meteora DAMM v2** per stock once Meteora badges it: a later migration out of the locked pool needs its own
   program change and review; until then the locked pool is the venue.

### The options that were considered


1. **Meteora DAMM v2 with a token badge.** Ask Meteora to badge TSLAon, SPYon, NVDAon (and later ones), then build
   graduation into DAMM v2. Graduated pools are visible to Jupiter and aggregators. Depends on Meteora's answer.
2. **Elpida's own locked pool.** After the curve completes, trading continues in a constant-product pool inside our
   program, liquidity locked forever (the same idea as Model 11 on EVM). No third party, works for any mint we accept,
   but Jupiter does not route to it until we integrate with Jupiter, and the audit scope grows.
3. **Both:** our own pool now, migrating to DAMM v2 for each stock once Meteora badges it.

Whatever the venue, every stock pair also needs: Ondo's answer on transfer hooks and program-owned accounts
(`claude/ELPIDA-ondo-chainlink-setup-2026-11-03.md`, question 4); a SOL/USD and stock price source on Solana for the
stale-price and corporate-action gate; and a devnet stand-in mint with exactly these extensions for testing.

## Build order once the venue is chosen

1. Devnet stand-in: a Token-2022 mint with ScaledUiAmount, Pausable, ConfidentialTransferMint, TransferHook (no
   program), DefaultAccountState initialized, metadata and a freeze authority; issuer controls like the EVM tTSLAon.
2. Program: curve config for the stand-in; graduation into the chosen venue; refuse graduation while the mint is
   paused, the vault is frozen or a hook is active, keeping the curve tradable (never stuck); multiplier-aware prices.
3. SOL-paid first purchase: Jupiter quote and swap first (mainnet), a devnet SOL/stand-in pool for testing, then the
   launch with what the swap delivered, resumable like the EVM version.
4. Indexer, launch picker and token page for Solana stock pairs; then the devnet program upgrade and audit scope.
