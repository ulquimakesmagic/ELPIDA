# Swap panel and USD market cap

The token trade panel now uses pay/receive cards, token metadata avatars, asset icons, Buy/Sell tabs and a currency dropdown. Non-native pairs offer their quote asset or the chain native coin. Selling selects the receive currency; buying selects the spend currency. Choosing a new currency or side clears the old amount and quote.

Native EVM trades use the atomic native routing implementation previously pushed after PR149 merged. This branch includes that implementation. Both hops must succeed together; unsupported wallets, unavailable liquidity and issuer restrictions fail before submission. The underlying quote pair is unchanged. Native routes use fixed 1% minimum-output protection per hop, disclosed in the panel. Direct trades retain configurable slippage. V2 taxed tokens and Solana native conversion remain unsupported; direct pair trading is available.

No conversion liquidity is created by this UI change. STKTEST still needs funded ETH/tNVDAon test liquidity for its native route. No mainnet actions were performed.

Market cap in the token strip, Explore cards and creator portfolio rows uses a fresh USD reference. Missing/stale USD references show `USD unavailable`, never a pair-denominated market cap. Market-cap charts require USD and show an unavailable state without it. Price, liquidity and volume retain their explicitly labelled pair fallback.

Validation: local isolated browser preview exercised pair quote, native selection, buy/sell switching, token image, dropdown and slippage settings. Preview quotes were fixtures; they are not public-chain routing evidence. Focused routing, batch, signer and shell tests passed 15/15; USD/chart/discovery checks passed 19/19. Full suite: 664 tests, 631 passed, zero failures, 33 environment skips (Solana validator unavailable on Windows). Entry market cap and launch-preview fallback labels were then brought under the same USD-only rule and focused checks rerun.
