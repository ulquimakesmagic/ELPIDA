# DEX destinations and fee accounting

Status is ELPIDA integration status, not whether a DEX exists on the chain.
Nothing here authorizes mainnet deployment.

| Chain | Standard-token destination | Tax-token destination | ELPIDA status |
| --- | --- | --- | --- |
| Base | Uniswap v3 | Uniswap-style v2 | Public V3 on Base Sepolia; new atomic factory needs deployment. V2 tax lifecycle tested locally; public deployment not pinned. |
| Ethereum | Uniswap v3 target | Uniswap v2 target | Public migration integrations not configured in ELPIDA yet. |
| BNB Chain | PancakeSwap target | PancakeSwap V2 target | Adapter addresses and fork fees must be verified; current V2 implementation tests Uniswap's 0.30% profile, not PancakeSwap's profile. |
| Robinhood Chain | Uniswap candidate | V2 candidate | DEXs exist; ELPIDA's addresses, migration adapters and router fee profile remain unverified/unconfigured. |
| Solana | PumpSwap | EVM configurable tax does not apply | PumpSwap migration/fee-harvest program implementation; devnet testing remains separate from mainnet readiness. |

The current Base Sepolia V3 factory, manager, WETH and 1% fee tier are in
`packages/core/uniswap.mjs`. A target row is not an enabled integration.
Uniswap lists its networks in its [deployment registry](https://developers.uniswap.org/deployments).

## Which fees apply?

| Stage | Charge | Destination |
| --- | --- | --- |
| Curve, after first-minute protection | 1.25% base fee | 50% Elpida, 50% creator side |
| Curve, tax token | Additional configured buy/sell tax, max 10% each | 30% Elpida, 70% creator side |
| First minute | Existing anti-snipe surplus | Locked graduation liquidity; not creator or protocol revenue |
| V3 pool, standard token | Pool fee (currently 1% on Base Sepolia) | LP earnings of ELPIDA's locked position split 50/50; other LPs earn their share and DEX protocol settings may reduce LP proceeds |
| V2 pool, tax token | Pool fee plus configured token tax | Pool fee compounds in LP reserves; token tax splits 30/70 |

The old curve's 1.25% is not charged on DEX swaps. The DEX does not take the
creator's configured tax: pool fee accounting and token tax accounting are
different. Fees applied to different input/output assets compound; they are not
always a simple sum of the quoted percentages.

Example on the curve, after launch protection: a 4% tax plus 1.25% base fee
charges 5.25% in total. Elpida receives 0.625% + 1.2% = 1.825% of gross input;
the creator side receives 0.625% + 2.8% = 3.425%, subject to integer rounding.
Creator allocations then divide the creator side without charging another fee.

After V2 graduation, a 4% buy tax sends 30% of the deducted tax tokens to the
treasury and 70% to creator allocation escrow. The separate pool fee remains
inside locked LP reserves. There is no native-currency tax conversion bot in
this version, and claims are labeled by the actual asset received.

## Security and validation notes

- Contract-level 10% caps and allocation totals; no admin tax setters, mint,
  blacklist or arbitrary withdrawals.
- Separate native/USDC V2 rehearsals; exact-input routing checks the user's
  actual received balance, including token tax, against minimum output.
- Before migration, third parties cannot seed the registered V2 pool with this
  token and obtain withdrawable LP shares. Empty pre-created pairs are accepted;
  unsolicited quote donations cannot steal LP principal. Synced quote-only
  donations may increase the opening pool price as additional locked backing.
- LP tokens are minted to the permanent dead address. Adding independent LP
  positions later does not unlock the original position.
- Public tax transactions require the full registered deployment identity.
  Public standard factories and Solana programs need fresh deployment/upgrade
  for optional buys; existing contracts cannot be retroactively changed.
