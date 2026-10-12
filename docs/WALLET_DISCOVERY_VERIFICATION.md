# Wallet discovery and launch responsiveness

EVM: EIP-6963 announcements plus deduplicated legacy EIP-1193 providers (including provider arrays and dedicated Rabby, Coinbase, OKX, Trust, Phantom and Backpack globals). Discovery does not prompt; a selected, missing wallet fails instead of silently opening another extension. EVM chain switching uses only that chosen provider.

Solana: Wallet Standard discovery filters the configured Solana chain and legacy transaction signing capability. Standard adapters pass the selected chain and account, and preserve mint co-signing. Existing Phantom, Solflare and Backpack injection remains a fallback. Not every extension supports every EVM network or Solana devnet; only installed, compatible providers are offered.

Icons: use wallet announcements and Wallet Standard icons, with local Phantom/Solflare fallbacks from anza-xyz/wallet-adapter and MetaMask fallback from MetaMask/metamask-extension. Base and Robinhood icons are the user-supplied PNGs.

Responsiveness: coalesce matching refreshes, bound read API requests to 15 seconds, and use the public indexer on Explore/Analytics rather than rereading every contract through browser RPCs. Launch, trading and portfolio still request wallet-specific contract state. No uncertain transaction is automatically retried.

Liquidity on cards means actual indexed quote funds in the curve or DEX; it excludes virtual reserves and is not two-sided pool TVL. Starting valuation remains unchanged.

Verification: 17 API/discovery/pricing/capability checks and 3 wallet discovery/adapter checks pass. Browser verified Solana Phantom/Zerion discovery with loaded icons and Base wallet selection. Public transactions require user signing and sufficient test funds.

The factory QuoteApproved history was being rescanned in 100-block batches on first wallet load. Approved pair addresses now come from the durable factory event index, with each template verified against factory.approvedQuotes before asset metadata is used. Only unindexed tail blocks are queried in the browser. Chain changes reset the pair cursor and asset cache. Public EVM HTTP reads have a 15-second deadline. Trusted reconnection never requests accounts or switches chains.

22 focused checks passed, including validated factory pair provenance. The public Base launch draft reached the final review; no transaction was signed or submitted. The connected wallet had about 0.000499 ETH, below the roughly 0.004 ETH creation fee before first purchase and gas.
