# Stock logos (optional)

The launch picker, Explore and token pages show each tokenized stock as a tile: its ticker on a colour of its own,
with a small issuer mark ("on" for Ondo, "x" for xStocks, a flask for a test stand-in). See
`packages/core/stock-catalog.mjs`.

To show a logo instead of the ticker:

1. Add `<TICKER>.png` here. Use the underlying ticker, for example `TSLA.png` (not `TSLAon.png`). It should be square,
   at least 88 × 88 px, and on a solid background.
2. Add the ticker to `STOCK_LOGOS` in `packages/core/stock-catalog.mjs`.

Only add images you are entitled to use, for example the token icons an issuer publishes for integrators. Company logos
are trademarks, and an issuer's token icon is not permission to use the company's own brand.
