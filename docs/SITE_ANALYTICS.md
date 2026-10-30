# Terms of Use dialog, cookie banner and visitor analytics

Added 30 October 2026. Code: `apps/web/consent.mjs` (browser), `apps/web/terms.mjs` (the Terms), `apps/api/site-analytics.mjs` (server),
`apps/web/admin-visitors.mjs` (operator Visitors tab). Tests: `tests/site-analytics.test.mjs`.

## What a visitor sees

1. **Terms of Use.** On the first visit a dialog blocks the app until the visitor ticks "I have read and agree to the
   Elpida Terms of Use, and I am not a Restricted Person (section 4)" and presses Accept. Decline shows a short
   "you need to accept the Terms" panel with a way back; nothing else works until they accept. The text is in
   `apps/web/terms.mjs` and is also at `#/terms` (footer: "Terms of use"). It opens with capitalised notices (experimental,
   unaudited, test networks; not registered with any regulator, not an offer or advice; liability limits and individual
   disputes), then 21 numbered sections. Section 4 always restricts comprehensively sanctioned places and sanctioned
   persons; `ELPIDA_RESTRICTED_JURISDICTIONS` adds named places (see [HUMAN_ACTIONS.md](HUMAN_ACTIONS.md)). The
   operating entity, governing law and dispute forum are not invented: the text says they will be stated once
   decided. This is a draft for counsel, see [TERMS_AND_RISK_DRAFT.md](TERMS_AND_RISK_DRAFT.md).

   The acceptance is stored in the browser with a version number; raising `TERMS_VERSION` (and `TERMS_UPDATED`) asks
   everyone again. Escape does not dismiss it. This is a click-through agreement, not a geo-block.
2. **Cookie banner.** After the disclaimer: "Essential only", "Allow analytics" or "Settings". Essential storage
   (network, theme, wallet choice, these answers, the upload and operator cookies) is always on. Analytics is off until
   allowed. A browser that sends Global Privacy Control is not shown the banner and stays essential-only. "Cookie
   settings" in the footer and on Docs → Privacy reopens it at any time.
3. **Docs → Privacy and cookies** explains the above in plain language.

## What is collected, only with analytics allowed

| Field | Source | Notes |
|---|---|---|
| Visitor | random 128-bit id made in the browser when analytics is allowed | stored as a salted hash; deleted from the browser when analytics is turned off |
| Session | random id per browser tab | salted hash |
| Page | fixed list: explore, launch, portfolio, rewards, analytics, docs, partners, terms, token, notfound | the operator panel is never counted; search text never leaves the browser |
| Token, network | the token page being viewed, the chosen network | public data |
| Source | `?ref=` or `utm_source` on the link, else the referring site's host | host only |
| Country | Cloudflare's `CF-IPCountry` header | two letters |
| Device | phone, tablet or computer, from the user agent | the user agent itself is not stored; bots are dropped |

Not stored: IP addresses, user agents, wallet addresses, search text. The salt lives only in
`site-analytics.sqlite` on the data volume. Page views are deleted after 90 days.

The Terms and consent choices are counted per day with no id at all ("Terms accepted", "Terms declined",
"analytics allowed", "essential only"), so the Visitors tab can show what share of visitors the numbers cover.

## Endpoints

- `POST /api/telemetry`: needs the page's `X-Elpida-Token` like every other POST. 60 events a minute per client, 6,000
  in total. Unknown fields are dropped and unknown pages or ids are refused.
- `GET /api/admin/visitors?days=1|7|30|90`: operator session only. Totals for today, 7 and 30 days, a daily series,
  returning visitors, top pages, tokens (with symbols), sources, countries, devices and networks, and the choice counts.

## Limits worth knowing

- Totals are a lower bound: visitors who choose "Essential only" or send Global Privacy Control are not counted.
- A visitor on two browsers counts twice; clearing site data makes a returning visitor look new.
- The country comes from Cloudflare. A request that reaches Railway directly has no country.
- This is not legal advice. Whether opt-in analytics and a click-through disclaimer are enough for a given country is
  a question for counsel; the questions are listed in [TERMS_AND_RISK_DRAFT.md](TERMS_AND_RISK_DRAFT.md).
