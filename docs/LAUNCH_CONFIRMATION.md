# Creation and metadata confirmation

On compatible Base Sepolia factories, metadata is uploaded before the launch and its content identifier is included in `launchWithPayment`. The creator's launch transaction authorizes that identifier on-chain. There is no second message signature to publish new token details. Existing tokens without a metadata reference retain the creator-signed recovery button.

When Pinata is configured, the logo and document are pinned to public IPFS. Otherwise the public testnet server must have a Railway persistent volume: it stores content addressed documents and images and resolves them through Elpida's public endpoints. A CID is not proof of public IPFS availability. This hosted fallback is testnet-only; public IPFS pinning still needs server credentials. Upload failures stop before spending launch funds.

EIP-5792 wallets that already advertise atomic support can submit exact ERC-20 approval(s) and the creation/first-purchase call together using `wallet_sendCalls` with `atomicRequired: true`. The app does not upgrade wallet permissions or silently enable account abstraction. Wallets without support retain separate bounded approvals when necessary. Native-only launches, or launches with sufficient existing allowances, use one normal creation transaction.

A batch ID is saved before sending. An uncertain result is never retried as a fresh launch: another attempt checks the stored batch instead. Completion requires matching chain and batch ID, atomic execution, successful receipts and matching on-chain logs. User rejection and definitively failed batches can be retried. A wallet simulation supplies batch gas estimates because a standalone launch estimate cannot see approval state from earlier calls in the same batch.

The feature is implemented and tested against local contracts; real atomic wallet confirmation still needs a compatible wallet to verify end to end. Solana and EVM deployments without the compatible metadata factory retain their existing metadata limitations. USDC-to-native conversion remains a separate explicit funding action.

Protocol origin is verifiable through factory launch events, creator/token/curve addresses and the metadata reference. Tokens remain standard transferable assets; there is no special address suffix, automatic external listing, or universal trading-bot support. Creator rewards beyond a single recipient remain simulation-only until those contracts and verification services are deployed.
