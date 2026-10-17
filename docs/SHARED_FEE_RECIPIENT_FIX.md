# Shared curve fee recipient

Read-only Base Sepolia inspection on 17 October 2026 confirmed successful
post-graduation VASTOLORDE trades:

- Buy: `0x5ce31b4d74709fe5a6c283af7dbed25cc7afa85034cb15001eadd39ca72022c5`
- Sell: `0xfd726c585340da0c9e60d7814a740f9b04fd1e731ba12d22978b071e6be5bf0c`

Both receipts had status 1 and sender
`0xf5B0cE04241f9518dfA3CBfbaafC7E40638E639D`. The index reports both as DEX pool
trades. The sell row displays the router because pool events identify its recipient;
the receipt sender confirms the wallet that submitted this transaction.

## Curve claim defect

The deployed curve `0x267629DDA69505Ac233fc92B3d7a4b09D6933924` has the same
protocol treasury and creator recipient, the address above. Its original `_claim`
chooses the protocol ledger whenever the recipient matches the treasury. Calling
`withdrawFees` therefore selects that ledger twice and never selects the creator
ledger. At inspection, protocol fees were zero while creator fees remained
313934283794784 wei (0.000313934283794784 ETH).

The fix pays the sum of both ledgers when the two fixed recipients are identical,
clearing both before the external call. If payment fails, both original ledger
values are restored. Distinct-recipient behavior stays unchanged. Model 10
pricing, fee rates, recipients and wallet separation are unchanged.

This is a source fix for new deployments. Existing curves are immutable; neither
repeated wallet confirmations nor a website deployment installs it on VASTOLORDE.
No recovery for its stranded creator-ledger amount is established here. Do not
represent it as claimed or migrate/delete existing tokens. A new reviewed testnet
factory/curve deployment and a new-token claim rehearsal are required to validate
the fix publicly. No deployment or wallet transaction was submitted in this pass.

## Wallet prompts

The current claim workflow can submit separate transactions for curve payouts,
LP fee collection, and each payable asset/recipient pair. Multiple wallet prompts
can be expected; they do not prove completion. Splitter claims are separate from
the stuck curve ledger. One recent successful token-asset splitter claim was
`0x6e57f69318ac68ad31f1a72c43f2018c38d719dceb7e9c7e8f4be01d427782e3`.

Validation: all 7 focused EVM tests passed, covering shared and distinct recipients, repeat claims, failed-payment ledger restoration, native and USDC graduation, and fee-only collection without moving principal.
