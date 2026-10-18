# Launch changes — 18 October 2026

These user decisions supersede the mandatory creator-purchase requirement in
the 17 October scope. They do not authorize mainnet deployment or real funds.

- Creator purchases are optional on EVM and Solana. Zero means no token
  allocation, trade, or trading fee; the launch fee and network costs remain.
- New standard EVM launches use atomic graduation: the final purchase creates
  the V3 pool and locks liquidity in the same transaction. Migration failure
  reverts that purchase, leaving the prior curve state available for trading.
- Model 10 virtual reserves, sale cap, FDV targets and anti-snipe schedule stay
  unchanged. Existing immutable curves retain their deployed behavior.
- The EVM base curve fee remains 1.25%, split 50/50 protocol/creator.
- Developers can optionally fix separate buy and sell taxes at launch, each
  0–10%. These are additional to base curve fees and split 30% protocol / 70%
  creator. They cannot be raised or changed after launch. Zero on both sides
  uses the standard token path.
- Creator wallet allocations divide the creator side only: both its half of
  base fees and its 70% of tax. Up to eight distinct wallets, totaling 100%.
- Tax tokens use a separate V2-compatible migration/router path. Standard V3
  routing is not used for transfer-tax tokens. Ordinary wallet transfers have
  no token tax. Post-migration tax applies to the canonical registered pair.
- Curve taxes accrue in the quote asset. After migration, the transfer tax is
  paid in the launched token: treasury receives 30%, creator allocation escrow
  receives 70%. Claiming does not change lifetime earned totals.
- After migration the 1.25% curve fee stops. The token tax and the DEX pool fee
  are distinct. V2 LP fees compound in permanently locked liquidity and are
  not separately withdrawable; creator tax claims do not withdraw LP principal.
- Automatic dividends, tax-to-native liquidation, buyback/burn and tax-funded
  LP automation are not enabled by this implementation. Existing non-tax local
  reward strategies remain separate; the tax flow explicitly allows wallets.

## Deployment gates

The default local API remains compatible with existing test fixtures. The new
`ElpidaAtomicDexFactory` artifact is available to the public testnet deployment
flow; capability probes and browser deployment records distinguish it from old
factories. A fresh factory must be deployed and verified before public zero-buy
or atomic standard launches are advertised as active.

Tax contracts and native/USDC lifecycle rehearsals use a separate local V2
factory. The public browser signing adapter and indexer support an explicitly
registered `network.taxDeployment` with factory, adapter, router, DEX factory,
WETH, treasury, creation block and model `curve-tax-v10`. Every identity is
checked before signing. No such public deployment is pinned by this patch;
the public tax inputs are disabled until one is verified and registered.
The current router/indexer profile is Uniswap-style V2 with a 0.30% pool fee;
other fork fee profiles need their own validation before registration.

Solana optional creator buys require rebuilding and upgrading the devnet
program. An account-free `optional_buy_version` probe distinguishes the upgrade
from older programs before asking for a zero-buy signature. The old public
binary is not represented as upgraded. Rust/Solana build tools are unavailable
on this Windows host; the program source must be built and exercised on the
Solana toolchain before deployment.

Keep the existing sponsored keeper/manual migration path for old curves,
including AIZEN. No server, UI or source patch can change their immutable code.

## Flap references and compatibility

Reviewed the live [launch form](https://flap.sh/launch), the official
[tax parameter reference](https://github.com/flap-sh/flap-skills/blob/main/launch-bnb-token-on-flap/references/tax-params.md),
and the [tax processing flow](https://docs.flap.sh/flap/developers/basic-and-mechanism/flap-tax-token/tax-token-v2).
Flap provides separate tax rates, an optional creator buy, and allocation
validation. This implementation follows those concepts, with ELPIDA's user-set
30/70 tax split and fixed creator wallet allocation. It does not copy Flap's
rates, thresholds, deployment addresses, dividend bots or arbitrary vault calls.

[Flap's migration documentation](https://docs.flap.sh/flap/developers/basic-and-mechanism/list-on-dex)
routes tax tokens to V2-style pools. [Uniswap's token integration documentation](https://developers.uniswap.org/docs/protocols/v3/concepts/unsupported-tokens)
explains why standard V3 routers cannot safely support fee-on-transfer tokens.
