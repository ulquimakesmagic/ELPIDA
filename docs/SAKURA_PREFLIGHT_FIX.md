# Sakura graduation preflight investigation, 1 November 2026

Affected Ethereum Sepolia token: 0x70c9c8579405c921b162b59f45a55ebe24e85f67.
Curve: 0xE5B6de2Cc228E6AB5A1743c8975Cd79Bb96B1CEf.

Read-only reproduction from the connected test wallet:
- A 0.001 ETH buy estimated successfully (225136 gas).
- Completion amount 0.044102262790405130 ETH failed on the primary RPC with code 3, empty revert data.
- A local fork at block 12037339 simulated the same final buy successfully.
- A configured secondary RPC also simulated it successfully with an explicit upper simulation gas limit.
- The new helper returned an actual gas estimate of 54526686 from that endpoint. Default simulation ceilings are
  the likely cause of the inconsistency; the primary RPC did not expose its internal cap.

The paced browser provider now consults only configured HTTPS alternatives for eth_call/eth_estimateGas errors
with code 3 and absent/empty revert bytes. It checks chain ID and a fresh block timestamp, uses that block's gas
limit only as the simulation ceiling, and accepts an estimate only within it. Existing explicit gas is preserved.
Actual transaction gas comes from the estimator, not a hardcoded guess. Useful revert bytes stop fallback.
No send/sign/broadcast RPC method is retried. Wrong-chain, stale, unavailable or malformed endpoints are refused.
CSP permits the configured fallback URLs; signing and submission remain in the wallet.

A slow-preflight hint now starts before gas estimation, distinguishing network simulation from a pending wallet
request. Generic missing-revert messages explain the uncertain simulation outcome and ask users to check wallet
activity if already confirmed. The dynamic test-pair recovery input now uses its own control reference rather
than a lookup that the shell-ID test incorrectly treated as a static HTML requirement.

No public graduation transaction was sent by this investigation. The fix still needs deployed browser and wallet
verification; successful simulation is not a successful on-chain graduation or a security approval.
