# Browser wallet chooser

The chooser connects only the wallet explicitly selected by the visitor. Discovery
never requests accounts, signatures or transactions. EVM and Solana provider choices
and saved preferences remain separate. No wallet SDK, WalletConnect relay, QR session,
new chain, or change to Model 10 pricing is introduced.

EVM wallets use EIP-6963 announcements first, including wallet-supplied data-image
icons rendered as img elements. Unknown conforming wallets work without an allowlist.
Legacy and wallet-browser namespaces additionally cover MetaMask, Trust Wallet,
Phantom, Zerion, Rabby, Coinbase, Brave, Rainbow, OKX, Backpack, Bitget, Binance and
TokenPocket. A window.ethereum.providers aggregate is not shown as an extra wallet.
Actual connection requires the selected wallet to support the selected chain.

Solana Wallet Standard is preferred. Signing-capable injected Phantom, Solflare,
Backpack, Trust Wallet, OKX, Coinbase and Bitget providers are also discovered.
EVM-only provider namespaces are never treated as Solana signing providers.

The install catalog links to official wallet sites and uses a separate disclosure;
its links are not represented as detected or connectable wallets. Logo files are
served locally; arbitrary remote wallet-icon URLs are not fetched.

## Logo provenance

Existing MetaMask, Phantom and Solflare SVGs are retained. Additional SVGs are from
RainbowKit's MIT-licensed wallet connector assets:
https://github.com/rainbow-me/rainbowkit/tree/main/packages/rainbowkit/src/wallets/walletConnectors

- trust.svg: trustWallet/trustWallet.svg
- rabby.svg: rabbyWallet/rabbyWallet.svg
- zerion.svg: zerionWallet/zerionWallet.svg
- coinbase.svg: coinbaseWallet/coinbaseWallet.svg
- brave.svg: braveWallet/braveWallet.svg
- rainbow.svg: rainbowWallet/rainbowWallet.svg
- okx.svg: okxWallet/okxWallet.svg
- backpack.svg: backpackWallet/backpackWallet.svg
- bitget.svg: bitgetWallet/bitgetWallet.svg
- binance.svg: binanceWallet/binanceWallet.svg
- ledger.svg: ledgerWallet/ledgerWallet.svg (fallback for announced Ledger wallets)

The upstream license is preserved in
apps/web/assets/wallets/RAINBOWKIT-LICENSE.txt. Wallet names and logos belong to their
respective owners; their inclusion does not imply endorsement.

Reference: https://eips.ethereum.org/EIPS/eip-6963

## Verification

The wallet dialog regression tests execute the real chooser function at its DOM
boundary to catch array-to-text coercion, ensure only one selected connection can
be pending, and verify retry after a rejected request. Discovery tests cover
namespace deduplication, brand flags, unknown EIP-6963 wallets, bundled logo paths,
provider separation and explicit Solana account/chain signing.

Live visual verification was unavailable because browser access to the local
preview was declined. No actual extension account connection was requested.
Validation on 2026-10-17: 12 wallet dialog/discovery/batch tests passed; all 3 web
shell/static-serving tests passed. JavaScript syntax and diff whitespace checks passed.
