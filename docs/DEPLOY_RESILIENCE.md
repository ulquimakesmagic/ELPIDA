# Redeploys without a broken page

## What happens today
During a Railway redeploy there is a short window where nothing answers, and Railway shows its own
"Application failed to respond" page. The window is longest when the service has a **volume**: Railway stops the
old container before the new one can mount the same volume, so a volume-backed service always has a short gap.

## What is in the app (this repo)
- `/health` reports a `build` id (`RAILWAY_GIT_COMMIT_SHA`, first 12 characters; `dev` locally).
- `apps/web/resilience.mjs`: an open tab probes `/health` every 20 s while visible. Two failed probes show a small
  "Elpida is updating. Reconnecting…" strip, retried at 3, 6, 12 then 15 s. When the server returns:
  - same build: the strip disappears and the page carries on;
  - new build on Explore or Docs with nothing focused: the tab reloads itself;
  - new build anywhere else (launch, token trading, rewards): a **Refresh** button, never a forced reload,
    so a wallet flow or a half-filled form is not lost.
- Graceful shutdown on SIGTERM already existed.

This covers people who already have Elpida open. Someone who opens the site *during* the gap still reaches Railway's
page, because the app is not running to answer them. Hiding that page needs something in front of Railway.

## Hiding Railway's error page (needs Malik)
`ops/cloudflare/fallback-worker.js` is a Cloudflare Worker that passes every request through and only replaces a
Railway failure (502, 503, 504, 52x, or no answer) with Elpida's own page: it reloads itself every 10 s and returns
`503` + `Retry-After: 10`, the correct signal for search engines that the outage is temporary. API calls get a JSON 503.
Responses that came from Elpida itself (they carry `X-Request-Id`) are never replaced.

Setup (free Cloudflare plan is enough):
1. Move the `elpida.fun` DNS to Cloudflare (change nameservers at the registrar). Keep the Railway CNAME, proxied (orange cloud).
2. Workers & Pages → Create Worker → paste `ops/cloudflare/fallback-worker.js` → Deploy.
3. Worker → Settings → Triggers → add route `elpida.fun/*`.
4. SSL/TLS mode: **Full (strict)**.
5. Check: during the next redeploy, elpida.fun shows "Elpida is updating" instead of Railway's page.

Moving DNS also changes how Google verification works: the Search Console TXT record must be copied to Cloudflare first.

## Shortening the gap on Railway
- Keep `healthcheckPath: /health` (already in `railway.json`): Railway only routes to a new deployment once it is healthy.
- Without a volume, Railway overlaps old and new deployments, so there is no gap at all. With a volume there will
  always be a short gap; the strip and the Worker are what make it invisible.
