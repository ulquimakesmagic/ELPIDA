# Ondo stock quote pairing — groundwork, 2026-10-28

This phase adds Ondo as an explicitly selected provider alongside existing providers on Ethereum, BNB Chain, Solana and Robinhood Chain. It does not activate public stock launches, change Model 10, change wallet selection, or submit transactions. Base is not included. Nine issuer-sourced canonical records are imported: NVDAon, TSLAon and SPYon on Ethereum, BNB and Solana. Ticker matching and third-party address lists are insufficient. Contract transfer and price semantics remain unverified.

The public discovery endpoint accepts `provider=ondo`, for example `/api/public/tokenized-equity?network=ethereum&provider=ondo`. Omitting the provider retains existing defaults. Discovery lists the imported assets with every capability disabled. These are not launch options. Mainnet Ondo addresses cannot be resolved through testnet aliases.

## What pairing means

An ELPIDA token/Ondo-stock pool holds actual stock tokens as its quote reserve. This is different from periodically buying stocks with creator rewards. Launch quote reserves, secondary trading, graduated pools, reward conversion, reward distribution and direct issuance/redemption retain separate capability gates. Verifying one does not enable another.

Ondo's technical documentation lists Ethereum, BNB Chain and Solana, plus selected bridged stocks on Robinhood Chain and HyperEVM. HyperEVM is outside ELPIDA's current network registry. The October 27 Robinhood announcement describes Uniswap v4 StablePair pools between matching stock tokens; those pools do not establish compatibility with ELPIDA's token/stock graduation route.

## Next verification phase

1. Address discovery complete for NVDAon, TSLAon and SPYon on Ethereum, BNB and Solana. Confirm the exact deployment bytecode and issuer control roles. Do not copy mainnet assets into testnet configuration.
2. Confirm raw transfer behavior, corporate-action accounting, freeze/pause/upgrade powers and the proposed curve, router and pool contracts' ability to hold and transfer each asset. Solana needs extension-aware venue checks independently from EVM.
3. Establish fresh total-return pricing and executable liquidity checks. A stock's quoted market price is not necessarily an executable swap price. Do not apply dividend/display scaling twice or assume all operations remain available outside market hours.
4. Rehearse launch without creator purchase, buy, sell, curve completion, automatic graduation, post-graduation swaps and fee claims against a pinned fork. Check issuer pauses, stale prices, failed transfers and conservation of raw reserves. Existing local ERC-20 lifecycle tests are harness evidence only, not Ondo approval.
5. Resolve jurisdiction and contract-custody eligibility, then record per-asset, per-chain capability evidence before enabling any flag. Nigeria remains unconfirmed. Direct issuer onboarding and secondary-market eligibility are distinct requirements.

## Primary sources

- https://docs.ondo.finance/ondo-stocks/technical
- https://docs.ondo.finance/ondo-stocks/corporate-actions
- https://docs.ondo.finance/ondo-stocks/eligibility
- https://docs.ondo.finance/ondo-stocks/secondary-market-restrictions
- https://ondo.finance/blog/ondo-stocks-live-on-robinhood-chain-and-uniswap

The shared conversation is background context, not evidence of an Ondo partnership or permission to distribute securities.

## Address discovery and fork rehearsal

`node scripts/ondo-assets.mjs` fetches official issuer asset pages and writes `backups/ondo-address-review.json` for review. It does not edit the registry. The parser reads structured asset records rather than arbitrary page addresses, checks chain identity, and rejects redirects, duplicates and conflicting records. The nine registry records were retrieved with this tool on 28 October.

The local-only EVM runner accepts:

```powershell
$env:ELPIDA_EQUITY_FORK_RPC = '<read-only archive RPC URL>'
$env:ELPIDA_EQUITY_HOLDER = '<existing funded holder address>'
node scripts/equity-lifecycle-fork.mjs ethereum NVDAon ondo
```

Use `bnb` for the BNB deployment. The holder is impersonated only inside Hardhat; no wallet or private key is used. Upstream calls read chain ID, block height and balances. All contract deployment, funding transfers, trades and graduation occur on the local fork at the recorded upstream block. Reports include network, provider, symbol, address and source. Ondo mode uses the atomic factory, publishes test metadata and launches with no creator purchase. This checks transfer/pool compatibility, not issuer eligibility or a production oracle.

On 28 October the attempted public Ethereum and BNB archive endpoints returned HTTP 403. A real Ondo fork lifecycle is therefore **not verified**. Local mock lifecycle results must not be promoted to real-contract verification. No stock-pair capability or deployment flag was enabled.

## Local validation

28 focused registry/discovery/accounting tests, 10 API integration tests and three local EVM lifecycle tests pass (41 total, no skips). Lifecycle coverage includes legacy 6-decimal quotes and atomic graduation with zero creator buy at both 6 and 18 decimals. The 18-decimal check caught a missing quoteDust term in the rehearsal balance assertion; conservation now includes separately recorded migration dust without changing any production contract.

The broader npm test run started in the original shared checkout is still in progress; it is not a completed validation of this isolated branch. Real Ondo transfer, issuer-control, oracle and venue tests remain open.
