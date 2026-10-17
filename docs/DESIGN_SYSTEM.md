# Elpida design system (v2)

Status: Phases 1–2 of the UI rebuild (`claude/ELPIDA-brew-style-rebuild-prompt.md`) — tokens, recipes, the app shell, and Home / Explore. The token page, launch, portfolio, analytics and docs are rebuilt in later phases; until then they render inside the new shell with the new palette applied to their existing components.

Files: `apps/web/theme.css` (tokens, recipes, shell; loaded after `styles.css`), `apps/web/explore.css` + `apps/web/explore-view.mjs` (Home / Explore), `apps/web/odometer.mjs` (rolling numbers), `apps/web/shell.mjs` (dock, theme, search, Last sale strip), `apps/web/theme-boot.js` (applies the saved theme before first paint; same-origin script, so the CSP still forbids inline scripts).

## Look
- Near-black canvas. Every surface is a floating rounded panel: a hairline border (0.67px, about one device pixel), a soft diagonal gradient and a faint inset top highlight.
- One accent family, used sparingly: the primary button, active states (accent-tinted gradient plus an inner glow), key numbers, one highlighted word per heading.
- Pills for every control (buttons, chips, search, tabs). Cards 20–26px radius, inner tiles 14–18px.
- Small muted labels over large tight numbers. Geist for text, Geist Mono for addresses, ages and contract fields.
- Honest figures: estimates and partial totals say so.

## Fonts
Geist and Geist Mono variable fonts (SIL OFL 1.1, `apps/web/assets/fonts/GEIST-OFL.txt`), self-hosted. Bricolage Grotesque and IBM Plex Sans remain only as fallbacks.

## Tokens
| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` | `#08090b` | `#f7f8f3` | Page |
| `--panel` / `--panel-2` / `--panel-3` | `#151517` / `#1e1e21` / `#2a2a2e` | `#fff` / `#f1f3eb` / `#e5e9dd` | Cards, inner tiles, tracks |
| `--panel-hi` → `--panel-lo` | `#1d1d1f` → `#0e0f11` | `#fff` → `#f7f8f2` | Card gradient (145°) |
| `--ink` / `--ink-2` / `--muted` | `#f2f1ed` / `#c9c8c2` / `#929298` | `#1d271a` / `#3c4736` / `#626d59` | Text |
| `--line` / `--line-soft` / `--line-faint` | white at 13% / 8.6% / 6% | ink at 12% / 9% / 6% | Card borders / inputs / table rows |
| `--up` / `--down` | `#76ed9a` / `#ffa1a1` | `#18884a` / `#c2413b` | Gains, losses |
| `--accent`, `--accent-hi`, `--accent-lo` | `#adff45`, `#d4ff8a`, `#7fcc1f` | same | Button gradient, fills |
| `--accent-ink` | `#0b1406` | same | Text on accent |
| `--accent-text` | `#b8ff5c` | `#3d7a08` | Accent-coloured text and icons |
| `--accent-tint` / `--accent-glow` | accent at 10% / 9% | darker green at 13% / 14% | Active fills, focus rings, glows |

Changing the accent family retints the whole app. The legacy names (`--paper`, `--surface*`, `--primary*`, `--ink-3`, `--positive`, `--negative`…) are mapped onto these tokens in `theme.css`.

## Recipes
| Class | Recipe |
|---|---|
| `.btn-accent`, `.btn-primary` | Vertical gradient `--accent-hi → --accent (60%) → --accent-lo`, accent hairline, `--accent-ink` text, pill, inset top highlight, soft accent glow. Sizes 38 / 44 / 48px. |
| `.btn-secondary` | Pill, near-transparent fill, `--line` hairline; brighter border on hover. |
| `.is-active`, `[aria-current]` nav, pressed segmented buttons | `linear-gradient(rgba(255,255,255,.043) 50%, var(--accent-tint))`, white 15.7% hairline, `inset 0 -3px 7px var(--accent-glow)`, accent icon. |
| `.card`, `.panel` and existing cards | 145° panel gradient, `--line` hairline, 20–24px radius. |
| `.chip` | Pill, 4% white fill, `--line-soft` hairline, 11px. Positive / negative / simulation variants. |
| `.input`, `.select`, `.textarea` | 46px, page-colour fill, `--line-soft`, 12px radius; focus = accent border + 3px accent ring. |
| `.icon-tile` | 44px rounded square, accent tint, accent icon. |
| `.round-button` | 36px circle, hairline, muted icon. |
| `.label-xs` | 9px uppercase, 0.5px tracking, muted. |

## Shell
- **Dock (desktop, > 780px).** Floating sidebar 8px from the viewport edges. Collapsed it is 80px of icons: Explore, Create, Portfolio, Rewards, Analytics, How it works; then the accent Launch button, the chain menu (all networks plus the simulation), theme, help and pin. It widens to 232px on hover or keyboard focus and the page reflows, not overlays. The pin keeps it open (remembered per browser). The tools stay in one column, so nothing moves under the pointer while it widens.
- **Top bar.** Sticky floating pill: search (Ctrl/⌘ K, filters Explore in place, kept in step with the Explore field), the Last sale strip, and the wallet button (accent when disconnected, quiet when connected, monospace for an address).
- **Last sale strip.** Newest buys across every indexed network from `GET /api/public/recent-trades` (token identity, side and time only; no accounts or amounts). It scrolls only when it overflows, pauses on hover, refreshes every 30 seconds while the tab is visible and hides when empty or in the simulation.
- **Mobile (≤ 780px).** Logo, chain menu, search and wallet in the header; theme moves to the footer. A floating bottom tab bar: Explore, Portfolio, a raised accent Create, Rewards, Analytics; the active tab gets accent text, a tinted tile and a glowing dot.
- **Footer.** Rounded card with a soft accent glow, links, a faint "elpida." watermark and a strip with the network note and the theme switch.
- **Wallet dialog.** Icon tile, title, "Available in this browser" with a re-scan button, one row per detected wallet (last used first), and the reassurance line. Uses the existing EIP-6963 and Wallet Standard discovery.
- **404.** Unknown routes show "Page not found." with a link to Explore.
- **Themes.** Dark by default, light on request; saved in `localStorage` (`elpida:theme`) and applied before first paint.

## Home / Explore (phase 2)
Data: every listing (`/api/public/tokens`, the simulation's `/api/state`) carries 24-hour activity from the indexers: `volume24h` (pair asset, including trader fees), `trades24h`, `buys24h`, `sells24h`, `lastTradeAt`, `lastBuyAt` (`indexedActivity` in `discovery.mjs`). Dollar figures use the existing references (native oracle; USDC at $1); pairs without one stay in their own asset. Ordering, filters, pages and URL state are pure functions in `discovery.mjs` (`exploreModel`, `trendingTokens`, `topCreators`, `feedRows`, `pageOf`, `exploreHash`), tested in `tests/explore-model.test.mjs`.

| Module | Behaviour |
|---|---|
| **Trending** | Tokens that traded in the last 24 hours, by dollar volume (unpriced pairs follow by trade count). Snap carousel: 4 / 3 / 2.2 / 1.4 cards per view by width (container query), prev/next buttons, edge fades only while there is more to scroll. Card: image area (or accent initials), rank chip, 24h change pill when known, name, ticker with pair + chain icons, curve bar or "Graduated", MARKET CAP / 24H VOLUME, address and age. Hidden when nothing traded. No "Pinned / Official" chip until a protocol pin list exists. |
| **Top creators** | Creators ranked by the 24h dollar volume of the tokens they launched (`+` marks a partial total). Clicking a pill filters Explore to their launches. Hidden when empty. *Deviation from the prompt:* it asked for creator fees earned over 7 days; the indexers hold only current unclaimed fees, not an earnings history, so volume is the honest available measure. |
| **Explore** | Sort tabs Trending · Market cap · New pairs · Last sale · Graduating (closest to completion, waiting migrations first). Filter field (name, ticker, address prefix of 4+ characters, or a full creator address), kept in step with the top bar search. "Paired with" chips with counts (All, Native, USDC, xStocks, Tokens; unavailable kinds disabled with the reason). Chain chips on public networks only. 8 list cards per page, 2 columns (1 below ~620px of list width). |
| **List card** | Image 82px (64px on small phones), NEW chip under 24h, name with ↗, `$TICKER · pair+chain icons · age · Dev x%` (amber above 10%), market cap (odometer, 19px) and 24h volume (odometer), curve bar, "Bought 4m ago" and copyable short address. The whole card is a link (stretched name link); the copy button sits above it. |
| **Live feed** | Sticky 340px column (drops below the list when the Explore column is under ~980px). Latest buys from `/api/public/recent-trades` (public networks) or `/api/recent-trades` (simulation); rows: avatar, name, `$TICKER · QUOTE`, "Bought 33s ago", market cap. New rows slide in. "Live" shows only while there are buys. Toggle remembered per browser (`elpida:feed`). A Notes tab (holder theses) is deferred: theses are per token and need holder checks, so there is no cross-token feed yet. |
| **Pagination** | "Showing 1–8 of N tokens · 8 per page", square page buttons with gaps, prev/next. |
| **URL** | `#/?tab=new&pair=usdc&chain=solana-devnet&q=…&page=2` (defaults omitted) via `history.replaceState`; pasted links restore the view. |
| **Dollar note** | One line under the list: the native references in use, with sources in a disclosure. |

Live updates: one Explore controller per visit; refreshes update cards in place (keyed by network and address), so values roll and flash only on real changes. Relative times tick every 15 seconds.

### Odometer (`odometer.mjs`)
`odometer(text, class)` renders one span per character plus a visually hidden copy for screen readers. `setOdometer(el, text, direction)`: when the value keeps its shape, changed digits roll up (rose) or down (fell) in 280ms; the value tints `--up` / `--down` for 1.2s and eases back. Unit changes (dollars ↔ pair asset) swap without rolling. Reduced motion keeps the tint, drops the roll.

## Motion
Dock width 220ms; label fades 120ms; marquee about 40px per second. Cards enter with a 260ms fade-up, staggered 30ms (first 12); hover lifts cards 2px and scales images to 1.03; feed rows arrive in 300ms. `prefers-reduced-motion` turns off the dock transition, the marquee, rolls, lifts and slides, keeping opacity fades and colour flashes.

## Checks
- `tests/web-shell.test.mjs`: every element the scripts look up exists in `index.html`; every local file the page references is served; no inline scripts; every sprite icon used exists; the recent-trades endpoint answers.
- `tests/explore-model.test.mjs`: 24h activity (EVM and Solana tables), trending, tabs, filters, chip counts, search, pages, creators, live feed join, URL round-trip. `tests/api.test.mjs` checks listing activity and the simulation's recent trades.
- No horizontal overflow at 320, 390, 768, 1280 and 1440px on Explore (including a paged view), Create, Portfolio, Analytics and the 404 page, in both themes.
