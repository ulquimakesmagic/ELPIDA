# Design: partner fee tiers and community takeovers (one release, before the audit)

Status: **proposal for review.** Nothing here is built. Decisions are Malik's (26 October 2026) unless marked as a
recommendation. Every change below ships in one contract release, deployed to the four EVM testnets and the Solana
devnet program, and then audited once with the rest of the mainnet scope.

## 1. What we are building

**Dev partnership.** A "Partner with Elpida" form in the site footer. Devs apply for an early-partner tier:

| Tier | Creator share of trading fees | Elpida share |
|---|---|---|
| Standard (everyone) | 50% | 50% |
| Partner 60 | 60% | 40% |
| Partner 70 | 70% | 30% |

Elpida reviews applications in the admin panel. Approving one registers the dev's wallet on-chain with its tier. Every
token that wallet launches afterwards carries that split for its whole life: on the bonding-curve fee and on the
locked pool's LP fees.

**Community takeover (CTO).** When a dev abandons a token, its community can take it over:

1. The community runs its petition in its own community (X, Telegram, the token's holder chat). There are no wallet
   signatures from holders.
2. A leader applies to Elpida with a form on the token page, linking the petition.
3. Elpida reviews it in the admin panel and decides where the token's creator fees go from then on:
   - **to holders**, as rewards paid out in rounds, in proportion to holdings; or
   - **to a takeover lead**: a person's wallet or, recommended for larger communities, a community multisig.
4. The change is announced on the token page and takes effect after a public notice period.

More generally, the admin can route **any** token's creator fees (on the new contracts) to holders or to a named
wallet. Takeovers are the main use.

## 2. Contracts (EVM)

### 2.1 Partner registry, in the factory

- `setPartner(address creator, uint16 creatorShareBps)`, callable only by the **treasury** (the Safe on mainnet).
  Allowed values: 5000 (removes the tier), 6000, 7000. Anything above 7000 reverts, so Elpida's share can never fall
  below 30% by mistake. Emits `PartnerSet`.
- At launch, the factory reads the launching wallet's share and passes it into the new curve and fee splitter as an
  **immutable** `creatorShareBps`. Changing or removing a tier later affects only that wallet's future launches.
  Tokens already launched keep the split they were born with.
- Curve: `creatorFees += base * creatorShareBps / 10000`, and the protocol gets the rest. This replaces today's
  hard-coded `base / 2`. Rounding stays in the creator's favour by at most 1 wei.
- Fee splitter: the same share in its constructor instead of `amount / 2`.
- The anti-snipe surplus (the fee above 1.25% in the first minute) is unchanged: it still goes to locked liquidity.

### 2.2 Creator fee router, one per token

Today the curve and splitter pay the creator's chosen wallet directly, and that address is immutable. In the new
release the factory deploys a small **`ElpidaCreatorFeeRouter`** per token, and that router is the creator recipient
everywhere. It holds a *route*:

| Route | Where `claim()` sends creator fees |
|---|---|
| `Creator` (default) | the creator's chosen wallet, exactly as today |
| `Lead` | a named wallet (a takeover lead or a community multisig) |
| `Holders` | the holder-reward distributor, funding the next payout round |

Who can change it:

- **The current beneficiary** may hand over to another wallet at any time: a voluntary handover, or a move to a new
  wallet of their own.
- **The treasury** may change the route only in two steps: `proposeRoute(route, target)`, then, after a public
  **notice period** (recommendation: 72 hours; Malik to confirm), `executeRoute()`. `cancelRoute()` withdraws a
  proposal. The notice period is a constant in the contract, visible to anyone.
- On `executeRoute()`, everything accrued **before** the change is first paid to the previous beneficiary. Only
  fees from then on follow the new route. No one loses fees they had already earned.

The router has no other powers: it cannot touch the curve, the pool, the liquidity or anyone's tokens. It moves only
creator fees, and only along the route.

**Holders route, details.** Payouts reuse `ElpidaHolderEpochs` (the Phase 2 candidate in `HOLDER_EPOCHS_PHASE2.md`):
a snapshot of balances at a past block, a published Merkle root, then push payments. That distributor pays ERC-20 only,
so native fees (ETH, BNB) are wrapped (WETH, WBNB) before funding a round. Excluded from every snapshot: the curve, the
pool and locker, the dead address, the treasury, the router itself and the original dev's wallet. The `HOLDER_EPOCHS`
production requirements (governed publisher, persistent manifests, completeness checks) become part of this release.

### 2.3 Solana

The same two features in the Anchor program, in the same upgrade:

- a `PartnerConfig` account per creator, written only by the program's treasury authority;
- a per-token creator-fee route account with the same three routes, the same handover rule and the same treasury
  propose, wait and execute flow.

The devnet program is upgraded once, then verified (`HUMAN_ACTIONS.md`), as with the 19 October build.

## 3. Site and server

- **Partner form** (footer → `#/partners`):
  - Fields: wallet, X handle, Telegram, optional email, chains, tier requested, a short pitch and links to past
    launches.
  - The applicant signs one free message to prove they own the wallet that will receive the higher share. This is
    the applicant only, not holders.
  - Stored server-side with the minimum personal data; rate-limited.
- **Takeover form** (token page → "Community takeover"):
  - Fields: the proposed route (holders or a lead wallet), the petition link, community links, the plan.
  - A lead signs once to prove they control the lead wallet. A holders route needs no wallet.
  - Then the token page shows the case publicly: open, under review, approved with its notice countdown, or rejected
    with a reason.
- **Admin panel** gains an "Applications" area:
  - partner and takeover queues, notes, and approve or reject;
  - approving prepares the transaction (`setPartner`, `proposeRoute`, `executeRoute`) for the **treasury wallet to
    sign**;
  - the panel still holds no keys and cannot send anything by itself;
  - a "Routes" view lists every token whose fees are not on the default route.
- **Disclosure.**
  - The create page and the terms state, before launch, that on the new contracts Elpida may redirect creator fees
    after a takeover review, with public notice.
  - Partner terms state the tier, that it applies to future launches only, and that Elpida may end it for new launches.

## 4. Review checklist for takeovers (guidance for reviewers, not enforced on-chain)

- **Abandoned:**
  - no trade, claim or post by the dev for 30 days or more; or
  - the dev holds under 1% of supply after selling.
- **A real community:** 50 or more holders, and some trading in the last 7 days.
- **The petition is real:** a public post, active replies and supporters who hold the token, not fresh empty wallets.
- **The lead has skin in the game:** holds 0.5% or more; is not the original dev or a wallet funded by them.
- **Holders or lead?**
  - Prefer **holders** when no clear lead exists or the community is split.
  - Prefer a **community multisig** over a single person for anything sizeable.
- **One open case per token.** A takeover can be reviewed again later under the same rules.

The admin panel shows the numbers it can check (holders, dev activity, lead holding) next to each case.

## 5. What does not change

- **Tokens already launched:**
  - keep their recipients and their 50/50 split; nothing on-chain can redirect them;
  - a takeover there is voluntary only: the old dev forwards fees by hand;
  - their factories stay indexed as legacy deployments.
- **Unchanged:** the $10 launch fee, Model 10 curve pricing, the 1.25% fee, graduation and locked liquidity.
- **The treasury gains no power over liquidity, tokens or trade execution.** Its new powers are limited to the
  partner registry and creator-fee routes, behind the notice period.

## 6. Delivery, in order

1. EVM contracts with unit tests and invariants: the partner split sums exactly, the router conserves fees, the
   notice period is enforced, pre-change fees go to the previous beneficiary, holder exclusions apply. Add these to
   both fuzz campaigns.
2. Solana program changes with tests.
3. Server: applications store and APIs; admin review and transaction preparation; holder-round automation.
4. Site: footer partner form, token-page takeover section and status, admin Applications and Routes views,
   disclosures.
5. Redeploy factories on the four EVM testnets and upgrade the devnet program. Rerun the full lifecycle on each,
   including one partner launch and one takeover per route.
6. Update `AUDIT_SCOPE.md` (new files, new treasury powers, new invariants), then send to auditors.

## 7. Decisions needed from Malik

1. The notice period before a route change takes effect: 72 hours recommended (48 hours to 7 days is reasonable).
2. Holders route: pro-rata by holding (recommended), or equal per wallet above a minimum?
3. A minimum holding to receive holder rewards, to keep dust wallets out (for example 0.01% of supply).
4. Do partner tiers also apply to Solana launches from the same person's Solana wallet? (Each chain needs its own
   registration, because the wallets differ.)
5. Should an Elpida admin also be able to end a partner tier for future launches? (Recommended yes; it never affects
   tokens already launched.)
