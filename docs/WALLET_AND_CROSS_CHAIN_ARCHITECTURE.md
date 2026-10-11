# Elpida wallets and funding

**11 October update:** funding is 10 USDC plus the first buy in the native/USDC pair, without a liquidity deposit. Virtual trading precedes locked-pool graduation. The deposit examples below are historical. See [current specification](VIRTUAL_CURVE_AND_PAIRS.md).

Design review: 10 October 2026. Recommendations below are not implemented wallet or bridge integrations.

## Recommended account model

Offer Connect wallet for existing users and email/social sign-up with user-owned embedded wallets for newcomers. An Elpida account links one EVM signer and one Solana signer, creating the second wallet when needed. Importing an existing wallet belongs inside its wallet application; Elpida should not collect seed phrases or private keys.

Privy supports embedded and external wallets for both chain families; it is a candidate provider, not a selected dependency. Validate user ownership, recovery, export, revocation, supported networks and provider costs in a separate test before adoption. Server-controlled wallets and unrestricted additional signers do not provide the same authority model as a user-owned wallet. [Privy overview](https://docs.privy.io/wallets/overview), [ownership and delegation example](https://docs.privy.io/recipes/bankr-bot-guide).

A Solana wallet cannot submit an Ethereum contract launch. The account needs an EVM signer or an explicitly authorized destination-chain execution mechanism. The same EVM account can normally be used across EVM chains, but its balances, approvals, gas and transactions remain separate on each chain.

## Funding and the unified balance

Connecting a wallet enables authorized transactions; it does not move USDC. On the launch chain, the user approves the factory for the creation fee, liquidity deposit and first buy. Funds go into their defined on-chain destinations, not an Elpida operator wallet.

Start with wallet balances by chain and add routing only when tested. For example, a user with 100 USDC on Solana and zero on Base must transfer an adequate amount to Base before executing a Base launch. A 10 USDC fee plus 100 USDC liquidity plus 25 USDC first buy requires 135 USDC, with routing costs and gas additional. The wallet identity and the funding route are separate requirements.

Two researched funding options:

| Option | Balance model | Elpida use |
| --- | --- | --- |
| Circle CCTP | Transfer native USDC between supported chains | Route directly from the source wallet to the destination wallet; await transfer completion and refresh the launch quote |
| Circle Gateway | USDC deposited in Gateway contracts forms a unified balance | Optional Add funds flow for repeated cross-chain use; authorize settlement to a destination, then execute its launch |

CCTP supports USDC on Ethereum, Base and Solana. Its BNB entry is USYC-only, and Robinhood is absent from the published table. Do not infer USDC routing from a chain's presence or EVM compatibility. [CCTP coverage](https://developers.circle.com/cctp/concepts/supported-chains-and-domains), [CCTP overview](https://developers.circle.com/cctp).

Gateway documents user-authorized non-custodial deposits and a seven-day trustless withdrawal path. Transfers can be fast after the balance is established; deposits still require confirmations. These are Gateway's service claims, not measured Elpida transaction times. [Gateway overview](https://developers.circle.com/gateway).

The Gateway chain table lists Ethereum, Base and Solana, but the Solana API-name columns are blank while other docs reference a Solana integration. Treat the exact Solana endpoints and deployments as an integration validation item. BNB and Robinhood are absent. Never present Gateway as covering all five Elpida targets. [Gateway coverage](https://developers.circle.com/gateway/references/supported-blockchains).

Gateway adds transfer, gas and optional forwarding costs; quote them dynamically and include a maximum authorized fee. Moving USDC is separate from paying gas for the subsequent launch or trade. Gas sponsorship requires a tested sponsor/paymaster or Solana fee payer, cost limits and abuse controls. [Gateway fees](https://developers.circle.com/gateway/references/fees).

## Interface behavior

- Show total recognized USDC, ready on the selected chain, deposited unified funds and pending transfers separately. Do not count the same deposit in both wallet and Gateway balances.
- Offer Add funds and Withdraw. Identify the exact chain and accepted token address before showing a deposit destination.
- Launch review shows creation fee, irreversible liquidity deposit, first buy, minimum tokens received, route fee and gas payer.
- For insufficient destination funds, show a route quote and expected settlement stages. Require authorization for that route.
- If funding settles but launch fails, keep funds in the user's destination wallet and offer retry or withdrawal. Do not automatically repeat a bridge transfer.
- Onboarding asks for only the chain wallet needed now; existing users may connect both.

## Accounting and transaction workflow

The draft `db/schema.sql` already associates wallets and ledger entries with chains. It is illustrative and must not become an operator-held cash ledger by accident. For non-custodial routing it should record observed assets and operation states, not assert that Elpida can spend a wallet balance without consent.

Suggested operation states: quoted, authorized, source submitted, source confirmed, settlement pending, destination funded, launch submitted, launch confirmed, failed or recovery required. Preserve source and destination transaction IDs, user-authorized recipients, environment, contract addresses, quote expiry, minimum output and maximum fees.

Use operation idempotency, unique chain/transaction/log identifiers, finality checks, reconciliation and explicit retry rules. A cross-chain transfer and destination launch are not one atomic transaction. Re-quote after funding; bound any delegated signer by allowed contracts, amounts, deadlines and revocable permissions.

Do not mix mainnet and testnet balances. Do not treat bridged assets, tUSDC or any token named USDC as native Circle USDC. Track contract/mint, issuer, chain, decimals and route separately.

## Build order

1. Keep connected-wallet EVM testing and finish locked-pool validation.
2. Add account authentication and user-owned embedded EVM wallet onboarding with recovery/export tests.
3. Add Solana wallet connection and an established Solana launch/pool adapter.
4. Test Solana-to-Base USDC transfer, destination execution, failed launch recovery and gas funding.
5. Evaluate Gateway deposits and withdrawals for the unified Add funds experience.
6. Enable other chains only after verifying quote assets, DEX deployments, lockers and funding routes.
