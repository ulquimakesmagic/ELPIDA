# Elpida design system and UX decisions

October 2026 redesign of the web app (`apps/web`). It covers the brand, the tokens, the components and the reasons behind the main flows.

## Brand

**Mark.** A dawn sun rising over a horizon line, with a sprout cut out of the sun.
- Elpida means "hope". The mark reads as a beginning (sunrise) and as growth (the sprout).
- Because the sprout is negative space, the mark still works in one colour.
- At 16 px the sprout simplifies away, but the sun and horizon stay recognisable.

**Wordmark.** "elpida" in Bricolage Grotesque at weight 680, converted to outlines. It needs no font to render.

**Files in `apps/web/assets/brand/`:**

| File | Use |
|---|---|
| `elpida-mark.svg` | Colour mark |
| `elpida-mark-mono.svg` | `currentColor`, for single-colour print, stamps and overlays |
| `elpida-mark-dark.svg` | For dark backgrounds |
| `elpida-wordmark.svg`, `-dark`, `-mono` | Mark plus wordmark; used in the navigation |
| `elpida-logotype.svg` | Wordmark only; used in the footer |
| `elpida-app-icon.svg`, `favicon.svg`, `favicon-16.png`, `favicon-32.png`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `site.webmanifest` | App icon and favicons |

**Interface icons.** `apps/web/assets/icons.svg` is a sprite of 49 Lucide icons drawn with one stroke weight (ISC licence in `assets/LUCIDE-LICENSE.txt`). It replaces the previous mix of decorative Unicode symbols.

## Tokens (`apps/web/styles.css`, `:root`)

**Colour.** The user's latest direction is a black-and-green theme inspired by Helm. The app now stays dark regardless of the operating-system theme. The editable mark, wordmarks, favicons and manifest share the green accent. This replaces the earlier blue/saffron direction.

| Token | Value | Role |
|---|---|---|
| `--paper` | #080B09 | Near-black page background |
| `--surface` | #101512 | Cards and form panels |
| `--ink` | #F2F7F3 | Main text |
| `--primary` | #76ED9A | Green actions and selected states |
| `--dawn` | #76ED9A | Mark and bonding-curve progress |
| `--positive` / `--negative` | — | Buy and sell, success and error |
| `--sim` / `--testnet` | — | Environment badges |

**Type.**
- Bricolage Grotesque for headings and figures; IBM Plex Sans for the interface.
- Numbers use tabular figures.
- Fonts are self-hosted, as the server's content security policy requires.
- Scale: 12, 13, 15, 18, 22, 28, 36 px.

**Spacing, radius, shadow, motion.**
- Spacing: a 4 px base (4, 8, 12, 16, 20, 24, 32, 40, 56).
- Radius: 6 for inputs and chips, 10 for cards and buttons, 16 for panels and dialogs.
- Shadow: one subtle shadow for cards and one raised shadow for dialogs and toasts. There are no glows and no glass effects.
- Motion: 120, 180 and 260 ms with one easing curve. It is used for step changes, revealed settings, dialogs, toasts and progress fills. `prefers-reduced-motion` turns all of it off, and nothing delays a wallet or trade action.

## Components

Shared helpers in `ui.mjs` provide the building blocks below. All dynamic text is set with `textContent`, never parsed as HTML.

- Buttons: primary, secondary, ghost, buy, sell.
- Form fields: label, hint and error, wired with `aria-describedby`; inputs with a unit suffix.
- Choice cards: radio groups for network, trading pair and reward strategy.
- Chips, progress bars, avatars with an initials fallback, copy buttons, callouts, and a toast queue.

## Information architecture

**Navigation.** Explore, Portfolio and Rewards in the top bar; on small screens the same items plus Create sit in a bottom tab bar.

**Environment.** A badge in the top bar always shows the current environment:
- "Local simulation" (amber) or "Network · testnet" (blue).
- There is no live-network state, because there is no mainnet deployment.

The badge opens one panel for the environment, demo accounts, test funds, faucets and the one-time launchpad setup. This replaces the separate per-chain launch apps.

**Routes.** Hash routes: `#/`, `#/token/<address>`, `#/portfolio`, `#/rewards`, `#/launch`. The old `/launch` URL redirects to `#/launch`.

## Launch flow

The flow has five steps, with a stepper you can revisit, Back and Continue buttons, and a live preview and cost summary beside it.

1. **Token details.** Inline validation for each field. Logo upload is limited to PNG, JPG, WebP, GIF, AVIF or BMP up to 5 MB on every supported chain. Links are optional.
2. **Network and trading pair.** The wallet is requested only after a public testnet is chosen, and only through an explicit Connect wallet button. Setup and reconnect states are shown in place.
   - Unsupported pairs are disabled with a reason: Solana uses USDC only, and approved-token pairs are local only.
   - The trading pair is explained separately from the reward asset.
3. **Creator rewards.** Five strategy cards. Only the settings for the chosen strategy appear:
   - Allocation rows with a live check that the percentages total 100%.
   - Threshold, minimum token holding, reward asset or vesting, depending on the strategy.

   On public testnets, strategies other than creator wallets are disabled with the reason: the contracts are not deployed there yet. The step lists what is fixed at launch.
4. **First purchase.** Shows the creation fee, the purchase, the included trading fee, estimated tokens (calculated with the contracts' curve formula for USDC pairs) and the available balance.
   - The purchase is labelled as required, because the EVM factory and the Solana program both reject zero.
   - It is described as the first trade on a virtual bonding curve, not as funding a pool.
5. **Review.** Editable summary blocks, a "Fixed after launch" list, and the final action **Create token**.
   - Progress shows as separate states: Approve USDC (EVM USDC pairs), Confirm in your wallet, Submitted, Confirmed.
   - Rejections, insufficient funds and wrong networks show a readable error and **Try again**.

The draft is saved in session storage, so it survives failures, navigation and page reloads.

## Wording

- **Consistent terms:** trading pair, reward asset, creator fees, minimum token holding, distribution threshold, verify ownership, claim rewards.
- **Implementation detail kept out of the main flows:** vault and contract addresses sit behind "Technical details".
- **Market figures are defined where they appear:**
  - price;
  - market cap (price × circulating supply);
  - fully diluted value (price × total supply);
  - total supply;
  - circulating supply;
  - trading reserve.
- **Units:** USDC pairs show dollars, assuming 1 USDC = $1. Other pairs show values in the pair asset.
- **Holder payouts** are described as weighted by eligible holdings at the recorded snapshot.
- **TEST-STOCK** is always labelled as a simulated asset, never an issued xStock.

## Rewards dashboard

**Creator fees.** One row per token you created, with a Distribute fees action. PumpSwap LP fees that are ready to harvest appear here too.

**Reward treasuries** (local simulation). Each treasury separates:
- funds accumulating toward the threshold (with progress);
- completed holder distributions (snapshot block, number of holders, amount);
- rewards ready to claim;
- allocations awaiting ownership verification;
- verified allocations;
- vesting (total, unlocked, claimed).

**Ownership verification.** A four-step dialog:
1. Choose the payout wallet.
2. Get the DNS TXT record, with copy buttons, or create the X challenge.
3. Sign with the payout wallet.
4. Verify, or continue to X.

Failures explain the next action: DNS propagation, expired challenge, or wrong wallet. When the server has no X credentials, the dialog says so instead of offering a broken flow.

## Why not React or Next.js

The app is about 1,100 lines of plain ES modules with no build step. The server's content security policy (`script-src 'self'`) and same-origin API also suit a static, module-based client.

The quality problems were visual and structural, not a framework limit, so the redesign keeps the stack. Moving to React or Next.js would add a build pipeline and a second server, and gain little for this scope.

Motion follows the restrained patterns of Motion for React and Watermelon's animated components (short entrances, no idle animation), implemented in CSS.

## Verification (11 October 2026)

**Automated browser runs** (Playwright, Chromium, `e2e-ui.mjs`, `e2e-sol-ui.mjs`):

- **Local simulation:**
  1. Explore, open a token, get a quote and buy.
  2. Launch validation errors.
  3. Full launch with a logo upload and a 70% wallet / 30% website allocation, reaching the success state and the new token page.
  4. Reward treasury, then a DNS challenge in the verify dialog.
  5. Portfolio, then the environment panel.
- **Solana localnet with the real PumpSwap program:**
  1. Switch network, then the tUSDC faucet.
  2. Launch through all five steps.
  3. Wait out launch protection, complete the curve, migrate to PumpSwap.
  4. Migrated token page, then rewards.
- **Layout:** desktop (1360 px), tablet (820 px) and mobile (390 px), with no horizontal scrolling. No console errors.

**Unit and API tests:** `tests/api.test.mjs`, `reward-policy`, `metadata`, `launch-capabilities` and `x-verification`: 14 passed.

Screenshots are in `docs/screenshots/redesign-2026-10/`.

## Follow-up review and black/green theme

The existing redesign was preserved and reviewed against the pasted brief. Follow-up fixes retain connection errors after rerender, show the USDC creation-fee approval for native EVM launches, default simulated-stock purchases to 0.01 rather than 25, support 18-decimal token purchases, remove empty `null` placeholders from the purchase summary, and keep the reward-process button stable across asynchronous refreshes. X-service availability wording no longer exposes environment variable names in the main claim flow. Discovery copy describes the product without implying a token-quality guarantee.

Brand assets and original files were backed up before changes. New screenshots for the black/green version are in `docs/screenshots/black-green-2026-10/`. The 14 API, metadata, reward-policy, network-capability and X-verification checks passed in this review. Public integrations still require their existing deployments/credentials; this visual update does not enable undeployed reward strategies or real xStocks.

Browser review of the final theme completed a five-step local DAWN launch with 70% wallet / 30% website allocations, bought 10 simulated USDC of DAWN, confirmed the treasury split, and opened a DNS challenge with copyable records. No external domain ownership or X account was claimed. Layouts were inspected at 1360, 820 and 390 pixels, and the temporary viewport override was reset. Mobile step controls and the account button have explicit accessible names. Main text, muted text, primary-button and error-callout color pairs all exceed 4.5:1 contrast. The existing localhost server and existing user launches were kept running.
