# The mainnet site (17 November 2026)

Elpida runs as two services from the same code (Malik, 17 Nov):

- **Testnet site** (default): the public testnets, the local simulation, faucets and test tools, exactly as before.
- **Mainnet site** (`ELPIDA_MODE=mainnet`): only chains whose mainnet deployment is finished. Chains move over one at a
  time; the first is Base.

## How a chain appears on the mainnet site

`apps/api/evm-networks.mjs` builds each mainnet in `packages/core/mainnets.mjs` from two committed files:

- `deployments/plans/<chain>.json`: the plan (treasury Safe, keeper, guardian, Uniswap PoolManager, Chainlink ETH/USD,
  USDC, minimum fee, daily launch cap);
- `deployments/<chain>.json`: the record `scripts/v2-mainnet-deploy.mjs` writes. The chain is listed only once its
  `status` is `ready` (after the Safe batch and `verify`). Until then the start-up log says why it is left out.

The network carries the V2 launchpad (factory, hook, router, distributors, flywheel vault, deploy block), so the indexer,
prices, analytics and token pages work from the record alone. No Model 10 or Model 11 launchpad exists on mainnet.

## What the mainnet service needs (Railway variables)

| Variable | Why |
|---|---|
| `ELPIDA_MODE=mainnet` | Serve mainnets only |
| `ELPIDA_RPC_8453` | Private Base RPC (Alchemy). The server's indexer, prices and keeper use it; browsers use `https://mainnet.base.org` |
| `ELPIDA_RPC_56`, `ELPIDA_RPC_4663`, `ELPIDA_RPC_1` | The same for BNB Chain, Robinhood Chain and Ethereum, once each has a ready record (Alchemy covers all three: `bnb-mainnet`, `robinhood-mainnet`, `eth-mainnet`). Browsers use the public RPC in `packages/core/mainnets.mjs` |
| `ELPIDA_RPC_42161` | Private HTTPS Arbitrum One RPC. Set it in `/etc/elpida/elpida.env` on Oracle before merging the Arbitrum ready record. |
| `ELPIDA_V2_KEEPER_KEY` | The keeper wallet named in the plan: collects fees and pays creator rewards. Fund it with about 0.002 ETH on Base |
| `ELPIDA_PUBLIC_URL`, `PINATA_JWT`, a volume, `ELPIDA_BACKUP_*` | As for any mainnet (`PRODUCTION_GUARD.md`) |

Leave out everything test-only: Circle test funding, tokenized-stock flags (they stay off for the mainnet beta), the
test-network worker keys, `ELPIDA_V2_DISTRIBUTIONS` (the first release pays creator rewards only; the trader airdrop,
holder and flywheel shares accrue unpaid) and `ELPIDA_SOLANA_CLUSTER` (Solana stays off on the mainnet site until Solana
itself is on mainnet). Preview with `npm run check:production -- --as-mainnet-site`; the server refuses to start until
it passes.

## Cost

The testnet site does not need a paid service: `docs/ORACLE_HOSTING.md` runs it on Oracle Cloud's Always Free VM, so
Railway can host the mainnet site alone.

## Indexer RPC (19 November 2026)

Alchemy's free plan answers `eth_getLogs` for at most 10 blocks, and the V2 indexer reads logs 100 to 1,000 blocks at a
time, so on Alchemy free it fails with `SERVER_ERROR` on every tick. Set `ELPIDA_INDEX_RPC_<chainId>` (one or more
HTTPS URLs, comma-separated; the indexer fails over between them) to an endpoint without that limit, for example
`ELPIDA_INDEX_RPC_8453=https://base-rpc.publicnode.com,https://mainnet.base.org`. It is used by the public indexer
only; the keeper, prices and the production guard keep `ELPIDA_RPC_<chainId>`. Indexer errors now log a short `reason`
with URLs and keys removed.

For Arbitrum One, set `ELPIDA_INDEX_RPC_42161=https://arb1.arbitrum.io/rpc,https://arbitrum-one-rpc.publicnode.com` alongside the private server RPC. Once `/api/public/status` shows Arbitrum caught up, review its public launch, buy and sell in Analytics. The Contracts section of Docs reads the factory, hook, router, USDC distributor and treasury from the same ready record.
