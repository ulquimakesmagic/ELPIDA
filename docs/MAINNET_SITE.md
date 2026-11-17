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
