# Elpida design system (v2)

Status: Phase 1 of the UI rebuild (`claude/ELPIDA-brew-style-rebuild-prompt.md`) — tokens, recipes and the app shell. Explore, the token page, launch, portfolio, analytics and docs are rebuilt in later phases; until then they render inside the new shell with the new palette applied to their existing components.

Files: `apps/web/theme.css` (tokens, recipes, shell; loaded after `styles.css`), `apps/web/shell.mjs` (dock, theme, search, Last sale strip), `apps/web/theme-boot.js` (applies the saved theme before first paint; same-origin script, so the CSP still forbids inline scripts).

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

## Motion
Dock width 220ms; label fades 120ms; marquee about 40px per second. `prefers-reduced-motion` turns off the dock transition and the marquee (plus every existing animation, as before).

## Checks
- `tests/web-shell.test.mjs`: every element the scripts look up exists in `index.html`; every local file the page references is served; no inline scripts; every sprite icon used exists; the recent-trades endpoint answers.
- No horizontal overflow at 320, 390, 768, 1280 and 1440px on Explore, Create, Portfolio, Rewards, Analytics, a token page and the 404 page, in both themes.
