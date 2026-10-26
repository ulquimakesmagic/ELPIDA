# Design: early-partner tiers with buyback and burn (one release, before the audit)

Status: **agreed scope, 26 October 2026 (Malik).** Community takeovers were considered and dropped: Elpida takes no
power to redirect anyone's creator fees. This release adds early-partner fee tiers only, on every chain, deployed to
the four EVM testnets and the Solana devnet program, then audited once with the rest of the mainnet scope.

## 1. What we are building

A **"Partner with Elpida"** form in the site footer. Devs apply to become early partners:

| Tier | Creator | Buyback and burn | Elpida |
|---|---|---|---|
| Standard (everyone) | 50% | — | 50% |
| Partner | 50% | 10% | 40% |
| Elite (solid projects, assigned by Elpida) | 50% | 20% | 30% |

Percentages are shares of the 1.25% trading fee, and of the locked pool's LP fees after graduation.

- **The creator's share never changes.** The tier gives up part of Elpida's share to **buy back and burn the token**,
  which benefits every holder. (Decided 26 October 2026 instead of direct holder payouts. Direct payouts would need
  the holder-payout system finished and audited, would invite snapshot gaming, and could look like dividends. They
  can be reconsidered later.)
- Elpida reviews applications in the admin panel. Approval registers the dev's launching wallet on each chain with a
  tier and an **expiry date**: 60 days by default, set per partner at approval (one to two months).
- Every token that wallet launches **before the expiry** carries the tier for its whole life. Tokens launched later,
  or by anyone else, are Standard.

The tier is an onboarding incentive: it rewards devs who bring launches to Elpida early. It is not a permanent
status.

## 2. Contracts (EVM)

### 2.1 Partner registry, in the factory

- `setPartner(address creator, uint16 buybackBps, uint64 expiresAt)`, callable only by the **treasury** (the Safe on
  mainnet):
  - `buybackBps` must be 1000 (Partner) or 2000 (Elite), and `expiresAt` must be in the future and at most 180 days
    ahead;
  - `setPartner(creator, 0, 0)` ends a partnership early;
  - emits `PartnerSet`.
- `buybackShareOf(address)` returns the burn share a launch by that wallet would get right now: 0 unless a tier exists
  and has not expired.
- At launch, the factory records the **launching wallet's** share for this launch. The new curve reads it once in its
  constructor, the same way it reads `automaticGraduation()`, and stores it as an **immutable** `buybackBps`.
- Changing or ending a tier never affects tokens already launched.

### 2.2 On the bonding curve

On every buy and sell, the base fee (1.25%) splits three ways:

- **creator:** 50%, rounded in the creator's favour exactly as today;
- **burn:** `buybackBps`;
- **Elpida:** the rest.

The burn part is used **in the same transaction** to buy tokens from the curve at the current price, with no fee.
Those tokens go straight to the dead address.

- There is no keeper and no separate call that could be front-run or delayed.
- The quote paid goes into the curve's real reserve, so it ends up in the locked pool at graduation.
- If a buyback would reach the sale cap, it is skipped, and that amount is added to the locked-liquidity bonus
  instead. A buyback can never complete or graduate the curve.
- A buyback too small to buy one token unit goes to the locked-liquidity bonus too.
- The accounting invariant becomes: quote balance = real reserve + Elpida fees + creator fees + liquidity bonus
  (unchanged, because the bought tokens are paid into the reserve). Tokens are still conserved: curve, holders,
  pool and the dead address.
- The anti-snipe surplus (above 1.25% in the first minute) is unchanged: it still goes to locked liquidity.

### 2.3 After graduation (LP fees)

The fee splitter splits LP fees the same three ways:

- **Token side:** the burn share of the token-side fees is sent to the dead address when fees are collected.
- **Quote side:** the burn share of ETH or USDC fees is held for buyback. Anyone can call `buyback()`, which swaps it
  for the token through the pool and burns what it receives.
- **Protecting that swap** (changed during implementation, 26 October 2026; this replaces the earlier TWAP plan):
  - each call spends at most **1% of the pool's quote balance**; a larger queue takes several calls;
  - with the 1% pool fee, an attacker who moves the price before and after a buyback that small pays more in fees
    than the buyback's price impact gives back, so a sandwich loses money;
  - only the pool can call the swap callback, only during the splitter's own buyback, and only for at most the
    queued amount.
  - Why not a TWAP: it would add gas to every fee collection and a price-history dependency, for no extra safety at
    this size.

### 2.4 Solana

The same in the Anchor program, in one upgrade:

- a `PartnerConfig` PDA per creator wallet (`buyback_bps`, `expires_at`), written only by the program's treasury
  authority;
- the share is fixed in the pool state at launch;
- curve trades buy and burn in the same instruction;
- PumpSwap LP-fee harvests burn the token side and hold the SOL side for a bounded buyback.

## 3. Site, server and admin panel

- **Partner form** (footer link → `#/partners`):
  - Fields: launching wallet per chain (EVM and/or Solana), X handle, Telegram, optional email, the tier requested,
    a short pitch and links to past launches.
  - The applicant signs one free message per wallet to prove they own the wallet that will launch.
  - Stored server-side with the minimum personal data; rate-limited; never public.
- **Admin panel, "Partners" area:**
  - an application queue with notes; approve with tier, expiry and the chains to register, or reject;
  - approving prepares the registration transaction for each chain, which the **treasury wallet signs**. The panel
    holds no keys and sends nothing by itself;
  - a list of active partners with their tier, expiry, chains and the tokens launched under the tier;
  - "End partnership", which also needs the treasury's signature.
- **Visible to everyone:**
  - the create page tells a partner wallet its tier and expiry before launch;
  - the token page shows "Partner · 10% of fees buy back and burn" (or "Elite · 20%") and the total burned so far.
- **Partner terms:** the tier, the expiry, future launches only, and that Elpida may end it early (again future
  launches only).

## 4. What does not change

- Tokens already launched keep their 50/50 split and recipients. Their factories stay indexed as legacy deployments.
- The creator's 50% is never reduced, for anyone.
- Unchanged: the $10 launch fee, Model 10 pricing, the 1.25% fee, graduation and locked liquidity.
- The treasury's only new power is the partner registry. It cannot change any launched token's split, recipient,
  liquidity or tokens.

## 5. Delivery, in order

1. **EVM contracts**, in two PRs: (a) the registry and the curve buyback (#105); (b) the LP-fee buyback with the 1%
   depth cap. Unit tests and invariants:
   - the split sums exactly for 0, 1000 and 2000;
   - burned tokens go to the dead address and never complete the curve;
   - expiry is enforced at the launch block;
   - only the treasury can register;
   - a tier change does not touch launched tokens;
   - the splitter burns the token side, and each quote-side buyback spends at most 1% of the pool's quote balance;
   - both fuzz campaigns run with partner launches too.
2. **Solana program** changes with tests.
3. **Server:** applications store and APIs; admin review and transaction preparation; indexer and API expose each
   token's share.
4. **Site:** footer form, the create page notice, the token page label, and the admin panel's Partners area.
5. **Redeploy** factories on the four EVM testnets and upgrade the devnet program. Rerun the full lifecycle on each,
   including one partner launch and one expired-partner launch.
6. **Update `AUDIT_SCOPE.md`** (the partner registry, the treasury's new power, new invariants), then send to auditors.

## 6. Open choice

- **Cap on launches per partner within the window** (for example 10), so one approved wallet cannot launch dozens of
  Elite tokens. Off unless Malik wants it; it is a small addition to the registry.
