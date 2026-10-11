# Unified token creation flow

Open Create a token and choose a chain inside the form. No wallet is requested when opening the page. Selecting an EVM testnet requests an EVM wallet connection and network switch; selecting Solana requests its wallet. The local demo uses simulated accounts.

If a connection fails or is cancelled, the token draft stays in place and Connect wallet allows a retry. Chain selection is disabled during wallet requests. A successful connection stays on its selected network even if refreshing balances fails.

First-time EVM testnet setup appears in the same form, followed by token creation. Setup and launch remain separate signed transactions. A shared factory configured by the team skips individual setup; public shared factories are not currently configured. Chain contracts and balances remain independent, and the explorer still displays the active network. This change unifies creation, not cross-chain balances or market indexing.

Solana still requires the model 3 program upgrade and initialization documented in LAUNCH_AVAILABILITY.md. Browser setup cannot deploy or upgrade the program.
