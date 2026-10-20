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

## Hiding Railway's error page (live since 20 October 2026)
`ops/cloudflare/fallback-worker.js` is a Cloudflare Worker that passes every request through and only replaces a
Railway failure (502, 503, 504, 52x, or no answer) with Elpida's own page: it reloads itself every 10 s and returns
`503` + `Retry-After: 10`, the correct signal for search engines that the outage is temporary. API calls get a JSON 503.
Responses that came from Elpida itself (they carry `X-Request-Id`) are never replaced.

### What is configured (Cloudflare free plan)
- Registrar stays Vercel; only the nameservers moved to Cloudflare (`ada.ns.cloudflare.com`, `cullen.ns.cloudflare.com`).
  Undo: Vercel → Domains → elpida.fun → Nameservers → **Restore Original Nameservers**. DNSSEC is off.
- DNS records (nothing else; the scan's Vercel leftovers, CAA records and the fixed-IP apex record were removed):

  | Type | Name | Content | Proxy |
  |---|---|---|---|
  | CNAME | `elpida.fun` | the service's `*.up.railway.app` host (flattened at the apex) | Proxied |
  | TXT | `elpida.fun` | `google-site-verification=…` (Search Console) | DNS only |
  | TXT | `_railway-verify` | `railway-verify=…` (Railway custom domain) | DNS only |

  If the Railway service or its domain is recreated, update the CNAME target to the new `*.up.railway.app` host.
- SSL/TLS: Cloudflare **Automatic SSL/TLS** (it scans the origin and picks the mode). Never use Flexible: it loops with Railway.
- Worker `elpida-fallback`, code identical to `ops/cloudflare/fallback-worker.js` (pasted, not retyped).
  Attached as a **Route** `elpida.fun/*` (not a Custom Domain, which would replace Railway as the origin).
  Failure mode **Fail open**: past the free 100k requests/day, traffic bypasses the Worker straight to Railway.
- Checked after setup: `/`, `/learn`, `/learn/faq`, `/sitemap.xml`, `/robots.txt`, `/health`, `/api/config` return 200
  through Cloudflare with Elpida's `X-Request-Id`; HEAD on the sitemap returns 200.

### Changing the Worker
Edit `ops/cloudflare/fallback-worker.js`, run `npm test` (the Worker has tests in `tests/resilience.test.mjs`), merge,
then in Cloudflare: Workers & Pages → `elpida-fallback` → Edit code → replace all → Deploy. Keep the two copies identical.

### Setting it up again from scratch
1. Cloudflare → Add a domain → `elpida.fun` → Free. Make the records match the table above exactly.
2. At the registrar, replace the nameservers with the two Cloudflare assigns; make sure DNSSEC is off first.
3. After the "active" email, check the site loads through Cloudflare.
4. Workers & Pages → Create → Start with Hello World → name it → Deploy → Edit code → paste the file → Deploy.
5. Worker → Domains → **Add Route** → zone `elpida.fun`, route `elpida.fun/*`, Fail open.
6. Check: during the next redeploy, elpida.fun shows "Elpida is updating" instead of Railway's page.

## Shortening the gap on Railway
- Keep `healthcheckPath: /health` (already in `railway.json`): Railway only routes to a new deployment once it is healthy.
- Without a volume, Railway overlaps old and new deployments, so there is no gap at all. With a volume there will
  always be a short gap; the strip and the Worker are what make it invisible.
