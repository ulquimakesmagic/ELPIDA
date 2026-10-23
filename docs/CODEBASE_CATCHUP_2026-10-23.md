# Codebase catch-up — 23 October 2026

Reviewed `origin/main` at `7f3b1cdf2848b2918d7a887bbf34f5cd470c644a`
(PR #64), compared with our previous stopping point `7351064` (PR #26).
There are 91 intervening commits and changes to 113 files. This is a source and
recorded-evidence review, not a fresh public-chain or hosted-service audit.

## Progress since this chat last worked on the project

- **Base Sepolia standard lifecycle:** the current mainnet checklist records
  SONGOKU atomic graduation on 21 October, then a DEX buy, sell, fee collection
  and claims. The old instruction to complete SONGOKU is superseded. See A2,
  A3 and A5 in `MAINNET_CHECKLIST_2026-10-19.md` for transaction hashes.
- **Ethereum Sepolia:** the chain fork check is recorded as 13/13, Model 10 is
  enabled, and the team factory at block 11972040 is pinned. VEGETA graduation,
  post-pool sell and claim evidence is in `MULTICHAIN_TESTNETS.md`. Do not mix
  same-address contracts across chains: the Ethereum factory address also
  appears in Base's legacy registry, but these are separate deployments.
- **BNB/PancakeSwap:** adapter slot0 compatibility, router layouts, Swap parsing
  and fork RPC diagnostics/fallbacks were added. `testnetDexes` still has BNB
  disabled pending its successful fork run. Robinhood has no enabled ELPIDA
  public testnet DEX integration.
- **Wallets:** public RPC handles reads, gas estimation and receipt discovery;
  the selected browser wallet still signs and submits. EIP-5792 batches reduce
  approval/trade prompts where supported. Permissionless fee claims can use
  Multicall3; launched-token sells use a standing approval, while quote-asset
  payments keep exact approvals. Public tax flows remain a separate path.
- **Solana:** optional-buy binaries were rebuilt on 19 October; the checklist
  records 26/26 validator tests. The devnet upgrade and updated on-chain build
  verification are still open. Do not repeat the obsolete claim that no binary
  has been built; do not claim the rebuilt binary is already deployed.
- **Product:** portfolio/docs/analytics/theme/chart work, SEO/token previews,
  mobile/a11y improvements and deployment resilience landed. The recorded public
  domain is `elpida.fun`, with Cloudflare fallback Worker setup documented.
- **Reliability/security:** EVM economic-invariant and indexer recovery tests,
  Solana-mainnet production guard, secrets/dependency review, incident runbook
  and optional second-provider backup mirror were added. The written review is
  not an independent contract audit; its dated npm/secret results are not a
  newly rerun assessment.
- **Tokenized equity:** provider registry, capability gates, issuer-risk
  disclosures and local/fork/simulation tools were added. Stock capabilities
  remain off; bStocks are explicitly excluded. Fork evidence is not permission
  to enable live assets. The unreachable stock-reserve graduation floor was
  retired; stock-paired simulation uses completion.
- **Tax tokens:** the existing 1.25% base fee and 30/70 additional-tax model are
  unchanged. No public `taxDeployment` is registered. The V2 test deployment
  plan, honest venue labels and tax deployment tooling remain separate work.

## Next steps supported by current evidence

1. Complete a **USDC-paired public lifecycle** (A4) on Base Sepolia: launch,
   curve buy/sell, atomic graduation, DEX buy/sell and claims. The existing native
   SONGOKU lifecycle no longer needs repeating merely because of old chat notes.
2. Upgrade and verify the rebuilt Solana devnet program (B1), then exercise
   optional creator buy and post-PumpSwap indexing (B3).
3. Finish BNB's fork check with a suitable RPC before enabling that DEX path.
4. Complete the independent audit, multisig/upgrade authority setup, second
   backup provider plus timed restore drill, monitoring and legal review before
   any mainnet decision. Token taxes and tokenized equities stay gated.

`AGENTS.md` now makes codebase catch-up mandatory whenever an agent resumes.
Use the latest mainnet checklist and newer deployment evidence when older
dated sections disagree. No mainnet work is authorized by this catch-up.
