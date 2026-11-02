# Stock logos

Ondo stocks show Ondo's own token icons automatically:
- **Source:** the server fetches each icon from Ondo's CDN (`cdn.ondo.finance/tokens/logos/<symbol>_160x160.png`).
- **Checks:** it fetches icons only for stocks in Ondo's catalog, accepts only small PNGs, and refuses redirects.
- **Caching:** it caches each icon on the data volume.
- **Serving:** it serves them from `/api/public/stock-icon/<SYMBOL>.png`, so the site's CSP is unchanged.

This is in `apps/api/stock-catalog.mjs`. A test stand-in such as tTSLAon shows the icon of the stock it imitates, with
a flask badge and a Test label.

When there is no issuer icon (another provider, or the CDN is unreachable), the tile shows the ticker on a colour of its
own. To show a different image for such a stock:
1. Add `<TICKER>.png` here, for example `TSLA.png`.
2. List the ticker in `STOCK_LOGOS` in `packages/core/stock-catalog.mjs`.

Only add images you are entitled to use.
