# Token trading terminal

The token page uses an 80-pixel desktop ribbon: compact token identity, market cap, spot price, actual liquidity, trailing 24-hour volume, supply and creator fees sit above an interactive TradingView Lightweight Charts chart. Holder/trade counts, chain context and price provenance are disclosed in the status dropdown. Mobile uses two compact rows with horizontally scrollable metrics. TradingView attribution and the Apache 2.0 license are retained. This is Lightweight Charts 5.2.1 using Elpida indexer candles, not TradingView Advanced Charts or an external TradingView listing. Advanced indicators, drawing tools and a licensed Advanced Charts integration are not included.

## Wallet position

The API uses confirmed indexed trades and balances. Weighted-average entry price is remaining trading-pair cost divided by remaining token holdings; entry market cap multiplies that average by total supply. Partial sales remove proportional cost and contribute to realized P&L. Unrealized P&L is marked position value minus remaining cost. Trading fees are included in indexed execution amounts; network gas is excluded. Marked values do not promise liquidation proceeds or account for sale price impact.

USD displays convert quote-asset values using the current reference. These are not historical USD entry values, and historical chart candles also use the current reference. No fabricated candles are generated. Missing trade history, transfers or uncertain DEX router payer attribution return unknown entry and P&L. EVM transfer events are checked against attributable trade transactions. Solana lacks full transfer indexing, so cost basis remains unknown until that coverage exists; holdings and current value still work.

## Holder theses

One latest thesis exists per network/token/wallet. Revisions remain public and immutable in the public-theses.sqlite WAL database, which is included in encrypted off-site snapshots and isolated restores. Only a verified holder can publish or update. A wallet signs the full text together with site origin, token, chain, wallet, version, content digest, random nonce and five-minute expiry. Signatures authorize text publication only; the API rechecks live chain holdings before accepting the text and atomically consumes the nonce. EVM externally owned wallets use verified personal-message signatures; Solana uses verified Ed25519 signatures. Contract-wallet EIP-1271 validation is not yet supported.

The public feed ranks current indexed EVM holders by balance. Solana rankings cover the largest token accounts returned by its indexer; missing authors are explicitly unranked. Readers may inspect retained historical versions after an author exits. Text is rendered as plain text. Holding and signing do not verify the accuracy of a thesis. Moderation/reporting is a remaining mainnet product requirement.

Limits: 2,000 characters, one update per minute, 100 versions per author/token, 10,000 total revisions, 1,000 outstanding challenges, 100 displayed feed entries. The API has process-wide read/write admission limits. Before large public traffic, add distributed per-client admission, pagination and durable abuse controls; the current limits target the testnet beta.

## Validation and scope

Position math, transfers, router ambiguity, signature tampering, spoofing, replay, loss of holdings, Solana signing and revision persistence are covered by tests. HTTP integration exercises position data and real simulated-wallet signing. Backup testing restores the thesis SQLite database alongside indexed tokens and metadata.

Existing curve and supported EVM DEX trading remains available. Graduated Solana trading continues through the existing external PumpSwap link. This change does not deploy new mainnet contracts or change fees, curve economics, supply, creator rewards or liquidity locks. An independent security audit and public funded graduation verification remain mainnet gates.
