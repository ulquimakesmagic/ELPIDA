# Trading pairs

Every network uses the same three pair kinds, defined once in `packages/core/pairs.mjs`. The launch flow always shows all three; a kind that a network cannot offer is shown disabled with the reason. There are no dollar (USDC) pairs: pricing is native (see `docs/NATIVE_PRICING.md`).

| Kind | Local simulation | Base Sepolia (DEX launchpad) | Other EVM testnets (basic launchpad) | Solana |
|---|---|---|---|---|
| Native coin | ETH | ETH | ETH / tBNB | SOL (wrapped automatically) |
| xStock | TEST-STOCK (simulated) | TEST-STOCK once the owner approves it | Not available: needs DEX graduation | **Not available:** PumpSwap refuses xStock mints |
| Paired token | Graduated ETH-paired Elpida tokens | TEST-MEME once the owner approves it | Not available: needs DEX graduation | TEST-MEME |

## Creation fee

Always paid in the network's own coin, whatever the pair, at the value in `config/native-pricing.json` (for example 0.01 SOL on Solana Devnet, 0.0001 ETH on Base Sepolia). The team changes it with `scripts/native-pricing.mjs` (Solana) or **Apply native pricing** (EVM).

The launch flow shows the fee in the native coin, and adds it to the purchase when the pair is also the native coin.

## Setting up the test pairs

- **Solana:** run `solana-upgrade.cmd` (`npm run solana:deploy -- --upgrade`). It upgrades the program and creates the SOL and TEST-MEME configs. The TEST-MEME faucet appears under *Network and funds*.
- **Base Sepolia:** the launchpad owner (its treasury wallet) opens *Network and funds* and chooses **Add test xStock and token pairs**. That takes six confirmations and costs only gas: each test asset is deployed, gets a Uniswap migration adapter, and is approved with a curve starting at 20 TEST-STOCK or 500,000 TEST-MEME FDV.

## Solana: new launches pair with SOL only (1 November 2026)

Every new Solana launch pairs with SOL and graduates to Raydium CPMM. The site no longer offers USDC, token or stock
pairs for new Solana launches, even where the program has their configs (`SOLANA_LAUNCH_KINDS` in
`packages/core/pairs.mjs`). The program itself is unchanged. Tokens already launched on other pairs keep trading on
their PumpSwap pools, and stay indexed and claimable.

## Why xStocks are not on Solana yet

Real xStocks are Token-2022 mints with an issuer permanent delegate. PumpSwap rejects permanent-delegate quote mints (`UnsupportedQuoteMint`, checked against the real program on a local validator). An xStock-paired curve could therefore fill up but never graduate, so the program refuses such configs. Meteora DAMM v2 accepts the badged xStock mints, so the way to add them is a DAMM v2 graduation path for xStock pairs.

## Wallet connection

People choose which wallet to use:

- **EVM:** wallets are discovered through EIP-6963.
- **Solana:** Phantom, Solflare or Backpack.

This matters because several extensions compete for `window.ethereum`. The extension that wins may not support the selected testnet and then never opens a prompt.

Connecting asks for accounts first, then switches the chain. A request already pending in the wallet (`-32002`) and a wallet that does not answer within 90 seconds both show a message saying what to do.
