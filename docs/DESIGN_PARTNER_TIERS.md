# Design: early-partner fee tiers (one release, before the audit)

Status: **agreed scope, 26 October 2026 (Malik).** Community takeovers were considered and dropped: Elpida takes no
power to redirect anyone's creator fees. This release adds early-partner fee tiers only, on every chain, deployed to
the four EVM testnets and the Solana devnet program, then audited once with the rest of the mainnet scope.

## 1. What we are building

A **"Partner with Elpida"** form in the site footer. Devs apply to become early partners:

| Tier | Creator share of trading fees | Elpida share |
|---|---|---|
| Standard (everyone) | 50% | 50% |
| Partner 60 | 60% | 40% |
| Partner 70 | 70% | 30% |

Elpida reviews applications in the admin panel. Approval registers the dev's launching wallet on each chain with a
tier and an **expiry date**: 60 days by default, set per partner at approval (one to two months). Every token that
wallet launches **before the expiry** carries the tier's split for its whole life, on the bonding-curve fee and on the
locked pool's LP fees. Tokens launched after the expiry, or by anyone else, are standard 50/50.

The tier is an onboarding incentive: it rewards devs who bring launches to Elpida early. It is not a permanent
status.

## 2. Contracts (EVM)

### 2.1 Partner registry, in the factory

- `setPartner(address creator, uint16 creatorShareBps, uint64 expiresAt)`, callable only by the **treasury** (the Safe
  on mainnet):
  - `creatorShareBps` must be 6000 or 7000, and `expiresAt` must be in the future and at most 180 days ahead;
  - `setPartner(creator, 0, 0)` ends a partnership early;
  - emits `PartnerSet(creator, creatorShareBps, expiresAt)`.
- `creatorShareOf(address)` is a public view returning the share a launch by that wallet would get right now:
  5000 unless a tier exists and has not expired.
- At launch, the factory records the **launching wallet's** share for this launch. The new curve reads it once in its
  constructor, the same way it already reads `automaticGraduation()`, and stores it as an **immutable**
  `creatorShareBps`.
- **Changing or ending a tier never affects tokens already launched.**

### 2.2 Using the share

- **Curve:** `creatorFees += base * creatorShareBps / 10000`, and the protocol gets the rest. This replaces the
  hard-coded `base / 2`. The fee is still exactly 1.25%, and rounding still favours the creator by at most 1 wei. The
  anti-snipe surplus (above 1.25% in the first minute) still goes to locked liquidity.
- **Graduation:** the curve passes `creatorShareBps` to the migration adapter (new field in its `Request`). The adapter
  passes it to the LP fee locker, and the locker passes it to the fee splitter, which uses it instead of `amount / 2`.
- Fixed for life: there is no way to change a token's share after launch.

### 2.3 Solana

The same in the Anchor program, in one upgrade:

- a `PartnerConfig` PDA per creator wallet, holding `creator_share_bps` and `expires_at`, written only by the program's
  treasury authority;
- at launch, the program reads it (if present and not expired) and stores the share in the pool state;
- the curve fee split and the PumpSwap LP-fee harvest use it.

The devnet program is upgraded once, then verified (`HUMAN_ACTIONS.md`).

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
  - the create page tells a partner wallet its share and expiry before launch;
  - the token page shows "Partner token · 70/30" in its details and safety card.
- **Partner terms:** the tier, the expiry, future launches only, and that Elpida may end it early (again future
  launches only).

## 4. What does not change

- Tokens already launched keep their 50/50 split and recipients. Their factories stay indexed as legacy deployments.
- Unchanged: the $10 launch fee, Model 10 pricing, the 1.25% fee, graduation and locked liquidity.
- The treasury's only new power is the partner registry. It cannot change any launched token's split, recipient,
  liquidity or tokens.

## 5. Delivery, in order

1. **EVM contracts** with unit tests and invariants:
   - the split sums exactly for 5000, 6000 and 7000;
   - expiry is enforced at the launch block;
   - only the treasury can register;
   - a tier change does not touch launched tokens;
   - the pool fee splitter uses the token's share;
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
  70% tokens. Off unless Malik wants it; it is a small addition to the registry.
