# JUICEWRLD Base Sepolia fork verification

## Verified result — 13 October 2026

**PASS**, using Base Sepolia block **48075531**. The script executed 15 successful local transactions against the copied deployed contracts. It spent **16,197.283346 local USDC** to complete JUICEWRLD, graduated it, checked price continuity and locked NFT custody, executed both DEX trade directions and paid creator/protocol fees in both pool assets. Fee collection left position liquidity unchanged; an unauthorized principal withdrawal reverted.

Graduation consumed **6,939,714 gas** in the fork. This is an execution measurement, not a public Base fee estimate. The test does not reproduce the Base sequencer or its L1 data fee.

The run needed a local block after forking to avoid missing historical hardfork activation data and a direct local signer for the impersonated USDC master minter. Public RPC reads were slow and one setup attempt timed out. The successful run used the same public upstream without replacing contract code or economics.

The public token remains on its curve. Live graduation, public indexing of new DEX events, browser migration UX and independent security review remain separate requirements.

## Running the check

Run `npm.cmd run test:base-fork` from the project folder. This launches an in-process Hardhat chain with chain ID 31337 and copies Base Sepolia at a fixed block. It does not expose a server, load user keys or submit upstream transactions. The upstream RPC is used only for reads. Every simulated write is guarded by local chain identity and Hardhat metadata checks.

The script targets the existing JUICEWRLD token and curve, verifies the Circle USDC quote and deployed Uniswap manager/factory addresses, and locally impersonates Circle's master-minter role to authorize a local test signer. It mints 20,000 USDC in the local copy only. It does not rewrite curve parameters, replace contract code or change public USDC balances.

The script buys the remaining curve allocation with a bounded approval, graduates through the deployed migration adapter and Uniswap copies, checks terminal price continuity and NFT ownership by the immutable locker, buys and sells through SwapRouter02, collects fees, claims the protocol/creator shares and verifies principal liquidity is unchanged. It also checks that an unauthorized liquidity withdrawal reverts. Swap outputs have a 1% minimum-output margin.

The report is saved in `backups/base-fork/lifecycle-report.json`, which is ignored by Git. Transaction hashes in that report are local simulation receipts; they are not public explorer transactions. A PASS is integration evidence, not an independent audit or proof of live-chain graduation.

Optional environment variables:

- `ELPIDA_BASE_FORK_RPC`: a Base Sepolia RPC with historical-state access. Keep URLs containing API keys out of Git and shared logs.
- `ELPIDA_BASE_FORK_BLOCK`: a specific safe integer block number after JUICEWRLD creation and before its public graduation. The default is the live head minus ten blocks.

Public RPC availability and historical-state access can limit the test. An RPC failure must not be treated as a contract failure. The fork's local execution environment is not a complete simulation of Base sequencer ordering, MEV or production availability.
