# Base Sepolia tax deployment and rehearsal

Prepared 18 October 2026. Test funds only. No deployment or signing occurs by
reading the plan. `config/base-sepolia-tax-plan.json` is an inert preparation
file, not a live `network.taxDeployment` entry.

## First finish the existing standard-token rehearsal

SONGOKU `0x27a4A0fAcDc4ba89E4c3A0dd7d9D4bC849ac0E4B` uses atomic factory
`0x98a0E75dbBe9EdA5D228319C72D496b814bA7145`; its curve is
`0xbBCDC54cdBa0477F80adBf93559b4108bfF31136`.

Verified on chain: zero creator purchase, two buys, a shared-recipient fee claim,
and a sell. The sell transaction
`0xb54e68e610e4150fc52f7d17633f01cfef55d995cbe8ed25da0ec18a94ceca34`
left 0.049723050788829215 test ETH to complete the curve. That is a snapshot,
not a fixed future quote: refresh the live remaining amount before signing.
Keep additional test ETH for gas. Do not spend this reserve on tax deployment
before completing the standard graduation check.

On the final purchase, require a successful receipt containing `Bought`,
`CurveCompleted` and `Graduated` from this curve in the same transaction. Check
the pool's token pair and fee tier, the position NFT's locker ownership, locked
status and nonzero liquidity. Then test a small DEX buy and sell, collect LP
fees and claim the fixed shares. Neither automatic graduation nor post-migration
trading has yet been verified publicly for SONGOKU.

## Choose and verify the V2 destination

The [official Uniswap V2 table](https://developers.uniswap.org/docs/protocols/v2/deployments)
and [unified registry](https://developers.uniswap.org/deployments.json) did not
list a chain-84532 V2 deployment when checked. The registry source commit was
`a677c0d4b5fb6e3357cf6d0f0315bcb135a1e1ee`. Base mainnet and Ethereum Sepolia
addresses are not substitutes for Base Sepolia.

The prepared route is a new, labelled **ELPIDA V2 test deployment using Uniswap
V2 core**, matching the real V2 core fixture used by local tests. It must not be
presented as an official Uniswap deployment. No DEX address is pinned yet.
Record the exact V2 artifact hash/version and creation transaction, compare
deployed runtime with the artifact, and verify its factory/pair fee behavior.
The configured router supports the 0.30% V2 profile only.

Before public registration, change the currently hard-coded `Uniswap v2` display
labels in the tax wallet, local runtime and indexer to distinguish this test
venue. This is an outstanding UI task, not an enabled integration.

## Deployment order when test funds are available

Use the existing test treasury in the plan. All sends stay on chain 84532. This
sequence is an operator runbook; the current browser tools do not contain a tax
deployment button. Prepare unsigned deployments for browser-wallet signing or
a separate reviewed testnet deployment flow; do not paste keys into scripts.

| Order | Action | Arguments |
| --- | --- | --- |
| 1 | Deploy V2 core factory | `UniswapV2Factory(treasury)` using the installed V2 artifact |
| 2 | Deploy ELPIDA migration adapter | `ElpidaV2TaxMigrationAdapter(dexFactory, wrappedNative, usdc)` |
| 3 | Deploy tax-aware router | `ElpidaV2TaxRouter(dexFactory, wrappedNative, 30)` |
| 4 | Deploy tax factory | `ElpidaTaxFactory(treasury, adapter, 50, 86400)` |
| 5 | Fix USD pricing once | `factory.configureUsdPricing(usdFeed, 1500, usdc)` |
| 6 | Approve USDC curve template | `factory.approveQuote(usdc, 55555556, adapter)` |

The JSON file contains the full public addresses. The factory creates its
internal deployer contracts during construction; do not deploy those separately.
The adapter supports native/WETH and the configured USDC. Zero-value contract
deployment/configuration still costs gas. Obtain estimates at execution time;
there is no hard-coded gas budget or faucet promise.

Record each transaction hash, receipt status, contract address and creation
block. Verify constructor/creation bytecode, deployed dependencies and all
immutable/configured values against the plan. Check Model 10, tax version 1,
optional-buy version 1 and `automaticGraduation() == true`. Check the router's
DEX factory, WETH and 30-bps fee; adapter DEX factory, WETH and USDC; treasury,
oracle, age limit and quote template. Read `feeTo()` on the V2 factory: a DEX
protocol-fee setting can affect LP proceeds and must be disclosed.

## Public activation gate

Only after those checks, prepare a registry PR with the real values:

```js
taxDeployment: {
  factory: '<tax factory>', adapter: '<ELPIDA V2 adapter>',
  router: '<ELPIDA tax-aware router>', dexFactory: '<verified V2 factory>',
  weth: '<wrapped native>', treasury: '<test treasury>',
  block: '<integer creation block>', model: 'curve-tax-v10'
}
```

Use an integer for `block`; angle-bracket strings above are documentation only.
The router is ELPIDA's tax-aware router, not the standard V2 Router02. Leave the
existing standard factory and all legacy entries in place. The browser must
reject a mismatched deployment before approval/signing, and the indexer must
discover tax tokens separately. Keep tax controls disabled until registration
and venue labels are correct. Complete the rehearsal before promoting the
integration beyond test use.

## Tax lifecycle acceptance checklist

For both native and USDC pairs, use separate fresh tokens. Select fixed buy tax
4%, sell tax 6%, two distinct test-wallet recipients at 60%/40%, and zero creator
purchase. Confirm the recipients before launch; the addresses and tax rates
cannot be changed afterward. Ordinary wallet transfers are untaxed; token tax
after migration applies to the canonical registered pair.

- Zero-buy launch: creator balance, sold amount and trading fees start at zero.
  The $10 launch fee and gas still apply. For USDC fee payment, use a creator
  distinct from the treasury; the existing browser rejects self-payment.
- Wait out the first 60 seconds; execute a small buy and a partial sell. Base
  curve fee is 1.25%, split 50/50. Additional side tax splits 30% treasury and
  70% creator escrow. The creator allocation divides both creator portions.
- Example: a 0.01 ETH curve buy with 4% tax accrues 0.0001825 ETH protocol and
  0.0003425 ETH creator-side fees, subject to rounding. Its creator escrow then
  allocates 60%/40%. First-minute protection surplus is separate locked backing.
- Claim to each fixed recipient, including the non-creator wallet. Confirm
  recipient-specific balances and that lifetime earned totals do not fall.
- Complete the curve and require V2 graduation in the final-buy receipt. Verify
  the registered pair, reserves, and LP minted to the permanent dead address.
- Make a small post-migration buy and sell with minimum output protection.
  The curve's 1.25% stops. The separate 0.30% pool fee still applies; token tax
  is deducted in the launched token and sent 30% treasury / 70% allocation.
  Compare actual token balance changes, not a simple sum of percentages on
  potentially different input/output assets.
- Claim the creator token-tax allocation. V2 LP fees compound in reserves;
  these are not V3-style separately collectible LP revenue. No tax-to-ETH
  conversion, dividends or buyback bot is enabled.
- Keep 10% cap, invalid allocation totals, identity mismatch, pre-seeding and
  failed-migration rollback checks in local EVM tests; do not spend public test
  funds sending deliberately reverting transactions.

## Evidence to retain

Deployment identities and transaction receipts; native and USDC launch hashes;
buy, sell, claim and final-buy hashes; pool and allocation addresses; before/
after balances by asset; LP custody proof; indexed trade/fee results; and any
unresolved failures. Keep this evidence separate from mainnet readiness.
