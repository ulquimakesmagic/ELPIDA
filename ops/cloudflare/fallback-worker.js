// Cloudflare Worker in front of elpida.fun. It passes every request to Railway untouched. Only when Railway cannot answer
// (a redeploy, a restart, a crash) does it return Elpida's own "back in a moment" page instead of Railway's error page.
// The page refreshes itself, and crawlers get 503 + Retry-After, which tells search engines the outage is temporary.
const RETRYABLE = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]);
const RETRY_SECONDS = 10;

const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${RETRY_SECONDS}"><meta name="robots" content="noindex"><title>Elpida · Back in a moment</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#08090b;color:#e9ecef;font:16px/1.6 system-ui,sans-serif;text-align:center;padding:16px}
main{max-width:420px}h1{font-size:1.6rem;margin:16px 0 8px}p{color:#a3a9b1;margin:0 0 8px}.dot{width:10px;height:10px;border-radius:50%;background:#c8f560;margin:0 auto;animation:p 1.2s ease-in-out infinite}
@keyframes p{50%{opacity:.25}}@media (prefers-reduced-motion:reduce){.dot{animation:none}}a{color:#c8f560}</style></head>
<body><main><div class="dot" aria-hidden="true"></div><h1>Elpida is updating</h1><p>We are shipping an improvement. This page will reload by itself in a few seconds.</p><p><a href="">Reload now</a></p></main></body></html>`;

function fallback(request) {
  const api = new URL(request.url).pathname.startsWith('/api/');
  const headers = { 'Retry-After': String(RETRY_SECONDS), 'Cache-Control': 'no-store' };
  return api
    ? new Response(JSON.stringify({ error: 'Elpida is updating. Retry shortly.' }), { status: 503, headers: { ...headers, 'Content-Type': 'application/json' } })
    : new Response(page, { status: 503, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
}

export default {
  async fetch(request) {
    try {
      const response = await fetch(request);
      return RETRYABLE.has(response.status) && !response.headers.get('X-Request-Id') ? fallback(request) : response;
    } catch {
      return fallback(request);
    }
  },
};
